// vega-torrentd: Vega Desktop's torrent engine, a libtorrent (the library behind
// qBittorrent) session behind a small HTTP API on 127.0.0.1.
//
// The API keeps the routes and JSON shapes Vega's frontend used with librqbit:
//   POST /torrents?overwrite=&timeout_ms=&initial_peers=&output_folder=&paused=   body: magnet
//   GET  /torrents[?with_stats=true]          GET /torrents/{hash}
//   GET  /torrents/{hash}/stats/v1            POST /torrents/{hash}/update_only_files
//   GET  /torrents/{hash}/stream/{file}[/name]  (HTTP Range)
//   POST /torrents/{hash}/pause|start|delete|forget
// plus source checks:
//   POST /swarm/probe   {hashes}   peers the DHT returns per release
//   POST /swarm/monitor {magnets}  POST /swarm/stats {hashes}
//   POST /swarm/stop    {hashes}   POST /swarm/claim {hash}
//
// Usage: vega-torrentd --dir <download dir> [--port 0] [--parent-pid N]
// Prints "PORT <n>" on stdout once it listens.

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#ifdef _WIN32
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/peer_info.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/version.hpp>

namespace lt = libtorrent;
namespace fs = std::filesystem;
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

// Added to every torrent: provider magnets often carry no trackers, and most
// Russian swarms are behind RuTracker's and Rutor's announce URLs.
const char* kTrackers[] = {
    "udp://tracker.opentrackr.org:1337/announce", "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce", "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce", "udp://explodie.org:6969/announce",
    "udp://open.tracker.cl:1337/announce", "udp://tracker.qu.ax:6969/announce",
    "udp://tracker.theoks.net:6969/announce", "udp://tracker.tryhackx.org:6969/announce",
    "udp://tracker-udp.gbitt.info:80/announce", "udp://tracker.gmi.gd:6969/announce",
    "http://tracker.dler.org:6969/announce", "udp://retracker01-msk-virt.corbina.net:80/announce",
    "udp://opentor.net:6969", "http://retracker.local/announce",
    "http://bt.t-ru.org/ann?magnet", "http://bt2.t-ru.org/ann?magnet",
};

// A source check downloads this much of the main video.
constexpr std::int64_t kTestBytes = 24LL * 1024 * 1024;
// Read-ahead of a stream: 1% of the file, between 16 and 256 MB; the first
// bytes of it get deadlines so playback does not wait on them.
constexpr std::int64_t kMinReadahead = 16LL * 1024 * 1024;
constexpr std::int64_t kMaxReadahead = 256LL * 1024 * 1024;
constexpr std::int64_t kCriticalBytes = 4LL * 1024 * 1024;

lt::session* g_session = nullptr;
std::string g_download_dir;
std::mutex g_mutex;              // guards the maps below
std::condition_variable g_wake;  // metadata or a piece arrived
std::map<std::string, int> g_ids;
int g_next_id = 0;

struct MonitorEntry {
  Clock::time_point added;
  bool owned = false;
  bool prepared = false;
  Clock::time_point metadata_at{};
  bool has_metadata = false;
  std::int64_t bytes_at_metadata = 0;
  std::int64_t bytes = 0;
  int max_rate = 0, max_peers = 0, max_seeds = 0, known = 0;
  std::vector<std::string> peer_list;
};
std::map<std::string, MonitorEntry> g_monitored;
std::set<std::string> g_claimed;
std::map<std::string, std::set<std::string>> g_probe;  // hash -> DHT peers seen

std::string to_hex(const lt::sha1_hash& h) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  for (auto byte : h) {
    auto b = static_cast<unsigned char>(byte);
    out += digits[b >> 4];
    out += digits[b & 15];
  }
  return out;
}

bool from_hex(const std::string& hex, lt::sha1_hash& out) {
  if (hex.size() != 40) return false;
  auto value = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (int i = 0; i < 20; ++i) {
    int hi = value(hex[2 * i]), lo = value(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<char>((hi << 4) | lo);
  }
  return true;
}

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

lt::torrent_handle find(const std::string& hash) {
  lt::sha1_hash h;
  if (!from_hex(hash, h)) return {};
  auto handle = g_session->find_torrent(h);
  return handle.is_valid() ? handle : lt::torrent_handle{};
}

int id_of(const std::string& hash) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_ids.find(hash);
  if (it != g_ids.end()) return it->second;
  return g_ids[hash] = g_next_id++;
}

// The id the frontend may send instead of a hash.
std::string hash_of(const std::string& key) {
  if (key.size() == 40) return lower(key);
  std::lock_guard<std::mutex> lock(g_mutex);
  for (auto& [hash, id] : g_ids)
    if (std::to_string(id) == key) return hash;
  return lower(key);
}

