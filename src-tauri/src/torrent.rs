use axum::serve::Listener;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::net::Ipv6Addr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librqbit::api::{Api, TorrentIdOrHash};
use librqbit::dht::Id20;
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::http_api_types::PeerStatsFilter;
use librqbit::{
    AddTorrent, AddTorrentOptions, ListenerMode, ListenerOptions, Magnet,
    ManagedTorrent, Session, SessionOptions,
};
use serde::Serialize;

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

/// A monitored release downloads this much of its main video, then stops.
const TEST_BYTES: u64 = 24 * 1024 * 1024;
/// How long a monitored release may take to send its torrent info.
const MONITOR_METADATA_TIMEOUT: Duration = Duration::from_secs(50);
/// Peer addresses kept, to hand playback the peers that answered.
const TEST_PEER_LIST: usize = 40;

/// What the monitor has seen of a release since it was added.
struct MonitorEntry {
    added_at: Instant,
    /// Added by the monitor (not already playing), so removed when it stops.
    owned: bool,
    handle: Option<Arc<ManagedTorrent>>,
    metadata_at: Option<Instant>,
    bytes_at_metadata: u64,
    bytes: u64,
    max_rate: f64,
    max_peers: usize,
    known: usize,
    peer_list: Vec<String>,
}

/// Releases measured while a source list is open; the ones picked for
/// playback stay in the session when measuring stops.
#[derive(Default)]
pub struct SwarmTests {
    claimed: Mutex<HashSet<String>>,
    monitored: Mutex<HashMap<String, MonitorEntry>>,
}

impl SwarmTests {
    fn is_claimed(&self, hash: &str) -> bool {
        self.claimed.lock().map(|claimed| claimed.contains(hash)).unwrap_or(false)
    }
}

pub struct TorrentState {
    pub session: Arc<Session>,
    pub api_port: u16,
    pub tests: Arc<SwarmTests>,
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

        Ok(Self {
            session,
            api_port,
            tests: Arc::new(SwarmTests::default()),
        })
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

/// How a monitored release is doing right now. Speeds are bytes per second;
/// seeds are -1 because librqbit does not say which peers have every piece.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSample {
    metadata: bool,
    elapsed_ms: u64,
    data_ms: u64,
    bytes: u64,
    rate: f64,
    max_rate: f64,
    peers: usize,
    seeds: i64,
    max_peers: usize,
    max_seeds: i64,
    known: usize,
    done: bool,
    peer_list: Vec<String>,
}

fn torrent_state<'a>(state: &'a tauri::State<'_, Option<TorrentState>>) -> Result<&'a TorrentState, String> {
    state
        .inner()
        .as_ref()
        .ok_or_else(|| "Torrent service is not available".to_string())
}

/// Index of the largest file: the video a stream would read.
fn largest_file(handle: &ManagedTorrent) -> Option<usize> {
    handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .max_by_key(|(_, file)| file.len)
                .map(|(index, _)| index)
        })
        .ok()
        .flatten()
}

/// Starts measuring releases while a source list is open: each one not
/// already in the session is added in the background and downloads the
/// start of its main video. Nothing is decided here; `swarm_stats` reports
/// how each is doing and `stop_swarm_monitor` ends it.
#[tauri::command]
pub async fn monitor_swarms(state: tauri::State<'_, Option<TorrentState>>, magnets: Vec<String>) -> Result<(), String> {
    let torrent = torrent_state(&state)?;
    for magnet in magnets {
        let Some(id) = Magnet::parse(&magnet).ok().and_then(|parsed| parsed.as_id20()) else {
            continue;
        };
        let hash = id.as_string();
        // A release already in the session (playing) is measured as it is.
        let existing = torrent.session.get(TorrentIdOrHash::Hash(id));
        {
            let mut monitored = torrent.tests.monitored.lock().map_err(|_| "Swarm monitor is unavailable".to_string())?;
            if monitored.contains_key(&hash) {
                continue;
            }
            monitored.insert(
                hash.clone(),
                MonitorEntry {
                    added_at: Instant::now(),
                    owned: existing.is_none(),
                    handle: existing.clone(),
                    metadata_at: None,
                    bytes_at_metadata: 0,
                    bytes: 0,
                    max_rate: 0.0,
                    max_peers: 0,
                    known: 0,
                    peer_list: Vec::new(),
                },
            );
        }
        if existing.is_some() {
            continue;
        }
        let session = torrent.session.clone();
        let tests = torrent.tests.clone();
        tauri::async_runtime::spawn(async move {
            let add = session.add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions {
                    overwrite: true,
                    ..Default::default()
                }),
            );
            let handle = match tokio::time::timeout(MONITOR_METADATA_TIMEOUT, add).await {
                Ok(Ok(response)) => response.into_handle(),
                _ => None,
            };
            let Some(handle) = handle else { return };
            let watched = tests
                .monitored
                .lock()
                .map(|mut monitored| match monitored.get_mut(&hash) {
                    Some(entry) => {
                        entry.handle = Some(handle.clone());
                        true
                    }
                    None => false,
                })
                .unwrap_or(false);
            if !watched {
                // Measuring stopped while the info was on its way.
                if !tests.is_claimed(&hash) {
                    let _ = session.delete(TorrentIdOrHash::Hash(id), true).await;
                }
                return;
            }
            if !tests.is_claimed(&hash) {
                // Only the start of the main video, as playback would read it.
                if let Some(largest) = largest_file(&handle) {
                    let _ = session.update_only_files(&handle, &HashSet::from([largest])).await;
                }
            }
        });
    }
    Ok(())
}

