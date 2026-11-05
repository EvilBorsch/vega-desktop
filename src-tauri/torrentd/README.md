# vega-torrentd

Vega Desktop's torrent engine: [libtorrent](https://libtorrent.org) (the library behind qBittorrent) in its own process, with an HTTP API on 127.0.0.1. The app starts it at launch (`src-tauri/src/torrent.rs`) and the frontend talks to it directly (`src/lib/services/torrentStreamService.ts`, `src/lib/services/torrentEngine.ts`).

It replaced librqbit after a comparison on one PC with the same releases and trackers: libtorrent connected to 77–117 peers at 14–25 MB/s where librqbit connected to 1 at up to 3.9 MB/s.

## API

| Route | Use |
|---|---|
| `POST /torrents?timeout_ms=&initial_peers=&output_folder=&paused=` (body: magnet) | add, wait for the torrent info; `{id, details: {info_hash, name, files}}` |
| `GET /torrents[?with_stats=true]`, `GET /torrents/{hash}` | list, details |
| `GET /torrents/{hash}/stats/v1` | state, progress, peers, speed (librqbit's shape) |
| `POST /torrents/{hash}/update_only_files` `{only_files: [i]}` | file selection |
| `GET /torrents/{hash}/stream/{file}[/name]` | the file over HTTP with Range; pieces ahead of the reader get deadlines |
| `POST /torrents/{hash}/pause\|start\|delete\|forget` | |
| `POST /swarm/probe {hashes}` | peers the DHT returns per release |
| `POST /swarm/monitor {magnets}`, `/swarm/stats {hashes}`, `/swarm/stop {hashes}`, `/swarm/claim {hash}` | the source list's speed check |

## Build (Windows)

Visual Studio 2022 Build Tools with C++ (its bundled vcpkg and CMake are used):

```powershell
powershell -ExecutionPolicy Bypass -File src-tauri/torrentd/build.ps1
```

The first build compiles libtorrent, Boost and OpenSSL with vcpkg (about an hour). The result, a single static exe, is copied to `src-tauri/resources/torrentd/vega-torrentd.exe` and bundled with the app. Other platforms build the same `main.cpp` with CMake against libtorrent-rasterbar 2.x, cpp-httplib and nlohmann-json.
