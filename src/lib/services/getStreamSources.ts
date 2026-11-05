import {providerManager} from './ProviderManager';
import {fetchExtraTorrentStreams, mergeTrackerStreams} from '../providers/extraTorrentSources';
import type {Stream} from '../providers/types';

/** The same tracker catalog and hash deduplication for watching and downloading. */
export async function getStreamSources(args: Parameters<typeof providerManager.getStream>[0]): Promise<Stream[]> {
  const extra = args.providerValue === 'torrentio'
    ? fetchExtraTorrentStreams(args.link, args.type, args.signal)
    : Promise.resolve([] as Stream[]);
  let primary: Stream[] = [];
  try {
    primary = (await providerManager.getStream(args)) || [];
  } catch (error) {
    if (!(await extra).length) throw error;
    console.warn('Provider streams failed; showing tracker releases:', error);
  }
  return mergeTrackerStreams(primary, await extra);
}
