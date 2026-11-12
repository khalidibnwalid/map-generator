import type { MapTheme } from "../core/GPURenderer";
import { CELL_KM2, type WorldData } from "../game/WorldData";
import type { HistoryFrame } from "../game/sim/History";
import type { Battle } from "../game/sim/Simulation";
import { compact, frameExtent, type AtlasHost, type Extent, type MapView } from "./AtlasRender";
import { loadPosterFonts, paintBackground, paintDecorations, posterLayout, posterView, type PosterSpec } from "./PosterDecor";
import type { LegendRow, LegendSection } from "./ProvincePoster";
import { createDropdown } from "./components/Dropdown";
import { nationFlagUrl } from "../game/flags";

// "Expansion history" poster of one realm, after the classic maps of an
// empire's growth: its land at the start of the recorded history in the
// darkest shade of its color, each later period of conquest a lighter shade,
// land it held for a time and lost again in pale yellow, its vassals in light
// gray, the border at its greatest extent outlined, and its largest battles
// marked (red won, blue lost).
//
// The history is rebuilt from the simulation's recorded frames (see History):
// frame 0 holds the owner of every cell, later frames the cells that changed,
// and every frame the realms with their overlords. Realms are followed by
// their stable uid, so renames and shifting indices don't matter.

// --- Classification ---

export const CORE = 0; // held at the first recorded year (and at the end)
export const LOST = -2; // held for a time, not at the end
export const NONE = -1; // never held
// 1..periods.length: first held in that period, still held at the end

export interface ExpansionPeriod {
  from: number; // years, inclusive
  to: number;
  cells: number; // land cells held at the end that were first taken in it
}

export interface ExpansionVassal {
  uid: number;
  name: string; // its name when it last was a vassal
  nation: number; // index in world.nations today, -1 if gone (or renamed)
  from: number; // first year it was a vassal
  to: number; // last year it was a vassal (the end year if still one)
  atEnd: boolean;
  cells: number; // land shown as the vassal's (never held by the realm itself)
}

export interface ExpansionBattle {
  year: number;
  x: number; // cells
  y: number;
  won: boolean;
  enemy: string;
  place: string;
  size: number; // cells taken: how decisive it was
}

export interface Expansion {
  nation: number;
  uid: number;
  name: string;
  color: string;
  startYear: number; // first recorded year
  endYear: number;
  cls: Int8Array; // per cell (y * W + x): CORE, 1..periods, LOST or NONE; water is NONE
  firstHeld: Int32Array; // first year held, -1 never
  lostAt: Int32Array; // last year it was lost, -1 never
  periods: ExpansionPeriod[];
  vassalCell: Int16Array; // per cell: index into vassals, -1 none
  vassals: ExpansionVassal[];
  peak: { year: number; cells: number; mask: Uint8Array }; // its own land at its greatest extent
  battles: ExpansionBattle[]; // the ones shown, largest first
  battleTotals: { won: number; lost: number };
  counts: { core: number; lost: number; everHeld: number; atEnd: number };
}

export interface ExpansionOptions {
  endYear?: number; // defaults to the last recorded year
  periods?: number; // conquest periods, 1-8 (default 5)
  // The end is the live map (the default when the end year is the last one):
  // land changed since the last recorded year (edits, painting) counts too
  live?: boolean;
  maxBattles?: number; // markers kept (default 14)
}

// What the classification needs from the simulation
export interface ExpansionSource {
  history: { frames: HistoryFrame[] };
  battles: Battle[];
}

export function hasHistory(sim: ExpansionSource | null | undefined): boolean {
  return !!sim && sim.history.frames.length >= 2 && !!sim.history.frames[0].key;
}

// First and last recorded years
export function historyYears(sim: ExpansionSource): { first: number; last: number } | null {
  const f = sim.history.frames;
  if (f.length < 2) return null;
  return { first: f[0].year, last: f[f.length - 1].year };
}

// The uid the history knows a living nation by
function uidOf(world: WorldData, frames: HistoryFrame[], nation: number): number {
  const n = world.nations[nation];
  if (!n) return -1;
  for (let f = frames.length - 1; f >= Math.max(0, frames.length - 3); f--) {
    const list = frames[f].nations;
    if (list[nation]?.name === n.name) return list[nation].uid;
    const byName = list.find((m) => m.name === n.name);
    if (byName) return byName.uid;
  }
  return -1;
}

function unrle(pairs: Int32Array, out: Int16Array) {
  let o = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    out.fill(pairs[k], o, o + pairs[k + 1]);
    o += pairs[k + 1];
  }
}

// Steps through frames 0..last, calling change(cell, before, after) for every
// cell whose owner (uid) changed and then frame(f, owners)
function replay(
  frames: HistoryFrame[],
  cells: number,
  last: number,
  change: ((i: number, before: number, after: number, f: number) => void) | null,
  frame: (f: number, cur: Int16Array) => void,
) {
  const cur = new Int16Array(cells);
  const tmp = new Int16Array(cells);
  unrle(frames[0].key!, cur);
  frame(0, cur);
  for (let f = 1; f <= last; f++) {
    const fr = frames[f];
    if (fr.key) {
      unrle(fr.key, tmp);
      for (let i = 0; i < cells; i++) {
        if (tmp[i] === cur[i]) continue;
        change?.(i, cur[i], tmp[i], f);
        cur[i] = tmp[i];
      }
    } else if (fr.diffIdx && fr.diffVal) {
      const di = fr.diffIdx;
      const dv = fr.diffVal;
      for (let k = 0; k < di.length; k++) {
        const i = di[k];
        if (cur[i] === dv[k]) continue;
        change?.(i, cur[i], dv[k], f);
        cur[i] = dv[k];
      }
    }
    frame(f, cur);
  }
}

// Step between period boundaries: round years for long histories
function roundStep(span: number, periods: number): number {
  const per = span / Math.max(1, periods);
  return per >= 80 ? 10 : per >= 25 ? 5 : 1;
}

// Splits the years in which land still held at the end was first taken into
// periods of about equal conquest (quantiles), boundaries rounded to round
// years; periods that would hold nothing are merged away
export function conquestPeriods(gainYears: Map<number, number>, startYear: number, endYear: number, want: number): ExpansionPeriod[] {
  const years = [...gainYears.keys()].sort((a, b) => a - b);
  const total = years.reduce((s, y) => s + gainYears.get(y)!, 0);
  if (!total) return [];
  const count = Math.max(1, Math.min(want, years.length));
  const step = roundStep(endYear - startYear, count);
  const bounds: number[] = []; // first year of periods 2..count
  let acc = 0;
  let k = 1;
  for (const y of years) {
    acc += gainYears.get(y)!;
    while (k < count && acc >= (total * k) / count) {
      // Starts the next period after this year, at a round year
      let b = Math.round((y + 1) / step) * step;
      if (b <= startYear + 1) b = y + 1;
      bounds.push(b);
      k++;
    }
  }
  const edges = [startYear + 1, ...bounds, endYear + 1].filter((b, i, a) => i === 0 || b > a[i - 1]);
  const out: ExpansionPeriod[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    let cells = 0;
    for (const y of years) if (y >= edges[i] && y < edges[i + 1]) cells += gainYears.get(y)!;
    out.push({ from: edges[i], to: edges[i + 1] - 1, cells });
  }
  // An empty period joins the one after it (or before, at the end)
  for (let i = 0; i < out.length; ) {
    if (out[i].cells > 0 || out.length === 1) {
      i++;
      continue;
    }
    if (i + 1 < out.length) out[i + 1].from = out[i].from;
    else out[i - 1].to = out[i].to;
    out.splice(i, 1);
  }
  return out;
}

