# Shared source selection for watching and downloading

Android 5.3.0-fixes.19 (229) and desktop 2.3.3 route video downloads through the same source picker as playback. Quality and language filters, current swarm counts, speed checks, recheck, and ordering all come from the existing playback component. Download cards use the download action and icon. The old independent video lists were removed; the existing downloaded-file and subtitle management controls remain available.

`getStreamSources` supplies both flows with the same additional Russian tracker catalog and hash deduplication. Provider-specific download requests retain `isDownload: true`; direct HTTP links and unrelated providers remain supported.

Downloading stops and awaits temporary swarm measurements before dispatching the selected source, so a sample torrent cannot be reused with its temporary save directory as a download destination. Watching continues to claim its tested torrent. Closing a picker during cleanup cancels the pending selection. Android retains copy-link, external-downloader preference, and the explicit internal/external alternative.

Verification on 2026-11-05:

- Android: 96 focused tests pass across source selection, source resolution, swarm scheduling/health, badges, and downloaded-file management. TypeScript passes.
- Desktop: 20 focused tests pass, including rendering the actual shared picker, measured ordering, download dispatch after cleanup, and playback handoff. TypeScript passes.
- Full Android suite: 156 suites pass, 8 fail; 1184 tests pass, 2 fail. Remaining failures are the previously recorded native/ESM/CSS mock setup and filename expectations. The previously failing download-sheet suite now passes.
- Full desktop suite: 139 tests pass, 2 fail, 1 skipped. The existing failures require the absent sibling `vega-mobile` checkout and a separately built webOS fixture.
- No physical Android playback/download test was performed. Release binary hashes, signature verification, and installed desktop verification are recorded outside the repositories in `D:/projects/vega-release-receipt-20261105-download-selection.json`.
