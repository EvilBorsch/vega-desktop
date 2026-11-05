/**
 * Runs a task, and again after each delay while it keeps failing. A network
 * hiccup on first launch must not leave the app without its providers until
 * the next start. Returns a function that stops further attempts.
 */
export const retryWithDelays = (
  task: () => Promise<unknown>,
  delays: number[],
  onGiveUp?: (error: unknown) => void,
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (index: number) => {
    task().catch(error => {
      if (stopped) return;
      if (index >= delays.length) {
        onGiveUp?.(error);
        return;
      }
      timer = setTimeout(() => attempt(index + 1), delays[index]);
    });
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

/** Pauses between attempts to set up the default providers. */
export const DEFAULT_PROVIDER_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];
