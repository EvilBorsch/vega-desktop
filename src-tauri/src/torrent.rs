use axum::serve::Listener;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::Ipv6Addr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librqbit::api::{Api, TorrentIdOrHash};
use librqbit::dht::Id20;
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::http_api_types::PeerStatsFilter;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ListenerMode, ListenerOptions, Magnet,
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

/// A swarm test reads this much of the main video file, then stops.
const TEST_BYTES: u64 = 12 * 1024 * 1024;
const TEST_POLL: Duration = Duration::from_millis(500);
/// Speed samples averaged for the result: the last three seconds.
const TEST_SPEED_SAMPLES: usize = 6;
/// Time after the torrent info a test keeps measuring, and how far past its
/// budget it may go for releases whose info came late.
const TEST_MIN_DATA_WINDOW: Duration = Duration::from_secs(8);
const TEST_EXTRA_WINDOW: Duration = Duration::from_secs(12);
/// Peer addresses kept, to hand playback the peers that answered.
const TEST_PEER_LIST: usize = 40;

/// Swarm tests in flight: the releases picked for playback stay in the
/// session, and leaving the source list stops the others.
#[derive(Default)]
pub struct SwarmTests {
    claimed: Mutex<HashSet<String>>,
    generation: AtomicU32,
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

/// What briefly joining a release's swarm showed. Speeds are bytes per second;
/// `seeds` is -1 because librqbit does not say which peers have every piece.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwarmTestResult {
    peers: usize,
    seeds: i64,
    known: usize,
    metadata: bool,
    metadata_ms: u64,
    speed: f64,
    max_speed: f64,
    peer_list: Vec<String>,
}

fn torrent_state<'a>(state: &'a tauri::State<'_, Option<TorrentState>>) -> Result<&'a TorrentState, String> {
    state
        .inner()
        .as_ref()
        .ok_or_else(|| "Torrent service is not available".to_string())
}