json file_list(const lt::torrent_handle& h) {
  json files = json::array();
  auto ti = h.torrent_file();
  if (!ti) return files;
  const auto& fs_ = ti->layout();
  auto priorities = h.get_file_priorities();
  for (lt::file_index_t i{0}; i < fs_.end_file(); ++i) {
    std::string path = fs_.file_path(i);
    std::replace(path.begin(), path.end(), '\\', '/');
    json components = json::array();
    std::stringstream parts(path);
    for (std::string part; std::getline(parts, part, '/');) components.push_back(part);
    int index = static_cast<int>(i);
    bool included = index < static_cast<int>(priorities.size()) ? priorities[index] != lt::dont_download : true;
    files.push_back({{"name", path}, {"components", components}, {"length", fs_.file_size(i)}, {"included", included}});
  }
  return files;
}

json details(const lt::torrent_handle& h) {
  auto st = h.status(lt::torrent_handle::query_name);
  return {{"info_hash", to_hex(st.info_hashes.v1)}, {"name", st.name}, {"files", file_list(h)}};
}

json stats(const lt::torrent_handle& h) {
  auto st = h.status();
  std::string state = "live";
  if (st.errc) state = "error";
  else if (st.flags & lt::torrent_flags::paused) state = "paused";
  else if (st.state == lt::torrent_status::checking_files || st.state == lt::torrent_status::checking_resume_data)
    state = "initializing";
  double mbps = st.download_payload_rate / 1048576.0;
  double up = st.upload_payload_rate / 1048576.0;
  char human[32];
  std::snprintf(human, sizeof human, "%.2f MiB/s", mbps);
  return {
      {"state", state},
      {"error", st.errc ? json(st.errc.message()) : json(nullptr)},
      {"progress_bytes", st.total_wanted_done},
      {"total_bytes", st.total_wanted},
      {"uploaded_bytes", st.all_time_upload},
      {"finished", st.is_finished},
      {"live",
       {{"snapshot",
         {{"fetched_bytes", st.total_payload_download},
          {"downloaded_and_checked_bytes", st.total_done},
          {"peer_stats",
           {{"live", st.num_peers},
            {"seeds", st.num_seeds},
            {"seen", st.list_peers},
            {"connecting", std::max(0, st.num_connections - st.num_peers)},
            {"queued", 0},
            {"dead", 0}}}}},
        {"download_speed", {{"mbps", mbps}, {"human_readable", human}}},
        {"upload_speed", {{"mbps", up}}}}},
  };
}

lt::add_torrent_params magnet_params(const std::string& magnet, lt::error_code& ec) {
  auto params = lt::parse_magnet_uri(magnet, ec);
  if (ec) return params;
  for (const char* tracker : kTrackers) params.trackers.emplace_back(tracker);
  params.save_path = g_download_dir;
  // Streams are not queued behind other torrents (libtorrent's default of 3
  // active downloads parked new sources at 0 B/s).
  params.flags &= ~lt::torrent_flags::auto_managed;
  params.flags &= ~lt::torrent_flags::paused;
  return params;
}

// Waits until the torrent has its info, or the timeout passes.
bool wait_metadata(const lt::torrent_handle& h, int timeout_ms) {
  auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  std::unique_lock<std::mutex> lock(g_mutex);
  while (Clock::now() < deadline) {
    if (!h.is_valid()) return false;
    if (h.status(lt::status_flags_t{}).has_metadata) return true;
    g_wake.wait_for(lock, std::chrono::milliseconds(250));
  }
  return h.is_valid() && h.status(lt::status_flags_t{}).has_metadata;
}

std::string content_type(const std::string& name) {
  auto ext = lower(fs::path(name).extension().string());
  if (ext == ".mp4" || ext == ".m4v") return "video/mp4";
  if (ext == ".mkv") return "video/x-matroska";
  if (ext == ".webm") return "video/webm";
  if (ext == ".avi") return "video/x-msvideo";
  if (ext == ".ts" || ext == ".m2ts") return "video/mp2t";
  if (ext == ".mov") return "video/quicktime";
  return "application/octet-stream";
}