// Name of the nearest town (within reach), else the province
function placeName(world: WorldData, x: number, y: number): string {
  const W = world.width;
  let best = "";
  let bd = 14;
  for (const c of world.cities) {
    let dx = Math.abs(c.x - x);
    if (dx > W / 2) dx = W - dx;
    const d = Math.hypot(dx, c.y - y);
    if (d < bd) {
      bd = d;
      best = c.name;
    }
  }
  if (best) return best;
  const cx = ((Math.floor(x) % W) + W) % W;
  const cy = Math.max(0, Math.min(world.height - 1, Math.floor(y)));
  const p = world.grid[cx]?.[cy]?.provinceIndex;
  return p !== undefined && p >= 0 ? (world.provinces[p]?.name ?? "") : "";
}

// Rebuilds the realm's history from the recorded frames and classifies every
// land cell it ever held. Pure: no DOM, the simulation is only read.
export function expansionOf(world: WorldData, sim: ExpansionSource, nation: number, opts: ExpansionOptions = {}): Expansion | null {
  const frames = sim.history.frames;
  if (frames.length < 2 || !frames[0].key) return null;
  const uid = uidOf(world, frames, nation);
  if (uid < 0) return null;
  const W = world.width;
  const N = W * world.height;
  const land = world.waterType;
  const startYear = frames[0].year;
  const lastYear = frames[frames.length - 1].year;
  const endYear = Math.max(startYear + 1, Math.min(lastYear, Math.round(opts.endYear ?? lastYear)));
  const E = Math.max(1, Math.min(frames.length - 1, endYear - startYear)); // years are consecutive

  const firstHeld = new Int32Array(N).fill(-1);
  const lostAt = new Int32Array(N).fill(-1);
  const nameAt = new Map<number, string>(); // year -> the realm's name
  let landNow = 0;
  let peakFrame = 0;
  let peakCells = -1;
  // Vassals: first and last frame each realm was bound to this one
  const vas = new Map<number, { from: number; to: number; lastFrame: number; name: string }>();
  let held: Int16Array | null = null;

  replay(
    frames,
    N,
    E,
    (i, before, after, f) => {
      if (land[i] !== 0) return;
      if (after === uid) {
        landNow++;
        if (firstHeld[i] < 0) firstHeld[i] = frames[f].year;
      } else if (before === uid) {
        landNow--;
        lostAt[i] = frames[f].year;
      }
    },
    (f, cur) => {
      const fr = frames[f];
      if (f === 0)
        for (let i = 0; i < N; i++)
          if (cur[i] === uid && land[i] === 0) {
            firstHeld[i] = fr.year;
            landNow++;
          }
      for (const m of fr.nations) {
        if (m.uid === uid) nameAt.set(fr.year, m.name);
        if (m.overlord !== uid) continue;
        const v = vas.get(m.uid);
        if (v) {
          v.to = fr.year;
          v.lastFrame = f;
          v.name = m.name;
        } else vas.set(m.uid, { from: fr.year, to: fr.year, lastFrame: f, name: m.name });
      }
      if (landNow > peakCells) {
        peakCells = landNow;
        peakFrame = f;
      }
      if (f === E) held = cur.slice();
    },
  );
  const recordedEnd = held as Int16Array | null;
  if (!recordedEnd) return null;
  // The end: today's map, or the recorded year asked for
  const live = opts.live ?? endYear === lastYear;
  const liveOwner = new Int16Array(N).fill(-1);
  if (live)
    for (let x = 0; x < W; x++) {
      const col = world.grid[x];
      for (let y = 0; y < world.height; y++) liveOwner[y * W + x] = col[y].nationIndex ?? -1;
    }
  const heldAtEnd = (i: number) => (live ? liveOwner[i] === nation : recordedEnd[i] === uid);
  let liveCells = 0;
  if (live)
    for (let i = 0; i < N; i++) {
      if (land[i] !== 0 || liveOwner[i] !== nation) continue;
      liveCells++;
      // Held now but never in a recorded year: taken since (an edit), the last period
      if (firstHeld[i] < 0) firstHeld[i] = endYear;
    }
  if (Math.max(peakCells, liveCells) <= 0) return null;

  // --- Classes ---
  const cls = new Int8Array(N).fill(NONE);
  const gains = new Map<number, number>();
  const counts = { core: 0, lost: 0, everHeld: 0, atEnd: 0 };
  for (let i = 0; i < N; i++) {
    if (firstHeld[i] < 0) continue;
    counts.everHeld++;
    if (!heldAtEnd(i)) {
      cls[i] = LOST;
      counts.lost++;
      continue;
    }
    counts.atEnd++;
    if (firstHeld[i] === startYear) {
      cls[i] = CORE;
      counts.core++;
    } else gains.set(firstHeld[i], (gains.get(firstHeld[i]) ?? 0) + 1);
  }
  const periods = conquestPeriods(gains, startYear, endYear, Math.max(1, Math.min(8, opts.periods ?? 5)));
  for (let i = 0; i < N; i++) {
    if (cls[i] !== NONE || firstHeld[i] < 0 || !heldAtEnd(i)) continue;
    const y = firstHeld[i];
    const k = periods.findIndex((p) => y >= p.from && y <= p.to);
    cls[i] = k >= 0 ? k + 1 : periods.length; // (rounding never leaves a gap, but stay safe)
  }

  // --- Greatest extent and the vassals' land (a second, cheap replay) ---
  const peakMask = new Uint8Array(N);
  const vassalList = [...vas.entries()].map(([vuid, v]) => ({ vuid, ...v }));
  const recordedVassals = vassalList.slice();
  const cellsOf = new Map<number, number[]>();
  const wanted = new Set<number>([peakFrame, ...recordedVassals.map((v) => v.lastFrame)]);
  replay(frames, N, E, null, (f, cur) => {
    if (!wanted.has(f)) return;
    if (f === peakFrame) for (let i = 0; i < N; i++) peakMask[i] = cur[i] === uid && land[i] === 0 ? 1 : 0;
    for (const v of recordedVassals) {
      if (v.lastFrame !== f) continue;
      const list: number[] = [];
      for (let i = 0; i < N; i++) if (cur[i] === v.vuid && land[i] === 0) list.push(i);
      cellsOf.set(v.vuid, list);
    }
  });
  // Today's map may hold more than any recorded year
  if (live && liveCells > peakCells) {
    peakCells = liveCells;
    peakFrame = E;
    for (let i = 0; i < N; i++) peakMask[i] = land[i] === 0 && liveOwner[i] === nation ? 1 : 0;
  }
  const endYearOf = frames[E].year;
  // Live: today's vassals with today's land (some may have become vassals since)
  const nowVassal = new Map<number, number>(); // uid -> nation index
  if (live)
    world.nations.forEach((n, vi) => {
      if (n.overlord !== nation) return;
      let vu = uidOf(world, frames, vi);
      if (vu < 0) vu = -2 - vi; // not recorded yet
      nowVassal.set(vu, vi);
      const e = vassalList.find((v) => v.vuid === vu);
      if (e) {
        e.to = endYearOf;
        e.name = n.name;
      } else vassalList.push({ vuid: vu, from: endYearOf, to: endYearOf, lastFrame: E, name: n.name });
      const list: number[] = [];
      for (let i = 0; i < N; i++) if (land[i] === 0 && liveOwner[i] === vi) list.push(i);
      cellsOf.set(vu, list);
    });
  const atEndVassal = (v: { vuid: number; to: number }) => (live ? nowVassal.has(v.vuid) : v.to === endYearOf);
  // Vassals at the end first, then the most recent; land the realm itself held stays its own
  vassalList.sort((a, b) => Number(atEndVassal(b)) - Number(atEndVassal(a)) || b.to - a.to || a.from - b.from);
  const vassalCell = new Int16Array(N).fill(-1);
  const vassals: ExpansionVassal[] = [];
  for (const v of vassalList) {
    let cells = 0;
    const idx = vassals.length;
    for (const i of cellsOf.get(v.vuid) ?? []) {
      if (cls[i] !== NONE || vassalCell[i] >= 0) continue;
      vassalCell[i] = idx;
      cells++;
    }
    if (!cells) continue;
    const now = nowVassal.get(v.vuid) ?? world.nations.findIndex((n) => n.name === v.name);
    vassals.push({ uid: v.vuid, name: v.name, nation: now, from: v.from, to: v.to, atEnd: atEndVassal(v), cells });
  }

  // --- Battles it fought, largest first, spread out ---
  const mine: ExpansionBattle[] = [];
  let won = 0;
  let lost = 0;
  for (const b of sim.battles) {
    if (b.year < startYear || b.year > endYear) continue;
    const name = nameAt.get(b.year);
    if (!name || (b.winner !== name && b.loser !== name) || b.winner === b.loser) continue;
    const w = b.winner === name;
    if (w) won++;
    else lost++;
    mine.push({ year: b.year, x: b.x, y: b.y, won: w, enemy: w ? b.loser : b.winner, place: "", size: b.size });
  }
  mine.sort((a, b) => b.size - a.size || a.year - b.year);
  const maxBattles = Math.max(0, opts.maxBattles ?? 14);
  const spacing = Math.max(3, Math.sqrt(counts.everHeld) * 0.07);
  const battles: ExpansionBattle[] = [];
  for (const b of mine) {
    if (battles.length >= maxBattles) break;
    const near = battles.some((o) => {
      let dx = Math.abs(o.x - b.x);
      if (dx > W / 2) dx = W - dx;
      return Math.hypot(dx, o.y - b.y) < spacing;
    });
    if (near) continue;
    b.place = placeName(world, b.x, b.y);
    battles.push(b);
  }

  const n = world.nations[nation];
  return {
    nation,
    uid,
    name: n.name,
    color: n.color,
    startYear,
    endYear: endYearOf,
    cls,
    firstHeld,
    lostAt,
    periods,
    vassalCell,
    vassals,
    peak: { year: frames[peakFrame].year, cells: peakCells, mask: peakMask },
    battles,
    battleTotals: { won, lost },
    counts,
  };
}

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

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
type RGB = [number, number, number];

