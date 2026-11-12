import type { MapTheme, RenderLayers } from "../core/GPURenderer";
import { isAutonomous, provinceTypeInfo } from "../game/provinceTypes";
import type { WorldData } from "../game/WorldData";
import { compact, type MapStyle, type MapView } from "./AtlasRender";
import type { CanvasTheme } from "./themes";

// Map styles a poster can ask for instead of the live layers:
//  "provinces": an administrative map. Every province gets its own shade of
//   its realm's color (neighbors never share one), realm borders stay strong
//   and province borders thin, names sit at each province's roomiest spot.
//   For selected nations the neighbors are grayed, the realm casts a soft
//   shadow, its capital and provincial seats are marked and the legend lists
//   the provinces with their area, people and kind.
//  "flags": nations as flags (see FlagMapRenderer).

export type PosterStyle = MapStyle | "live";

export const MAP_STYLES: { value: PosterStyle; label: string }[] = [
  { value: "live", label: "As shown" },
  { value: "provinces", label: "Provinces" },
  { value: "flags", label: "Flags" },
];

// The layers a style draws, over the live ones
export function styledLayers<T extends RenderLayers & { labels: boolean; flags: boolean; flagmap: boolean }>(L: T, style?: MapStyle): T {
  if (style === "flags") return { ...L, nations: true, borders: true, provinces: false, flagmap: true, flags: false };
  if (style === "provinces")
    return { ...L, nations: true, borders: true, provinces: true, labels: true, flagmap: false, flags: false, provinceShade: 0, fillMin: 0.72, provinceFill: true, pois: false, resources: false, trade: false };
  return L;
}

// Lettering of the poster themes (see PosterDecor's styles)
const LETTERING: Record<MapTheme, { name: string; caps: boolean }> = {
  Historical: { name: "'IM Fell English', Georgia, serif", caps: false },
  Atlas: { name: "Inter, 'Segoe UI', system-ui, sans-serif", caps: true },
  Realistic: { name: "'Cormorant Garamond', Georgia, serif", caps: false },
};

// --- Colors ---

function hexToHsl(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1, 7), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

// Shades of one realm color: lighter, darker and slightly warmer or cooler
function shadesOf(color: string): number[] {
  const [h, s0, l0] = hexToHsl(color);
  const s = Math.min(0.75, s0);
  const l = Math.max(0.34, Math.min(0.66, l0));
  const steps: [number, number, number][] = [
    [0, 0, 0],
    [0, -0.05, 0.14],
    [0, 0.04, -0.12],
    [14, 0, 0.06],
    [-14, 0.02, -0.05],
    [0, -0.12, 0.24],
    [8, 0.05, -0.2],
  ];
  return steps.map(([dh, ds, dl]) => hslToRgb((h + dh + 360) % 360, Math.max(0, Math.min(1, s + ds)), Math.max(0.12, Math.min(0.9, l + dl))));
}

export const rgbHex = (v: number) => "#" + v.toString(16).padStart(6, "0");

// A color per province (0xRRGGBB): shades of its realm's color, chosen so that
// provinces sharing a border never share a shade (greedy graph coloring)
export function provinceColors(world: WorldData): number[] {
  const W = world.width;
  const H = world.height;
  const P = world.provinces.length;
  const nb: Set<number>[] = world.provinces.map(() => new Set());
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    const right = world.grid[(x + 1) % W];
    for (let y = 0; y < H; y++) {
      const c = col[y];
      const p = c.provinceIndex ?? -1;
      if (c.isWater || p < 0 || p >= P) continue;
      const link = (o: (typeof col)[number] | undefined) => {
        const q = o?.provinceIndex ?? -1;
        if (!o || o.isWater || q < 0 || q === p || q >= P) return;
        nb[p].add(q);
        nb[q].add(p);
      };
      link(right[y]);
      if (y + 1 < H) link(col[y + 1]);
    }
  }
  const out = new Array<number>(P).fill(-1);
  const byNation = new Map<number, number[]>();
  world.provinces.forEach((p, i) => {
    const list = byNation.get(p.nationIndex) ?? [];
    list.push(i);
    byNation.set(p.nationIndex, list);
  });
  for (const [n, list] of byNation) {
    const shades = shadesOf(world.nations[n]?.color ?? "#888888");
    const used = new Array<number>(shades.length).fill(0);
    const pick = new Map<number, number>();
    list.sort((a, b) => nb[b].size - nb[a].size || a - b);
    for (const i of list) {
      const taken = new Set<number>();
      for (const q of nb[i]) if (pick.has(q)) taken.add(pick.get(q)!);
      let best = -1;
      for (let k = 0; k < shades.length; k++) if (!taken.has(k) && (best < 0 || used[k] < used[best])) best = k;
      if (best < 0) best = used.indexOf(Math.min(...used));
      pick.set(i, best);
      used[best]++;
      out[i] = shades[best];
    }
  }
  return out;
}