// Puts the pieces right after the reader first: the next few with deadlines
// sized to playback, the rest of the read-ahead at top priority.
void prefetch(const lt::torrent_handle& h, int current, std::int64_t file_size) {
  auto ti = h.torrent_file();
  if (!ti) return;
  std::int64_t piece_length = ti->piece_length();
  std::int64_t readahead = std::clamp(file_size / 100, kMinReadahead, kMaxReadahead);
  int count = static_cast<int>((readahead + piece_length - 1) / piece_length);
  int critical = static_cast<int>(std::max<std::int64_t>(2, kCriticalBytes / piece_length));
  for (int i = 1; i <= count; ++i) {
    lt::piece_index_t next{current + i};
    if (next >= ti->end_piece()) break;
    if (h.have_piece(next)) continue;
    h.piece_priority(next, lt::top_priority);
    if (i <= critical) h.set_piece_deadline(next, 800 + i * 400);
  }
}

// Blocks until a piece is on disk, nudging its deadline; false if the reader
// went away or the torrent was removed.
bool wait_piece(const lt::torrent_handle& h, lt::piece_index_t piece, const std::function<bool()>& still_wanted) {
  int rounds = 0;
  std::unique_lock<std::mutex> lock(g_mutex);
  while (true) {
    if (!h.is_valid()) return false;
    if (h.have_piece(piece)) return true;
    if (!still_wanted()) return false;
    if (rounds++ % 20 == 0) {
      h.piece_priority(piece, lt::top_priority);
      h.set_piece_deadline(piece, 500);
    }
    g_wake.wait_for(lock, std::chrono::milliseconds(250));
  }
}

void serve_stream(const httplib::Request& req, httplib::Response& res, const std::string& hash, int file) {
  auto h = find(hash);
  if (!h.is_valid()) {
    res.status = 404;
    res.set_content("Torrent not found", "text/plain");
    return;
  }
  auto ti = h.torrent_file();
  if (!ti || file < 0 || file >= ti->num_files()) {
    res.status = 404;
    res.set_content("File not found", "text/plain");
    return;
  }
  lt::file_index_t index{file};
  const auto& files = ti->layout();
  std::int64_t size = files.file_size(index);
  std::int64_t offset_in_torrent = files.file_offset(index);
  std::string path = (fs::u8path(h.status(lt::torrent_handle::query_save_path).save_path) / fs::u8path(files.file_path(index))).string();
  // The file must download: a skipped file lives in libtorrent's part file.
  if (h.file_priority(index) == lt::dont_download) h.file_priority(index, lt::default_priority);
  std::int64_t piece_length = ti->piece_length();

  res.set_header("Accept-Ranges", "bytes");
  res.set_content_provider(
      static_cast<size_t>(size), content_type(path),
      [h, path, size, offset_in_torrent, piece_length](size_t offset, size_t length, httplib::DataSink& sink) {
        std::ifstream in;
        std::vector<char> buffer;
        std::int64_t position = static_cast<std::int64_t>(offset);
        std::int64_t end = std::min<std::int64_t>(size, position + static_cast<std::int64_t>(length));
        while (position < end) {
          auto piece = static_cast<int>((offset_in_torrent + position) / piece_length);
          if (!h.have_piece(lt::piece_index_t{piece})) {
            h.piece_priority(lt::piece_index_t{piece}, lt::top_priority);
            h.set_piece_deadline(lt::piece_index_t{piece}, 300);
            prefetch(h, piece, size);
            if (!wait_piece(h, lt::piece_index_t{piece}, [&sink] { return sink.is_writable(); })) return false;
          }
          prefetch(h, piece, size);
          std::int64_t piece_end = (static_cast<std::int64_t>(piece) + 1) * piece_length - offset_in_torrent;
          std::int64_t chunk = std::min(end, piece_end) - position;
          if (!in.is_open()) {
            in.open(fs::u8path(path), std::ios::binary);
            if (!in) {
              // libtorrent creates the file with its first piece; wait briefly.
              std::this_thread::sleep_for(std::chrono::milliseconds(200));
              in.clear();
              in.open(fs::u8path(path), std::ios::binary);
              if (!in) return false;
            }
          }
          buffer.resize(static_cast<size_t>(chunk));
          in.clear();
          in.seekg(position);
          in.read(buffer.data(), chunk);
          auto got = in.gcount();
          if (got <= 0) {
            // Written but not yet visible through this handle: reopen and retry.
            in.close();
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
          }
          if (!sink.write(buffer.data(), static_cast<size_t>(got))) return false;
          position += got;
        }
        return true;
      });
}

// --- source checks ---------------------------------------------------------

