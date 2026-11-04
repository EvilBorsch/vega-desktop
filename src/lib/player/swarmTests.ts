import {useEffect, useMemo, useRef} from 'react';
import {create} from 'zustand';
import {invoke} from '@tauri-apps/api/core';
import type {Stream} from '../providers/types';
import {isTauriRuntime} from '../../platform/host';
import {liveSeeders, streamInfoHash} from './swarmHealth';
import {streamLanguages, streamQuality} from './streamFilters';

/** What measuring a release's swarm showed. */
export type SwarmTestResult = {
  /** Peers that connected and peers trackers/DHT named; seeds among them (-1: unknown). */
  peers: number;
  seeds: number;
  known: number;
  metadata: boolean;
  /** Bytes per second since the torrent info arrived, and the peak rate. */
  speed: number;
  maxSpeed: number;
  /** Addresses of peers that connected, to hand playback straight away. */
  peerList: string[];
  testedAt: number;
  /** Still being measured: an estimate from the seconds so far. */
  provisional?: boolean;
};

/** How a monitored release is doing right now (the native swarmStats). */
export type LiveSample = {
  metadata: boolean;
  /** Since the release was added, and since its torrent info arrived. */
  elapsedMs: number;
  dataMs: number;
  /** Video bytes since the torrent info arrived; the current and peak rate. */
  bytes: number;
  rate: number;
  maxRate: number;
  peers: number;
  seeds: number;
  maxPeers: number;
  maxSeeds: number;
  known: number;
  /** The start of the video (24 MB) is in. */
  done: boolean;
  peerList: string[];
};

/** Releases looked at in each pass: the top of the list. */
export const SWARM_TEST_BATCH = 8;
/**
 * Releases downloading at the same time. A stalled one does not hold a slot:
 * it is still watched, but the next release starts beside it.
 */
export const MONITOR_CONCURRENCY = 6;
/** Releases watched at most, stalled ones included. */
export const MAX_MONITORED = 16;
// No torrent info this long, or no video this long after it: stalled.
const STALL_NO_INFO_MS = 8_000;
const STALL_NO_DATA_MS = 6_000;
// A release this fast for this long, and not falling off, is judged at once.
const CLEAR_SPEED = 1024 * 1024;
const CLEAR_AFTER_MS = 6_000;
// BitTorrent is slow to start: a new peer is often let in only by an
// "optimistic unchoke" that rotates every 30 s, and small swarms can take
// minutes. A release that sends video is judged after 30 s; one that sends
// nothing is watched in the background for up to 2 minutes, or until its place
// is needed after 45 s.
export const MEASURE_WINDOW_MS = 30_000;
export const GIVE_UP_MS = 120_000;
export const EVICT_AFTER_MS = 45_000;
// Video that makes a 30-second measurement meaningful.
const MIN_MEASURED_BYTES = 2 * 1024 * 1024;
// The speed so far ranks a release once it has had this long.
const PROVISIONAL_AFTER_MS = 8_000;
// Swarms change slowly; a result stays useful for the next choices, also
// after the app restarts.
const RESULT_TTL_MS = 30 * 60 * 1000;
const SAVED_KEY = 'SwarmTests:v1';
const SAVED_LIMIT = 400;

const loadSaved = (): Record<string, SwarmTestResult> => {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') as Record<string, SwarmTestResult>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(saved).filter(([, result]) => result && now - result.testedAt < RESULT_TTL_MS));
  } catch {
    return {};
  }
};

const save = (results: Record<string, SwarmTestResult>) => {
  try {
    const latest = Object.entries(results)
      .sort(([, a], [, b]) => b.testedAt - a.testedAt)
      .slice(0, SAVED_LIMIT);
    localStorage.setItem(SAVED_KEY, JSON.stringify(Object.fromEntries(latest)));
  } catch {}
};

type SwarmTestState = {
  results: Record<string, SwarmTestResult>;
  running: Record<string, true>;
  /** Releases being measured, with their latest numbers. */
  live: Record<string, LiveSample | undefined>;
  update: (stats: Record<string, LiveSample>) => void;
  /** Stops measuring these releases without a result. */
  drop: (hashes: string[]) => void;
  /** Failed tests per release; one that did not answer is tested once more. */
  failures: Record<string, number>;
  start: (hashes: string[]) => void;
  /** Forgets the results of these releases, so they are tested again. */
  recheck: (hashes: string[]) => void;
  finish: (hashes: string[], results: Record<string, Omit<SwarmTestResult, 'testedAt'>>) => void;
};

