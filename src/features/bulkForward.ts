// Safe bulk operations: a throttled queue that runs Telegram calls one at a
// time with a gap between them, honours FLOOD_WAIT_X (sleeps exactly what
// Telegram asks + 1 s) and can be cancelled. Used by bulk forwarding so many
// messages can be forwarded without tripping Telegram's anti-spam limits.

export interface QueueOptions {
  /** Pause between two calls (ms). Default 1500. */
  gapMs?: number;
  /** Progress callback (done, total, waitingSeconds?). */
  onProgress?: (done: number, total: number, waitSec?: number) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(new Error("CANCELLED"))), { once: true });
  });

export function floodSeconds(e: any): number | null {
  const m = /FLOOD_WAIT_(\d+)|SLOWMODE_WAIT_(\d+)/.exec(String(e?.errorMessage || e?.message || ""));
  if (m) return Number(m[1] || m[2]);
  return typeof e?.seconds === "number" ? e.seconds : null;
}

/** Run `fn` over `items` sequentially with throttling. Returns failures. */
export async function runThrottled<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
  opts: QueueOptions = {},
): Promise<{ item: T; error: unknown }[]> {
  const gap = opts.gapMs ?? 1500;
  const failed: { item: T; error: unknown }[] = [];
  for (let i = 0; i < items.length; i++) {
    if (opts.signal?.aborted) throw new Error("CANCELLED");
    for (let attempt = 0; ; attempt++) {
      try {
        await fn(items[i]);
        break;
      } catch (e) {
        const wait = floodSeconds(e);
        if (wait != null && attempt < 5) {
          opts.onProgress?.(i, items.length, wait + 1);
          await sleep((wait + 1) * 1000, opts.signal);
          continue;
        }
        failed.push({ item: items[i], error: e });
        break;
      }
    }
    opts.onProgress?.(i + 1, items.length);
    if (i < items.length - 1) await sleep(gap, opts.signal);
  }
  return failed;
}

/** Split into chunks (Telegram forwards up to 100 ids per call; we use smaller safe batches). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
