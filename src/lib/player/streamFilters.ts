import type {Stream} from '../providers/types';

export type FilterableStream = Pick<Stream, 'quality' | 'tag' | 'tags'>;
const languages = [
  ['RU', /\b(RU|RUS|RUSSIAN)\b|русск|🇷🇺/i],
  ['EN', /\b(EN|ENG|ENGLISH|GB|US)\b|англий|🇬🇧|🇺🇸/i],
  ['UA', /\b(UA|UKR|UKRAINIAN)\b|україн|🇺🇦/i],
  ['MULTI', /\b(MULTI|DUAL)(?:[- ]AUDIO)?\b/i],
  ['JA', /\b(JA|JP|JAPANESE)\b|япон|🇯🇵/i],
  ['KO', /\b(KO|KR|KOREAN)\b|корей|🇰🇷/i],
  ['HI', /\b(HI|HINDI)\b|хинди|🇮🇳/i],
  ['ES', /\b(ES|SP|SPA|SPANISH)\b|испан|🇪🇸/i],
  ['FR', /\b(FR|FRE|FRENCH)\b|француз|🇫🇷/i],
  ['DE', /\b(DE|GER|GERMAN)\b|немец|🇩🇪/i],
  ['IT', /\b(IT|ITA|ITALIAN)\b|итальян|🇮🇹/i],
  ['PT', /\b(PT|BR|PORTUGUESE)\b|португал|🇵🇹|🇧🇷/i],
  ['TA', /\b(TA|TAMIL)\b/i],
  ['TE', /\b(TE|TZ|TELUGU)\b/i],
  ['ZH', /\b(ZH|CHINESE)\b|китай|🇨🇳/i],
] as const;

export const streamLanguages = (stream: FilterableStream): string[] => {
  const text = [stream.tag, ...(stream.tags || [])].filter(Boolean).join(' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)\b/gi, '');
  const found = languages.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  return found.length ? found : ['UNKNOWN'];
};
export const streamQuality = (stream: FilterableStream): string => {
  const quality = stream.quality?.trim() || '';
  if (/^(4k|uhd)$/i.test(quality)) return '2160';
  return quality.match(/\d{3,4}/)?.[0] || quality || 'UNKNOWN';
};
export const getStreamFilterOptions = (streams: FilterableStream[]) => ({
  qualities: [...new Set(streams.map(streamQuality))].sort((a, b) => (Number(b) || 0) - (Number(a) || 0)),
  languages: [...new Set(streams.flatMap(streamLanguages))].sort((a, b) => {
    const order = [...languages.map(([code]) => code), 'UNKNOWN'] as string[];
    return order.indexOf(a) - order.indexOf(b);
  }),
});
/**
 * What a source list opens with: Russian audio, or English when no release has
 * Russian, and the best quality among the releases in that language.
 */
export const defaultStreamFilters = (streams: FilterableStream[]): {qualities: string[]; languages: string[]} => {
  const language = ['RU', 'EN'].find(code => streams.some(stream => streamLanguages(stream).includes(code)));
  const pool = language ? streams.filter(stream => streamLanguages(stream).includes(language)) : streams;
  const best = Math.max(0, ...pool.map(stream => Number(streamQuality(stream)) || 0));
  return {languages: language ? [language] : [], qualities: best ? [String(best)] : []};
};

export const filterStreams = <T extends FilterableStream>(streams: T[], qualities: string[], selectedLanguages: string[]): T[] =>
  streams.filter(stream => (!qualities.length || qualities.includes(streamQuality(stream))) &&
    (!selectedLanguages.length || streamLanguages(stream).some(language => selectedLanguages.includes(language))));