void prioritize_test_pieces(const lt::torrent_handle& h) {
  auto ti = h.torrent_file();
  if (!ti) return;
  const auto& files = ti->layout();
  lt::file_index_t largest{0};
  for (lt::file_index_t i{0}; i < files.end_file(); ++i)
    if (files.file_size(i) > files.file_size(largest)) largest = i;
  std::int64_t piece_length = ti->piece_length();
  int first = static_cast<int>(files.file_offset(largest) / piece_length);
  int count = static_cast<int>(std::max<std::int64_t>(2, (kTestBytes + piece_length - 1) / piece_length));
  std::vector<lt::download_priority_t> priorities(static_cast<size_t>(ti->num_pieces()), lt::dont_download);
  for (int i = first; i < std::min(ti->num_pieces(), first + count); ++i) priorities[static_cast<size_t>(i)] = lt::top_priority;
  h.prioritize_pieces(priorities);
}

json monitor_stats(const std::vector<std::string>& hashes) {
  json out = json::object();
  auto now = Clock::now();
  for (const auto& raw : hashes) {
    std::string hash = lower(raw);
    MonitorEntry entry;
    bool prepare = false;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto it = g_monitored.find(hash);
      if (it == g_monitored.end()) continue;
      entry = it->second;
    }
    int peers_now = 0, seeds_now = 0, rate = 0;
    auto h = find(hash);
    if (h.is_valid()) {
      auto st = h.status();
      entry.known = std::max(entry.known, st.list_peers);
      if (st.has_metadata) {
        if (!entry.has_metadata) {
          entry.has_metadata = true;
          entry.metadata_at = now;
          entry.bytes_at_metadata = st.total_payload_download;
        }
        if (entry.owned && !entry.prepared) {
          std::lock_guard<std::mutex> lock(g_mutex);
          if (!g_claimed.count(hash)) prepare = true;
        }
        entry.bytes = std::max<std::int64_t>(0, st.total_payload_download - entry.bytes_at_metadata);
        rate = st.download_payload_rate;
        entry.max_rate = std::max(entry.max_rate, rate);
      }
      std::vector<lt::peer_info> peers;
      h.get_peer_info(peers);
      peers_now = static_cast<int>(peers.size());
      for (const auto& peer : peers) {
        if (peer.flags & lt::peer_info::seed) ++seeds_now;
        if (entry.peer_list.size() < 40) {
          std::string address = peer.remote_endpoint().address().to_string();
          std::string endpoint = peer.remote_endpoint().address().is_v6() ? "[" + address + "]:" + std::to_string(peer.remote_endpoint().port())
                                                           : address + ":" + std::to_string(peer.remote_endpoint().port());
          if (std::find(entry.peer_list.begin(), entry.peer_list.end(), endpoint) == entry.peer_list.end())
            entry.peer_list.push_back(endpoint);
        }
      }
      entry.max_peers = std::max(entry.max_peers, peers_now);
      entry.max_seeds = std::max(entry.max_seeds, seeds_now);
      if (prepare) {
        entry.prepared = true;
        prioritize_test_pieces(h);
      }
    }
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto it = g_monitored.find(hash);
      if (it == g_monitored.end()) continue;
      it->second = entry;
    }
    auto ms = [](Clock::duration d) { return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(d).count()); };
    out[hash] = {
        {"metadata", entry.has_metadata},
        {"elapsedMs", ms(now - entry.added)},
        {"dataMs", entry.has_metadata ? ms(now - entry.metadata_at) : 0.0},
        {"bytes", entry.bytes},
        {"rate", rate},
        {"maxRate", entry.max_rate},
        {"peers", peers_now},
        {"seeds", seeds_now},
        {"maxPeers", entry.max_peers},
        {"maxSeeds", entry.max_seeds},
        {"known", entry.known},
        {"done", entry.bytes >= kTestBytes * 95 / 100},
        {"peerList", entry.peer_list},
    };
  }
  return out;
}

void alert_loop(std::atomic<bool>& running) {
  while (running) {
    g_session->wait_for_alert(std::chrono::milliseconds(500));
    std::vector<lt::alert*> alerts;
    g_session->pop_alerts(&alerts);
    bool wake = false;
    for (auto* a : alerts) {
      if (lt::alert_cast<lt::metadata_received_alert>(a) || lt::alert_cast<lt::piece_finished_alert>(a) ||
          lt::alert_cast<lt::add_torrent_alert>(a) || lt::alert_cast<lt::torrent_removed_alert>(a)) {
        wake = true;
      } else if (auto* reply = lt::alert_cast<lt::dht_get_peers_reply_alert>(a)) {
        std::string hash = to_hex(reply->info_hash);
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_probe.find(hash);
        if (it != g_probe.end())
          for (const auto& peer : reply->peers()) it->second.insert(peer.address().to_string() + ":" + std::to_string(peer.port()));
      }
    }
    if (wake) g_wake.notify_all();
  }
}

