export type TorrentFileInfo = {index: number; name: string; path?: string; size: number};
export type EpisodeTarget = {season?: number; episode: number};

const VIDEO_EXTENSIONS = /\.(mp4|mkv|avi|webm|mov|ts|flv|wmv|m4v)$/i;
const NOT_EPISODE = /(^|[^a-z])(sample|trailer|featurette|extras?)([^a-z]|$)/i;

// Season and episode written in a file name, most specific patterns first.
const SEASON_EPISODE = [/s(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)/i, /(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)/i];
const EPISODE_ONLY = [
  /(?:^|[^a-z])(?:e|ep|episode)[ ._-]*(\d{1,3})(?!\d)/i,
  /(?:серия|серии|эпизод)[ ._-]*(\d{1,3})(?!\d)/i,
  /(\d{1,3})[ ._-]*(?:серия|эпизод)/i,
];
const SEASON_FOLDER = /(?:season|сезон)[ ._-]*(\d{1,2})|(?:^|\/)s(\d{1,2})(?:\/|$)/i;

/** Season and episode of a Torrentio episode link (a JSON payload). */
export const episodeTargetFromLink = (link?: string): EpisodeTarget | undefined => {
  if (!link?.startsWith('{')) return undefined;
  try {
    const payload = JSON.parse(link);
    const episode = Number(payload?.episode);
    if (!Number.isInteger(episode) || episode <= 0) return undefined;
    const season = Number(payload?.season);
    return Number.isInteger(season) && season > 0 ? {season, episode} : {episode};
  } catch {
    return undefined;
  }
};

const parseEpisode = (file: TorrentFileInfo): {season?: number; episode: number} | undefined => {
  for (const pattern of SEASON_EPISODE) {
    const match = file.name.match(pattern);
    if (match) return {season: Number(match[1]), episode: Number(match[2])};
  }
  const folder = (file.path ?? '').match(SEASON_FOLDER);
  const season = folder ? Number(folder[1] ?? folder[2]) : undefined;
  for (const pattern of EPISODE_ONLY) {
    const match = file.name.match(pattern);
    if (match) return {season, episode: Number(match[1])};
  }
  return undefined;
};

const largest = (files: TorrentFileInfo[]) =>
  files.reduce((best, file) => (file.size > best.size ? file : best)).index;

/**
 * File to stream from a torrent. Movies take the largest video. A series episode
 * must not: season packs hold every episode and the largest is often the last.
 */
export const pickVideoFileIndex = (files: TorrentFileInfo[], target?: EpisodeTarget): number => {
  const videos = files.filter(file => VIDEO_EXTENSIONS.test(file.name));
  if (videos.length === 0) return files[0]?.index ?? 0;
  const episodes = videos.filter(file => !NOT_EPISODE.test(file.name));
  const candidates = episodes.length > 0 ? episodes : videos;
  if (!target || candidates.length === 1) return largest(candidates);

  const matching = candidates.filter(file => {
    const parsed = parseEpisode(file);
    return parsed?.episode === target.episode &&
      (parsed.season === undefined || target.season === undefined || parsed.season === target.season);
  });
  if (matching.length > 0) return largest(matching);

  // Names without episode numbers: packs list episodes in order.
  if (candidates.some(file => parseEpisode(file))) return largest(candidates);
  const ordered = [...candidates].sort((a, b) =>
    (a.path ?? a.name).localeCompare(b.path ?? b.name, undefined, {numeric: true}));
  return (ordered[target.episode - 1] ?? ordered[0]).index;
};