// The fills are laid over the terrain at about half strength, so they span
// the whole range from dark to light
const VASSAL_RGB: RGB = [184, 183, 179]; // light gray, outlined in the realm color
const OTHER_SWATCH: Record<MapTheme, string> = { Historical: "#d8d0bf", Atlas: "#dedede", Realistic: "#8e8e8e" }; // the terrain grayed (see washOutside)

const PALE_YELLOW: RGB = [246, 226, 120];

// Yellow would not stand out on a yellowish realm: its land held for a time is
// then hatched in its own color over a light tint of it instead
function lostClashes(color: string): boolean {
  const [h, s] = hexToHsl(color);
  return h >= 40 && h <= 75 && s > 0.2;
}

// Land held for a time: the fill, and the hatch drawn over it (if any)
function lostFill(color: string): { fill: RGB; hatch: RGB | null } {
  if (!lostClashes(color)) return { fill: PALE_YELLOW, hatch: null };
  const [h, s] = hexToHsl(color);
  return { fill: hsl(h, Math.min(0.5, s), 0.9), hatch: hsl(h, Math.min(0.85, Math.max(0.45, s)), 0.32) };
}

// --- OKLab (perceptual lightness, so the steps look even in every hue) ---
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function oklch(hexColor: string): [number, number, number] {
  const v = parseInt(hexColor.slice(1, 7), 16);
  const r = toLin(((v >> 16) & 255) / 255);
  const g = toLin(((v >> 8) & 255) / 255);
  const b = toLin((v & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

// Linear RGB of an OKLCH color (may fall outside 0..1)
function oklchLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// The color, its chroma reduced until it fits sRGB
function oklchRgb(L: number, C: number, h: number): RGB {
  const fits = (c: number) => oklchLinear(L, c, h).every((v) => v >= -0.0005 && v <= 1.0005);
  if (!fits(C)) {
    let lo = 0;
    let hi = C;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  return oklchLinear(L, C, h).map((v) => Math.round(255 * fromLin(Math.max(0, Math.min(1, v))))) as RGB;
}

// Core and each period in the realm's own hue: an even perceptual ramp from
// dark and saturated (core, OKLab L 0.38, about HSL 28%) to light and pale
// (last period, L 0.89, about HSL 83%), chroma falling along it. The ramp is
// absolute, so a pale or a dark realm color gets the same spread; a gray
// realm stays gray.
export function expansionShades(color: string, periods: number): RGB[] {
  const [, C0, h] = oklch(color);
  const C = C0 < 0.025 ? C0 : Math.max(0.11, Math.min(0.2, C0 * 1.15));
  const n = periods + 1;
  return Array.from({ length: n }, (_, k) => {
    const t = n === 1 ? 0 : k / (n - 1);
    return oklchRgb(0.38 + 0.51 * t, C * (1 - 0.6 * t), h);
  });
}

// Perceptual lightness of a color (0..1)
export const lightness = (c: RGB) => oklch(hex(c))[0];

// How strongly the fills cover the terrain (a hint of relief stays)
const FILL_STRENGTH = 0.88;

// What a fill looks like on the map, for the legend
function onMap(c: RGB, theme: MapTheme): string {
  const ground: RGB = theme === "Realistic" ? [120, 120, 100] : theme === "Historical" ? [228, 214, 180] : [238, 236, 228];
  return hex(c.map((v, k) => Math.round(ground[k] * (1 - FILL_STRENGTH) + v * FILL_STRENGTH)) as RGB);
}

// --- Poster spec ---

export interface ExpansionPosterSpec extends PosterSpec {
  expansion: Expansion;
}

export function isExpansionSpec(spec: PosterSpec): spec is ExpansionPosterSpec {
  return "expansion" in spec && !!(spec as ExpansionPosterSpec).expansion;
}

// One computed history per (world, recording, nation, options): previews ask often
let cache: { key: string; world: WorldData; frames: HistoryFrame[]; exp: Expansion | null } | null = null;

// Today's land of a realm and its vassals, cheaply fingerprinted (edits since the last recorded year)
function liveStamp(world: WorldData, nation: number): string {
  const bloc = world.nations.map((n, i) => (i === nation || n.overlord === nation ? 1 : 0));
  let count = 0;
  let hash = 0;
  for (let x = 0; x < world.width; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++) {
      const n = col[y].nationIndex ?? -1;
      if (n < 0 || !bloc[n]) continue;
      count++;
      hash = (hash * 31 + x * 7919 + y * 104729 + n) | 0;
    }
  }
  return `${count}:${hash}:${bloc.join("")}`;
}

export function cachedExpansion(world: WorldData, sim: ExpansionSource, nation: number, opts: ExpansionOptions): Expansion | null {
  const frames = sim.history.frames;
  const key = [nation, world.nations[nation]?.name, frames.length, frames[frames.length - 1]?.year, sim.battles.length, opts.endYear, opts.periods, opts.maxBattles, liveStamp(world, nation)].join("|");
  if (cache && cache.key === key && cache.world === world && cache.frames === frames) return cache.exp;
  const exp = expansionOf(world, sim, nation, opts);
  cache = { key, world, frames, exp };
  return exp;
}

export function expansionDefaults(exp: Expansion): { title: string; subtitle: string } {
  return {
    title: `The Expansion of ${exp.name}`,
    subtitle: `Years ${exp.startYear}–${exp.endYear} · at its height ${compact(exp.peak.cells * CELL_KM2)} km² in ${exp.peak.year}`,
  };
}

// Columns and rows of everything the poster shows, across the date line
function maskExtent(world: WorldData, inside: (i: number) => boolean): Extent | null {
  const W = world.width;
  const H = world.height;
  const cols = new Uint8Array(W);
  let y0 = H;
  let y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!inside(y * W + x)) continue;
      cols[x] = 1;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (y1 < 0) return null;
  let bestLen = 0;
  let bestEnd = 0;
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
  if (bestLen === 0) return { x0: 0, x1: W, y0, y1: y1 + 1 };
  return { x0: bestEnd, x1: bestEnd + W - bestLen, y0, y1: y1 + 1 };
}

// The poster spec for a realm's expansion: framed on all it ever held and its
// vassals, keyed by its own legend
export function expansionPosterSpec(
  world: WorldData,
  exp: Expansion,
  base: Omit<PosterSpec, "extent" | "keep" | "legendNations" | "title" | "subtitle" | "thematic" | "thematic2" | "style" | "layers">,
  title: string | null, // null: no cartouche; "" the default
  subtitle: string,
): ExpansionPosterSpec | null {
  const e = maskExtent(world, (i) => exp.cls[i] !== NONE || exp.vassalCell[i] >= 0);
  if (!e) return null;
  const extent = frameExtent(world, e, 0.08, 0.7, 2.2, 24);
  const d = expansionDefaults(exp);
  const legendNations = [exp.nation, ...exp.vassals.filter((v) => v.atEnd && v.nation >= 0).map((v) => v.nation)];
  return {
    ...base,
    extent,
    keep: null,
    legendNations,
    title: title === null ? null : title || d.title,
    subtitle: subtitle || d.subtitle,
    thematic: "none",
    legendSections: expansionLegend(exp, base.theme),
    expansion: exp,
  };
}

// --- Export dialog (PosterDialog) ---

export const EXPANSION_STYLE = { value: "expansion", label: "Expansion" } as const;

export interface ExpansionChoice {
  nation: number; // -1: the dialog picks the largest realm
  endYear: number; // 0: the last recorded year
  periods: number;
}

function optionsOf(c: ExpansionChoice): ExpansionOptions {
  return { endYear: c.endYear || undefined, periods: c.periods };
}

// The realm that conquered the most (land taken in battles won), else the largest
export function biggestConqueror(world: WorldData, sim: ExpansionSource, landArea: number[]): number {
  const won = new Map<string, number>();
  for (const b of sim.battles) won.set(b.winner, (won.get(b.winner) ?? 0) + b.size);
  let best = -1;
  let bestScore = -1;
  world.nations.forEach((n, i) => {
    const score = (won.get(n.name) ?? 0) * 1e6 + (landArea[i] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

// Changes worth a new preview while the dialog stays open (history running)
export function historyStamp(sim: ExpansionSource | null): string {
  const f = sim?.history.frames;
  return sim && f && f.length ? `${f.length}|${f[f.length - 1].year}|${sim.battles.length}` : "";
}

// Shows the expansion controls when that style is picked and fills them in.
// Without a recorded history the style is disabled; returns whether it can be used.
// A missing choice of realm takes the first valid one of `preferred` (the
// dialog's own selection, then the Nations tab's), else the biggest conqueror.
export function syncExpansionControls(
  root: HTMLElement,
  world: WorldData,
  sim: ExpansionSource | null,
  choice: ExpansionChoice,
  active: boolean,
  landArea: number[],
  preferred: number[],
  onPick: (nation: number) => void,
): boolean {
  const ok = hasHistory(sim);
  const q = <E extends HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
  const button = q<HTMLButtonElement>(`.pd-seg[data-key="style"] .pick[data-value="${EXPANSION_STYLE.value}"]`);
  button.disabled = !ok;
  button.title = ok ? "A realm's growth through the recorded history" : "Run the History simulation first";
  q("#pd-exp-hint").textContent = ok ? "" : "Expansion: run the History simulation first.";
  q("#pd-expansion").style.display = ok && active ? "flex" : "none";
  // The scope is the chosen realm
  const scope = q(`.pd-seg[data-key="scope"]`).parentElement;
  if (scope) scope.style.display = ok && active ? "none" : "";
  if (!ok) return false;
  const years = historyYears(sim!)!;
  if (!world.nations[choice.nation]) choice.nation = preferred.find((i) => !!world.nations[i]) ?? biggestConqueror(world, sim!, landArea);
  // An end year at (or past) the last one follows the latest year
  if (choice.endYear && (choice.endYear <= years.first || choice.endYear >= years.last)) choice.endYear = 0;
  // The app's dropdown with flags, rebuilt when the realms or the choice change
  const host = q("#pd-exp-nation");
  const key = `${world.seed}|${choice.nation}|${world.nations.map((n) => n.name + n.color).join(",")}`;
  if (host.dataset.key !== key) {
    host.dataset.key = key;
    host.replaceChildren(
      createDropdown({
        className: "pd-exp-dd",
        title: "The realm whose growth the poster shows",
        value: String(choice.nation),
        options: world.nations
          .map((n, i) => ({ n, i }))
          .sort((a, b) => (landArea[b.i] || 0) - (landArea[a.i] || 0))
          .map(({ n, i }) => ({ value: String(i), label: n.name, image: nationFlagUrl(world, i, 18, 12), hint: `${compact((landArea[i] || 0) * CELL_KM2)} km²` })),
        onChange: (v) => onPick(Number(v)),
      }),
    );
  }
  const end = q<HTMLInputElement>("#pd-exp-end");
  end.min = String(years.first + 1);
  end.max = String(years.last);
  if (document.activeElement !== end) end.value = String(choice.endYear || years.last);
  root.querySelectorAll<HTMLElement>(`.pd-seg[data-key="periods"] .pick`).forEach((b) => b.classList.toggle("active", Number(b.dataset.value) === choice.periods));
  return true;
}

export function expansionDefaultsFor(world: WorldData, sim: ExpansionSource | null, c: ExpansionChoice) {
  const exp = sim && hasHistory(sim) ? cachedExpansion(world, sim, c.nation, optionsOf(c)) : null;
  return exp ? expansionDefaults(exp) : null;
}

export function expansionSpecFor(
  world: WorldData,
  sim: ExpansionSource | null,
  c: ExpansionChoice,
  longEdge: number,
  decor: { title: boolean; compass: boolean; scaleBar: boolean; legend: boolean; frame: boolean; flags: boolean },
  theme: MapTheme,
  title: string,
  subtitle: string,
): ExpansionPosterSpec | null {
  if (!sim || !hasHistory(sim)) return null;
  const exp = cachedExpansion(world, sim, c.nation, optionsOf(c));
  if (!exp) return null;
  const base = {
    longEdge,
    compass: decor.compass,
    scaleBar: decor.scaleBar,
    legend: decor.legend,
    frame: decor.frame,
    flags: decor.flags,
    theme,
    imprint: `Seed ${world.seed} · ${world.width} × ${world.height} cells of 5 km · Years ${exp.startYear}–${exp.endYear}`,
  };
  return expansionPosterSpec(world, exp, base, decor.title ? title : null, subtitle);
}

// --- Legend ---

const lineSwatch = (color: string, width: number, halo?: string) => (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  ctx.save();
  ctx.lineCap = "round";
  if (halo) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = width + 3;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + h / 2);
    ctx.lineTo(x + w - 2, y + h / 2);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x + 2, y + h / 2);
  ctx.lineTo(x + w - 2, y + h / 2);
  ctx.stroke();
  ctx.restore();
};

const dotSwatch = (fill: string) => (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  battleDot(ctx, x + w / 2, y + h / 2, 5, fill);
};

const vassalSwatch = (fill: string, edge: string) => (ctx: CanvasRenderingContext2D, x: number, y: number) => {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, 14, 14);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = edge;
  ctx.strokeRect(x + 0.8, y + 0.8, 12.4, 12.4);
  ctx.restore();
};

// Diagonal lines of the realm color over a light tint of it
const hatchSwatch = (fill: string, line: string) => (ctx: CanvasRenderingContext2D, x: number, y: number) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, 14, 14);
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, 14, 14);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let d = -14; d < 14; d += 5) {
    ctx.moveTo(x + d, y + 14);
    ctx.lineTo(x + d + 14, y);
  }
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.strokeRect(x, y, 14, 14);
};