// --- live seeder counts: UDP tracker scrape (BEP 15) -------------------------
// Index snapshots are often months old; public trackers answer for up to 74
// releases per packet in about a second.
const char* kScrapeTrackers[][2] = {
    {"tracker.opentrackr.org", "1337"}, {"open.stealth.si", "80"},      {"tracker.torrent.eu.org", "451"},
    {"exodus.desync.com", "6969"},      {"open.demonii.com", "1337"},   {"tracker.qu.ax", "6969"},
    {"opentor.net", "6969"},            {"retracker01-msk-virt.corbina.net", "80"},
};

struct Scrape {
  int seeders = 0, leechers = 0;
};

void put32(std::vector<unsigned char>& out, std::uint32_t v) {
  for (int i = 3; i >= 0; --i) out.push_back(static_cast<unsigned char>(v >> (8 * i)));
}
std::uint32_t get32(const unsigned char* p) {
  return (std::uint32_t(p[0]) << 24) | (std::uint32_t(p[1]) << 16) | (std::uint32_t(p[2]) << 8) | p[3];
}

#ifdef _WIN32
using socket_t = SOCKET;
void close_socket(socket_t s) { closesocket(s); }
const socket_t kNoSocket = INVALID_SOCKET;
#else
using socket_t = int;
void close_socket(socket_t s) { close(s); }
const socket_t kNoSocket = -1;
#endif

// One tracker: connect, then scrape the hashes in packets of 70.
std::map<std::string, Scrape> scrape_tracker(const char* host, const char* port, const std::vector<std::string>& hashes) {
  std::map<std::string, Scrape> out;
  addrinfo hints{}, *addr = nullptr;
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  if (getaddrinfo(host, port, &hints, &addr) != 0 || !addr) return out;
  socket_t sock = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
  if (sock == kNoSocket) {
    freeaddrinfo(addr);
    return out;
  }
#ifdef _WIN32
  DWORD timeout = 2500;
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof timeout);
#else
  timeval timeout{2, 500000};
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
#endif
  auto exchange = [&](const std::vector<unsigned char>& request, unsigned char* reply, int size) {
    if (sendto(sock, reinterpret_cast<const char*>(request.data()), static_cast<int>(request.size()), 0, addr->ai_addr,
               static_cast<int>(addr->ai_addrlen)) < 0)
      return -1;
    return static_cast<int>(recv(sock, reinterpret_cast<char*>(reply), size, 0));
  };
  std::uint32_t transaction = static_cast<std::uint32_t>(Clock::now().time_since_epoch().count());
  std::vector<unsigned char> connect;
  put32(connect, 0x417);
  put32(connect, 0x27101980);
  put32(connect, 0);  // connect
  put32(connect, transaction);
  unsigned char reply[2048];
  int got = exchange(connect, reply, sizeof reply);
  if (got >= 16 && get32(reply) == 0 && get32(reply + 4) == transaction) {
    std::vector<unsigned char> connection(reply + 8, reply + 16);
    for (size_t start = 0; start < hashes.size(); start += 70) {
      size_t end = std::min(hashes.size(), start + 70);
      std::vector<unsigned char> request(connection);
      put32(request, 2);  // scrape
      put32(request, ++transaction);
      for (size_t i = start; i < end; ++i) {
        lt::sha1_hash h;
        if (!from_hex(hashes[i], h)) h.clear();
        request.insert(request.end(), h.begin(), h.end());
      }
      got = exchange(request, reply, sizeof reply);
      if (got < 8 || get32(reply) != 2 || get32(reply + 4) != transaction) break;
      for (size_t i = start; i < end && 8 + (i - start + 1) * 12 <= static_cast<size_t>(got); ++i) {
        const unsigned char* entry = reply + 8 + (i - start) * 12;
        out[hashes[i]] = {static_cast<int>(get32(entry)), static_cast<int>(get32(entry + 8))};
      }
    }
  }
  close_socket(sock);
  freeaddrinfo(addr);
  return out;
}

json scrape(const std::vector<std::string>& hashes) {
  std::vector<std::map<std::string, Scrape>> answers(std::size(kScrapeTrackers));
  std::vector<std::thread> threads;
  for (size_t i = 0; i < std::size(kScrapeTrackers); ++i)
    threads.emplace_back([&, i] { answers[i] = scrape_tracker(kScrapeTrackers[i][0], kScrapeTrackers[i][1], hashes); });
  for (auto& thread : threads) thread.join();
  json out = json::object();
  for (const auto& hash : hashes) {
    Scrape best;
    int trackers = 0;
    for (const auto& answer : answers) {
      auto it = answer.find(hash);
      if (it == answer.end()) continue;
      ++trackers;
      best.seeders = std::max(best.seeders, it->second.seeders);
      best.leechers = std::max(best.leechers, it->second.leechers);
    }
    if (trackers) out[hash] = {{"seeders", best.seeders}, {"leechers", best.leechers}, {"trackers", trackers}};
  }
  return out;
}