// --- Label spots ---

interface Spot {
  x: number; // cells
  y: number;
  room: number; // cells to the province's edge
  cells: number;
}

// For each province, the land cell farthest inside it (its roomiest spot)
function provinceSpots(world: WorldData): (Spot | null)[] {
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const prov = new Int32Array(N).fill(-1);
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) if (!col[y].isWater) prov[y * W + x] = col[y].provinceIndex ?? -1;
  }
  const dist = new Uint16Array(N);
  const queue = new Int32Array(N);
  let tail = 0;
  for (let i = 0; i < N; i++) {
    const p = prov[i];
    if (p < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    if (y === 0 || y === H - 1 || prov[i - W] !== p || prov[i + W] !== p || prov[y * W + ((x + 1) % W)] !== p || prov[y * W + ((x - 1 + W) % W)] !== p) {
      dist[i] = 1;
      queue[tail++] = i;
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % W;
    const y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const k = ny * W + ((x + dx + W) % W);
        if (dist[k] || prov[k] !== prov[i]) continue;
        dist[k] = dist[i] + 1;
        queue[tail++] = k;
      }
    }
  }
  const out: (Spot | null)[] = world.provinces.map(() => null);
  const score: number[] = world.provinces.map(() => -Infinity);
  const count: number[] = world.provinces.map(() => 0);
  for (let i = 0; i < N; i++) {
    const p = prov[i];
    if (p < 0 || p >= out.length) continue;
    count[p]++;
    const x = i % W;
    const y = (i - x) / W;
    const P = world.provinces[p];
    // Deepest first; among equals, nearest the centroid
    let dx = Math.abs(x + 0.5 - (P.centroidX ?? x));
    dx = Math.min(dx, W - dx);
    const dy = Math.abs(y + 0.5 - (P.centroidY ?? y));
    const s = dist[i] - Math.hypot(dx, dy) * 0.02;
    if (s > score[p]) {
      score[p] = s;
      out[p] = { x: x + 0.5, y: y + 0.5, room: dist[i], cells: 0 };
    }
  }
  out.forEach((s, p) => {
    if (s) s.cells = count[p];
  });
  return out;
}

// World copies (wrapping east-west) that reach the screen
function copies(world: WorldData, width: number, scale: number, offsetX: number): number[] {
  const span = world.width * scale;
  const out: number[] = [];
  for (let k = Math.floor(-offsetX / span) - 1; k <= Math.ceil((width - offsetX) / span); k++) out.push(k);
  return out;
}

// --- Map overlays ---

