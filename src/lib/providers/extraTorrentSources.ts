import {platformFetch} from '../../platform/network';
import type {Stream} from './types';

/** JSON over the app's HTTP bridge (no CORS); throws on a non-2xx answer. */
const requestJson = async (
  url: string,
  {params, method = 'GET', body}: {params?: Record<string, unknown>; method?: string; body?: unknown} = {},
): Promise<any> => {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  const response = await platformFetch(target.toString(), {
    method,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${target.host}`);
  return response.json();
};

/**
 * More releases for a Torrentio title. Torrentio indexes only two Russian
 * trackers (RuTracker and Rutor), so results are extended with public JSON
 * APIs, all queried at once:
 *  - JacRed mirrors: Russian trackers (Kinozal, NNM-Club, MegaPeer, LostFilm,
 *    BitRu, Torrent.by, Selezen, AnimeLayer, ...) plus releases from Knaben;
 *  - Knaben, apibay (The Pirate Bay), Torrents-CSV, BitSearch and EZTV:
 *    international indexes.
 * Every source is optional: a failing or slow one only drops its releases,
 * and a failing host is skipped for a while.
 */
export const JACRED_HOSTS = [
  'https://jacred.su',
  'https://jac.red',
  'https://jacred.stream',
  'https://jacred.pro',
  'https://jr.maxvol.pro',
  'https://jacred.viewbox.dev',
];
// Mirrors that only answer with their documented public key.
const JACRED_KEYS: Record<string, string> = {'https://jacred.viewbox.dev': 'viewbox'};
export const KNABEN_API = 'https://api.knaben.org/v1';

const REQUEST_TIMEOUT_MS = 7000;
const HOST_RETRY_MS = 30 * 60 * 1000;
const MIRROR_GRACE_MS = 2500;
const TITLE_LOOKUP_BUDGET_MS = 5000;
const TOTAL_BUDGET_MS = 14000;
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const USER_AGENT = 'Vega/5.3 (Android; torrent search)';

const TRACKER_NAMES: Record<string, string> = {
  rutracker: 'RuTracker',
  rutor: 'Rutor',
  kinozal: 'Kinozal',
  nnmclub: 'NNM-Club',
  megapeer: 'MegaPeer',
  bitru: 'BitRu',
  torrentby: 'Torrent.by',
  selezen: 'Selezen',
  lostfilm: 'LostFilm',
  animelayer: 'AnimeLayer',
  anilibria: 'AniLibria',
  aniliberty: 'AniLiberty',
  anidub: 'AniDub',
  anifilm: 'AniFilm',
  toloka: 'Toloka',
  baibako: 'BaibaKo',
  hdrezka: 'HDRezka',
  knaben: 'Knaben',
};
// JacRed trackers that index international releases rather than Russian ones.
const INTERNATIONAL_TRACKERS = new Set(['knaben']);
const SERIES_TYPES = new Set(['serial', 'multserial', 'docuserial', 'tvshow']);
const MOVIE_TYPES = new Set(['movie', 'multfilm', 'documovie']);

export type JacredTorrent = {
  tracker: string;
  title: string;
  size?: number;
  sizeName?: string;
  sid?: number;
  magnet?: string;
  relased?: number;
  createTime?: string;
  updateTime?: string;
  videotype?: string;
  quality?: number;
  voices?: string[];
  seasons?: number[];
  types?: string[];
};

/** A release from an international index, named in Western style. */
export type WesternHit = {
  title: string;
  hash: string;
  magnet?: string;
  seeders: number;
  bytes?: number;
  /** The index it came from, shown as the server. */
  source: string;
  /** When the seeder count was last measured, if the index says. */
  checkedAt?: number;
};

export type TorrentioTarget = {
  imdbId: string;
  tmdbId?: string;
  type: 'movie' | 'series';
  title?: string;
  year?: string;
  season?: number;
  episode?: number;
};

/** Title, year and episode of a Torrentio link (an IMDb id or a JSON payload). */
export const parseTorrentioTarget = (
  link: string | undefined,
  routeType?: string,
): TorrentioTarget | undefined => {
  if (!link) return undefined;
  let payload: any = {};
  if (link.trim().startsWith('{')) {
    try {
      payload = JSON.parse(link);
    } catch {
      return undefined;
    }
  } else {
    payload = {imdbId: link.match(/tt\d+/)?.[0]};
  }
  const imdbId = String(payload?.imdbId ?? '').match(/^tt\d+$/)?.[0];
  if (!imdbId) return undefined;
  const season = Number(payload.season);
  const episode = Number(payload.episode);
  const isSeries =
    (payload.type || routeType) === 'series' ||
    (Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0);
  const tmdbId = String(payload.tmdbId ?? '').match(/^\d+$/)?.[0];
  return {
    imdbId,
    tmdbId,
    type: isSeries ? 'series' : 'movie',
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : undefined,
    year: payload.year ? String(payload.year) : undefined,
    season: isSeries && season > 0 ? season : undefined,
    episode: isSeries && episode > 0 ? episode : undefined,
  };
};

const yearRange = (year?: string): {from?: number; to?: number} => {
  const years = (year || '').match(/\d{4}/g)?.map(Number) || [];
  if (!years.length) return {};
  // "2023–" is a running show: no end year.
  return {from: years[0], to: years.length > 1 ? years[1] : /[–-]\s*$/.test(year || '') ? undefined : years[0]};
};

const range = (from: number, to: number): number[] =>
  from > 0 && to >= from && to - from < 50
    ? Array.from({length: to - from + 1}, (_, index) => from + index)
    : [];

// Episode of a single-episode release: S02E03, S02E03-E05, S02E03E04, 2x03.
const EPISODE_CODE = /\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:(?:[ ._]?-[ ._]?(?:S\d{1,2}[ ._-]?)?E?|E)(\d{1,4}))?(?!\d)/i;
const CROSS_CODE = /\b(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?\b/i;

const episodeCode = (title: string): {season: number; from: number; to: number} | undefined => {
  const match = title.match(EPISODE_CODE) || title.match(CROSS_CODE);
  if (!match) return undefined;
  const from = Number(match[2]);
  const to = match[3] && Number(match[3]) > from ? Number(match[3]) : from;
  return {season: Number(match[1]), from, to};
};

const SEASON_IN_TITLE = [
  /сезон[ыа]?[:\s]*(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?/i,
  /(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?\s*сезон/i,
  /\bseasons?[ ._-]*(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?/i,
  /\bS(\d{1,2})(?:\s*[-–—]\s*S?(\d{1,2}))?\b/i,
  /\[(\d{1,2})x\d{1,3}/i,
  // Anime trackers number seasons as TV series: "[ТВ-2]".
  /\[(?:ТВ|TV)[-–—\s]?(\d{1,2})\]/i,
];

/** Seasons a pack names: S02, S01-S05, S01-S02-S03, "Сезон: 2", "1-5 сезоны". */
export const seasonsInTitle = (title: string): number[] => {
  const listed = [...title.matchAll(/\bS(\d{1,2})(?=[\s._\-\])]|$)/gi)].map(match => Number(match[1]));
  if (listed.length > 1) {
    return range(Math.min(...listed), Math.max(...listed));
  }
  for (const pattern of SEASON_IN_TITLE) {
    const match = title.match(pattern);
    if (match) return range(Number(match[1]), match[2] ? Number(match[2]) : Number(match[1]));
  }
  return [];
};

// "(28 из 28)" counts episodes, so that form only names episodes as a range.
const EPISODE_RANGES = [
  /сери[яи][:\s]*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\s*из\s*\d+/i,
  /\[\d{1,2}x(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\s*из\s*\d+\]/i,
  /\[(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*из\s*\d+\]/i,
  /\((\d{1,4})\s*[-–—]\s*(\d{1,4})\s*из\s*\d+\)/i,
  // AnimeLayer: "(1—3)". Three digits at most, so release years never match.
  /\((\d{1,3})\s*[-–—]\s*(\d{1,3})\)/,
];

const containsEpisode = (title: string, episode: number): boolean => {
  const code = episodeCode(title);
  if (code) return episode >= code.from && episode <= code.to;
  for (const pattern of EPISODE_RANGES) {
    const match = title.match(pattern);
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    return episode >= from && episode <= to;
  }
  return true;
};

/** Whether a release can hold the target season and episode. */
const holdsEpisode = (title: string, seasons: number[], target: TorrentioTarget): boolean => {
  if (!target.season) return true;
  const code = episodeCode(title);
  if (code && code.season !== target.season) return false;
  const known = seasons.length ? seasons : code ? [code.season] : seasonsInTitle(title);
  // A pack that names no season is usually the first one (or a miniseries).
  if (!known.length ? target.season !== 1 && !/complete|полный|все сезоны/i.test(title) : !known.includes(target.season)) {
    return false;
  }
  return !target.episode || containsEpisode(title, target.episode);
};

/** Whether a JacRed release can hold the requested movie or episode. */
export const matchesJacred = (torrent: JacredTorrent, target: TorrentioTarget): boolean => {
  if (!torrent.magnet?.startsWith('magnet:') || !(torrent.sid && torrent.sid > 0)) return false;
  const types = torrent.types || [];
  const {from, to} = yearRange(target.year);
  const released = torrent.relased || 0;
  const code = episodeCode(torrent.title);
  if (target.type === 'movie') {
    if (code || (types.length && types.every(type => SERIES_TYPES.has(type)))) return false;
    return !from || !released || Math.abs(released - from) <= 1;
  }
  // Knaben mirrors label some episodes as movies; their S01E01 code says otherwise.
  if (!code && types.length && types.every(type => MOVIE_TYPES.has(type))) return false;
  if (from && released && released < from - 1) return false;
  if (to && released && released > to + 1) return false;
  return holdsEpisode(torrent.title, torrent.seasons || [], target);
};

const normalizeName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether a release named in Western style (Title.Year.1080p...) is the target. */
export const matchesWestern = (hit: WesternHit, target: TorrentioTarget): boolean => {
  if (!hit.title || !target.title || !/^[0-9a-f]{40}$/i.test(hit.hash)) return false;
  if (!(hit.seeders > 0)) return false;
  // Anime groups lead with a tag: "[SubsPlease] Title - 01".
  const name = normalizeName(hit.title.replace(/^\s*(\[[^\]]*\]\s*)+/, ''));
  const title = normalizeName(target.title);
  if (!title || !(name === title || name.startsWith(`${title} `))) return false;
  const rest = name.slice(title.length);
  const code = episodeCode(hit.title);
  if (target.type === 'movie') {
    if (code) return false;
    const year = Number(rest.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || 0);
    const {from} = yearRange(target.year);
    // Common titles are reused, so a release must name a matching year.
    return Boolean(year) && (!from || Math.abs(year - from) <= 1);
  }
  return holdsEpisode(hit.title, [], target);
};

export const torrentHash = (link?: string): string =>
  link?.match(/[?&]xt=urn:btih:([^&]+)/i)?.[1]?.toLowerCase() || '';

const formatSize = (bytes?: number, fallback?: string): string => {
  if (!bytes || bytes <= 0) return fallback?.replace(/ГБ/i, 'GB').replace(/МБ/i, 'MB') || '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit < 2 ? 0 : 2)} ${units[unit]}`;
};

const qualityFromTitle = (title: string): string => {
  if (/2160p|\b4k\b|\buhd\b/i.test(title)) return '2160';
  if (/1080[pi]/i.test(title)) return '1080';
  if (/720p/i.test(title)) return '720';
  if (/480p|576p|\bDVDRip\b|\bXviD\b/i.test(title)) return '480';
  return '';
};

const jacredQuality = (torrent: JacredTorrent): string => {
  const fromTitle = qualityFromTitle(torrent.title);
  if (fromTitle) return fromTitle;
  // JacRed reports 480 when the title names no resolution; HDR is a UHD release.
  if (torrent.videotype === 'hdr') return '2160';
  const quality = torrent.quality || 0;
  return [2160, 1080, 720, 480, 360].includes(quality) ? String(quality) : '';
};

const formatTags = (title: string): string[] => {
  const tags: string[] = [];
  if (/\bAV1\b/i.test(title)) tags.push('AV1');
  else if (/x265|HEVC|H\.?265/i.test(title)) tags.push('HEVC');
  else if (/x264|\bAVC\b|H\.?264/i.test(title)) tags.push('AVC');
  if (/10-?bit/i.test(title)) tags.push('10-bit');
  if (/Dolby\s*Vision|\bDV\b|\bDoVi\b/i.test(title)) tags.push('DV');
  if (/HDR10\+/i.test(title)) tags.push('HDR10+');
  else if (/\bHDR(?:10)?(?![a-z])/i.test(title)) tags.push('HDR');
  if (/remux/i.test(title)) tags.push('Remux');
  else if (/WEB-?DLRip/i.test(title)) tags.push('WEB-DLRip');
  else if (/WEB-?DL/i.test(title)) tags.push('WEB-DL');
  else if (/WEB-?Rip/i.test(title)) tags.push('WEBRip');
  else if (/BDRip|BRRip/i.test(title)) tags.push('BDRip');
  else if (/Blu-?Ray|\bBD\b/i.test(title)) tags.push('BluRay');
  else if (/HDTV/i.test(title)) tags.push('HDTV');
  else if (/HDRip/i.test(title)) tags.push('HDRip');
  return tags;
};

// Audio languages named in an international release title.
const RELEASE_LANGUAGES: [string, RegExp][] = [
  ['RU', /\b(RUS|RUSSIAN)\b|русск/i],
  ['MULTI', /\b(MULTI|DUAL)\b/i],
  ['FR', /\b(FRENCH|TRUEFRENCH|VFF|VFQ|VF2|VOSTFR)\b/i],
  ['ES', /\b(SPANISH|ESP|CASTELLANO|LATINO|SPA)\b/i],
  ['IT', /\b(ITA|ITALIAN)\b/i],
  ['DE', /\b(GER|GERMAN)\b/i],
  ['PT', /\b(PORTUGUESE|DUBLADO|PT-?BR)\b/i],
  ['HI', /\b(HINDI)\b/i],
  ['KO', /\b(KOR|KOREAN)\b/i],
  ['JA', /\b(JAP|JPN|JAPANESE)\b/i],
];

const releaseLanguages = (title: string, source: string): string[] => {
  const found = RELEASE_LANGUAGES.filter(([, pattern]) => pattern.test(title)).map(([code]) => code);
  if (found.length) return found;
  // Fansub releases keep the Japanese audio; other international ones are English.
  return /nyaa|anidex|tokyotosho/i.test(source) ? ['JA'] : ['EN'];
};

const voiceTag = (voices?: string[]): string => {
  const names = (voices || []).map(voice => voice.trim()).filter(Boolean);
  if (!names.length) return '';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
};

const releaseStream = ({server, title, magnet, quality, seeders, seedersAsOf, languages, extra = [], size}: {
  server: string;
  title: string;
  magnet: string;
  quality: string;
  seeders: number;
  /** When the count is an old snapshot rather than a live one. */
  seedersAsOf?: Date;
  languages: string[];
  extra?: string[];
  size: string;
}): Stream => {
  const seedersTag = seedersAsOf
    ? `≈${Math.max(0, seeders)} seeders (${String(seedersAsOf.getUTCMonth() + 1).padStart(2, '0')}.${seedersAsOf.getUTCFullYear()})`
    : `👤${Math.max(0, seeders)}`;
  const tags = [
    quality ? `${quality}p` : '',
    seedersTag,
    ...formatTags(title),
    ...languages,
    ...extra,
    size,
  ].filter(Boolean);
  return {
    server,
    title,
    link: magnet,
    type: 'torrent',
    quality: quality || undefined,
    tags,
    tag: tags.join(' • '),
  };
};

// JacRed's public mirror refreshes most records rarely. An old seeder count is
// shown as such and ranks after live counts, since the release may be gone.
const STALE_SEEDERS_MS = 45 * 24 * 60 * 60 * 1000;
const staleSince = (torrent: JacredTorrent, now: number): Date | undefined => {
  const updated = Date.parse(torrent.updateTime || torrent.createTime || '');
  return Number.isFinite(updated) && now - updated > STALE_SEEDERS_MS ? new Date(updated) : undefined;
};

export const jacredToStream = (torrent: JacredTorrent, now = Date.now()): Stream => {
  const international = INTERNATIONAL_TRACKERS.has(torrent.tracker);
  // Knaben mirrors end their names with the index they came from: "... | The Pirate Bay".
  const origin = international ? torrent.title.match(/\s+\|\s*([^|]+)$/)?.[1]?.trim() : undefined;
  const title = origin ? torrent.title.slice(0, torrent.title.lastIndexOf('|')).trim() : torrent.title;
  return releaseStream({
    server: origin || TRACKER_NAMES[torrent.tracker] || torrent.tracker.charAt(0).toUpperCase() + torrent.tracker.slice(1),
    title,
    magnet: torrent.magnet!,
    quality: jacredQuality(torrent),
    seeders: torrent.sid || 0,
    seedersAsOf: staleSince(torrent, now),
    languages: international
      ? releaseLanguages(title, origin || '')
      : torrent.tracker === 'toloka' ? ['UA'] : ['RU'],
    extra: [voiceTag(torrent.voices)],
    size: formatSize(torrent.size, torrent.sizeName),
  });
};

export const westernToStream = (hit: WesternHit, now = Date.now()): Stream => {
  const title = hit.title.trim();
  const hash = hit.hash.toLowerCase();
  const checked = hit.checkedAt && now - hit.checkedAt > STALE_SEEDERS_MS ? new Date(hit.checkedAt) : undefined;
  return releaseStream({
    server: hit.source,
    title,
    magnet: hit.magnet?.startsWith('magnet:')
      ? hit.magnet
      : `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`,
    quality: qualityFromTitle(title),
    seeders: hit.seeders,
    seedersAsOf: checked,
    languages: releaseLanguages(title, hit.source),
    size: formatSize(hit.bytes),
  });
};

const seedersOf = (stream: Stream): number => {
  const text = [...(stream.tags || []), stream.tag || ''].join(' ');
  return Number(text.match(/👤\s*(\d+)/)?.[1] || text.match(/\bS:\s*(\d+)/i)?.[1] || 0);
};

/**
 * Torrentio results keep their own relative order. A duplicate from another
 * source only lends its release name and its tracker list: Torrentio magnets
 * carry no trackers, so peers come slower without them.
 */
export const mergeTrackerStreams = (primary: Stream[], extra: Stream[]): Stream[] => {
  if (!extra.length) return primary;
  const byHash = new Map<string, Stream>();
  for (const stream of extra) {
    const hash = torrentHash(stream.link);
    const known = byHash.get(hash);
    if (hash && (!known || seedersOf(stream) > seedersOf(known))) byHash.set(hash, stream);
  }
  const merged = primary.map(stream => {
    const hash = torrentHash(stream.link);
    const twin = hash ? byHash.get(hash) : undefined;
    if (!twin) return stream;
    byHash.delete(hash);
    const bare = stream.link.startsWith('magnet:') && !/[?&]tr=/i.test(stream.link);
    return {...stream, title: stream.title || twin.title, link: bare ? twin.link : stream.link};
  });
  const added = [...byHash.values()];
  if (!added.length) return merged;
  const rank = (stream: Stream) => Number(stream.quality?.match(/\d{3,4}/)?.[0] || 0);
  const all = [...merged, ...added];
  // Debrid and direct links keep their place at the top.
  const direct = all.filter(stream => stream.type !== 'torrent');
  const torrents = all
    .filter(stream => stream.type === 'torrent')
    .map((stream, index) => ({stream, index}))
    .sort((a, b) =>
      rank(b.stream) - rank(a.stream) ||
      seedersOf(b.stream) - seedersOf(a.stream) ||
      a.index - b.index)
    .map(({stream}) => stream);
  return [...direct, ...torrents];
};

const withDeadline = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });

const searchCache = new Map<string, {at: number; results: Promise<any[]>}>();

// One request per query for a while: the next-episode prefetch repeats them.
const cachedSearch = <T>(key: string, search: () => Promise<T[]>): Promise<T[]> => {
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.results as Promise<T[]>;
  const results = search();
  searchCache.set(key, {at: Date.now(), results});
  results.catch(() => {
    if (searchCache.get(key)?.results === results) searchCache.delete(key);
  });
  return results;
};

// Hosts that failed recently, skipped until the time stored.
const hostSkipUntil = new Map<string, number>();
const hostUsable = (host: string) => (hostSkipUntil.get(host) || 0) < Date.now();
const markHost = (host: string, ok: boolean) => {
  if (ok) hostSkipUntil.delete(host);
  else hostSkipUntil.set(host, Date.now() + HOST_RETRY_MS);
};

/** GET a JSON document from an optional source; a failure marks its host. */
const getJson = async (host: string, path: string, params: Record<string, unknown>): Promise<any> => {
  try {
    const data = await requestJson(`${host}${path}`, {params});
    markHost(host, true);
    return data;
  } catch (error) {
    markHost(host, false);
    throw error;
  }
};

const updatedAt = (torrent: JacredTorrent) => Date.parse(torrent.updateTime || torrent.createTime || '') || 0;