json parse_body(const httplib::Request& req) {
  try {
    return json::parse(req.body);
  } catch (...) {
    return json::object();
  }
}

}  // namespace

int main(int argc, char** argv) {
  int port = 0;
  unsigned long parent_pid = 0;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string key = argv[i];
    if (key == "--dir") g_download_dir = argv[i + 1];
    else if (key == "--port") port = std::atoi(argv[i + 1]);
    else if (key == "--parent-pid") parent_pid = std::strtoul(argv[i + 1], nullptr, 10);
  }
  if (g_download_dir.empty()) g_download_dir = (fs::temp_directory_path() / "vega-torrents").string();
  std::error_code fs_error;
  fs::create_directories(fs::u8path(g_download_dir), fs_error);

  lt::settings_pack pack;
  pack.set_str(lt::settings_pack::user_agent, "Vega/2.3 libtorrent/2.0");
  pack.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:0,[::]:0");
  pack.set_str(lt::settings_pack::dht_bootstrap_nodes,
               "router.bittorrent.com:6881,dht.transmissionbt.com:6881,router.utorrent.com:6881,dht.libtorrent.org:25401");
  pack.set_bool(lt::settings_pack::enable_dht, true);
  pack.set_bool(lt::settings_pack::enable_lsd, true);
  pack.set_bool(lt::settings_pack::enable_upnp, true);
  pack.set_bool(lt::settings_pack::enable_natpmp, true);
  // The Android app's settings (measured on the same PC: 116-117 peers, 15-25 MB/s).
  pack.set_int(lt::settings_pack::piece_timeout, 12);
  pack.set_int(lt::settings_pack::request_timeout, 25);
  pack.set_int(lt::settings_pack::peer_connect_timeout, 7);
  pack.set_int(lt::settings_pack::max_out_request_queue, 1500);
  pack.set_int(lt::settings_pack::active_downloads, 12);
  pack.set_int(lt::settings_pack::active_limit, 30);
  pack.set_int(lt::settings_pack::dht_upload_rate_limit, 64000);
  pack.set_int(lt::settings_pack::torrent_connect_boost, 60);
  pack.set_int(lt::settings_pack::connection_speed, 60);
  pack.set_bool(lt::settings_pack::strict_end_game_mode, false);
  pack.set_bool(lt::settings_pack::announce_to_all_trackers, true);
  pack.set_bool(lt::settings_pack::announce_to_all_tiers, true);
  pack.set_int(lt::settings_pack::alert_mask, lt::alert_category::status | lt::alert_category::error |
                                                  lt::alert_category::piece_progress | lt::alert_category::dht_operation);
  lt::session session(pack);
  g_session = &session;

  std::atomic<bool> running{true};
  std::thread alerts([&running] { alert_loop(running); });

  httplib::Server server;
  server.new_task_queue = [] { return new httplib::ThreadPool(32); };

  server.Post("/torrents", [](const httplib::Request& req, httplib::Response& res) {
    std::string magnet = req.body;
    magnet.erase(magnet.find_last_not_of(" \r\n\t") + 1);
    if (magnet.rfind("magnet:", 0) != 0) {
      res.status = 400;
      res.set_content("Only magnet links are supported", "text/plain");
      return;
    }
    lt::error_code ec;
    auto params = magnet_params(magnet, ec);
    if (ec) {
      res.status = 400;
      res.set_content("Invalid magnet: " + ec.message(), "text/plain");
      return;
    }
    if (req.has_param("output_folder")) params.save_path = req.get_param_value("output_folder");
    if (req.get_param_value("paused") == "true") params.flags |= lt::torrent_flags::paused;
    if (req.has_param("initial_peers")) {
      std::stringstream list(req.get_param_value("initial_peers"));
      for (std::string peer; std::getline(list, peer, ',');) {
        auto colon = peer.rfind(':');
        if (colon == std::string::npos) continue;
        std::string host = peer.substr(0, colon);
        if (!host.empty() && host.front() == '[') host = host.substr(1, host.size() - 2);
        lt::error_code peer_error;
        auto address = lt::make_address(host, peer_error);
        if (!peer_error) params.peers.emplace_back(address, static_cast<unsigned short>(std::atoi(peer.c_str() + colon + 1)));
      }
    }
    std::string hash = to_hex(params.info_hashes.v1);
    auto handle = find(hash);
    if (handle.is_valid()) {
      bool claimed;
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        claimed = g_claimed.count(hash) > 0;
      }
      // A source check let only its first megabytes download: the player needs it all.
      if (claimed) {
        if (auto ti = handle.torrent_file())
          handle.prioritize_pieces(std::vector<lt::download_priority_t>(static_cast<size_t>(ti->num_pieces()), lt::default_priority));
      }
      handle.unset_flags(lt::torrent_flags::auto_managed);
      if (!(params.flags & lt::torrent_flags::paused)) handle.resume();
    } else {
      handle = g_session->add_torrent(std::move(params), ec);
      if (ec) {
        res.status = 400;
        res.set_content("Could not add the torrent: " + ec.message(), "text/plain");
        return;
      }
    }
    int timeout = req.has_param("timeout_ms") ? std::atoi(req.get_param_value("timeout_ms").c_str()) : 30000;
    if (!wait_metadata(handle, timeout)) {
      // The torrent keeps looking for peers; a new attempt asks trackers again.
      handle.force_reannounce();
      handle.force_dht_announce();
      res.status = 408;
      res.set_content("Timed out waiting for the torrent info", "text/plain");
      return;
    }
    json body = {{"id", id_of(hash)}, {"details", details(handle)}, {"output_folder", handle.status(lt::torrent_handle::query_save_path).save_path}, {"seen_peers", json::array()}};
    res.set_content(body.dump(), "application/json");
  });

  server.Get("/torrents", [](const httplib::Request& req, httplib::Response& res) {
    bool with_stats = req.get_param_value("with_stats") == "true";
    json list = json::array();
    for (const auto& h : g_session->get_torrents()) {
      std::string hash = to_hex(h.info_hashes().v1);
      json item = {{"id", id_of(hash)}, {"info_hash", hash}, {"name", h.status(lt::torrent_handle::query_name).name}};
      if (with_stats) item["stats"] = stats(h);
      list.push_back(item);
    }
    res.set_content(json{{"torrents", list}}.dump(), "application/json");
  });

  server.Get(R"(/torrents/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    auto h = find(hash_of(req.matches[1]));
    if (!h.is_valid()) return void(res.status = 404);
    res.set_content(details(h).dump(), "application/json");
  });

  server.Get(R"(/torrents/([^/]+)/stats/v1)", [](const httplib::Request& req, httplib::Response& res) {
    auto h = find(hash_of(req.matches[1]));
    if (!h.is_valid()) return void(res.status = 404);
    res.set_content(stats(h).dump(), "application/json");
  });

  server.Post(R"(/torrents/([^/]+)/update_only_files)", [](const httplib::Request& req, httplib::Response& res) {
    auto h = find(hash_of(req.matches[1]));
    auto ti = h.is_valid() ? h.torrent_file() : nullptr;
    if (!ti) return void(res.status = 404);
    auto body = parse_body(req);
    std::vector<lt::download_priority_t> priorities(static_cast<size_t>(ti->num_files()), lt::dont_download);
    for (const auto& index : body.value("only_files", json::array()))
      if (index.is_number_integer() && index.get<int>() >= 0 && index.get<int>() < ti->num_files())
        priorities[static_cast<size_t>(index.get<int>())] = lt::default_priority;
    h.prioritize_files(priorities);
    res.set_content("{}", "application/json");
  });

  auto stream = [](const httplib::Request& req, httplib::Response& res) {
    serve_stream(req, res, hash_of(req.matches[1]), std::atoi(std::string(req.matches[2]).c_str()));
  };
  server.Get(R"(/torrents/([^/]+)/stream/(\d+)(?:/.*)?)", stream);

  auto action = [](const std::string& name) {
    return [name](const httplib::Request& req, httplib::Response& res) {
      std::string hash = hash_of(req.matches[1]);
      auto h = find(hash);
      if (!h.is_valid()) return void(res.status = 404);
      if (name == "pause") {
        h.unset_flags(lt::torrent_flags::auto_managed);
        h.pause();
      } else if (name == "start") {
        h.unset_flags(lt::torrent_flags::auto_managed);
        h.resume();
      } else {
        g_session->remove_torrent(h, name == "delete" ? lt::session::delete_files : lt::remove_flags_t{});
        std::lock_guard<std::mutex> lock(g_mutex);
        g_claimed.erase(hash);
      }
      res.set_content("{}", "application/json");
    };
  };
  for (const char* name : {"pause", "start", "delete", "forget"})
    server.Post(std::string(R"(/torrents/([^/]+)/)") + name, action(name));

  server.Post("/swarm/probe", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    std::vector<std::string> hashes;
    for (const auto& item : body.value("hashes", json::array()))
      if (item.is_string()) hashes.push_back(lower(item.get<std::string>()));
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      for (const auto& hash : hashes) g_probe[hash];
    }
    for (int round = 0; round < 2; ++round) {
      for (const auto& hash : hashes) {
        lt::sha1_hash id;
        if (from_hex(hash, id)) g_session->dht_get_peers(id);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(3000));
    }
    json out = json::object();
    std::lock_guard<std::mutex> lock(g_mutex);
    for (const auto& hash : hashes) {
      out[hash] = g_probe[hash].size();
      g_probe.erase(hash);
    }
    res.set_content(out.dump(), "application/json");
  });

  server.Post("/swarm/scrape", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    std::vector<std::string> hashes;
    for (const auto& item : body.value("hashes", json::array()))
      if (item.is_string() && item.get<std::string>().size() == 40) hashes.push_back(lower(item.get<std::string>()));
    res.set_content(scrape(hashes).dump(), "application/json");
  });

  server.Post("/swarm/monitor", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    for (const auto& item : body.value("magnets", json::array())) {
      if (!item.is_string()) continue;
      lt::error_code ec;
      auto params = magnet_params(item.get<std::string>(), ec);
      if (ec) continue;
      std::string hash = to_hex(params.info_hashes.v1);
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (g_monitored.count(hash)) continue;
      }
      // A release already in the session (playing) is measured as it is.
      bool present = find(hash).is_valid();
      if (!present) g_session->add_torrent(std::move(params), ec);
      MonitorEntry entry;
      entry.added = Clock::now();
      entry.owned = !present && !ec;
      std::lock_guard<std::mutex> lock(g_mutex);
      g_monitored[hash] = entry;
    }
    res.set_content("{}", "application/json");
  });

  server.Post("/swarm/stats", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    std::vector<std::string> hashes;
    for (const auto& item : body.value("hashes", json::array()))
      if (item.is_string()) hashes.push_back(item.get<std::string>());
    res.set_content(monitor_stats(hashes).dump(), "application/json");
  });

  server.Post("/swarm/stop", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    for (const auto& item : body.value("hashes", json::array())) {
      if (!item.is_string()) continue;
      std::string hash = lower(item.get<std::string>());
      bool owned = false, claimed = false;
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_monitored.find(hash);
        if (it == g_monitored.end()) continue;
        owned = it->second.owned;
        claimed = g_claimed.count(hash) > 0;
        g_monitored.erase(it);
      }
      if (owned && !claimed) {
        auto h = find(hash);
        if (h.is_valid()) g_session->remove_torrent(h, lt::session::delete_files);
      }
    }
    res.set_content("{}", "application/json");
  });

  server.Post("/swarm/claim", [](const httplib::Request& req, httplib::Response& res) {
    auto body = parse_body(req);
    std::string hash = lower(body.value("hash", std::string()));
    if (!hash.empty()) {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_claimed.insert(hash);
    }
    res.set_content("{}", "application/json");
  });

  server.Get("/", [](const httplib::Request&, httplib::Response& res) {
    res.set_content(R"({"engine":"libtorrent","version":")" LIBTORRENT_VERSION R"("})", "application/json");
  });

  // The web player reads streams with fetch and needs the range headers.
  server.set_default_headers({{"Access-Control-Allow-Origin", "*"},
                              {"Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges"}});
  server.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
    res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Range");
  });

  int bound = port > 0 ? (server.bind_to_port("127.0.0.1", port) ? port : -1) : server.bind_to_any_port("127.0.0.1");
  if (bound <= 0) {
    std::fprintf(stderr, "Could not listen on 127.0.0.1\n");
    return 1;
  }
  std::printf("PORT %d\n", bound);
  std::fflush(stdout);

#ifdef _WIN32
  // Exit with the app, so no torrent keeps downloading after Vega closed.
  if (parent_pid) {
    std::thread([parent_pid, &server] {
      HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(parent_pid));
      if (!parent) return;
      WaitForSingleObject(parent, INFINITE);
      CloseHandle(parent);
      server.stop();
    }).detach();
  }
#endif

  server.listen_after_bind();
  running = false;
  alerts.join();
  // Streams are a cache: what Vega played is removed with the session.
  for (const auto& h : g_session->get_torrents()) {
    if (h.status(lt::torrent_handle::query_save_path).save_path == g_download_dir) g_session->remove_torrent(h, lt::session::delete_files);
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  return 0;
}
