const decode = (value: string): string | undefined => {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return undefined; }
};

const magnetParts = (link?: string): string[] =>
  /^magnet:\?/i.test(link?.trim() || '') ? link!.trim().slice(8).split('#')[0].split('&') : [];

const parameter = (part: string): [string, string | undefined] => {
  const equals = part.indexOf('=');
  return equals < 0 ? ['', undefined] : [(decode(part.slice(0, equals)) || '').toLowerCase(), decode(part.slice(equals + 1))];
};

/** The torrent identity, independent of its filename, tracker or hash encoding. */
export const torrentInfoHash = (link?: string): string | undefined => {
  for (const part of magnetParts(link)) {
    const [key, value] = parameter(part);
    if (key !== 'xt') continue;
    const hash = value?.match(/^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i)?.[1];
    if (!hash) continue;
    if (hash.length === 40) return hash.toLowerCase();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let buffer = 0;
    let hex = '';
    for (const char of hash.toUpperCase()) {
      buffer = (buffer << 5) | alphabet.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        hex += ((buffer >>> bits) & 255).toString(16).padStart(2, '0');
        buffer &= (1 << bits) - 1;
      }
    }
    return hex;
  }
  return undefined;
};

/** Keep every tracker/peer address when mirrors advertise the same torrent. */
export const mergeTorrentMagnets = (primary: string, links: string[]): string => {
  const hash = torrentInfoHash(primary);
  if (!hash) return primary;
  const parts: string[] = [];
  const addresses = new Set<string>();
  let exactTopic = false;
  for (const part of magnetParts(primary)) {
    const [key, value] = parameter(part);
    if (key === 'xt' && value && /^urn:btih:/i.test(value)) {
      if (!exactTopic) parts.push(`xt=urn:btih:${hash}`);
      exactTopic = true;
    } else if ((key === 'tr' || key === 'x.pe') && value) {
      const id = `${key}:${value}`;
      if (!addresses.has(id)) parts.push(part);
      addresses.add(id);
    } else if (part) parts.push(part);
  }
  for (const link of links) {
    if (torrentInfoHash(link) !== hash) continue;
    for (const part of magnetParts(link)) {
      const [key, value] = parameter(part);
      if ((key !== 'tr' && key !== 'x.pe') || !value) continue;
      const id = `${key}:${value}`;
      if (!addresses.has(id)) parts.push(`${key}=${encodeURIComponent(value)}`);
      addresses.add(id);
    }
  }
  const merged = `magnet:?${parts.join('&')}`;
  return merged === primary ? primary : merged;
};
