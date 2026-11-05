import { invoke } from "@tauri-apps/api/core";

let port: Promise<number> | undefined;

/** Port of vega-torrentd, the libtorrent engine the app starts. */
export const torrentEnginePort = (): Promise<number> => {
  port =
    port ||
    invoke<number>("get_torrent_api_port").catch((error) => {
      port = undefined;
      throw error;
    });
  return port;
};

/** POSTs JSON to the engine and returns its JSON answer. */
export const torrentEngine = async <T = unknown>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${await torrentEnginePort()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Torrent engine: HTTP ${response.status}`);
  return (await response.json()) as T;
};