// Faint diagonal hatching over autonomous provinces (drawn under the vector layers)
export function hatchAutonomous(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  width: number,
  height: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  theme: MapTheme,
  keep?: Set<number> | null,
) {
  const auto = new Set(world.provinces.map((p, i) => (isAutonomous(p) ? i : -1)).filter((i) => i >= 0));
  if (!auto.size) return;
  const W = world.width;
  // Each autonomous province's cells as horizontal runs, one path for all
  const path = new Path2D();
  const ks = copies(world, width, scale, offsetX);
  for (let y = 0; y < world.height; y++) {
    const sy = y * scale + offsetY;
    if (sy + scale < 0 || sy > height) continue;
    let x = 0;
    while (x < W) {
      const c = world.grid[x][y];
      const p = c.provinceIndex ?? -1;
      if (c.isWater || !auto.has(p) || (keep && !keep.has(world.provinces[p].nationIndex))) {
        x++;
        continue;
      }
      let x1 = x + 1;
      while (x1 < W && !world.grid[x1][y].isWater && world.grid[x1][y].provinceIndex === p) x1++;
      for (const k of ks) {
        const sx = (x + k * W) * scale + offsetX;
        if (sx > width || sx + (x1 - x) * scale < 0) continue;
        path.rect(sx, sy, (x1 - x) * scale, scale);
      }
      x = x1;
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clip(path);
  ctx.strokeStyle = theme === "Realistic" ? "rgba(255, 255, 255, 0.45)" : "rgba(40, 28, 18, 0.38)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  const step = Math.max(5, Math.min(9, scale * 0.6));
  for (let d = -height; d < width + height; d += step) {
    ctx.moveTo(d, 0);
    ctx.lineTo(d + height, height);
  }
  ctx.stroke();
  ctx.restore();
}

// A soft shadow cast by the realms in `keep` onto the (grayed) land and sea
// around them, so the country lifts off the page. Device pixels, in strips.
export function shadowOutside(ctx: CanvasRenderingContext2D, world: WorldData, v: MapView, keep: Set<number>) {
  // The realm's land, one texel per cell
  const W = world.width;
  const shape = document.createElement("canvas");
  shape.width = W;
  shape.height = world.height;
  const sg = shape.getContext("2d")!;
  const img = sg.createImageData(W, world.height);
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++) {
      const i = y * W + x;
      const n = col[y].nationIndex ?? -1;
      img.data[i * 4 + 3] = world.waterType[i] === 0 && n >= 0 && keep.has(n) ? 255 : 0;
    }
  }
  sg.putImageData(img, 0, 0);
  const blur = 9 * v.pixelRatio;
  const off = 4 * v.pixelRatio;
  const margin = Math.ceil(blur * 3 + off);
  const stripH = Math.min(v.h, 512);
  const strip = document.createElement("canvas");
  strip.width = v.w;
  strip.height = stripH + 2 * margin;
  const s = strip.getContext("2d")!;
  const span = W * v.scale;
  const k0 = Math.floor(-v.offsetX / span) - 1;
  const k1 = Math.ceil((v.w - v.offsetX) / span);
  const drawShape = (dx: number, dy: number) => {
    for (let k = k0; k <= k1; k++) s.drawImage(shape, v.offsetX + k * span + dx, v.offsetY + dy, span, world.height * v.scale);
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let y = 0; y < v.h; y += stripH) {
    const h = Math.min(stripH, v.h - y);
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, strip.width, strip.height);
    s.imageSmoothingEnabled = true;
    s.translate(0, margin - y);
    s.filter = `blur(${blur}px)`;
    drawShape(off * 0.6, off);
    s.filter = "none";
    // Only outside the realm
    s.globalCompositeOperation = "destination-out";
    drawShape(0, 0);
    s.globalCompositeOperation = "source-in";
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.fillStyle = "rgba(10, 8, 6, 0.55)";
    s.fillRect(0, 0, strip.width, strip.height);
    ctx.drawImage(strip, 0, margin, v.w, h, v.x, v.y + y, v.w, h);
  }
  ctx.restore();
}

// --- Labels ---

type Rect = { x: number; y: number; w: number; h: number };

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