/** Releases from every reachable JacRed mirror; the most recently updated record of a release wins. */
const searchJacred = (query: string): Promise<JacredTorrent[]> =>
  cachedSearch(`jacred:${query.toLowerCase()}`, async () => {
    const hosts = JACRED_HOSTS.filter(hostUsable);
    const answers: JacredTorrent[][] = [];
    let lastError: unknown = new Error('No JacRed mirror is reachable');
    // Once one mirror answered, a slow one gets a short grace period, not the
    // full request timeout.
    await new Promise<void>(resolve => {
      let pending = hosts.length;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        pending--;
        if (!pending) {
          if (grace) clearTimeout(grace);
          resolve();
        }
      };
      if (!pending) resolve();
      for (const host of hosts) {
        getJson(host, '/api/v1.0/torrents', {search: query, exact: true, ...(JACRED_KEYS[host] ? {apikey: JACRED_KEYS[host]} : {})})
          .then(data => {
            if (!Array.isArray(data)) throw new Error('Unexpected JacRed response');
            answers.push(data as JacredTorrent[]);
            grace = grace || setTimeout(resolve, MIRROR_GRACE_MS);
          })
          .catch(error => {
            lastError = error;
          })
          .finally(settle);
      }
    });
    if (!answers.length) throw lastError;
    const byHash = new Map<string, JacredTorrent>();
    for (const torrent of answers.flat()) {
      const hash = torrentHash(torrent.magnet) || `${torrent.tracker}:${torrent.title}`;
      const known = byHash.get(hash);
      if (!known || updatedAt(torrent) > updatedAt(known)) byHash.set(hash, torrent);
    }
    return [...byHash.values()];
  });