const MAX_VASSAL_ROWS = 6;

function vassalWhen(v: ExpansionVassal): string {
  return v.atEnd ? `from ${v.from}` : v.from === v.to ? `in ${v.from}` : `${v.from}–${v.to}`;
}

export function expansionLegend(exp: Expansion, theme: MapTheme): LegendSection[] {
  const shades = expansionShades(exp.color, exp.periods.length);
  const area = (cells: number) => `${compact(cells * CELL_KM2)} km²`;
  const growth: LegendRow[] = [{ label: `Realm in ${exp.startYear}`, value: area(exp.counts.core), color: onMap(shades[0], theme) }];
  exp.periods.forEach((p, k) =>
    growth.push({ label: `${k === 0 ? "Conquered " : ""}${p.from}–${p.to}`, value: area(p.cells), color: onMap(shades[k + 1], theme) }),
  );
  if (exp.counts.lost) {
    const l = lostFill(exp.color);
    growth.push({ label: "Held for a time, lost", value: area(exp.counts.lost), ...(l.hatch ? { swatch: hatchSwatch(onMap(l.fill, theme), hex(l.hatch)) } : { color: onMap(l.fill, theme) }) });
  }
  const sections: LegendSection[] = [{ title: `Growth of ${exp.name}`, rows: growth, more: 0, dots: false }];
  if (exp.vassals.length) {
    const edge = hex(expansionShades(exp.color, 2)[1]);
    sections.push({
      title: "Vassals",
      rows: exp.vassals.slice(0, MAX_VASSAL_ROWS).map((v) => ({ label: v.name, value: vassalWhen(v), swatch: vassalSwatch(VASSAL_SWATCH[theme], edge) })),
      more: Math.max(0, exp.vassals.length - MAX_VASSAL_ROWS),
      dots: false,
    });
  }
  const key: LegendRow[] = [{ label: `Greatest extent, ${exp.peak.year}`, swatch: lineSwatch(hex(shades[0]), 3, "rgba(255,255,255,0.8)") }];
  const { won, lost } = exp.battleTotals;
  if (won) key.push({ label: "Battle won", value: `${won}`, swatch: dotSwatch(WON) });
  if (lost) key.push({ label: "Battle lost", value: `${lost}`, swatch: dotSwatch(LOST_BATTLE) });
  if (exp.battles.length < won + lost) key.push({ label: `Largest ${exp.battles.length} marked` });
  key.push({ label: "Other realms", color: OTHER_SWATCH[theme] });
  sections.push({ title: "Key", rows: key, more: 0, dots: false });
  return sections;
}

