import {useEffect} from 'react';
import {create} from 'zustand';
import {invoke} from '@tauri-apps/api/core';
import type {Stream} from '../providers/types';
import {isTauriRuntime} from '../../platform/host';
import {liveSeeders, streamInfoHash} from './swarmHealth';
import {streamLanguages, streamQuality} from './streamFilters';

/** What briefly joining a release's swarm showed (Rust `test_swarms`). */
export type SwarmTestResult = {
  /** Peers that connected and peers trackers/DHT named. */
  peers: number;
  /** Seeds among the peers; -1 when the engine cannot tell. */
  seeds: number;
  known: number;
  metadata: boolean;
  /** Bytes per second over the last seconds of the test, and the peak. */
  speed: number;
  maxSpeed: number;
  /** Addresses of peers that connected, to hand playback straight away. */
  peerList: string[];
  testedAt: number;
};

/** Candidates tested at once; enough to fill the first screen of the list. */
export const SWARM_TEST_BATCH = 8;
// Releases whose torrent info comes late are measured a little longer.
export const SWARM_TEST_SECONDS = 12;
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
  failures: {},
  start: hashes => set(state => ({running: {...state.running, ...Object.fromEntries(hashes.map(hash => [hash, true as const]))}})),
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
    for (const hash of hashes) delete running[hash];
    const now = Date.now();
    const next = {...state.results};
    const failures = {...state.failures};
    for (const [hash, result] of Object.entries(results)) {
      next[hash] = {...result, testedAt: now};
      if (!result.metadata) failures[hash] = (failures[hash] || 0) + 1;
    }
    save(next);
    return {running, results: next, failures};
  }),
}));

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

/** One line for a release card: what the swarm test found. */
export const describeTest = (result?: SwarmTestResult, running = false): TestLine | undefined => {
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
    return {text: `No video data in the test · ${result.peers} peers${seeds} connected`, tone: 'bad'};
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
    .filter((result): result is SwarmTestResult => Boolean(result));
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
    tested: hashes.filter(hash => freshResult(results, hash)).length,
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
 * Tests the top of a source list while it is shown: the first untested
 * releases, a batch at a time, until the releases at the top are all measured.
 * Leaving the list stops the tests.
 */
export const useSwarmTests = (streams: Stream[], enabled: boolean) => {
  const results = useSwarmTestStore(state => state.results);
  const running = useSwarmTestStore(state => state.running);
  const failures = useSwarmTestStore(state => state.failures);
  const busy = Object.keys(running).length > 0;
  useEffect(() => {
    if (!enabled || busy || !isTauriRuntime()) return;
    const hashes = nextToTest(streams.slice(0, SWARM_TEST_BATCH * 2), results, running, failures);
    if (!hashes.length) return;
    const magnets = hashes.map(hash => streams.find(stream => streamInfoHash(stream) === hash)!.link);
    const {start, finish} = useSwarmTestStore.getState();
    start(hashes);
    invoke<Record<string, Omit<SwarmTestResult, 'testedAt'>>>('test_swarms', {magnets, seconds: SWARM_TEST_SECONDS})
      .then(found => finish(hashes, found || {}))
      .catch(() => finish(hashes, {}));
  }, [streams, enabled, busy, results, running, failures]);
  useEffect(() => () => {
    if (isTauriRuntime()) invoke('cancel_swarm_tests').catch(() => {});
  }, []);
  return {results, running};
};
