//! Vega's torrent engine is vega-torrentd: libtorrent (the library behind
//! qBittorrent) in its own process, with an HTTP API on 127.0.0.1. On the
//! same PC and releases it connected to 77-117 peers at 14-25 MB/s, where the
//! librqbit session this replaces connected to 1 at up to 3.9 MB/s.
//!
//! The app starts it with the session's download folder and its own process
//! id (the engine exits with the app) and hands its port to the frontend,
//! which talks to it directly.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const ENGINE: &str = if cfg!(windows) { "vega-torrentd.exe" } else { "vega-torrentd" };

pub struct TorrentState {
    pub api_port: u16,
    child: Mutex<Option<Child>>,
}

impl Drop for TorrentState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn engine_path(resource_dir: &Path) -> Option<PathBuf> {
    let mut dirs = vec![
        resource_dir.join("resources").join("torrentd"),
        resource_dir.join("torrentd"),
        resource_dir.to_path_buf(),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("resources").join("torrentd"));
            dirs.push(dir.to_path_buf());
        }
    }
    dirs.into_iter().map(|dir| dir.join(ENGINE)).find(|path| path.is_file())
}

impl TorrentState {
    /// Starts the engine and waits for it to report its port.
    pub fn start(resource_dir: &Path, download_dir: PathBuf) -> anyhow::Result<Self> {
        // Streams are a cache: what a crash left behind goes.
        let _ = std::fs::remove_dir_all(&download_dir);
        std::fs::create_dir_all(&download_dir)?;
        let engine = engine_path(resource_dir)
            .ok_or_else(|| anyhow::anyhow!("{} is missing from the app resources", ENGINE))?;

        let mut command = Command::new(&engine);
        command
            .arg("--dir")
            .arg(&download_dir)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("the torrent engine has no output"))?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut sent = false;
            // Read everything the engine prints, so its pipe never fills up.
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !sent {
                    if let Some(port) = line.strip_prefix("PORT ").and_then(|port| port.trim().parse::<u16>().ok()) {
                        let _ = sender.send(port);
                        sent = true;
                    }
                }
            }
        });
        let api_port = match receiver.recv_timeout(Duration::from_secs(15)) {
            Ok(port) => port,
            Err(_) => {
                let _ = child.kill();
                anyhow::bail!("the torrent engine did not start");
            }
        };
        vlog_debug!("[torrent] libtorrent engine on port {} ({})", api_port, engine.display());
        Ok(Self {
            api_port,
            child: Mutex::new(Some(child)),
        })
    }
}