export const useSwarmTestStore = create<SwarmTestState>(set => ({
  results: loadSaved(),
  running: {},
  live: {},
  failures: {},
  start: hashes => set(state => ({
    running: {...state.running, ...Object.fromEntries(hashes.map(hash => [hash, true as const]))},
    live: {...state.live, ...Object.fromEntries(hashes.map(hash => [hash, undefined]))},
  })),
  update: stats => set(state => {
    const live = {...state.live};
    for (const [hash, sample] of Object.entries(stats)) if (hash in live) live[hash] = sample;
    return {live};
  }),
  drop: hashes => set(state => {
    const running = {...state.running};
    const live = {...state.live};
    for (const hash of hashes) {
      delete running[hash];
      delete live[hash];
    }
    return {running, live};
  }),
  recheck: hashes => set(state => {
    const results = {...state.results};
    const failures = {...state.failures};
    for (const hash of hashes) {
      delete results[hash];
      delete failures[hash];
    }
    save(results);
    return {results, failures};
  }),
  finish: (hashes, results) => set(state => {
    const running = {...state.running};
    const live = {...state.live};
    for (const hash of hashes) {
      delete running[hash];
      delete live[hash];
    }
    const now = Date.now();
    const next = {...state.results};
    const failures = {...state.failures};
    for (const [hash, result] of Object.entries(results)) {
      next[hash] = {...result, testedAt: now};
      if (!result.metadata) failures[hash] = (failures[hash] || 0) + 1;
    }
    save(next);
    return {running, live, results: next, failures};
  }),
}));

/** Bytes per second since the torrent info arrived. */
export const sampleSpeed = (sample: LiveSample) =>
  sample.dataMs > 0 ? (sample.bytes * 1000) / Math.max(1000, sample.dataMs) : 0;

const sampleResult = (sample: LiveSample): Omit<SwarmTestResult, 'testedAt'> => ({
  peers: sample.maxPeers,
  seeds: sample.maxSeeds,
  known: sample.known,
  metadata: sample.metadata,
  speed: sampleSpeed(sample),
  maxSpeed: sample.maxRate,
  peerList: sample.peerList || [],
});

/** Whether a monitored release is downloading, still starting, or stalled. */
export const sampleState = (sample?: LiveSample): 'starting' | 'downloading' | 'stalled' => {
  if (!sample) return 'starting';
  if (!sample.metadata) return sample.elapsedMs >= STALL_NO_INFO_MS ? 'stalled' : 'starting';
  if (sample.rate >= NO_DATA_SPEED) return 'downloading';
  return sample.dataMs >= STALL_NO_DATA_MS ? 'stalled' : 'starting';
};

/**
 * The result of a release once its speed is clear: the start of its video is
 * in, it has been fast and steady for a few seconds, or it sent video for
 * 30 s. A release that sends nothing keeps being watched in the background,
 * without holding up the others, for up to 2 minutes.
 */
export const settleSample = (sample: LiveSample): Omit<SwarmTestResult, 'testedAt'> | undefined => {
  if (sample.elapsedMs >= GIVE_UP_MS) return sampleResult(sample);
  if (!sample.metadata) return undefined;
  if (sample.done || (sample.dataMs >= MEASURE_WINDOW_MS && sample.bytes >= MIN_MEASURED_BYTES)) return sampleResult(sample);
  const speed = sampleSpeed(sample);
  const steady = sample.dataMs >= CLEAR_AFTER_MS && speed >= CLEAR_SPEED && sample.rate >= speed * 0.7;
  return steady ? sampleResult(sample) : undefined;
};

/** Final results plus the estimates of releases measured for a few seconds. */
export const withProvisional = (
  results: Record<string, SwarmTestResult>,
  live: Record<string, LiveSample | undefined>,
): Record<string, SwarmTestResult> => {
  const now = Date.now();
  let merged: Record<string, SwarmTestResult> | undefined;
  for (const [hash, sample] of Object.entries(live)) {
    if (!sample?.metadata || sample.dataMs < PROVISIONAL_AFTER_MS) continue;
    merged = merged || {...results};
    merged[hash] = {...sampleResult(sample), testedAt: now, provisional: true};
  }
  return merged || results;
};

export const freshResult = (results: Record<string, SwarmTestResult>, hash?: string): SwarmTestResult | undefined => {
  const result = hash ? results[hash] : undefined;
  return result && Date.now() - result.testedAt < RESULT_TTL_MS ? result : undefined;
};

