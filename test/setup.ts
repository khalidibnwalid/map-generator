// Generation awaits a frame before starting; Node has no rAF
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
// Silence the per-stage timing log
const log = console.log;
console.log = (...a: unknown[]) => {
  if (typeof a[0] === "string" && a[0].startsWith("[MapGenerator]")) return;
  log(...a);
};