const searchKnaben = (query: string): Promise<WesternHit[]> =>
  cachedSearch(`knaben:${query.toLowerCase()}`, async () => {
    const data = await requestJson(KNABEN_API, {method: 'POST', body: {
      search_type: '100%',
      search_field: 'title',
      query,
      order_by: 'seeders',
      order_direction: 'desc',
      size: 150,
      hide_unsafe: true,
      hide_xxx: true,
    }});
    const hits = data?.hits;
    if (!Array.isArray(hits)) throw new Error('Unexpected Knaben response');
    return hits.map((hit: any): WesternHit => ({
      title: String(hit.title || ''),
      hash: String(hit.hash || torrentHash(hit.magnetUrl || '')),
      magnet: hit.magnetUrl || undefined,
      seeders: Number(hit.liveSeeders ?? hit.seeders ?? 0),
      bytes: Number(hit.bytes) || undefined,
      source: String(hit.tracker || 'Knaben'),
    }));
  });

const APIBAY = 'https://apibay.org';
const searchApibay = (query: string): Promise<WesternHit[]> =>
  cachedSearch(`apibay:${query.toLowerCase()}`, async () => {
    const data = await getJson(APIBAY, '/q.php', {q: query, cat: 200});
    if (!Array.isArray(data)) throw new Error('Unexpected apibay response');
    return data
      .filter((item: any) => item?.info_hash && !/^0+$/.test(item.info_hash))
      .map((item: any): WesternHit => ({
        title: String(item.name || ''),
        hash: String(item.info_hash),
        seeders: Number(item.seeders) || 0,
        bytes: Number(item.size) || undefined,
        source: 'The Pirate Bay',
      }));
  });

