import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {sourceModule, moduleUrl} from './helpers/platform-modules.mjs';

const require = createRequire(import.meta.url);
const pkg = name => pathToFileURL(require.resolve(name)).href;
const transport = moduleUrl('export const torrentEngine=async()=>({});');
const host = moduleUrl('export const isTauriRuntime=()=>false;');
const identity = await sourceModule('lib/providers/torrentIdentity.ts');
const health = await sourceModule('lib/player/swarmHealth.ts', {
  react: pkg('react'), '@tanstack/react-query': pkg('@tanstack/react-query'),
  '../providers/torrentIdentity': identity, '../services/torrentEngine': transport, '../../platform/host': host,
});
const filters = await sourceModule('lib/player/streamFilters.ts');
const tools = await import(await sourceModule('lib/player/swarmTests.ts', {
  react: pkg('react'), zustand: pkg('zustand'), '../services/torrentEngine': transport,
  '../../platform/host': host, './swarmHealth': health, './streamFilters': filters,
}));
const {withLiveCounts, applySwarmHealth} = await import(health);
const hash = '0123456789abcdef0123456789abcdef01234567';
const release = {link: `magnet:?xt=urn:btih:${hash}`, type: 'torrent', server: 'Tracker', tags: ['RU', '👤200', '⬇90']};

test('fresh tracker counts replace larger index numbers, including zero', () => {
  assert.deepEqual(withLiveCounts(release, {seeders: 12, leechers: 3}).tags, ['RU', '👤12', '⬇3']);
  assert.deepEqual(withLiveCounts(release, {seeders: 0, leechers: 0}).tags, ['RU', '👤0']);
  assert.equal(withLiveCounts(release), release);
});

test('empty DHT answers do not discard a release before its speed can be measured', () => {
  const other = {...release, tags: ['RU']};
  const state = applySwarmHealth([other], {peers: {[hash]: 0, ['f'.repeat(40)]: 12}}, new Set(), new Set());
  assert.equal(state.visible.length, 1);
  assert.equal(state.hidden.length, 0);
});

test('new releases get their first chance before a failed torrent is retried', () => {
  const next = {...release, link: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111'};
  const failed = {testedAt: Date.now(), metadata: false};
  assert.deepEqual(tools.nextToTest([release, next], {[hash]: failed}, {}, {[hash]: 1}), ['1111111111111111111111111111111111111111', hash]);
});

test('a measured fast release rises above the swarm with the most advertised seeds', () => {
  const fast = {...release, link: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111', tags: ['👤1']};
  const result = speed => ({metadata: true, peers: 5, speed, maxSpeed: speed, testedAt: Date.now()});
  assert.equal(tools.sortBySpeed([release, fast], {[hash]: result(350_000), ['1111111111111111111111111111111111111111']: result(5_000_000)}, 'speed')[0], fast);
});

test('expired early results cannot starve a never-attempted tail release', () => {
  const tail = {...release, link: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111'};
  const expired = {metadata: true, speed: 500_000, testedAt: Date.now() - 31 * 60 * 1000};
  assert.deepEqual(tools.nextToTest([release, tail], {[hash]: expired}, {}), ['1111111111111111111111111111111111111111', hash]);
});

test('an unavailable measurement does not invent an empty swarm or playback failure', () => {
  assert.deepEqual(tools.describeTest({unavailable: true, metadata: false}), {text: 'Speed check unavailable', tone: 'pending'});
});