async fn wait_cancelled(tests: &SwarmTests, generation: u32) {
    while tests.generation.load(Ordering::SeqCst) == generation {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
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

async fn test_swarm(
    session: Arc<Session>,
    tests: Arc<SwarmTests>,
    generation: u32,
    magnet: String,
    id: Id20,
    budget: Duration,
) -> SwarmTestResult {
    let hash = id.as_string();
    let started = Instant::now();
    let hard_deadline = started + budget + TEST_EXTRA_WINDOW;
    let mut result = SwarmTestResult {
        seeds: -1,
        ..Default::default()
    };
    // The playing release (or one picked meanwhile) is measured, never removed.
    let preexisting = session.get(TorrentIdOrHash::Hash(id)).is_some();
    let add = session.add_torrent(
        AddTorrent::from_url(magnet),
        Some(AddTorrentOptions {
            overwrite: true,
            ..Default::default()
        }),
    );
    let added = match futures_util::future::select(
        Box::pin(tokio::time::timeout(budget + TEST_EXTRA_WINDOW, add)),
        Box::pin(wait_cancelled(&tests, generation)),
    )
    .await
    {
        futures_util::future::Either::Left((added, _)) => added.ok().and_then(|added| added.ok()),
        futures_util::future::Either::Right(_) => None,
    };
    let release = |session: Arc<Session>, tests: Arc<SwarmTests>, hash: String| async move {
        if preexisting || tests.is_claimed(&hash) {
            return;
        }
        // A cancelled add can still have registered the torrent.
        if session.get(TorrentIdOrHash::Hash(id)).is_some() {
            let _ = session.delete(TorrentIdOrHash::Hash(id), true).await;
        }
    };
    let Some(added) = added else {
        release(session, tests, hash).await;
        return result;
    };
    let (handle, owned) = match added {
        AddTorrentResponse::Added(_, handle) => (handle, !preexisting),
        AddTorrentResponse::AlreadyManaged(_, handle) => (handle, false),
        AddTorrentResponse::ListOnly(_) => return result,
    };
    result.metadata = true;
    result.metadata_ms = started.elapsed().as_millis() as u64;
    if owned && !tests.is_claimed(&hash) {
        // Read the start of the main video, as playback would.
        if let Some(largest) = largest_file(&handle) {
            let _ = session.update_only_files(&handle, &HashSet::from([largest])).await;
        }
    }
    let metadata_at = Instant::now();
    // A release whose info came late still gets a few seconds of data.
    let deadline = (started + budget).max(metadata_at + TEST_MIN_DATA_WINDOW).min(hard_deadline);
    // Bytes peers sent in this test. `progress_bytes` is no measure: it jumps
    // when the file selection changes.
    let mut start_bytes: Option<u64> = if owned { Some(0) } else { None };
    let mut samples = VecDeque::with_capacity(TEST_SPEED_SAMPLES);
    let mut fetched = 0u64;
    while Instant::now() < deadline && tests.generation.load(Ordering::SeqCst) == generation {
        tokio::time::sleep(TEST_POLL).await;
        let stats = handle.stats();
        if let Some(live) = &stats.live {
            let bytes = live.snapshot.fetched_bytes;
            fetched = bytes.saturating_sub(*start_bytes.get_or_insert(bytes));
            let peers = &live.snapshot.peer_stats;
            result.peers = result.peers.max(peers.live as usize);
            result.known = result.known.max(peers.seen as usize);
            let speed = live.download_speed.mbps * 1024.0 * 1024.0;
            result.max_speed = result.max_speed.max(speed);
            if samples.len() == TEST_SPEED_SAMPLES {
                samples.pop_front();
            }
            samples.push_back(speed);
        }
        if let Some(live) = handle.live() {
            for addr in live.per_peer_stats_snapshot(PeerStatsFilter::default()).peers.into_keys() {
                if result.peer_list.len() < TEST_PEER_LIST && !result.peer_list.contains(&addr) {
                    result.peer_list.push(addr);
                }
            }
        }
        if stats.finished || (owned && fetched >= TEST_BYTES) {
            break;
        }
    }
    let average = if samples.is_empty() {
        0.0
    } else {
        samples.iter().sum::<f64>() / samples.len() as f64
    };
    // A fast release can read the whole test in a second or two, before the
    // speed estimate catches up; the bytes it fetched say the same.
    let elapsed = metadata_at.elapsed().as_secs_f64().max(0.5);
    result.speed = average.max(fetched as f64 / elapsed);
    if owned {
        release(session, tests, hash).await;
    }
    result
}

/// Joins each release's swarm for a few seconds and measures it: peers that
/// connected, how fast the start of the video arrived. Releases not picked
/// meanwhile are removed afterwards with what they downloaded.
#[tauri::command]
pub async fn test_swarms(
    state: tauri::State<'_, Option<TorrentState>>,
    magnets: Vec<String>,
    seconds: u64,
) -> Result<HashMap<String, SwarmTestResult>, String> {
    let torrent = torrent_state(&state)?;
    let session = torrent.session.clone();
    let tests = torrent.tests.clone();
    let generation = tests.generation.load(Ordering::SeqCst);
    let budget = Duration::from_secs(seconds.clamp(3, 30));
    let mut seen = HashSet::new();
    let jobs: Vec<_> = magnets
        .into_iter()
        .filter_map(|magnet| {
            let id = Magnet::parse(&magnet).ok()?.as_id20()?;
            seen.insert(id).then(|| (id, magnet))
        })
        .map(|(id, magnet)| {
            let session = session.clone();
            let tests = tests.clone();
            async move {
                let result = test_swarm(session, tests, generation, magnet, id, budget).await;
                (id.as_string(), result)
            }
        })
        .collect();
    let results: HashMap<String, SwarmTestResult> = futures_util::future::join_all(jobs).await.into_iter().collect();
    let working = results.values().filter(|result| result.peers > 0).count();
    vlog_debug!("[torrent] Swarm test: {}/{} releases connected to peers", working, results.len());
    Ok(results)
}

/// Keeps a tested release in the session: it is about to be played.
#[tauri::command]
pub fn claim_swarm_test(state: tauri::State<'_, Option<TorrentState>>, info_hash: String) -> Result<(), String> {
    let torrent = torrent_state(&state)?;
    if let Ok(mut claimed) = torrent.tests.claimed.lock() {
        claimed.insert(info_hash.to_lowercase());
    }
    Ok(())
}

/// Stops the tests in flight; their releases are removed.
#[tauri::command]
pub fn cancel_swarm_tests(state: tauri::State<'_, Option<TorrentState>>) -> Result<(), String> {
    let torrent = torrent_state(&state)?;
    torrent.tests.generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