const TORRENTS_CSV = 'https://torrents-csv.com';
const searchTorrentsCsv = (query: string): Promise<WesternHit[]> =>
  cachedSearch(`torrentscsv:${query.toLowerCase()}`, async () => {
    const data = await getJson(TORRENTS_CSV, '/service/search', {q: query, size: 50});
    if (!Array.isArray(data?.torrents)) throw new Error('Unexpected Torrents-CSV response');
    return data.torrents.map((item: any): WesternHit => ({
      title: String(item.name || ''),
      hash: String(item.infohash || ''),
      seeders: Number(item.seeders) || 0,
      bytes: Number(item.size_bytes) || undefined,
      source: 'Torrents-CSV',
      checkedAt: Number(item.scraped_date) ? Number(item.scraped_date) * 1000 : undefined,
    }));
  });

const BITSEARCH = 'https://bitsearch.eu';
const searchBitsearch = (query: string): Promise<WesternHit[]> =>
  cachedSearch(`bitsearch:${query.toLowerCase()}`, async () => {
    const data = await getJson(BITSEARCH, '/api/v1/search', {q: query});
    const items = Array.isArray(data) ? data : data?.results;
    if (!Array.isArray(items)) throw new Error('Unexpected BitSearch response');
    return items.map((item: any): WesternHit => ({
      title: String(item.title || item.name || ''),
      hash: String(item.infohash || ''),
      seeders: Number(item.seeders) || 0,
      bytes: Number(item.size) || undefined,
      source: 'BitSearch',
      checkedAt: Date.parse(item.updatedAt || '') || undefined,
    }));
  });