// --- Map ---

// Fill colors per cell for the map's region layer (laid over the terrain,
// following the coasts, with fine lines between regions)
function cellPainter(world: WorldData, exp: Expansion): (x: number, y: number) => [number, number, number, number] | null {
  const W = world.width;
  const shades = expansionShades(exp.color, exp.periods.length);
  const lost = lostFill(exp.color).fill;
  // Other land stays bare here and is grayed afterwards
  return (x, y) => {
    const i = y * W + x;
    const c = exp.cls[i];
    if (c === LOST) return [...lost, 255];
    if (c >= 0) return [...shades[Math.min(c, shades.length - 1)], 255];
    if (exp.vassalCell[i] >= 0) return [...VASSAL_RGB, 255];
    return null;
  };
}

// Stripes over the land held for a time, when it is hatched (see lostFill)
function stripePainter(world: WorldData, exp: Expansion): ((x: number, y: number) => [number, number, number, number] | null) | undefined {
  const hatch = lostFill(exp.color).hatch;
  if (!hatch) return undefined;
  const W = world.width;
  return (x, y) => (exp.cls[y * W + x] === LOST ? [...hatch, 255] : null);
}

// Region outlines: the grid edges between land cells i and j where edge(i, j)
// (coasts are left to the map), chained into polylines and smoothed.
// Coordinates in cells, unwrapped from column gx0.
function outlines(world: WorldData, edge: (i: number, j: number) => boolean, gx0: number, gx1: number): Float64Array[] {
  const W = world.width;
  const H = world.height;
  const GW = gx1 - gx0;
  const VW = GW + 1;
  const cellAt = (lx: number, y: number) => y * W + ((((gx0 + lx) % W) + W) % W);
  const isLand = (i: number) => world.waterType[i] === 0;
  const edges: number[] = []; // vertex pairs
  for (let y = 0; y < H; y++)
    for (let lx = 0; lx < GW; lx++) {
      const i = cellAt(lx, y);
      if (!isLand(i)) continue;
      const out = (j: number) => isLand(j) && edge(i, j);
      if (lx + 1 < GW && out(cellAt(lx + 1, y))) edges.push(y * VW + lx + 1, (y + 1) * VW + lx + 1);
      if (lx > 0 && out(cellAt(lx - 1, y))) edges.push(y * VW + lx, (y + 1) * VW + lx);
      if (y > 0 && out(cellAt(lx, y - 1))) edges.push(y * VW + lx, y * VW + lx + 1);
      if (y + 1 < H && out(cellAt(lx, y + 1))) edges.push((y + 1) * VW + lx, (y + 1) * VW + lx + 1);
    }
  const E = edges.length / 2;
  const at = new Map<number, number[]>();
  for (let e = 0; e < E; e++)
    for (const v of [edges[e * 2], edges[e * 2 + 1]]) {
      const l = at.get(v);
      if (l) l.push(e);
      else at.set(v, [e]);
    }
  const used = new Uint8Array(E);
  const chains: Float64Array[] = [];
  const walk = (start: number) => {
    const pts: number[] = [start];
    let v = start;
    for (;;) {
      const next = at.get(v)!.find((e) => !used[e]);
      if (next === undefined) break;
      used[next] = 1;
      v = edges[next * 2] === v ? edges[next * 2 + 1] : edges[next * 2];
      pts.push(v);
    }
    if (pts.length < 2) return;
    const xy = new Float64Array(pts.length * 2);
    pts.forEach((p, k) => {
      xy[k * 2] = gx0 + (p % VW);
      xy[k * 2 + 1] = Math.floor(p / VW);
    });
    chains.push(smooth(xy, pts[0] === pts[pts.length - 1]));
  };
  // Open chains from their ends first, then the loops
  for (const [v, l] of at) if (l.length % 2 === 1 && l.some((e) => !used[e])) walk(v);
  for (let e = 0; e < E; e++) if (!used[e]) walk(edges[e * 2]);
  return chains;
}

