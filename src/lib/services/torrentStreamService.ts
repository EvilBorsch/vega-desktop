import { invoke } from "@tauri-apps/api/core";
import {isTauriRuntime} from "../../platform/host";
import { pickVideoFileIndex, type EpisodeTarget } from "../player/episodeFile";
import { useTorrentStatusStore } from "../zustand/torrentStatusStore";
import { knownPeers } from "../player/swarmTests";

export function isTorrentUrl(url?: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("magnet:") || /\.torrent(?:[?#]|$)/.test(trimmed);
}

export function extractInfoHash(url?: string | null): string | null {
  if (!url) return null;
  const match = url.match(/urn:btih:([a-zA-Z0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

export interface ResolveTorrentOptions {
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  timeoutMs?: number;
}

export interface TorrentStreamResult {
  streamUrl: string;
  infoHash: string;
}

const activeStreamTorrents = new Set<string>();

export function getInfoHashFromStreamUrl(streamUrl?: string | null): string | null {
  if (!streamUrl) return null;
  const match = streamUrl.match(/\/torrents\/([a-zA-Z0-9]+)\/stream\//i);
  return match ? match[1].toLowerCase() : null;
}

// librqbit waits for a magnet's metadata inside POST /torrents, by default for
// ten minutes. An attempt is cut short instead and added again: a fresh add
// re-announces to trackers and the DHT, which is what re-opening a source did.
const METADATA_TIMEOUT_MS = 30_000;
const MAX_ADD_ATTEMPTS = 3;

/** Season and episode the next torrent stream should play from a pack. */
let episodeTarget: EpisodeTarget | undefined;
export function setTorrentEpisodeTarget(target?: EpisodeTarget): void {
  episodeTarget = target;
}
export function getTorrentEpisodeTarget(): EpisodeTarget | undefined {
  return episodeTarget;
}

const status = () => useTorrentStatusStore.getState();

const formatSpeed = (mbps?: number) =>
  mbps && mbps > 0.01 ? (mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${Math.round(mbps * 1024)} KB/s`) : "";

/** Peers, speed and progress of a torrent librqbit already has. */
export async function torrentStatsLine(apiPort: number, infoHash: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/torrents/${infoHash}/stats/v1`, { signal });
  if (!res.ok) return "";
  const stats = await res.json();
  const peers = stats?.live?.snapshot?.peer_stats;
  const parts = [
    peers ? `${peers.live || 0} peers connected (${peers.seen || 0} found)` : "",
    formatSpeed(stats?.live?.download_speed?.mbps),
    stats?.progress_bytes ? `${(stats.progress_bytes / 1024 / 1024).toFixed(1)} MB` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Picks the file to stream: the requested episode in a pack, else the largest video. */
export function pickTorrentFile(
  files: Array<{ name: string; length?: number }>,
  target?: EpisodeTarget,
): number {
  return pickVideoFileIndex(
    files.map((file, index) => {
      const path = file.name || "";
      const name = path.substring(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
      return { index, name, path, size: file.length || 0 };
    }),
    target,
  );
}

async function addTorrent(apiPort: number, torrentUrl: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  const timer = setTimeout(abort, METADATA_TIMEOUT_MS + 5_000);
  // Peers a swarm test just talked to: no new search before the first bytes.
  const peers = knownPeers(torrentUrl);
  const initialPeers = peers.length ? `&initial_peers=${encodeURIComponent(peers.join(","))}` : "";
  try {
    const res = await fetch(
      `http://127.0.0.1:${apiPort}/torrents?overwrite=true&timeout_ms=${METADATA_TIMEOUT_MS}${initialPeers}`,
      { method: "POST", body: torrentUrl, signal: controller.signal },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || res.statusText || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (error: any) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted || /timeout|timed out/i.test(String(error?.message))) {
      throw new Error(`Peers did not send the torrent info in ${METADATA_TIMEOUT_MS / 1000} s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Resolves a magnet URL or .torrent into a local HTTP streaming URL served by librqbit.
 */
export async function resolveTorrentStream(
  torrentUrl: string,
  options?: ResolveTorrentOptions,
): Promise<TorrentStreamResult> {
  if (!isTorrentUrl(torrentUrl)) {
    return { streamUrl: torrentUrl, infoHash: "" };
  }
  if (!isTauriRuntime()) throw new Error("Torrent playback requires the desktop app.");

  const timeoutMs = options?.timeoutMs || 45_000;
  const signal = options?.signal;
  const startedAt = Date.now();
  status().set({ active: true, title: "Getting torrent info", detail: "Connecting to trackers and DHT", startedAt });
  options?.onProgress?.("Connecting to torrent network...");

  const apiPort = await invoke<number>("get_torrent_api_port");

  // 1. Add torrent to librqbit session, again if its metadata does not come.
  let data: any;
  for (let attempt = 1; ; attempt++) {
    try {
      status().set({
        title: "Getting torrent info",
        detail: attempt > 1 ? `Trying again (${attempt}/${MAX_ADD_ATTEMPTS}) · asking trackers and DHT for peers` : "Connecting to trackers and DHT",
      });
      data = await addTorrent(apiPort, torrentUrl, signal);
      break;
    } catch (error: any) {
      if (signal?.aborted || attempt >= MAX_ADD_ATTEMPTS) {
        status().clear();
        throw new Error(
          `${error?.message || "The torrent could not be added."} Tried ${attempt} times. This release may be dead or blocked on your network; choose another source.`,
        );
      }
    }
  }
  const infoHash =
    data.details?.info_hash || extractInfoHash(torrentUrl) || (data.id !== undefined ? String(data.id) : null);

  if (!infoHash) {
    status().clear();
    throw new Error("Failed to determine torrent info hash");
  }

  options?.onProgress?.("Waiting for torrent peers and metadata...");
  status().set({ title: "Downloading the start of the video", detail: "" });

  // 2. Poll until torrent is active (live or paused) and files metadata is populated
  const startTime = Date.now();
  let torrentDetails: any = data.details;
  let failure: Error | undefined;

  while (!failure && Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      status().clear();
      throw new Error("Torrent stream resolution aborted");
    }

    try {
      const statsRes = await fetch(
        `http://127.0.0.1:${apiPort}/torrents/${infoHash}/stats/v1`,
        { signal },
      );

      if (statsRes.ok) {
        const stats = await statsRes.json();
        if (stats.state === "error") {
          failure = new Error(stats.error || "The torrent failed to start");
          break;
        }
        if (stats.state === "live" || stats.state === "paused") {
          // Verify we have file metadata
          if (!torrentDetails?.files || torrentDetails.files.length === 0) {
            const detailRes = await fetch(
              `http://127.0.0.1:${apiPort}/torrents/${infoHash}`,
              { signal },
            ).catch(() => null);

            if (detailRes?.ok) {
              const fullDetails = await detailRes.json();
              if (fullDetails?.files && fullDetails.files.length > 0) {
                torrentDetails = fullDetails;
                break;
              }
            }
          } else {
            break;
          }
        }
      }
    } catch (e: any) {
      if (signal?.aborted) throw e;
    }

    await new Promise((r) => setTimeout(r, 600));
  }
  if (failure) {
    status().clear();
    throw failure;
  }

  // 3. Fallback check for files from /torrents/{infoHash}
  if (!torrentDetails?.files || torrentDetails.files.length === 0) {
    const detailRes = await fetch(
      `http://127.0.0.1:${apiPort}/torrents/${infoHash}`,
      { signal },
    ).catch(() => null);

    if (detailRes?.ok) {
      const fullDetails = await detailRes.json();
      if (fullDetails?.files && fullDetails.files.length > 0) {
        torrentDetails = fullDetails;
      }
    }
  }

  const files: Array<{ name: string; length?: number; [key: string]: any }> =
    torrentDetails?.files || [];

  if (files.length === 0) {
    status().clear();
    throw new Error(
      "Torrent metadata timeout: could not retrieve file list from peers. Try another source.",
    );
  }

  // 4. The requested episode of a season pack, else the largest video.
  const bestIndex = pickTorrentFile(files, episodeTarget);
  const bestFileName = files[bestIndex]?.name || "";
  // Only that file downloads, so a 100 GB pack does not compete with the stream.
  if (files.length > 1) {
    fetch(`http://127.0.0.1:${apiPort}/torrents/${infoHash}/update_only_files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ only_files: [bestIndex] }),
    }).catch(() => {});
  }

  const rawName = bestFileName || "";
  const baseName = rawName.substring(
    Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\")) + 1,
  );
  const nameSuffix = baseName ? `/${encodeURIComponent(baseName)}` : "";

  activeStreamTorrents.add(infoHash.toLowerCase());
  watchTorrentStatus(apiPort, infoHash);

  return {
    streamUrl: `http://127.0.0.1:${apiPort}/torrents/${infoHash}/stream/${bestIndex}${nameSuffix}`,
    infoHash,
  };
}

let statusWatch: ReturnType<typeof setInterval> | undefined;

/** Keeps the loading screen's peers and speed current until playback starts. */
export function watchTorrentStatus(apiPort: number, infoHash: string): void {
  stopTorrentStatus(false);
  const tick = () => {
    torrentStatsLine(apiPort, infoHash)
      .then((line) => {
        if (status().active) status().set({ detail: line });
      })
      .catch(() => {});
  };
  tick();
  statusWatch = setInterval(tick, 1000);
}

/** Playback started or the player closed: the loading status is no longer needed. */
export function stopTorrentStatus(clear = true): void {
  if (statusWatch) clearInterval(statusWatch);
  statusWatch = undefined;
  if (clear) status().clear();
}

/**
 * Resolves a magnet URL or .torrent into a local HTTP streaming URL served by librqbit.
 */
export async function resolveTorrentStreamUrl(
  torrentUrl: string,
  options?: ResolveTorrentOptions,
): Promise<string> {
  if (!isTorrentUrl(torrentUrl)) {
    return torrentUrl;
  }
  const result = await resolveTorrentStream(torrentUrl, options);
  return result.streamUrl;
}

/**
 * Pauses or cleans up an active streaming torrent in librqbit.
 */
export async function pauseTorrentStream(infoHash: string): Promise<void> {
  try {
    const apiPort = await invoke<number>("get_torrent_api_port");
    await fetch(`http://127.0.0.1:${apiPort}/torrents/${infoHash}/pause`, {
      method: "POST",
    });
  } catch {}
}

/**
 * Deletes a torrent stream and removes downloaded files from disk via librqbit.
 * Verifies that the torrent is not a saved item in user's downloads before deleting.
 */
export async function deleteTorrentStream(infoHash: string): Promise<void> {
  if (!infoHash) return;
  const normalizedHash = infoHash.toLowerCase();
  activeStreamTorrents.delete(normalizedHash);

  try {
    const { useDownloadStore } = await import("../zustand/downloadStore");
    const downloads = useDownloadStore.getState().downloads || {};
    const isSavedDownload = Object.values(downloads).some(
      (item) =>
        item?.isTorrent &&
        item.torrentInfoHash?.toLowerCase() === normalizedHash,
    );

    if (isSavedDownload) {
      return;
    }

    const apiPort = await invoke<number>("get_torrent_api_port");
    await fetch(
      `http://127.0.0.1:${apiPort}/torrents/${encodeURIComponent(infoHash)}/delete`,
      {
        method: "POST",
        keepalive: true,
      },
    );
  } catch (e) {
    console.warn("[torrentStreamService] Failed to delete torrent stream:", e);
  }
}

/**
 * Cleans up all active streaming torrents and deletes downloaded cache files.
 */
export async function cleanupAllStreamTorrents(): Promise<void> {
  const hashes = Array.from(activeStreamTorrents);
  for (const hash of hashes) {
    await deleteTorrentStream(hash).catch(() => {});
  }
}
