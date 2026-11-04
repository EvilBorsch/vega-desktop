import type {FilterableStream} from './streamFilters';

/** Keep every provider detail, including seed counts, while removing repeats. */
export function streamBadges(stream: FilterableStream): string[] {
  const values = [
    stream.quality ? `${stream.quality.replace(/p$/i, '')}p` : '',
    ...(stream.tags || []),
    ...(stream.tag || '').split(/\s*[•·\n]\s*/),
  ];
  const seen = new Set<string>();
  return values.map(value => value.trim()).filter(value => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