// Staircases to curves: edge midpoints, then two rounds of corner cutting
function smooth(xy: Float64Array, closed: boolean): Float64Array {
  let p = Array.from(xy);
  const n = p.length / 2;
  if (n < 3) return xy;
  const mid: number[] = [];
  if (!closed) mid.push(p[0], p[1]);
  const segs = n - 1;
  for (let k = 0; k < segs; k++) mid.push((p[k * 2] + p[k * 2 + 2]) / 2, (p[k * 2 + 1] + p[k * 2 + 3]) / 2);
  if (!closed) mid.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
  p = mid;
  for (let it = 0; it < 2; it++) {
    const m = p.length / 2;
    const q: number[] = [];
    if (!closed) q.push(p[0], p[1]);
    const count = closed ? m : m - 1;
    for (let k = 0; k < count; k++) {
      const a = k;
      const b = (k + 1) % m;
      const ax = p[a * 2];
      const ay = p[a * 2 + 1];
      const bx = p[b * 2];
      const by = p[b * 2 + 1];
      q.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    if (!closed) q.push(p[(m - 1) * 2], p[(m - 1) * 2 + 1]);
    else q.push(q[0], q[1]);
    p = q;
  }
  return Float64Array.from(p);
}

// Deepest cell of each connected group (4-neighbors) of cells sharing a key
function groupSpots(world: WorldData, key: (i: number) => number, minCells: number): { key: number; x: number; y: number; depth: number; cells: number[] }[] {
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const seen = new Uint8Array(N);
  const out: { key: number; x: number; y: number; depth: number; cells: number[] }[] = [];
  for (let s = 0; s < N; s++) {
    const k = key(s);
    if (seen[s] || k < 0) continue;
    const cells: number[] = [s];
    seen[s] = 1;
    for (let h = 0; h < cells.length; h++) {
      const i = cells[h];
      const x = i % W;
      const y = (i - x) / W;
      for (const j of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? i - W : -1, y + 1 < H ? i + W : -1]) {
        if (j < 0 || seen[j] || key(j) !== k) continue;
        seen[j] = 1;
        cells.push(j);
      }
    }
    if (cells.length < minCells) continue;
    // Distance to the group's edge, in rings
    const inGroup = new Set(cells);
    const depth = new Map<number, number>();
    const q: number[] = [];
    for (const i of cells) {
      const x = i % W;
      const y = (i - x) / W;
      const edge = [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? i - W : -1, y + 1 < H ? i + W : -1].some((j) => j < 0 || !inGroup.has(j));
      if (edge) {
        depth.set(i, 1);
        q.push(i);
      }
    }
    let best = q[0] ?? s;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % W;
      const y = (i - x) / W;
      for (const j of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? i - W : -1, y + 1 < H ? i + W : -1]) {
        if (j < 0 || !inGroup.has(j) || depth.has(j)) continue;
        depth.set(j, depth.get(i)! + 1);
        q.push(j);
        if (depth.get(j)! > depth.get(best)!) best = j;
      }
    }
    out.push({ key: k, x: (best % W) + 0.5, y: Math.floor(best / W) + 0.5, depth: depth.get(best) ?? 1, cells });
  }
  return out.sort((a, b) => b.cells.length - a.cells.length);
}

