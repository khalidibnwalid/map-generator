import type { MapTheme, ThematicMode } from "../core/GPURenderer";
import type { SimEvent } from "../game/sim/Simulation";
import type { WorldData } from "../game/WorldData";

// Off-screen map rendering shared by the poster export and the nation fact
// sheet. Everything is laid out in "layout pixels" (what the live view would
// show) and drawn at `pixelRatio` device pixels each, so a 2K and an 8K poster
// have the same composition, only sharper.

export interface MapView {
  x: number; // target rectangle in the context, device pixels
  y: number;
  w: number;
  h: number;
  scale: number; // device pixels per cell
  offsetX: number; // screen = world * scale + offset, relative to the rectangle
  offsetY: number;
  pixelRatio: number;
  keep?: Set<number> | null; // nations drawn vividly; other land is dimmed
  waitForCities?: boolean; // wait (bounded) for detailed city plans in view
  onProgress?: (fraction: number, label: string) => void;
  canceled?: () => boolean;
}

// What the poster and fact sheet need from the app
export interface AtlasHost {
  getWorld(): WorldData;
  mapTheme(): MapTheme;
  thematicMode(): ThematicMode;
  simYear(): number; // 0 when history has not run
  simEvents(): SimEvent[];
  landArea(): number[]; // land cells per nation
  renderMapTo(ctx: CanvasRenderingContext2D, view: MapView): Promise<void>;
}

export interface Extent {
  x0: number; // cells; x0 may be negative or x1 past the width (wrapped)
  y0: number;
  x1: number;
  y1: number;
}

// Land owned by `keep`, optionally with their vassals
export function scopeNations(world: WorldData, picked: Iterable<number>, withVassals: boolean): Set<number> {
  const out = new Set<number>();
  for (const i of picked) if (world.nations[i]) out.add(i);
  if (withVassals)
    world.nations.forEach((n, i) => {
      if (n.overlord !== undefined && out.has(n.overlord)) out.add(i);
    });
  return out;
}

// Bounding box of the nations' land. Across the date line it takes the
// complement of the widest empty run of columns, so a realm split by the seam
// gets one tight box instead of the whole width.
export function nationsExtent(world: WorldData, keep: Set<number>): Extent | null {
  const W = world.width;
  const H = world.height;
  const cols = new Uint8Array(W);
  let y0 = H;
  let y1 = -1;
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      if (world.waterType[y * W + x] !== 0) continue;
      const n = col[y].nationIndex ?? -1;
      if (n < 0 || !keep.has(n)) continue;
      cols[x] = 1;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (y1 < 0) return null;
  // Widest circular gap of empty columns (two passes catch the one that wraps)
  let bestLen = 0;
  let bestEnd = 0; // first occupied column after the gap
  let run = 0;
  for (let k = 0; k < W * 2; k++) {
    if (cols[k % W]) {
      if (run > bestLen) {
        bestLen = run;
        bestEnd = k % W;
      }
      run = 0;
    } else run++;
  }
  const x0 = bestEnd;
  const span = W - bestLen;
  return { x0, y0, x1: x0 + span, y1: y1 + 1 };
}

// Pads an extent (at least minW cells wide) and widens it to an aspect ratio
// between minA and maxA
export function frameExtent(world: WorldData, e: Extent, pad: number, minA: number, maxA: number, minW = 0): Extent {
  let w = e.x1 - e.x0;
  let h = e.y1 - e.y0;
  const p = Math.max(4, Math.max(w, h) * pad);
  const cx = (e.x0 + e.x1) / 2;
  let cy = (e.y0 + e.y1) / 2;
  w = Math.max(minW, w + p * 2);
  h = Math.max(minW / maxA, h + p * 2);
  if (w / h < minA) w = h * minA;
  if (w / h > maxA) h = w / maxA;
  w = Math.min(w, world.width);
  h = Math.min(h, world.height);
  cy = Math.max(h / 2, Math.min(world.height - h / 2, cy));
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
}