/** A tested release whose peers did not even send the torrent info. */
export const testFailed = (result?: SwarmTestResult) => Boolean(result && !result.metadata);

/** Below this a test got next to nothing (bytes per second). */
export const NO_DATA_SPEED = 16 * 1024;

/** Measured speed that streams HD video without waiting. */
export const GOOD_SPEED = 300 * 1024;

/**
 * Expected speed, in bytes per second, used for sorting. A measured speed wins;
 * otherwise the swarm size stands in (a seed or DHT peer worth ~50 KB/s, an old
 * seeder snapshot far less), so untested releases rank among each other.
 */
export const expectedSpeed = (stream: Stream, result?: SwarmTestResult): number => {
  if (result) return testFailed(result) ? -1 : Math.max(result.speed, result.maxSpeed * 0.5);
  const text = [...(stream.tags || []), stream.tag || ''].join(' ');
  const online = Number(text.match(/👥\s*(\d+)/)?.[1] || 0);
  const snapshot = Number(text.match(/≈(\d+) seeders/)?.[1] || 0);
  const snapshotLeechers = Number(text.match(/≈\d+ seeders, (\d+) leechers/)?.[1] || 0);
  const seeders = liveSeeders(stream) || 0;
  // Leechers upload the pieces they have, a fraction of what a seed sends.
  const leechers = Number(text.match(/⬇\s*(\d+)/)?.[1] || 0);
  return Math.max(seeders * 50_000 + leechers * 15_000, online * 30_000, snapshot * 5_000 + snapshotLeechers * 1_500);
};

export type SourceSort = 'speed' | 'quality';

/**
 * Fastest first: releases measured fast enough to stream, then untested ones by
 * swarm size, then measured slow ones, releases whose peers did not answer
 * last. One 10-second test is noisy, so a slow result is not ranked below an
 * unknown as "dead". "Quality" orders by resolution first.
 */
export const sortBySpeed = (streams: Stream[], results: Record<string, SwarmTestResult>, sort: SourceSort): Stream[] => {
  const score = (stream: Stream) => {
    const result = freshResult(results, streamInfoHash(stream));
    // Direct (non-torrent) links do not depend on a swarm.
    if (stream.type !== 'torrent') return {tier: 0, speed: Number.MAX_SAFE_INTEGER};
    const speed = expectedSpeed(stream, result);
    if (!result) return {tier: 1, speed};
    // A release still ramping up stays among the unmeasured until it is fast.
    if (result.provisional) return speed >= GOOD_SPEED ? {tier: 0, speed} : {tier: 1, speed: Math.max(speed, expectedSpeed(stream))};
    return {tier: speed < 0 ? 3 : speed >= GOOD_SPEED ? 0 : 2, speed};
  };
  const quality = (stream: Stream) => Number(streamQuality(stream)) || 0;
  return streams
    .map((stream, index) => ({stream, index, ...score(stream)}))
    .sort((a, b) =>
      (sort === 'quality' ? quality(b.stream) - quality(a.stream) : 0) ||
      a.tier - b.tier ||
      b.speed - a.speed ||
      a.index - b.index)
    .map(({stream}) => stream);
};

export const formatSpeed = (bytesPerSecond: number) =>
  bytesPerSecond >= 1024 * 1024
    ? `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;

export type TestLine = {text: string; tone: 'good' | 'ok' | 'bad' | 'pending'};

const peersText = (peers: number, seeds: number) => (seeds >= 0 ? `${peers} peers (${seeds} seeds)` : `${peers} peers`);

/** One line for a release card: what measuring it found, or how it is going. */
export const describeTest = (
  result?: SwarmTestResult,
  running = false,
  live?: LiveSample,
): {text: string; tone: 'good' | 'ok' | 'bad' | 'pending'} | undefined => {
  if (live && (!result || result.provisional)) {
    const stalled = sampleState(live) === 'stalled';
    if (!live.metadata) {
      return {text: stalled ? `No torrent info yet · ${live.known} peers known · still trying` : `Getting torrent info… ${live.known} peers known`, tone: 'pending'};
    }
    if (!live.bytes) {
      return {text: stalled ? `No video yet · ${peersText(live.peers, live.seeds)} · still trying` : `Connecting… ${peersText(live.peers, live.seeds)}`, tone: 'pending'};
    }
    return {text: `Measuring… ${formatSpeed(sampleSpeed(live))} · ${peersText(live.peers, live.seeds)}`, tone: 'pending'};
  }
  if (!result) return running ? {text: 'Checking peers and speed…', tone: 'pending'} : undefined;
  if (!result.metadata) {
    return result.peers > 0
      ? {text: `${result.peers} peers connected but sent no torrent info — likely won't play`, tone: 'bad'}
      : {text: "No peers answered — likely won't play", tone: 'bad'};
  }
  if (result.peers === 0) return {text: 'Torrent info received, but no peer is sending data yet', tone: 'bad'};
  // Next to nothing arrived: say so instead of a speed of "1 KB/s".
  if (Math.max(result.speed, result.maxSpeed * 0.5) < NO_DATA_SPEED) {
    const seeds = result.seeds >= 0 ? ` (${result.seeds} seeds)` : '';
    return {text: `No video data in ${MEASURE_WINDOW_MS / 1000} s · ${result.peers} peers${seeds} connected`, tone: 'bad'};
  }
  const speed = Math.max(result.speed, result.maxSpeed * 0.5);
  const peers = result.seeds >= 0 ? `${result.peers} peers (${result.seeds} seeds)` : `${result.peers} peers connected`;
  const tone = speed >= 1024 * 1024 ? 'good' : speed >= GOOD_SPEED ? 'ok' : 'bad';
  return {text: `${formatSpeed(speed)} · ${peers}`, tone};
};

