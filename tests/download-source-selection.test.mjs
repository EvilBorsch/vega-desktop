import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {sourceModule, moduleUrl} from './helpers/platform-modules.mjs';
const require = createRequire(import.meta.url);
const pkg = name => pathToFileURL(require.resolve(name)).href;
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const react = pkg('react');
const identity = await sourceModule('lib/providers/torrentIdentity.ts');
const filters = await sourceModule('lib/player/streamFilters.ts');
const badges = await sourceModule('lib/player/streamBadges.ts');
const health = moduleUrl(`import {torrentInfoHash} from ${JSON.stringify(identity)};
export const streamInfoHash=s=>torrentInfoHash(s?.link);export const liveSeeders=()=>0;
export const useSwarmHealth=(streams,options)=>{globalThis.__downloadTest.health.push(options);return {visible:streams,hidden:[],checking:globalThis.__downloadTest.checking}};`);
const transport = moduleUrl('export const torrentEngine=async()=>({});');
const host = moduleUrl('export const isTauriRuntime=()=>false;');
const swarmActual = await sourceModule('lib/player/swarmTests.ts', {
  react, zustand: pkg('zustand'), '../services/torrentEngine': transport, '../../platform/host': host,
  './swarmHealth': health, './streamFilters': filters,
});
const swarm = moduleUrl(`export * from ${JSON.stringify(swarmActual)};
export const useSwarmTests=(streams,enabled)=>{globalThis.__downloadTest.speed.push(enabled);return {results:globalThis.__downloadTest.results,running:{},live:{}}};
export const stopSwarmTests=async()=>{globalThis.__downloadTest.stops++;await globalThis.__downloadTest.wait;};
export const claimSwarmTest=async()=>{globalThis.__downloadTest.claims++;};`);
const focus = moduleUrl(`import React from ${JSON.stringify(react)};
export const FocusContext=React.createContext('test');export const useFocusable=()=>({ref:null,focusKey:'test',focusSelf:()=>{}});`);
const button = moduleUrl(`import React from ${JSON.stringify(react)};
export const FocusableButton=props=>{globalThis.__downloadTest.buttons.push(props);return React.createElement('button',{'aria-label':props['aria-label']},props.children);};`);
const icons = moduleUrl(`import React from ${JSON.stringify(react)};const Icon=()=>React.createElement('span');
export const LuArrowLeft=Icon,LuPlay=Icon,LuDownload=Icon,LuX=Icon,LuCircleAlert=Icon,LuCopy=Icon,LuCheck=Icon,LuTrash2=Icon,LuCaptions=Icon,LuLoaderCircle=Icon;`);
async function componentModule(file, imports) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  let js = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
  js = js.replace(/import ["'][^"']+\.css["'];?/g, '');
  for (const [name, url] of Object.entries(imports)) js = js.replaceAll(JSON.stringify(name), JSON.stringify(url));
  return moduleUrl(js);
}
const picker = await componentModule('components/player/SourcePickerDialog.tsx', {
  react, '@noriginmedia/norigin-spatial-navigation-react': focus, 'react-icons/lu': icons,
  '../../lib/player/streamFilters': filters, '../../lib/player/streamBadges': badges,
  '../../lib/player/swarmHealth': health, '../../lib/player/swarmTests': swarm, '../layout/FocusableButton': button,
});
const dialog = await componentModule('components/DownloadServerDialog.tsx', {
  react, '@noriginmedia/norigin-spatial-navigation-react': focus, 'react-icons/lu': icons,
  '../lib/storage': moduleUrl('export const settingsStorage={isTvModeEnabled:()=>false};'),
  './layout/FocusableButton': button, './player/SourcePickerDialog': picker, '../lib/player/swarmHealth': health,
});
const {DownloadServerDialog} = await import(dialog);
const release = n => ({server: `Tracker ${n}`, type: 'torrent', quality: '1080', tags: ['RU'], link: `magnet:?xt=urn:btih:${String(n).repeat(40)}`});
const streams = [release(1), release(2)];
const setup = () => globalThis.__downloadTest = {health: [], speed: [], results: {}, buttons: [], stops: 0, claims: 0, checking: false};
const render = overrides => renderToStaticMarkup(React.createElement(DownloadServerDialog, {
  isOpen: true, streams, episodeTitle: 'Movie', onClose() {}, onSelect() {}, ...overrides,
}));