// The whole world, starting at the emptiest column so continents are not cut
export function worldExtent(world: WorldData): Extent {
  const W = world.width;
  const H = world.height;
  const land = new Float32Array(W);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (world.waterType[y * W + x] === 0) land[x]++;
  let best = 0;
  let bestV = Infinity;
  const R = Math.max(2, Math.round(W / 80));
  for (let x = 0; x < W; x++) {
    let v = 0;
    for (let d = -R; d <= R; d++) v += land[(x + d + W) % W];
    if (v < bestV) {
      bestV = v;
      best = x;
    }
  }
  return { x0: best, x1: best + W, y0: 0, y1: H };
}

// One texel per cell: opaque where land belongs to someone outside `keep`
export function dimMask(world: WorldData, keep: Set<number>): HTMLCanvasElement {
  const W = world.width;
  const H = world.height;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const img = g.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (world.waterType[i] !== 0) continue;
      const n = col[y].nationIndex ?? -1;
      if (n >= 0 && keep.has(n)) continue;
      img.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Grays out land outside `keep` inside the view, a strip at a time so even an
// 8K poster needs only a small scratch canvas.
export function dimOutside(ctx: CanvasRenderingContext2D, world: WorldData, v: MapView, keep: Set<number>, theme: MapTheme) {
  const mask = dimMask(world, keep);
  const stripH = Math.min(v.h, 512);
  const strip = document.createElement("canvas");
  strip.width = v.w;
  strip.height = stripH;
  const s = strip.getContext("2d")!;
  const W = world.width;
  const span = W * v.scale;
  const k0 = Math.floor(-v.offsetX / span) - 1;
  const k1 = Math.ceil((v.w - v.offsetX) / span);
  const wash = theme === "Realistic" ? "rgba(70, 72, 76, 0.32)" : theme === "Historical" ? "rgba(236, 224, 196, 0.5)" : "rgba(246, 246, 243, 0.55)";
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let y = 0; y < v.h; y += stripH) {
    const h = Math.min(stripH, v.h - y);
    s.globalCompositeOperation = "source-over";
    s.filter = "none";
    s.clearRect(0, 0, v.w, stripH);
    s.imageSmoothingEnabled = true;
    for (let k = k0; k <= k1; k++) s.drawImage(mask, v.offsetX + k * span, v.offsetY - y, span, world.height * v.scale);
    s.globalCompositeOperation = "source-in";
    s.filter = "grayscale(0.85) contrast(0.85)";
    s.drawImage(ctx.canvas, v.x, v.y + y, v.w, h, 0, 0, v.w, h);
    s.filter = "none";
    // The wash also dims where canvas filters are unsupported
    s.globalCompositeOperation = "source-atop";
    s.fillStyle = wash;
    s.fillRect(0, 0, v.w, h);
    ctx.drawImage(strip, 0, 0, v.w, h, v.x, v.y + y, v.w, h);
  }
  ctx.restore();
}

// Makes ctx draw in layout pixels: every setTransform the map renderers issue
// is scaled by `pr` and shifted to (tx, ty). Returns a function that undoes it.
export function layoutContext(ctx: CanvasRenderingContext2D, pr: number, tx: number, ty: number): () => void {
  const base = CanvasRenderingContext2D.prototype.setTransform as (this: CanvasRenderingContext2D, ...m: [number, number, number, number, number, number] | [DOMMatrix2DInit]) => void;
  const self = ctx as unknown as Record<string, unknown>;
  const set = (a?: number | DOMMatrix2DInit, b = 0, c = 0, d = 1, e = 0, f = 0) => {
    if (typeof a === "number") base.call(ctx, a * pr, b * pr, c * pr, d * pr, e * pr + tx, f * pr + ty);
    else base.call(ctx, new DOMMatrix([pr, 0, 0, pr, tx, ty]).multiply(DOMMatrix.fromMatrix(a ?? {})));
  };
  self.setTransform = set;
  self.resetTransform = () => set(1, 0, 0, 1, 0, 0);
  set(1, 0, 0, 1, 0, 0);
  return () => {
    delete self.setTransform;
    delete self.resetTransform;
    base.call(ctx, 1, 0, 0, 1, 0, 0);
  };
}

export const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Triggers a browser download of a blob
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";
}

// Compact number: 12.3k, 4.5M
export function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return Math.round(n).toString();
}