/// How each monitored release is doing; bytes and dataMs count from the
/// moment its torrent info arrived.
#[tauri::command]
pub fn swarm_stats(state: tauri::State<'_, Option<TorrentState>>, hashes: Vec<String>) -> Result<HashMap<String, LiveSample>, String> {
    let torrent = torrent_state(&state)?;
    let mut monitored = torrent.tests.monitored.lock().map_err(|_| "Swarm monitor is unavailable".to_string())?;
    let now = Instant::now();
    let mut samples = HashMap::new();
    for hash in hashes {
        let hash = hash.to_lowercase();
        let Some(entry) = monitored.get_mut(&hash) else { continue };
        let mut peers = 0;
        let mut rate = 0.0;
        if let Some(handle) = entry.handle.clone() {
            let stats = handle.stats();
            let fetched = stats.live.as_ref().map(|live| live.snapshot.fetched_bytes).unwrap_or(0);
            if entry.metadata_at.is_none() {
                entry.metadata_at = Some(now);
                entry.bytes_at_metadata = fetched;
            }
            if let Some(live) = &stats.live {
                entry.bytes = fetched.saturating_sub(entry.bytes_at_metadata);
                peers = live.snapshot.peer_stats.live as usize;
                entry.known = entry.known.max(live.snapshot.peer_stats.seen as usize);
                rate = live.download_speed.mbps * 1024.0 * 1024.0;
                entry.max_rate = entry.max_rate.max(rate);
                entry.max_peers = entry.max_peers.max(peers);
            }
            if let Some(live) = handle.live() {
                for addr in live.per_peer_stats_snapshot(PeerStatsFilter::default()).peers.into_keys() {
                    if entry.peer_list.len() < TEST_PEER_LIST && !entry.peer_list.contains(&addr) {
                        entry.peer_list.push(addr);
                    }
                }
            }
        }
        samples.insert(
            hash,
            LiveSample {
                metadata: entry.metadata_at.is_some(),
                elapsed_ms: now.duration_since(entry.added_at).as_millis() as u64,
                data_ms: entry.metadata_at.map(|at| now.duration_since(at).as_millis() as u64).unwrap_or(0),
                bytes: entry.bytes,
                rate,
                max_rate: entry.max_rate,
                peers,
                seeds: -1,
                max_peers: entry.max_peers,
                max_seeds: -1,
                known: entry.known,
                done: entry.bytes >= TEST_BYTES * 95 / 100,
                peer_list: entry.peer_list.clone(),
            },
        );
    }
    Ok(samples)
}

/// Ends measuring these releases. The ones the monitor added go, with what
/// they downloaded, unless the player took them over.
#[tauri::command]
pub async fn stop_swarm_monitor(state: tauri::State<'_, Option<TorrentState>>, hashes: Vec<String>) -> Result<(), String> {
    let torrent = torrent_state(&state)?;
    let removed: Vec<(String, bool)> = {
        let mut monitored = torrent.tests.monitored.lock().map_err(|_| "Swarm monitor is unavailable".to_string())?;
        hashes
            .iter()
            .filter_map(|hash| {
                let hash = hash.to_lowercase();
                monitored.remove(&hash).map(|entry| (hash, entry.owned))
            })
            .collect()
    };
    for (hash, owned) in removed {
        if !owned || torrent.tests.is_claimed(&hash) {
            continue;
        }
        let Ok(id) = Id20::from_str(&hash) else { continue };
        if torrent.session.get(TorrentIdOrHash::Hash(id)).is_some() {
            let _ = torrent.session.delete(TorrentIdOrHash::Hash(id), true).await;
        }
    }
    Ok(())
}

/// Keeps a measured release in the session: it is about to be played.
#[tauri::command]
pub fn claim_swarm_test(state: tauri::State<'_, Option<TorrentState>>, info_hash: String) -> Result<(), String> {
    let torrent = torrent_state(&state)?;
    if let Ok(mut claimed) = torrent.tests.claimed.lock() {
        claimed.insert(info_hash.to_lowercase());
    }
    Ok(())
}
