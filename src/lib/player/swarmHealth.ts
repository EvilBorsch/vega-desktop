import {useCallback, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {torrentEngine} from '../services/torrentEngine';
import type {Stream} from '../providers/types';
import {isTauriRuntime} from '../../platform/host';

/** Peers the DHT returned per info hash (the engine's /swarm/probe). */
export type SwarmProbe = {peers: Record<string, number>};

const DEAD_KEY = 'DeadReleases:v1';
// A swarm can come back; a release that had nobody is offered again tomorrow.
const DEAD_TTL_MS = 24 * 60 * 60 * 1000;

export const streamInfoHash = (stream?: Pick<Stream, 'link'>): string | undefined =>
  stream?.link?.match(/[?&]xt=urn:btih:([a-f0-9]{40})(?:&|$)/i)?.[1]?.toLowerCase();

/** A seeder count an index measured recently ("👤12"), not an old snapshot. */
export const liveSeeders = (stream: Pick<Stream, 'tag' | 'tags'>): number | undefined => {
  const match = [...(stream.tags || []), stream.tag || ''].join(' ').match(/👤\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
};

/** Live seeders and leechers from public trackers (UDP scrape), per info hash. */
export type SwarmScrape = Record<string, {seeders: number; leechers: number; trackers?: number}>;

// Swarm counts in a release's labels: live (👤, ⬇), an old snapshot (≈) or DHT peers (👥).
const SWARM_TAG = /^(?:👤\s*\d+|S:\s*\d+|⬇\s*\d+|≈\d+ seeders.*|👥\s*\d+)$/i;

/**
 * The release with its swarm counts replaced by what public trackers say now.
 * Index snapshots are often months old (JacRed matched a live scrape for 15%
 * of releases); an index's own live count is kept when it is higher, as it
 * may know trackers the scrape did not ask.
 */
export const withLiveCounts = (stream: Stream, live?: {seeders: number; leechers: number}): Stream => {
  if (!live || live.seeders + live.leechers <= 0) return stream;
  const seeders = Math.max(live.seeders, liveSeeders(stream) || 0);
  const swarm = [`👤${seeders}`, ...(live.leechers > 0 ? [`⬇${live.leechers}`] : [])];
  const splice = (parts: string[]) => {
    const at = parts.findIndex(part => SWARM_TAG.test(part.trim()));
    const kept = parts.filter(part => !SWARM_TAG.test(part.trim()));
    const position = at < 0 ? Math.min(1, kept.length) : at;
    return [...kept.slice(0, position), ...swarm, ...kept.slice(position)];
  };
  return {
    ...stream,
    tags: splice(stream.tags || []),
    tag: stream.tag ? splice(stream.tag.split(' • ')).join(' • ') : stream.tag,
  };
};

/**
 * Whether a probe says anything: when the DHT is unreachable every lookup
 * comes back empty, and that must not hide every release.
 */
export const probeIsConclusive = (probe?: SwarmProbe): boolean => {
  const counts = Object.values(probe?.peers || {});
  const found = counts.filter(count => count > 0).length;
  return counts.length > 0 && found >= Math.max(1, Math.ceil(counts.length * 0.15));
};

const readDead = (): Record<string, number> => {
  try {
    const saved = JSON.parse(localStorage.getItem(DEAD_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
};

/** Releases that failed to find a single peer when played, still within a day. */
export const deadReleases = (now = Date.now()): Set<string> =>
  new Set(Object.entries(readDead()).filter(([, until]) => until > now).map(([hash]) => hash));

export const markReleaseDead = (hash: string, now = Date.now()): void => {
  const dead = Object.fromEntries(Object.entries(readDead()).filter(([, until]) => until > now));
  dead[hash.toLowerCase()] = now + DEAD_TTL_MS;
  try {
    localStorage.setItem(DEAD_KEY, JSON.stringify(dead));
  } catch {}
};

const withTag = (stream: Stream, tag: string): Stream => ({
  ...stream,
  tags: [...(stream.tags || []), tag],
  tag: [stream.tag, tag].filter(Boolean).join(' • '),
});

/**
 * Hides releases nobody shares and labels the ones only the DHT vouches for.
 * A release with a fresh seeder count from an index, the playing one and a
 * remembered one stay listed whatever the probe says.
 */
export const applySwarmHealth = (
  streams: Stream[],
  probe: SwarmProbe | undefined,
  dead: Set<string>,
  keep: Set<string>,
  scrape?: SwarmScrape,
): {visible: Stream[]; hidden: Stream[]} => {
  const conclusive = probeIsConclusive(probe);
  const visible: Stream[] = [];
  const hidden: Stream[] = [];
  for (const listed of streams) {
    const listedHash = streamInfoHash(listed);
    const stream = listedHash && scrape ? withLiveCounts(listed, scrape[listedHash]) : listed;
    const hash = streamInfoHash(stream);
    // The release playing now stays; one that found no peer when played goes,
    // even if Resume remembers it; a remembered one is never hidden by a probe.
    if (!hash || keep.has(stream.link) || (!dead.has(hash) && keep.has(hash))) {
      visible.push(stream);
      continue;
    }
    const peers = probe?.peers[hash];
    const seeded = (liveSeeders(stream) || 0) > 0;
    if (dead.has(hash) || (conclusive && peers === 0 && !seeded)) {
      hidden.push(withTag(stream, 'No peers'));
      continue;
    }
    visible.push(peers && !seeded ? withTag(stream, `👥${peers}`) : stream);
  }
  return {visible, hidden};
};

/**
 * Probes the swarms of a source list once it is shown, so releases nobody
 * shares disappear before one is picked.
 */
export const useSwarmHealth = (
  streams: Stream[],
  {enabled, keep}: {enabled: boolean; keep: Set<string>},
) => {
  const hashes = useMemo(
    () => [...new Set(streams.filter(stream => stream.type === 'torrent').map(streamInfoHash).filter(Boolean))].sort() as string[],
    [streams],
  );
  const [deadVersion, setDeadVersion] = useState(0);
  // Live counts from public trackers, asked once per list.
  const {data: scrape} = useQuery({
    queryKey: ['swarmScrape', hashes.join(',')],
    queryFn: async (): Promise<SwarmScrape> => torrentEngine<SwarmScrape>('/swarm/scrape', {hashes}),
    enabled: enabled && isTauriRuntime() && hashes.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  const {data: probe, isFetching} = useQuery({
    queryKey: ['swarmProbe', hashes.join(',')],
    queryFn: async (): Promise<SwarmProbe> => ({peers: await torrentEngine<Record<string, number>>('/swarm/probe', {hashes})}),
    enabled: enabled && isTauriRuntime() && hashes.length > 0,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  const result = useMemo(
    () => applySwarmHealth(streams, probe, deadReleases(), keep, scrape),
    // deadVersion re-reads the dead list after a release is marked.
    [streams, probe, keep, deadVersion, scrape],
  );
  const markDead = useCallback((hash: string) => {
    markReleaseDead(hash);
    setDeadVersion(version => version + 1);
  }, []);
  return {...result, checking: enabled && isFetching && !probe && hashes.length > 0, markDead};
};
