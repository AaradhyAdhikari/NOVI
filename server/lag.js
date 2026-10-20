// How long Novi's one thread was blocked (anything blocking it delays every message): a timer every
// resolutionMs notes how late it fired. Settings → System shows it; a block over warnMs is logged so a slow
// moment can be traced afterwards.
export function createLagMeter({ resolutionMs = 50, warnMs = 1000, logger = console, keep = 1200 } = {}) {
  let last = Date.now();
  let worst = 0;
  const recent = []; // lateness of the last `keep` ticks (~1 min at 50 ms)
  const tick = setInterval(() => {
    const now = Date.now();
    const late = Math.max(0, now - last - resolutionMs);
    last = now;
    recent.push(late);
    if (recent.length > keep) recent.shift();
    if (late > worst) worst = late;
    if (late > warnMs) logger.warn?.(`[lag] Novi was blocked for ${late} ms`);
  }, resolutionMs);
  tick.unref?.();
  return {
    stats() {
      const sorted = [...recent].sort((a, b) => a - b);
      return { p99Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0, maxMs: worst };
    },
    reset() { recent.length = 0; worst = 0; },
    stop() { clearInterval(tick); },
  };
}