const EZTV = 'https://eztvx.to';
/** Every EZTV release of a show (EZTV indexes TV only), a page of 100 at a time. */
const searchEztv = (imdbId: string): Promise<WesternHit[]> =>
  cachedSearch(`eztv:${imdbId}`, async () => {
    const id = imdbId.replace(/^tt/, '');
    const page = (number: number) => getJson(EZTV, '/api/get-torrents', {imdb_id: id, limit: 100, page: number});
    const first = await page(1);
    const pages = Math.min(5, Math.ceil((Number(first?.torrents_count) || 0) / 100));
    const rest = await Promise.allSettled(Array.from({length: Math.max(0, pages - 1)}, (_, index) => page(index + 2)));
    const torrents = [first, ...rest.map(result => (result.status === 'fulfilled' ? result.value : null))]
      .flatMap(data => (Array.isArray(data?.torrents) ? data.torrents : []));
    return torrents.map((item: any): WesternHit => ({
      title: String(item.title || item.filename || '').replace(/\s*EZTV\s*$/i, ''),
      hash: String(item.hash || ''),
      magnet: item.magnet_url || undefined,
      seeders: Number(item.seeds) || 0,
      bytes: Number(item.size_bytes) || undefined,
      source: 'EZTV',
    }));
  });

const russianTitleCache = new Map<string, Promise<string[]>>();

