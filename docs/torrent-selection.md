# Torrent selection — Android fixes.18 / desktop 2.3.2

## Selection behavior

1. Query current tracker counts for unique torrent identities. The successful response replaces older advertised seed/leech counts, including a response of zero. Missing responses retain provider metadata as a fallback.
2. Wait for the initial count/availability check before starting bandwidth measurements. Prioritize releases matching the selected filters, ordered by swarm activity; continue through the rest of the available catalog in the background.
3. Measure up to six active releases concurrently. A stalled release can remain monitored while another gets a slot, with sixteen monitors at most. A completed measurement frees its slot for the next candidate.
4. Re-sort matching cards by measured speed as results arrive. The top card is the fastest suitable release measured so far; later results can promote another card. Progress covers the whole measurement queue.
5. Every untouched release gets its first attempt before failed retries or expired earlier results. There is no first-24 cutoff. A monitor missing from native statistics has a wall-clock deadline, and a failed start is reported as an unavailable check. Neither case can occupy the queue indefinitely or pretend to prove there are no peers.
6. Serialize monitor/stop operations so a delayed cleanup cannot stop the monitors of a reopened picker.

An empty public DHT lookup does not discard an unmeasured release: other trackers may have peers. Releases previously marked dead by actual playback remain accessible through the existing hidden-source control.

## Identity and labels

- Different torrent hashes remain separate even if film title, filename, size and quality coincide. This preserves independent releases and their measurements.
- Exact aliases of one v1 torrent share one check and one card. Hex, percent-encoded and Base32 magnet identities normalize to the same hash. Direct/debrid links remain distinct.
- Same-hash merges retain tracker and `x.pe` addresses from every mirror, audio labels, primary playback fields and details split across `tag` / `tags`.
- Historical `≈… seeders / peers (date)` badges are hidden, including provider/cached entries. Current live counts, measured peer counts and speed remain visible.

## Verification

The focused Android tests cover a real hook traversing a 35-release fixture, promotion of the fastest final release, one check per identity, current-count gating with a real QueryClient, expired-result fairness, missing samples, start errors and delayed stop/reopen behavior. Desktop tests cover the matching pure identity, ordering, count replacement and badge contracts. Two read-only reviews were performed; their metadata/fairness/lifecycle findings have regression tests and fixes.

Full-suite runs still expose the known unrelated Android failures in `App`, `DownloadBottomSheet`, `downloadId`, `downloadsLocalContent`, `Extensions`, `IconButton`, `searchResultsProviders`, `SeasonList`, and `watchWhileDownloading` (CSS/ESM/native test setup and filename expectations). Logs: `D:/projects/vega-scheduler-full-suite.log`.

Desktop full-suite environment failures: `provider-settings-action` expects the absent sibling `vega-mobile`; `webos-compat-browser` expects a separately built webOS fixture. Logs: `D:/projects/vega-desktop-scheduler-full-suite.log`. Generated browser-host files were prepared before the final full run.

Release hashes, signatures and local installation checks are recorded separately; no rollback APK or application archive is created. Automated scheduling tests use a controlled native backend. They verify the algorithm and do not claim real-world throughput of third-party swarms or Android device playback.

## Release verification

Android 5.3.0-fixes.18 / versionCode 228, ARM64 and ARMv7. APK v2 signature verified; the final scheduler and identity code are present in the packaged Hermes bundle. SHA-256: `2b4cc7937cc8335dc60b5593debfa2f9d02b724cb36130fcc462239f9171eb13`.

Focused checks: Android 80 tests, desktop 15 tests, both TypeScript checks passed. Full runs: Android 153 suites pass and the nine baseline suites above fail; desktop 134 tests pass, two environment-dependent tests fail and one is skipped. See the named logs for full failures.

Desktop 2.3.2 was installed with the normal NSIS updater, and the installed payload hash, version, responsive application window and running torrent engine were verified. Build and installation receipt: `D:/projects/vega-release-receipt-20261105-scheduling.json`.
