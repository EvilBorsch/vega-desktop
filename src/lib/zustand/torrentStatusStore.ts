import { create } from "zustand";

/** What a starting torrent stream is doing, for the player's loading screen. */
export interface TorrentStatus {
  active: boolean;
  title: string;
  detail: string;
  startedAt: number;
}

interface TorrentStatusState extends TorrentStatus {
  set: (status: Partial<TorrentStatus>) => void;
  clear: () => void;
}

const idle: TorrentStatus = { active: false, title: "", detail: "", startedAt: 0 };

export const useTorrentStatusStore = create<TorrentStatusState>((set) => ({
  ...idle,
  set: (status) => set((current) => ({ ...current, ...status })),
  clear: () => set(idle),
}));
