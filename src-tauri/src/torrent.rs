use axum::serve::Listener;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::net::Ipv6Addr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::Api;
use librqbit::dht::Id20;
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::{ListenerMode, ListenerOptions, Session, SessionOptions};

/// Added to every torrent. Provider magnets (Torrentio's in particular) often
/// carry no trackers at all, which leaves peer discovery to the DHT. RuTracker's
/// and Rutor's announce URLs are included because most of their swarms are
/// behind them.
const PUBLIC_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.qu.ax:6969/announce",
    "udp://tracker.theoks.net:6969/announce",
    "udp://tracker.tryhackx.org:6969/announce",
    "udp://tracker-udp.gbitt.info:80/announce",
    "udp://tracker.gmi.gd:6969/announce",
    "http://tracker.dler.org:6969/announce",
    "udp://retracker01-msk-virt.corbina.net:80/announce",
    "udp://opentor.net:6969",
    "http://retracker.local/announce",
    "http://bt.t-ru.org/ann?magnet",
    "http://bt2.t-ru.org/ann?magnet",
];

/// How long a swarm probe waits for each release's DHT peers.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// Peers that are enough to call a release alive.
const PROBE_ENOUGH_PEERS: usize = 8;

pub struct TorrentState {
    pub session: Arc<Session>,
    pub api_port: u16,
}

impl TorrentState {
    pub async fn new(download_dir: PathBuf) -> anyhow::Result<Self> {
        // Automatically clean up download_dir to clear orphaned torrents from crashes
        let _ = std::fs::remove_dir_all(&download_dir);
        std::fs::create_dir_all(&download_dir)?;

        // Allow all CORS origins. Windows Tauri v2 uses http://tauri.localhost which isn't in librqbit's default allowlist
        std::env::set_var("CORS_ALLOW_REGEXP", ".*");

        let opts = SessionOptions {
            // Without a listener only peers we dial can send data; peers that
            // can reach us (and UPnP-mapped routers) add many more connections.
            listen: Some(ListenerOptions {
                mode: ListenerMode::TcpOnly,
                listen_addr: (Ipv6Addr::UNSPECIFIED, 0).into(),
                enable_upnp_port_forwarding: true,
                ..Default::default()
            }),
            trackers: PUBLIC_TRACKERS
                .iter()
                .filter_map(|tracker| url::Url::parse(tracker).ok())
                .collect(),
            ..Default::default()
        };
        let session = match Session::new_with_opts(download_dir.clone(), opts).await {
            Ok(session) => session,
            Err(e) => {
                // A blocked listen port must not leave the app without torrents.
                vlog_warn!("[torrent] Session with listener failed ({}), starting without it", e);
                Session::new(download_dir).await?
            }
        };
        let api = Api::new(session.clone(), None, None);

        let opts = HttpApiOptions {
            read_only: false,
            basic_auth: None,
            allow_create: true,
        };

        let http_api = HttpApi::new(api, Some(opts));

        let dual_listener = librqbit_dualstack_sockets::socket::MaybeDualstackSocket::<
            tokio::net::TcpListener,
        >::bind_tcp("127.0.0.1:0".parse()?, Default::default())?;
        let api_port = dual_listener.local_addr()?.0.port();

        // Spawn HTTP server in the background
        tokio::spawn(async move {
            if let Err(e) = http_api.make_http_api_and_run(dual_listener, None).await {
                vlog_warn!("librqbit http api error: {}", e);
            }
        });

        Ok(Self { session, api_port })
    }
}

/// Peers the DHT returns for each info hash (lowercase hex), so a source list
/// can drop releases nobody shares before one is picked.
#[tauri::command]
pub async fn probe_swarms(
    state: tauri::State<'_, Option<TorrentState>>,
    hashes: Vec<String>,
) -> Result<HashMap<String, usize>, String> {
    let torrent = state
        .inner()
        .as_ref()
        .ok_or_else(|| "Torrent service is not available".to_string())?;
    let Some(dht) = torrent.session.get_dht().cloned() else {
        return Ok(HashMap::new());
    };
    let wanted: HashSet<String> = hashes.into_iter().map(|hash| hash.to_lowercase()).collect();
    let lookups = wanted.into_iter().filter_map(|hash| {
        let id = Id20::from_str(&hash).ok()?;
        let dht = dht.clone();
        Some(async move {
            let mut peers = HashSet::new();
            let mut stream = Box::pin(dht.get_peers(id, None));
            let _ = tokio::time::timeout(PROBE_TIMEOUT, async {
                while let Some(addr) = stream.next().await {
                    peers.insert(addr);
                    if peers.len() >= PROBE_ENOUGH_PEERS {
                        break;
                    }
                }
            })
            .await;
            (hash, peers.len())
        })
    });
    let results: HashMap<String, usize> = futures_util::future::join_all(lookups).await.into_iter().collect();
    let alive = results.values().filter(|count| **count > 0).count();
    vlog_debug!("[torrent] Swarm probe: {}/{} releases have DHT peers", alive, results.len());
    Ok(results)
}