/** Peers a recent test connected to, as librqbit's `initial_peers` takes them. */
export const knownPeers = (link: string): string[] => {
  const hash = streamInfoHash({link});
  const result = freshResult(useSwarmTestStore.getState().results, hash);
  return (result?.peerList || [])
    .map(peer => peer.replace(/^[a-z]+:\/\//i, ''))
    .filter(peer => /^[\d.]+:\d+$|^\[[0-9a-f:]+\]:\d+$/i.test(peer))
    .slice(0, 30);
};

const LANGUAGE_NAMES: Record<string, string> = {RU: 'Russian', EN: 'English'};
// Below this, the other language is worth a look.
const SLOW_LANGUAGE_SPEED = 1024 * 1024;

/**
 * When the releases shown in Russian (or English) all measured slow and the
 * other language has releases, which language to offer instead. A small
 * Russian swarm can be several times slower than the English one of the
 * same episode.
 */
export const slowLanguageHint = (
  listed: Stream[],
  all: Stream[],
  results: Record<string, SwarmTestResult>,
  languages: string[],
): {language: string; text: string} | undefined => {
  const current = languages.length === 1 ? languages[0] : undefined;
  if (!current || !LANGUAGE_NAMES[current]) return undefined;
  const other = current === 'RU' ? 'EN' : 'RU';
  if (!all.some(stream => stream.type === 'torrent' && streamLanguages(stream).includes(other))) return undefined;
  const measured = listed
    .filter(stream => stream.type === 'torrent')
    .map(stream => freshResult(results, streamInfoHash(stream)))
    .filter((result): result is SwarmTestResult => Boolean(result) && !result!.provisional);
  const torrents = listed.filter(stream => stream.type === 'torrent').length;
  if (!measured.length || measured.length < Math.min(3, torrents)) return undefined;
  const best = Math.max(0, ...measured.map(result => (testFailed(result) ? 0 : Math.max(result.speed, result.maxSpeed * 0.5))));
  if (best >= SLOW_LANGUAGE_SPEED) return undefined;
  const fastest = best >= NO_DATA_SPEED ? ` (fastest ${formatSpeed(best)})` : '';
  return {language: other, text: `${LANGUAGE_NAMES[current]} releases are slow here${fastest}. ${LANGUAGE_NAMES[other]} ones may be faster.`};
};

/** How far the speed check of a list has come. */
export const testProgress = (streams: Stream[], results: Record<string, SwarmTestResult>, running: Record<string, true>) => {
  const hashes = [...new Set(streams.filter(stream => stream.type === 'torrent').map(streamInfoHash).filter(Boolean))] as string[];
  return {
    total: hashes.length,
    tested: hashes.filter(hash => {
      const result = freshResult(results, hash);
      return Boolean(result && !result.provisional);
    }).length,
    testing: hashes.filter(hash => running[hash]).length,
  };
};

/** One line on the speed check, for the top of a source list. */
export const describeProgress = ({total, tested, testing}: ReturnType<typeof testProgress>): string | undefined => {
  if (!total) return undefined;
  if (testing) return `Checking speed: ${tested} of ${total} releases done, ${testing} in progress…`;
  return tested ? `Speed checked for ${tested} of ${total} releases · fastest first` : undefined;
};

/** Picks the releases to test next: the first untested torrents of a list. */
export const nextToTest = (
  streams: Stream[],
  results: Record<string, SwarmTestResult>,
  running: Record<string, true>,
  failures: Record<string, number> = {},
): string[] => {
  const hashes: string[] = [];
  for (const stream of streams) {
    if (stream.type !== 'torrent') continue;
    const hash = streamInfoHash(stream);
    if (!hash || running[hash] || hashes.includes(hash)) continue;
    const result = freshResult(results, hash);
    // A release that did not answer gets a second test; swarms answer unevenly.
    if (result && !(testFailed(result) && (failures[hash] || 0) < 2)) continue;
    hashes.push(hash);
    if (hashes.length >= SWARM_TEST_BATCH) break;
  }
  return hashes;
};

/** Keeps a tested release running for playback instead of removing it. */
export const claimSwarmTest = async (stream: Stream): Promise<void> => {
  const hash = streamInfoHash(stream);
  if (!hash || !isTauriRuntime()) return;
  await invoke('claim_swarm_test', {infoHash: hash}).catch(() => {});
};

/**
 * Measures the top of a source list while it is shown, without blocking it:
 * up to six releases at a time download the start of their video, their
 * numbers are read every second, and a release that has been measured long
 * enough makes room for the next one down the (re-sorted) list. Leaving the
 * list stops it.
 */
export const useSwarmTests = (streams: Stream[], enabled: boolean) => {
  const results = useSwarmTestStore(state => state.results);
  const live = useSwarmTestStore(state => state.live);
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const active = Object.keys(useSwarmTestStore.getState().live);
        if (active.length) {
          const stats: Record<string, LiveSample> = await invoke<Record<string, LiveSample>>('swarm_stats', {hashes: active}).catch(() => ({}));
          if (stopped) return;
          const settled: Record<string, Omit<SwarmTestResult, 'testedAt'>> = {};
          for (const hash of active) {
            const result = stats[hash] && settleSample(stats[hash]);
            if (result) settled[hash] = result;
          }
          useSwarmTestStore.getState().update(stats);
          const done = Object.keys(settled);
          if (done.length) {
            useSwarmTestStore.getState().finish(done, settled);
            invoke('stop_swarm_monitor', {hashes: done}).catch(() => {});
          }
        }
        let state = useSwarmTestStore.getState();
        const list = streamsRef.current;
        const busySlots = Object.values(state.live).filter(sample => sampleState(sample) !== 'stalled').length;
        let wanted = nextToTest(list.slice(0, MAX_MONITORED + SWARM_TEST_BATCH), state.results, state.running, state.failures)
          .slice(0, Math.max(0, MONITOR_CONCURRENCY - busySlots));
        // Watching is full: the release stalled longest gives its place.
        const room = MAX_MONITORED - Object.keys(state.live).length;
        if (wanted.length > room) {
          const evict = Object.entries(state.live)
            .filter((entry): entry is [string, LiveSample] => Boolean(entry[1]) && sampleState(entry[1]) === 'stalled' && entry[1]!.elapsedMs >= EVICT_AFTER_MS)
            .sort(([, a], [, b]) => b.elapsedMs - a.elapsedMs)
            .slice(0, wanted.length - room);
          if (evict.length) {
            const ended = Object.fromEntries(evict.map(([hash, sample]) => [hash, sampleResult(sample)]));
            state.finish(Object.keys(ended), ended);
            invoke('stop_swarm_monitor', {hashes: Object.keys(ended)}).catch(() => {});
            state = useSwarmTestStore.getState();
          }
          wanted = wanted.slice(0, Math.max(0, MAX_MONITORED - Object.keys(state.live).length));
        }
        const hashes = wanted;
        if (!hashes.length) return;
        const magnets = hashes.map(hash => list.find(stream => streamInfoHash(stream) === hash)!.link);
        state.start(hashes);
        await invoke('monitor_swarms', {magnets}).catch(() => useSwarmTestStore.getState().drop(hashes));
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => {
      stopped = true;
      clearInterval(timer);
      const active = Object.keys(useSwarmTestStore.getState().live);
      useSwarmTestStore.getState().drop(active);
      if (active.length) invoke('stop_swarm_monitor', {hashes: active}).catch(() => {});
    };
  }, [enabled]);
  const running = useMemo(
    () => Object.fromEntries(Object.keys(live).map(hash => [hash, true as const])) as Record<string, true>,
    [live],
  );
  const effective = useMemo(() => withProvisional(results, live), [results, live]);
  return {results: effective, running, live};
};