// Realm names (large, spaced capitals) and every province name that fits at
// its roomiest spot, sized by its area; autonomous provinces in italics. With
// realms in focus (`keep`) their capital and provincial seats are marked and
// the neighbors named small. Layout pixels. Returns the rectangles taken, for
// the city labels drawn after to avoid.
export function drawProvinceLabels(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  width: number,
  height: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  theme: CanvasTheme,
  mapTheme: MapTheme,
  keep: Set<number> | null | undefined,
  centroids: { x: number; y: number }[],
  landArea: number[],
): Rect[] {
  const taken: Rect[] = [];
  const free = (r: Rect, pad: number) =>
    !taken.some((t) => r.x < t.x + t.w + pad && r.x + r.w + pad > t.x && r.y < t.y + t.h + pad && r.y + r.h + pad > t.y);
  const ks = copies(world, width, scale, offsetX);
  const lettering = LETTERING[mapTheme];
  const focus = !!keep;
  const spaced = (s: string, by: string) => s.split("").join(by);
  // Places text centered at (sx, sy) if it fits `maxW` and the free space
  const label = (text: string, sx: number, sy: number, font: string, size: number, fill: string, halo: number, pad: number, maxW: number, spacing = 0) => {
    ctx.font = font;
    ctx.letterSpacing = `${spacing}px`;
    const w = ctx.measureText(text).width;
    if (w > maxW) return false;
    const r = { x: sx - w / 2, y: sy - size / 2, w, h: size };
    if (r.x + r.w < 0 || r.x > width || r.y + r.h < 0 || r.y > height || !free(r, pad)) return false;
    ctx.lineJoin = "round";
    ctx.lineWidth = halo;
    ctx.strokeStyle = theme.nationHalo;
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = fill;
    ctx.fillText(text, sx, sy);
    taken.push(r);
    return true;
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Capital and provincial seats of the realms in focus
  if (focus) {
    const capitals = new Set(world.cities.filter((c) => c.isCapital && keep!.has(c.nationIndex)).map((c) => c.id));
    const seats = new Map<number, { x: number; y: number }>();
    for (const p of world.provinces) {
      if (!keep!.has(p.nationIndex)) continue;
      const city = world.cities.find((c) => c.id === p.capitalCityId);
      const x = city?.x ?? p.seatX;
      const y = city?.y ?? p.seatY;
      if (x !== undefined && y !== undefined && !(city && capitals.has(city.id))) seats.set(p.id, { x, y });
    }
    const ink = mapTheme === "Realistic" ? "#1c1814" : theme.ink;
    for (const k of ks) {
      for (const s of seats.values()) {
        const sx = (s.x + k * world.width) * scale + offsetX;
        const sy = s.y * scale + offsetY;
        if (sx < -10 || sx > width + 10 || sy < -10 || sy > height + 10) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = "#fffaf0";
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = ink;
        ctx.stroke();
        taken.push({ x: sx - 4, y: sy - 4, w: 8, h: 8 });
      }
      for (const c of world.cities) {
        if (!capitals.has(c.id)) continue;
        const sx = (c.x + k * world.width) * scale + offsetX;
        const sy = c.y * scale + offsetY;
        if (sx < -12 || sx > width + 12 || sy < -12 || sy > height + 12) continue;
        star(ctx, sx, sy, 7.5);
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#fffaf0";
        ctx.stroke();
        ctx.fillStyle = mapTheme === "Historical" ? "#8b2f1f" : "#b8322a";
        ctx.fill();
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = ink;
        ctx.stroke();
        taken.push({ x: sx - 8, y: sy - 8, w: 16, h: 16 });
      }
    }
  }

  // Realms, largest first. In focus the title already names a lone realm;
  // the neighbors get small names (grayed with their land afterwards).
  const realms = world.nations
    .map((_, i) => i)
    .filter((i) => (landArea[i] || 0) > 0)
    .sort((a, b) => (landArea[b] || 0) - (landArea[a] || 0));
  for (const i of realms) {
    const inFocus = !keep || keep.has(i);
    if (inFocus && keep && keep.size === 1) continue;
    const extent = Math.sqrt(landArea[i] || 0) * scale;
    if (extent < 36) continue;
    const size = inFocus ? Math.max(11, Math.min(34, Math.round(extent * 0.13))) : Math.max(10, Math.min(15, Math.round(extent * 0.06)));
    const c = centroids[i] ?? { x: world.nations[i].capitalX, y: world.nations[i].capitalY };
    const text = world.nations[i].name.toUpperCase();
    const fill = inFocus ? theme.nationLabel : mapTheme === "Realistic" ? "rgba(40, 40, 44, 0.7)" : "rgba(70, 60, 50, 0.7)";
    for (const k of ks)
      label(text, (c.x + k * world.width) * scale + offsetX, c.y * scale + offsetY, `${inFocus ? "bold" : "600"} ${size}px ${lettering.name}`, size, fill, 4, 6, extent * 1.5, inFocus && size >= 16 ? size * 0.3 : size * 0.15);
  }

  // Provinces, largest first, at their roomiest spot; shrunk until they fit
  const spots = provinceSpots(world);
  const order = world.provinces
    .map((_, i) => i)
    .filter((i) => spots[i] && (!keep || keep.has(world.provinces[i].nationIndex)))
    .sort((a, b) => spots[b]!.cells - spots[a]!.cells);
  const minSize = focus ? 9 : 7;
  const maxSize = focus ? 26 : 13;
  for (const i of order) {
    const p = world.provinces[i];
    const s = spots[i]!;
    const extent = Math.sqrt(s.cells) * scale;
    const room = (s.room * 2 + 1) * scale * 1.25; // label width the spot allows
    if (extent < 16) continue;
    const auto = isAutonomous(p);
    const caps = lettering.caps;
    const text = caps ? spaced(p.name.toUpperCase(), "") : p.name;
    for (let size = Math.max(minSize, Math.min(maxSize, Math.round(extent * (focus ? 0.12 : 0.16)))); size >= minSize; size--) {
      const font = `${auto ? "italic " : ""}${focus ? 600 : 500} ${size}px ${lettering.name}`;
      let placed = false;
      for (const k of ks)
        placed =
          label(text, (s.x + k * world.width) * scale + offsetX, s.y * scale + offsetY, font, size, theme.nationLabel, focus ? 3 : 2.5, 3, Math.max(room, extent * 0.9), caps ? size * 0.12 : 0) || placed;
      if (placed) break;
    }
  }
  ctx.letterSpacing = "0px";
  ctx.restore();
  return taken;
}

// --- Legend ---

export interface LegendRow {
  label: string;
  value?: string;
  color?: string;
  flag?: number;
  swatch?: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) => void;
}