const wikidataRussianTitle = async (imdbId: string): Promise<string[]> => {
  const api = 'https://www.wikidata.org/w/api.php';
  const search = await requestJson(api, {
    params: {action: 'query', list: 'search', srsearch: `haswbstatement:P345=${imdbId}`, srlimit: 1, format: 'json'},
  });
  const entityId = search?.query?.search?.[0]?.title;
  if (!entityId) return [];
  const entity = await requestJson(api, {
    params: {action: 'wbgetentities', ids: entityId, props: 'labels', languages: 'ru', format: 'json'},
  });
  const label = entity?.entities?.[entityId]?.labels?.ru?.value;
  return typeof label === 'string' && label.trim() ? [label.trim()] : [];
};

// Only when the build supplies a TMDB key.
const tmdbApiKey = (): string => String((import.meta as any).env?.VITE_TMDB_API_KEY || '').trim();

// Only when the user or the build supplies a TMDB key.
const tmdbRussianTitle = async (target: TorrentioTarget): Promise<string[]> => {
  const apiKey = tmdbApiKey();
  if (!apiKey) return [];
  const mediaType = target.type === 'series' ? 'tv' : 'movie';
  const params = {api_key: apiKey, language: 'ru-RU'};
  let item: any;
  if (target.tmdbId) {
    item = await requestJson(`https://api.themoviedb.org/3/${mediaType}/${target.tmdbId}`, {params});
  } else {
    const found = await requestJson(`https://api.themoviedb.org/3/find/${target.imdbId}`, {
      params: {...params, external_source: 'imdb_id'},
    });
    item = (mediaType === 'tv' ? found?.tv_results : found?.movie_results)?.[0];
  }
  const title = item?.title || item?.name;
  return typeof title === 'string' && title.trim() ? [title.trim()] : [];
};

/** Russian titles (Wikidata, TMDB); Russian trackers name releases in Russian first. */
export const fetchRussianTitles = (target: TorrentioTarget): Promise<string[]> => {
  const cached = russianTitleCache.get(target.imdbId);
  if (cached) return cached;
  const titles = Promise.allSettled([wikidataRussianTitle(target.imdbId), tmdbRussianTitle(target)])
    .then(results => {
      const found = results.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
      if (!found.length && results.every(result => result.status === 'rejected')) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
      return [...new Set(found)];
    });
  russianTitleCache.set(target.imdbId, titles);
  titles.catch(() => {
    if (russianTitleCache.get(target.imdbId) === titles) russianTitleCache.delete(target.imdbId);
  });
  return titles;
};

/**
 * A title and its main part: trackers often drop a subtitle
 * ("Слово пацана. Кровь на асфальте" is also released as "Слово пацана").
 */