const WON = "#c8231e";
const LOST_BATTLE = "#2357b5";

function battleDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.32);
  ctx.strokeStyle = "#fffaf0";
  ctx.stroke();
}

const LETTERING: Record<MapTheme, { font: string; ink: string; halo: string }> = {
  Historical: { font: "'IM Fell English', Georgia, serif", ink: "#2e2016", halo: "rgba(243, 233, 208, 0.92)" },
  Atlas: { font: "Inter, 'Segoe UI', system-ui, sans-serif", ink: "#1f2830", halo: "rgba(255, 255, 255, 0.92)" },
  Realistic: { font: "'Cormorant Garamond', Georgia, serif", ink: "#f4ead2", halo: "rgba(20, 22, 26, 0.85)" },
};

type Rect = { x: number; y: number; w: number; h: number };

// Outlines, notes and battle markers over the rendered map. Layout pixels,
// translated into the map rectangle of the view.
function paintOverlay(ctx: CanvasRenderingContext2D, world: WorldData, exp: Expansion, v: MapView, theme: MapTheme) {
  const pr = v.pixelRatio;
  const W = world.width;
  const s = v.scale / pr; // layout px per cell
  const ox = v.offsetX / pr;
  const oy = v.offsetY / pr;
  const w = v.w / pr;
  const h = v.h / pr;
  const gx0 = Math.floor(-ox / s) - 2;
  const gx1 = Math.ceil((w - ox) / s) + 2;
  const L = LETTERING[theme];
  const shades = expansionShades(exp.color, exp.periods.length);
  const deep = hex(shades[0]);
  const pale = hex(expansionShades(exp.color, 2)[1]);
  const px = (x: number) => x * s + ox;
  const py = (y: number) => y * s + oy;
  // A point in view: the world copy nearest the view's middle
  const wrapX = (x: number) => {
    const mid = (w / 2 - ox) / s;
    return x + Math.round((mid - x) / W) * W;
  };
  const stroke = (chains: Float64Array[], width: number, color: string, dash: number[] = []) => {
    ctx.beginPath();
    for (const c of chains) {
      ctx.moveTo(px(c[0]), py(c[1]));
      for (let k = 2; k < c.length; k += 2) ctx.lineTo(px(c[k]), py(c[k + 1]));
    }
    ctx.setLineDash(dash);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  ctx.save();
  ctx.setTransform(pr, 0, 0, pr, v.x, v.y);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Thin light lines between the periods (and the land held for a time),
  // like the internal edges of a hand-colored map
  const band = (i: number) => (exp.cls[i] === LOST ? 100 : exp.cls[i]);
  const periodEdges = outlines(world, (i, j) => band(i) >= 0 && band(j) >= 0 && band(i) < band(j), gx0, gx1);
  stroke(periodEdges, 1.1, theme === "Realistic" ? "rgba(255,255,255,0.45)" : "rgba(255,252,240,0.7)");

  // Vassals: a pale line of the realm's color around their land
  const vassalEdge = outlines(world, (i, j) => exp.vassalCell[i] >= 0 && exp.vassalCell[j] < 0, gx0, gx1);
  stroke(vassalEdge, 2.4, pale, [5, 3]);

  // The border at the greatest extent, strong over a light halo
  const peak = outlines(world, (i, j) => exp.peak.mask[i] === 1 && exp.peak.mask[j] !== 1, gx0, gx1);
  const width = Math.max(2.2, Math.min(4, s * 0.35));
  stroke(peak, width + 3, theme === "Realistic" ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.75)");
  stroke(peak, width, deep);

  // Notes: vassals, then land held for a time
  const taken: Rect[] = [];
  const free = (r: Rect) => !taken.some((t) => r.x < t.x + t.w + 4 && r.x + r.w + 4 > t.x && r.y < t.y + t.h + 3 && r.y + r.h + 3 > t.y);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const note = (lines: { text: string; size: number; italic?: boolean; caps?: boolean }[], x: number, y: number, color = L.ink, halo = L.halo) => {
    let total = 0;
    const metrics = lines.map((l) => {
      ctx.font = `${l.italic ? "italic " : ""}600 ${l.size}px ${L.font}`;
      ctx.letterSpacing = l.caps ? `${l.size * 0.12}px` : "0px";
      const t = l.caps ? l.text.toUpperCase() : l.text;
      total += l.size * 1.2;
      return { t, wd: ctx.measureText(t).width };
    });
    const r = { x: x - Math.max(...metrics.map((m) => m.wd)) / 2, y: y - total / 2, w: Math.max(...metrics.map((m) => m.wd)), h: total };
    if (r.x < 2 || r.y < 2 || r.x + r.w > w - 2 || r.y + r.h > h - 2 || !free(r)) return false;
    let ty = r.y;
    lines.forEach((l, k) => {
      ctx.font = `${l.italic ? "italic " : ""}600 ${l.size}px ${L.font}`;
      ctx.letterSpacing = l.caps ? `${l.size * 0.12}px` : "0px";
      const cy = ty + (l.size * 1.2) / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = halo;
      ctx.strokeText(metrics[k].t, x, cy);
      ctx.fillStyle = color;
      ctx.fillText(metrics[k].t, x, cy);
      ty += l.size * 1.2;
    });
    taken.push(r);
    return true;
  };

  // Battles first: their markers must stay clear of the notes
  const marks = exp.battles.map((b) => ({ b, x: px(wrapX(b.x)), y: py(b.y) }));
  for (const m of marks) {
    if (m.x < -10 || m.x > w + 10 || m.y < -10 || m.y > h + 10) continue;
    taken.push({ x: m.x - 6, y: m.y - 6, w: 12, h: 12 });
  }

  const minNote = Math.max(12, (60 / s) * (60 / s) * 0.6); // groups big enough to carry a note
  const vassalSpots = groupSpots(world, (i) => exp.vassalCell[i], minNote);
  const labeled = new Set<number>();
  for (const g of vassalSpots) {
    if (labeled.has(g.key)) continue;
    const va = exp.vassals[g.key];
    const lines = [{ text: va.atEnd ? `Vassal from ${va.from}` : `Vassal ${vassalWhen(va).replace(/^in /, "")}`, size: 11, caps: true }];
    // A realm gone since is not named by the map's own labels
    const named = va.nation >= 0 && world.nations[va.nation]?.name === va.name;
    if (!named) lines.unshift({ text: va.name, size: 13, caps: true });
    const x = px(wrapX(g.x));
    const y = py(g.y) + (named ? 18 : 0);
    if (note(lines, x, y) || note(lines, x, py(g.y) - 18)) labeled.add(g.key);
  }
  // Each period's years inside its largest regions, where they fit
  const periodSpots = groupSpots(world, (i) => (exp.cls[i] >= 1 ? exp.cls[i] : -1), minNote);
  const perPeriod = new Map<number, number>();
  for (const g of periodSpots) {
    const p = exp.periods[g.key - 1];
    if (!p || (perPeriod.get(g.key) ?? 0) >= 2) continue;
    const text = p.from === p.to ? `${p.from}` : `${p.from}–${p.to}`;
    ctx.font = `italic 600 11px ${L.font}`;
    ctx.letterSpacing = "0px";
    if (ctx.measureText(text).width + 6 > g.depth * s * 2 || g.depth * s < 9) continue;
    const dark = lightness(shades[g.key]) < 0.66;
    const placed = note([{ text, size: 11, italic: true }], px(wrapX(g.x)), py(g.y), dark ? "#fffaf0" : "#2a2018", dark ? "rgba(20,16,12,0.55)" : "rgba(255,250,240,0.75)");
    if (placed) perPeriod.set(g.key, (perPeriod.get(g.key) ?? 0) + 1);
  }
  const lostSpots = groupSpots(world, (i) => (exp.cls[i] === LOST ? 1 : -1), minNote);
  for (const g of lostSpots.slice(0, 8)) {
    const from = g.cells.map((i) => exp.firstHeld[i]).sort((a, b) => a - b);
    const to = g.cells.map((i) => exp.lostAt[i]).filter((y) => y >= 0).sort((a, b) => a - b);
    const a = from[from.length >> 1];
    const b = to[to.length >> 1] ?? exp.endYear;
    const text = a <= exp.startYear ? `lost ${b}` : `held ${a}–${b}`;
    note([{ text, size: 12, italic: true }], px(wrapX(g.x)), py(g.y), theme === "Realistic" ? L.ink : "#6b5410");
  }

  // Battle markers and their names
  for (const m of marks) {
    if (m.x < -10 || m.x > w + 10 || m.y < -10 || m.y > h + 10) continue;
    battleDot(ctx, m.x, m.y, 6, m.b.won ? WON : LOST_BATTLE);
  }
  for (const m of marks) {
    const text = m.b.place ? `${m.b.place} ${m.b.year}` : `${m.b.year}`;
    const color = m.b.won ? "#8e1512" : "#173f8a";
    const lines = [{ text, size: 11.5 }];
    // Right of the dot, else left, below or above
    ctx.font = `600 11.5px ${L.font}`;
    ctx.letterSpacing = "0px";
    const tw = ctx.measureText(text).width;
    const ink = theme === "Realistic" ? L.ink : color;
    for (const [x, y] of [
      [m.x + 12 + tw / 2, m.y],
      [m.x - 12 - tw / 2, m.y],
      [m.x, m.y + 18],
      [m.x, m.y - 18],
    ])
      if (note(lines, x, y, ink)) break;
  }
  ctx.letterSpacing = "0px";
  ctx.restore();
}

// Other realms are grayed into the paper, vassals into a light gray
const WASH: Record<MapTheme, { other: string; vassal: string }> = {
  Realistic: { other: "rgba(150, 150, 150, 0.35)", vassal: "rgba(222, 222, 219, 0.42)" },
  Historical: { other: "rgba(236, 226, 202, 0.55)", vassal: "rgba(200, 199, 195, 0.5)" },
  Atlas: { other: "rgba(242, 242, 239, 0.6)", vassal: "rgba(196, 196, 193, 0.45)" },
};
const VASSAL_SWATCH: Record<MapTheme, string> = { Realistic: "#cfcfcc", Historical: "#bdbbb6", Atlas: "#c6c6c3" };

// Grays the land cells `grayed` picks (like AtlasRender's dimOutside, which
// keys on today's owners) under a wash, a strip at a time
function washOutside(ctx: CanvasRenderingContext2D, world: WorldData, v: MapView, grayed: (i: number) => boolean, wash: string) {
  const W = world.width;
  const H = world.height;
  const mask = document.createElement("canvas");
  mask.width = W;
  mask.height = H;
  const mg = mask.getContext("2d")!;
  const img = mg.createImageData(W, H);
  for (let i = 0; i < W * H; i++) if (world.waterType[i] === 0 && grayed(i)) img.data[i * 4 + 3] = 255;
  mg.putImageData(img, 0, 0);
  const stripH = Math.min(v.h, 512);
  const strip = document.createElement("canvas");
  strip.width = v.w;
  strip.height = stripH;
  const s = strip.getContext("2d")!;
  const span = W * v.scale;
  const k0 = Math.floor(-v.offsetX / span) - 1;
  const k1 = Math.ceil((v.w - v.offsetX) / span);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let y = 0; y < v.h; y += stripH) {
    const h = Math.min(stripH, v.h - y);
    s.globalCompositeOperation = "source-over";
    s.filter = "none";
    s.clearRect(0, 0, v.w, stripH);
    s.imageSmoothingEnabled = true;
    for (let k = k0; k <= k1; k++) s.drawImage(mask, v.offsetX + k * span, v.offsetY - y, span, H * v.scale);
    s.globalCompositeOperation = "source-in";
    s.filter = "grayscale(1) contrast(0.8)";
    s.drawImage(ctx.canvas, v.x, v.y + y, v.w, h, 0, 0, v.w, h);
    s.filter = "none";
    s.globalCompositeOperation = "source-atop";
    s.fillStyle = wash;
    s.fillRect(0, 0, v.w, h);
    ctx.drawImage(strip, 0, 0, v.w, h, v.x, v.y + y, v.w, h);
  }
  ctx.restore();
}