test('desktop download uses the watching filters, measured order and download action', async () => {
  const state = setup();
  const result = speed => ({metadata: true, speed, maxSpeed: speed, testedAt: Date.now()});
  state.results = {['1'.repeat(40)]: result(100_000), ['2'.repeat(40)]: result(5_000_000)};
  const selected = [];
  let closes = 0;
  const html = render({onSelect: stream => selected.push(stream), onClose: () => closes++});
  assert.match(html, /Choose a download source/);
  assert.match(html, /Quality/);
  assert.match(html, /Language/);
  assert.match(html, /Fastest first/);
  assert.ok(html.indexOf('Download Tracker 2') < html.indexOf('Download Tracker 1'));
  await state.buttons.find(button => button['aria-label'] === 'Download Tracker 2').onClick();
  assert.deepEqual(selected, [streams[1]]);
  assert.equal(closes, 1);
  assert.equal(state.stops, 1);
  assert.equal(state.claims, 0);
});
test('desktop download waits for fresh counts and does no work while closed', () => {
  const state = setup(); state.checking = true;
  render();
  assert.equal(state.health[0].enabled, true);
  assert.equal(state.speed.at(-1), false);
  setup(); render({isOpen: false});
  assert.deepEqual(globalThis.__downloadTest.health, []);
  assert.deepEqual(globalThis.__downloadTest.speed, []);
});
test('desktop waits for temporary measurement cleanup before dispatching download', async () => {
  const state = setup(); let finish; let selected = false;
  state.wait = new Promise(resolve => {finish = resolve;});
  render({onSelect: () => {selected = true;}});
  const choosing = state.buttons.find(button => button['aria-label'] === 'Download Tracker 1').onClick();
  assert.equal(selected, false);
  finish(); await choosing;
  assert.equal(selected, true);
});
test('watching still claims the measured swarm and dispatches playback', async () => {
  const state = setup(); const {SourcePickerDialog} = await import(picker); let selected;
  renderToStaticMarkup(React.createElement(SourcePickerDialog, {streams, onBack() {}, onSelect: stream => {selected = stream;}}));
  await state.buttons.find(button => button['aria-label'] === 'Play Tracker 1').onClick();
  assert.equal(selected, streams[0]);
  assert.equal(state.claims, 1);
  assert.equal(state.stops, 0);
});

test('watching and downloading share extra Russian sources and hash deduplication', async () => {
  const sources = await sourceModule('lib/providers/extraTorrentSources.ts', {'../../platform/network': moduleUrl('export const platformFetch=()=>{};'), './torrentIdentity': identity});
  const extras = moduleUrl(`export {mergeTrackerStreams} from ${JSON.stringify(sources)};export const fetchExtraTorrentStreams=async()=>globalThis.__sourceExtras;`);
  const manager = moduleUrl('export const providerManager={getStream:async()=>globalThis.__sourcePrimary};');
  const {getStreamSources} = await import(await sourceModule('lib/services/getStreamSources.ts', {'./ProviderManager': manager, '../providers/extraTorrentSources': extras}));
  globalThis.__sourcePrimary = [streams[0]]; globalThis.__sourceExtras = streams;
  for (const isDownload of [false, true]) {
    assert.deepEqual((await getStreamSources({link: 'tt123', type: 'movie', providerValue: 'torrentio', isDownload})).map(stream => stream.link), streams.map(stream => stream.link));
  }
});
