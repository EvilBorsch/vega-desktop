# Russian torrent search — 2026-11-05

Android 5.3.0-fixes.17 (versionCode 227) and desktop 2.3.1 use the same source changes.

- Added the reachable public aggregators `jac.black`, `nmjc.duckdns.org` and `jac.stull.xyz`, alongside `jac.red`, `jacred.su` and `jacred.stream`.
- All six are queried through native JSON and Jackett JSON. The published public search keys for `jacred.stream` (`pp`) and `jac.stull.xyz` (`1`) are supplied to both APIs.
- Removed the currently unreachable `jacred.pro`, `jr.maxvol.pro` and `jacred.viewbox.dev` from automatic requests. These are third-party services; availability can change.
- JacBlack's comma-separated native tracker names are normalized. Its international indexes are labelled EN/JA as appropriate; Mazepa/Toloka defaults to UA.
- Identical info hashes retain the union of their language labels, including when merging into Torrentio. A stronger international seeder count no longer hides known Russian audio from the RU filter. Seeder counts, quality and playback links keep their existing selection rules.
- The overall 14-second search limit returns completed source groups. A slow source no longer erases every completed result. JacRed query groups also preserve completed answers when another mirror is slow. Late answers cannot mutate an already returned list.

## Verification

- TypeScript checks pass in both repositories.
- Android: 39 tests pass in `extraTorrentSources.test.ts` and `swarmHealth.test.ts`.
- Desktop: 4 tests pass in `extra-torrent-sources.test.mjs`, covering live API request construction with a mocked transport, public keys, offline mirrors, timeout preservation, language labels and deduplication.
- Live desktop search was checked for The Whale (2022), American Crime Story S03E08 and Breaking Bad S02E03. Both before/after runs used identical known Russian translations to isolate source retrieval; requests to the torrent sources were real. Results and per-host request status/timing are recorded in `D:/projects/vega-live-source-check.json`. More hashes became visible under RU after language merging; many new-server records overlap existing sources.
- Server discovery probes are in `D:/projects/vega-source-probe.json` and `D:/projects/vega-source-targets.json`.
- Alternative candidates: `ru.jac.black` and `jac-red.ru` failed TLS from this machine; `jac.maxvol.pro` answered Jackett searches but supplied no magnets in the checked results; TorAPI's public Vercel deployment returned HTTP 402 `DEPLOYMENT_DISABLED`. They were not enabled.
- This verifies source retrieval and release builds, not playback of every third-party torrent or on-device Android playback.

## References

- [JacRed source and documentation](https://github.com/jacred-fdb/jacred)
- [JacRed API contract](https://github.com/jacred-fdb/jacred/blob/main/docs/api-reference/overview.mdx)
- [Public parser configuration list used for discovery](https://gist.github.com/skv-s/162da674abd72f1dc0ef25cdcd80a890)
- [TorAPI](https://github.com/Lifailon/TorAPI)

## Local build artifacts

Android APK: `android/app/build/outputs/apk/release/vega-v5.3.0-fixes.17.apk` (ARM64 and ARMv7).
SHA-256: `053ac934bcc5905d8e3a4f4eb44591ea51d9596db21cec517f8501bab36ce450`.
APK Signature Scheme v2 verified; package `com.vega`, versionCode 227.

The local Windows build requires CMake and NASM on PATH and `LIBCLANG_PATH=D:/projects/tools/libclang`. It uses an external local Tauri config disabling updater signature artifacts, since this is an installed local build rather than an upstream OTA publication. The installed app's version and hashes are recorded in `D:/projects/vega-release-receipt-20261105.json`.