// The whole poster: background, the map with the expansion as its region
// layer, the overlay, then the frame, title and legend
export async function paintExpansionPoster(
  host: AtlasHost,
  spec: ExpansionPosterSpec,
  waitForCities: boolean,
  onProgress?: (f: number, label: string) => void,
  canceled?: () => boolean,
): Promise<HTMLCanvasElement> {
  await loadPosterFonts();
  const world = host.getWorld();
  const exp = spec.expansion;
  const L = posterLayout(spec);
  const canvas = document.createElement("canvas");
  canvas.width = L.W;
  canvas.height = L.H;
  const ctx = canvas.getContext("2d")!;
  paintBackground(ctx, L, spec);
  const v = posterView(L, spec);
  await host.renderMapTo(ctx, {
    ...v,
    keep: null,
    style: undefined,
    thematic: "cultures", // a fill layer; its colors come from `paint`
    thematic2: "none",
    paint: { fill: cellPainter(world, exp), stripes: stripePainter(world, exp), strength: FILL_STRENGTH },
    waitForCities,
    onProgress,
    canceled,
  });
  if (!canceled?.()) {
    washOutside(ctx, world, v, (i) => exp.cls[i] === NONE && exp.vassalCell[i] < 0, WASH[spec.theme].other);
    if (exp.vassals.length) washOutside(ctx, world, v, (i) => exp.vassalCell[i] >= 0, WASH[spec.theme].vassal);
    paintOverlay(ctx, world, exp, v, spec.theme);
  }
  paintDecorations(ctx, L, spec, world, host.landArea());
  return canvas;
}