export const titleVariants = (titles: string[]): string[] => {
  const variants = titles.flatMap(title => {
    const main = title.split(/\s*(?:[.:]\s|\s[-–—]\s)/)[0]?.trim();
    // One word ("Mission" of "Mission: Impossible") would match unrelated releases.
    return main && /\S\s+\S/.test(main) && main !== title ? [title, main] : [title];
  });
  const seen = new Set<string>();
  return variants.filter(title => {
    const key = title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const pad = (value: number) => String(value).padStart(2, '0');

const westernQueries = (target: TorrentioTarget): string[] => {
  if (!target.title) return [];
  if (target.type === 'movie') {
    const {from} = yearRange(target.year);
    return [from ? `${target.title} ${from}` : target.title];
  }
  if (!target.season) return [target.title];
  const season = `S${pad(target.season)}`;
  return [
    ...(target.episode ? [`${target.title} ${season}E${pad(target.episode)}`] : []),
    `${target.title} ${season}`,
  ];
};

const fulfilled = <T>(results: PromiseSettledResult<T[]>[], source: string): T[] => {
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure && results.every(result => result.status === 'rejected')) {
    console.warn(`${source} search failed:`, failure.reason?.message || failure.reason);
  }
  return results.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
};

const searchJacredTarget = async (target: TorrentioTarget): Promise<Stream[]> => {
  // The original title is searched at once; the Russian ones once they are known.
  const original = titleVariants(target.title ? [target.title] : []);
  const searches = original.map(searchJacred);
  const russian = titleVariants(await withDeadline(
    fetchRussianTitles(target).catch(error => {
      console.warn('Russian title lookup failed:', error?.message || error);
      return [] as string[];
    }),
    TITLE_LOOKUP_BUDGET_MS,
    [] as string[],
  )).filter(title => !original.some(known => known.toLowerCase() === title.toLowerCase()));
  const results = await Promise.allSettled([...russian.map(searchJacred), ...searches]);
  return fulfilled(results, 'JacRed')
    .filter(torrent => matchesJacred(torrent, target))
    .map(torrent => jacredToStream(torrent));
};



const searchWesternTarget = async (target: TorrentioTarget): Promise<Stream[]> => {
  const queries = westernQueries(target);
  const searches = [searchKnaben, searchApibay, searchTorrentsCsv, searchBitsearch]
    .flatMap(search => queries.map(query => search(query)));
  if (target.type === 'series') searches.push(searchEztv(target.imdbId));
  const results = await Promise.allSettled(searches);
  // The highest seeder count reported for a release wins.
  const byHash = new Map<string, WesternHit>();
  for (const hit of fulfilled(results, 'International index')) {
    if (!matchesWestern(hit, target)) continue;
    const hash = hit.hash.toLowerCase();
    const known = byHash.get(hash);
    if (!known || hit.seeders > known.seeders) byHash.set(hash, hit);
  }
  return [...byHash.values()].map(hit => westernToStream(hit));
};

const searchTarget = async (target: TorrentioTarget): Promise<Stream[]> => {
  const [jacred, western] = await Promise.all([
    searchJacredTarget(target).catch(() => [] as Stream[]),
    searchWesternTarget(target).catch(() => [] as Stream[]),
  ]);
  const seen = new Set<string>();
  const streams = [...jacred, ...western].filter(stream => {
    const hash = torrentHash(stream.link);
    if (!hash || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
  console.log(`Extra torrent sources for ${target.imdbId}: JacRed ${jacred.length}, international ${western.length}, unique ${streams.length}`);
  return streams;
};

/** Releases from JacRed and Knaben for a Torrentio link; never throws. */
export const fetchExtraTorrentStreams = (
  link: string,
  routeType: string | undefined,
  signal?: AbortSignal,
): Promise<Stream[]> => {
  const target = parseTorrentioTarget(link, routeType);
  if (!target || signal?.aborted) return Promise.resolve([]);
  // A slow mirror must not hold back the Torrentio list for long. Searches
  // finish in the background on abort so their cache still helps the next try.
  return new Promise(resolve => {
    const abort = () => resolve([]);
    signal?.addEventListener('abort', abort);
    withDeadline(searchTarget(target), TOTAL_BUDGET_MS, [] as Stream[]).then(streams => {
      signal?.removeEventListener('abort', abort);
      resolve(streams);
    });
  });
};
