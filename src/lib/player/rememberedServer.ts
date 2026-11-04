import type {Stream} from '../providers/types';

// Persist identity only: provider links and authentication headers can expire.
const identity = (stream: Stream) => ({
  server: stream.server,
  type: stream.type,
  quality: stream.quality || '',
  tag: stream.tag || '',
  tags: [...(stream.tags || [])].sort(),
  torrentHash:
    stream.link.match(/[?&]xt=urn:btih:([^&]+)/i)?.[1]?.toLowerCase() || '',
});
export type ServerIdentity = ReturnType<typeof identity>;
export const serverIdentity = (stream: Stream): ServerIdentity | undefined =>
  stream?.link && stream.server ? identity(stream) : undefined;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The source last picked for one episode (or a movie) of a title. */
export const rememberedServerKey = (episode: any, params: any, provider: string): string => {
  const episodeId = episode?.link || episode?.title;
  const infoUrl = params?.infoUrl;
  return episodeId && infoUrl
    ? `PlaybackServer:v1:${params?.providerValue || provider}:${infoUrl}:${episodeId}`
    : '';
};
/** The source last picked for any episode of a series. */
export const rememberedSeriesKey = (params: any, provider: string): string =>
  params?.type === 'series' && params?.infoUrl
    ? `PlaybackServer:v1:series:${params?.providerValue || provider}:${params.infoUrl}`
    : '';

export function rememberServer(key: string, stream: Stream): void {
  if (!key || !stream.link || !stream.server) return;
  try {
    localStorage.setItem(key, JSON.stringify(identity(stream)));
  } catch {}
}

export function rememberedIdentity(key: string): ServerIdentity | undefined {
  if (!key) return undefined;
  try {
    const saved = read(key);
    return saved ? JSON.parse(saved) : undefined;
  } catch {
    return undefined;
  }
}

export function findRememberedServer(key: string, streams: Stream[]): Stream | undefined {
  const saved = key ? read(key) : null;
  if (!saved) return undefined;
  try {
    const previous = JSON.parse(saved);
    return streams.find(stream => {
      const current = identity(stream);
      // Live seeder counts in the tags change; the hash names the release.
      return previous.torrentHash
        ? current.type === previous.type && current.torrentHash === previous.torrentHash
        : JSON.stringify(current) === saved;
    });
  } catch {
    return undefined;
  }
}

// Seeder counts and sizes change between episodes and refreshes; codec,
// language and dub labels describe the release.
const VOLATILE_TAG = /^(?:👤\s*\d+|👥\s*\d+|S:\s*\d+|≈\d+ seeders.*|No peers|\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB))$/i;
const stableTags = (tags: string[]) =>
  tags.map(tag => tag.trim().toLowerCase()).filter(tag => tag && !VOLATILE_TAG.test(tag));
const seeders = (stream: Stream) =>
  Number([...(stream.tags || []), stream.tag || ''].join(' ').match(/👤\s*(\d+)/)?.[1] || 0);

/**
 * The source for another episode that matches one picked before: the same
 * torrent (a season pack holds every episode), otherwise the same server and
 * quality with the most release labels in common.
 */
export function findSimilarStream(previous: ServerIdentity | undefined, streams: Stream[]): Stream | undefined {
  if (!previous?.server) return undefined;
  if (previous.torrentHash) {
    const same = streams.find(stream =>
      stream.type === previous.type && identity(stream).torrentHash === previous.torrentHash);
    if (same) return same;
  }
  const wanted = new Set(stableTags(previous.tags || []));
  let best: Stream | undefined;
  let bestScore = -1;
  for (const stream of streams) {
    if (stream.server !== previous.server || stream.type !== previous.type ||
        (stream.quality || '') !== previous.quality) continue;
    const score = stableTags(stream.tags || []).filter(tag => wanted.has(tag)).length;
    if (score > bestScore || (score === bestScore && best && seeders(stream) > seeders(best))) {
      best = stream;
      bestScore = score;
    }
  }
  return best;
}
