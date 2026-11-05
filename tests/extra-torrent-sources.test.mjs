import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceModule, moduleUrl} from './helpers/platform-modules.mjs';

let instance = 0;
async function loadSources(request = async () => { throw new Error('Unexpected network request'); }) {
  globalThis.__torrentSourceRequest = request;
  const network = moduleUrl(`export const instance=${++instance}; export const platformFetch=(...args)=>globalThis.__torrentSourceRequest(...args);`);
  const identity = await sourceModule('lib/providers/torrentIdentity.ts');
  return import(await sourceModule('lib/providers/extraTorrentSources.ts', {'../../platform/network': network, './torrentIdentity': identity}));
}

test('a timed-out source keeps completed releases; late results cannot mutate them', async () => {
  const {collectSearchResults} = await loadSources();
  let complete;
  const slow = new Promise(resolve => { complete = resolve; });
  const result = await collectSearchResults([Promise.resolve(['Russian release']), slow], 20);
  assert.deepEqual(result, ['Russian release']);
  complete(['late release']);
  await Promise.resolve();
  assert.deepEqual(result, ['Russian release']);
  assert.deepEqual(await collectSearchResults([Promise.reject(new Error('offline')), Promise.resolve(['release'])], 14000), ['release']);
  assert.deepEqual(await collectSearchResults([], 14000), []);
});

test('JacBlack native tracker lists keep Russian, English, Japanese and Ukrainian labels separate', async () => {
  const {jacredToStream, mergeJacred} = await loadSources();
  const hit = {title: 'The Whale (2022) 1080p', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, sid: 12};
  const english = jacredToStream({...hit, tracker: 'piratebay, yts'});
  assert.equal(english.server, 'The Pirate Bay · YTS');
  assert.ok(english.tags.includes('EN'));
  assert.ok(!english.tags.includes('RU'));
  const russian = jacredToStream({...hit, tracker: 'rutracker, kinozal, bitru'});
  assert.equal(russian.server, 'RuTracker · Kinozal · BitRu');
  assert.ok(russian.tags.includes('RU'));
  assert.ok(jacredToStream({...hit, tracker: 'nyaa'}).tags.includes('JA'));
  assert.ok(jacredToStream({...hit, tracker: 'mazepa, toloka'}).tags.includes('UA'));
  const [merged] = mergeJacred([{...hit, tracker: 'rutracker, kinozal'}, {...hit, tracker: 'kinozal', sid: 4}]);
  assert.deepEqual(merged.trackers, ['rutracker', 'kinozal']);
});

test('new aggregators are queried through both APIs with public keys and merged by hash despite offline sources', async () => {
  const requests = [];
  const hash = 'b'.repeat(40);
  const hit = {tracker: 'rutracker, kinozal', title: 'The Whale (2022) 1080p', relased: 2022, sid: 12, magnet: `magnet:?xt=urn:btih:${hash}`};
  const sources = await loadSources(async url => {
    const target = new URL(url);
    requests.push(target);
    if (target.host === 'www.wikidata.org') return Response.json({query: {search: []}});
    if (target.host === 'jacred.su') throw new Error('Offline mirror');
    if (target.pathname === '/api/v1.0/torrents') return Response.json(target.host === 'jac.black' ? [hit] : []);
    if (target.pathname === '/api/v2.0/indexers/all/results') return Response.json({Results: target.host === 'jac.stull.xyz' ? [{Tracker: 'rutracker', Title: hit.title, Seeders: 5, MagnetUri: hit.magnet, info: {relased: 2022}}] : []});
    throw new Error('Optional source offline');
  });
  const streams = await sources.fetchExtraTorrentStreams(JSON.stringify({imdbId: 'tt13833688', type: 'movie', title: 'The Whale', year: '2022'}), 'movie');
  assert.equal(streams.length, 1);
  assert.ok(streams[0].tags.includes('RU'));
  for (const host of ['jac.black', 'nmjc.duckdns.org', 'jacred.stream', 'jac.stull.xyz']) {
    assert.ok(requests.some(url => url.host === host && url.pathname === '/api/v1.0/torrents'), `${host} native API`);
    const jackett = requests.find(url => url.host === host && url.pathname === '/api/v2.0/indexers/all/results');
    assert.ok(jackett, `${host} Jackett API`);
    assert.equal(jackett.searchParams.get('Category[]'), '2000');
    assert.equal(jackett.searchParams.get('apikey') || '', host === 'jacred.stream' ? 'pp' : host === 'jac.stull.xyz' ? '1' : '');
  }
});