export interface LegendSection {
  title: string;
  rows: LegendRow[];
  more: number;
  dots: boolean;
}

const line = (width: number, dash: number[]) => (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) => {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, y + h / 2);
  ctx.lineTo(x + w, y + h / 2);
  ctx.stroke();
  ctx.restore();
};

const hatchSwatch = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -h; d < w; d += 4) {
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
  }
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.strokeRect(x, y, w, h);
};

const starSwatch = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) => {
  star(ctx, x + w / 2, y + h / 2, 7);
  ctx.fillStyle = "#b8322a";
  ctx.fill();
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = ink;
  ctx.stroke();
};

const seatSwatch = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) => {
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = "#fffaf0";
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = ink;
  ctx.stroke();
};

const MAX_PROVINCE_ROWS = 28;

// A provinces poster's legend. The world: its realms with their province
// counts. Realms in focus: their provinces in the map's colors, with area,
// people and kind. Then the key to the lines and marks.
export function provinceLegend(world: WorldData, keep: Set<number> | null, legendNations: number[], maxRows: number): LegendSection[] {
  const inScope = world.provinces.filter((p) => !keep || keep.has(p.nationIndex));
  const autonomous = inScope.filter(isAutonomous).length;
  const key: LegendRow[] = [
    { label: "Realm border", swatch: line(2.6, []) },
    { label: "Province border", swatch: line(1, [3, 2]) },
  ];
  if (keep) key.push({ label: "Capital", swatch: starSwatch }, { label: "Provincial seat", swatch: seatSwatch });
  if (autonomous) key.push({ label: provinceTypeInfo("autonomous").label, swatch: hatchSwatch });

  if (keep) {
    const colors = provinceColors(world);
    const list = inScope
      .map((p) => ({ p, i: world.provinces.indexOf(p) }))
      .sort((a, b) => (a.p.type === "capital" ? -1 : b.p.type === "capital" ? 1 : (b.p.area ?? 0) - (a.p.area ?? 0)));
    const rows = list.slice(0, MAX_PROVINCE_ROWS).map(({ p, i }) => {
      const info = provinceTypeInfo(p);
      const mark = info.id === "province" ? "" : `${info.icon} `;
      const people = p.population ? ` · ${compact(p.population)}` : "";
      return { label: `${mark}${p.name}`, value: `${compact(p.area ?? 0)} km²${people}`, color: colors[i] >= 0 ? rgbHex(colors[i]) : undefined };
    });
    const names = [...keep].map((n) => world.nations[n]?.name).filter(Boolean);
    const title = names.length === 1 ? `Provinces of ${names[0]}` : "Provinces";
    // Kinds shown by their marks in the list
    const kinds = new Set(inScope.map((p) => provinceTypeInfo(p).id).filter((t) => t !== "province"));
    const kindRows: LegendRow[] = [...kinds].map((t) => {
      const info = provinceTypeInfo(t);
      return { label: `${info.icon} ${info.label}` };
    });
    return [
      { title, rows, more: Math.max(0, list.length - MAX_PROVINCE_ROWS), dots: false },
      { title: "Key", rows: [...key, ...kindRows], more: 0, dots: false },
    ];
  }

  const counts = new Map<number, number>();
  for (const p of inScope) counts.set(p.nationIndex, (counts.get(p.nationIndex) ?? 0) + 1);
  const rowsLeft = Math.max(3, maxRows - key.length);
  const list = legendNations.filter((i) => world.nations[i]);
  const realms: LegendRow[] = list.slice(0, rowsLeft).map((i) => {
    const n = counts.get(i) ?? 0;
    return { label: world.nations[i].name, value: `${n} province${n === 1 ? "" : "s"}`, color: world.nations[i].color, flag: i };
  });
  return [
    { title: "Provinces", rows: realms, more: Math.max(0, list.length - rowsLeft), dots: false },
    { title: "Key", rows: key, more: 0, dots: false },
  ];
}