test('Russian audio survives deduplication against a stronger international result and Torrentio', async () => {
  const {mergeByHash, mergeTrackerStreams} = await loadSources();
  const link = `magnet:?xt=urn:btih:${'c'.repeat(40)}`;
  const english = {link, type: 'torrent', server: 'Comet', tags: ['EN', '👤99', '2 GB'], tag: 'EN • 👤99 • 2 GB'};
  const russian = {link, type: 'torrent', server: 'RuTracker', tags: ['RU', '👤4']};
  const [merged] = mergeByHash([english, russian]);
  assert.deepEqual(merged.tags, ['EN', '👤99', '2 GB', 'RU']);
  assert.equal(merged.tag, 'EN • 👤99 • 2 GB • RU');
  assert.deepEqual(mergeTrackerStreams([english], [russian])[0].tags, merged.tags);
  assert.equal(mergeTrackerStreams([english], [russian])[0].server, 'Comet');
});

test('provider duplicates collapse without extras while independent hashes stay separate', async () => {
  const {mergeTrackerStreams, torrentHash} = await loadSources();
  const a = '0123456789abcdef0123456789abcdef01234567';
  const b = '1111111111111111111111111111111111111111';
  const row = (hash, server) => ({link: `magnet:?xt=urn:btih:${hash}`, server, type: 'torrent', title: 'Same movie.mkv', tags: ['RU', '2 GB']});
  const direct = {link: 'https://cdn/movie.mp4', type: 'mp4', server: 'CDN'};
  const merged = mergeTrackerStreams([direct, row(a, 'Rutor'), row(a.toUpperCase(), 'RuTracker'), row(b, 'Kinozal')], []);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], direct);
  assert.deepEqual(merged.filter(x => x.type === 'torrent').map(x => torrentHash(x.link)), [a, b]);
});

test('one info hash retains all distinct tracker addresses', async () => {
  const {mergeByHash} = await loadSources();
  const hash = '0123456789abcdef0123456789abcdef01234567';
  const row = (tr, server) => ({link: `magnet:?xt=urn:btih:${hash}&tr=${encodeURIComponent(tr)}`, server, type: 'torrent'});
  const [merged] = mergeByHash([row('udp://first.test:80', 'Rutor'), row('https://second.test/announce', 'RuTracker')]);
  assert.deepEqual(new URLSearchParams(merged.link.slice(8)).getAll('tr'), ['udp://first.test:80', 'https://second.test/announce']);
});

test('encoded and Base32 hash forms normalize without accepting invalid hash prefixes', async () => {
  const {torrentHash} = await loadSources();
  assert.equal(torrentHash('magnet:?xt=urn%3Abtih%3A0123456789ABCDEF0123456789ABCDEF01234567'), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(torrentHash('magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH'), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(torrentHash('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567z'), '');
});

test('source badges omit dated peer snapshots but retain current measured counts', async () => {
  const {streamBadges} = await import(await sourceModule('lib/player/streamBadges.ts'));
  assert.deepEqual(streamBadges({quality: '1080', tags: ['≈143 seeders, 8 leechers (02.2026)', 'RU', '👤6'], tag: '≈143 seeders, 8 leechers (02.2026) • WEB-DL • ⬇2 • 2 GB'}), ['1080p', 'RU', '👤6', 'WEB-DL', '⬇2', '2 GB']);
});

test('language enrichment preserves provider metadata split between tag and tags', async () => {
  const {mergeTrackerStreams} = await loadSources();
  const link = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
  const original = {link, type: 'torrent', server: 'Provider', tags: ['EN'], tag: 'WEB-DL • HDR • 👤8', headers: {Referer: 'https://provider.test/'}};
  const [merged] = mergeTrackerStreams([original], [{link, type: 'torrent', server: 'RuTracker', tags: ['RU']}]);
  assert.deepEqual(merged.tags, ['EN', 'WEB-DL', 'HDR', '👤8', 'RU']);
  assert.deepEqual(merged.headers, original.headers);
  assert.deepEqual(original.tags, ['EN']);
});
