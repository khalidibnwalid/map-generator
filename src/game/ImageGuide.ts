import { distanceTransform, labelComponents, yieldFrame } from "./util/grid";
import type { NoiseEngine } from "../core/NoiseEngine";

// An imported picture read as a terrain guide: which cells are land, plus
// optional hints for relief, sea depth and rainfall taken from its colors.
// Handles filled silhouettes, outline sketches (small gaps bridged, nested
// outlines alternate land and water), colored maps (blue reads as sea) and
// grayscale heightmaps.

export type ImportMode = "auto" | "silhouette" | "outline" | "colors" | "heightmap";
export type GuideKind = Exclude<ImportMode, "auto">;

export interface ImportOptions {
  mode: ImportMode;
  invert: boolean; // swap land and sea
  gaps: number; // outline gaps to bridge, as a fraction of the long side
  seaLevel: number; // heightmap brightness at the coast, 0..1; < 0 picks one
}

export interface TerrainGuide {
  w: number;
  h: number;
  land: Uint8Array; // >= 128 is land; soft edges keep resampled coasts smooth
  relief: Uint8Array | null; // land height, 0 lowland .. 255 peaks
  depth: Uint8Array | null; // sea, 0 deep .. 255 shallow
  moisture: Uint8Array | null; // 0 arid .. 255 wet
  fit: "contain" | "stretch";
  roughness: number; // 0..1, fractal detail added to the coast
  islands: number; // 0..1, archipelagos scattered off the coasts
  zoom: number; // picture size on the world, 1 = fitted
}

export type GuideAnalysis = Omit<TerrainGuide, "fit" | "roughness" | "islands" | "zoom"> & {
  kind: GuideKind; // what the picture was read as
  seaLevel: number; // heightmaps: the threshold used
  landShare: number;
  landmasses: number;
};

// Guide resampled onto the world grid (flat, y * W + x)
export interface GuideField {
  land: Float32Array; // 0..1, coast at 0.5
  relief: Float32Array | null;
  depth: Float32Array | null;
  moisture: Float32Array | null;
  inside: Float32Array; // 1 well inside the picture, fading to 0 at its edges
  roughness: number;
  islands: number;
  islandSpecs: IslandSpec[];
}

// Long side the picture is reduced to before analysis
export const ANALYSIS_SIZE = 1024;

interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const FG_DIST = 60; // color distance from the paper that counts as ink

function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, max ? d / max : 0, max / 255];
}

function isBlue(r: number, g: number, b: number): boolean {
  const [h, s, v] = hsv(r, g, b);
  return h >= 175 && h <= 250 && s > 0.18 && v > 0.15;
}

// Relief, moisture and whether the color looks like natural terrain; null
// for ink (labels, borders) that says nothing about the ground beneath.
function terrainOf(r: number, g: number, b: number): [number, number, boolean] | null {
  const [h, s, v] = hsv(r, g, b);
  if (s < 0.14) {
    if (v > 0.86) return [0.95, 0.55, true]; // snow
    if (v < 0.22) return null;
    return [0.72, 0.3, true]; // bare rock
  }
  if (h >= 65 && h < 170) return [0.12 + (1 - v) * 0.12, 0.45 + s * 0.35 + (1 - v) * 0.2, true]; // greens
  if (h >= 42 && h < 65) return [0.3, 0.2, true]; // yellow and olive plains
  if (h >= 12 && h < 42) return v < 0.62 ? [0.68, 0.3, true] : [0.36, 0.08, true]; // brown hills, tan desert
  return [0.3, 0.4, false]; // reds, pinks, purples: political colors
}

// Most common color around the edge of the picture
function paperColor(img: Rgba): [number, number, number] {
  const { data, width: w, height: h } = img;
  const bins = new Map<number, [number, number, number, number]>();
  const add = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    const k = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
    const e = bins.get(k) ?? [0, 0, 0, 0];
    e[0]++;
    e[1] += data[o];
    e[2] += data[o + 1];
    e[3] += data[o + 2];
    bins.set(k, e);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let best: [number, number, number, number] = [1, 255, 255, 255];
  for (const e of bins.values()) if (e[0] > best[0]) best = e;
  return [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
}

// Separable box blur, run twice (close to a gaussian). With `weight`, a
// normalized blur that fills unweighted pixels from their neighbors.
function blur(src: Float32Array, W: number, H: number, r: number, weight?: Float32Array): Float32Array {
  const pass = (a: Float32Array) => {
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = acc / (2 * r + 1);
        acc += a[y * W + Math.min(W - 1, x + r + 1)] - a[y * W + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
    return out;
  };
  if (!weight) return pass(pass(src));
  const sw = new Float32Array(W * H);
  for (let i = 0; i < sw.length; i++) sw[i] = src[i] * weight[i];
  const num = pass(pass(sw));
  const den = pass(pass(weight));
  for (let i = 0; i < num.length; i++) num[i] = den[i] > 1e-4 ? num[i] / den[i] : 0;
  return num;
}

// Morphological opening: drops parts of the mask thinner than about 2r and
// leaves broader shapes as they were
function open(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const N = mask.length;
  const outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) outside[i] = mask[i] ? 0 : 1;
  const toOutside = distanceTransform(W, H, outside).dist;
  const core = new Uint8Array(N);
  for (let i = 0; i < N; i++) core[i] = toOutside[i] > r ? 1 : 0;
  const toCore = distanceTransform(W, H, core).dist;
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = mask[i] && toCore[i] <= r + 0.5 ? 1 : 0;
  return out;
}

// Drops specks of land and fills small enclosed ponds
function despeckle(land: Uint8Array, W: number, H: number): void {
  const N = W * H;
  const minIsland = Math.max(4, Math.round(N * 0.00003));
  const minLake = Math.max(12, Math.round(N * 0.0004));
  const lc = labelComponents(W, H, land);
  for (let i = 0; i < N; i++) if (land[i] && lc.sizes[lc.labels[i]] < minIsland) land[i] = 0;
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = land[i] ? 0 : 1;
  const wc = labelComponents(W, H, sea);
  const open = new Uint8Array(wc.sizes.length);
  for (let x = 0; x < W; x++) {
    if (sea[x]) open[wc.labels[x]] = 1;
    if (sea[(H - 1) * W + x]) open[wc.labels[(H - 1) * W + x]] = 1;
  }
  for (let y = 0; y < H; y++) {
    if (sea[y * W]) open[wc.labels[y * W]] = 1;
    if (sea[y * W + W - 1]) open[wc.labels[y * W + W - 1]] = 1;
  }
  for (let i = 0; i < N; i++) if (sea[i] && !open[wc.labels[i]] && wc.sizes[wc.labels[i]] < minLake) land[i] = 1;
}

function detectKind(img: Rgba, paper: [number, number, number]): GuideKind | "drawing" {
  const { data } = img;
  const n = img.width * img.height;
  let blue = 0;
  let gray = 0;
  let mid = 0;
  const levels = new Uint32Array(64);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (isBlue(r, g, b)) blue++;
    const [, s, v] = hsv(r, g, b);
    if (s < 0.1) gray++;
    const d = Math.hypot(r - paper[0], g - paper[1], b - paper[2]);
    if (d > 40 && v > 0.08 && v < 0.92) {
      mid++;
      levels[Math.floor(v * 63.99)]++;
    }
  }
  if (isBlue(...paper) || blue > n * 0.08) return "colors";
  let populated = 0;
  for (const c of levels) if (c > n * 0.002) populated++;
  if (gray > n * 0.97 && mid > n * 0.25 && populated >= 20) return "heightmap";
  return "drawing";
}

export function analyzeImage(img: Rgba, opts: ImportOptions): GuideAnalysis {
  // Transparent pixels read as white paper
  const data = new Uint8ClampedArray(img.data);
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3] / 255;
    if (a < 1) for (let c = 0; c < 3; c++) data[o + c] = data[o + c] * a + 255 * (1 - a);
  }
  const src: Rgba = { data, width: img.width, height: img.height };
  const paper = paperColor(src);
  const detected = opts.mode === "auto" ? detectKind(src, paper) : opts.mode;

  let res: Omit<GuideAnalysis, "landShare" | "landmasses">;
  if (detected === "heightmap") res = readHeightmap(src, opts);
  else if (detected === "colors") res = readColors(src, paper, opts);
  else res = readDrawing(src, paper, opts, detected === "drawing" ? "auto" : detected);

  const { w, h } = res;
  const mask = new Uint8Array(w * h);
  let land = 0;
  for (let i = 0; i < mask.length; i++) if (res.land[i] >= 128) {
    mask[i] = 1;
    land++;
  }
  const minArea = w * h * 0.0005;
  const landmasses = labelComponents(w, h, mask).sizes.filter((s) => s >= minArea).length;
  return { ...res, landShare: land / (w * h), landmasses };
}

const toBytes = (f: Float32Array): Uint8Array => {
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, f[i])) * 255);
  return out;
};

// Soft 0..255 coast from a binary mask
function softLand(mask: Uint8Array, W: number, H: number): Uint8Array {
  const f = new Float32Array(mask.length);
  for (let i = 0; i < f.length; i++) f[i] = mask[i];
  return toBytes(blur(f, W, H, 1));
}

// Relief and moisture from the colors of `known` land pixels, or null when
// the colors carry no terrain (one flat fill, or a political map)
function colorTerrain(
  img: Rgba,
  land: Uint8Array,
  known: (i: number) => boolean,
): { relief: Uint8Array | null; moisture: Uint8Array | null } {
  const { data, width: W, height: H } = img;
  const N = W * H;
  const rel = new Float32Array(N);
  const moist = new Float32Array(N);
  const wt = new Float32Array(N);
  let count = 0;
  let natural = 0;
  let sr = 0;
  let sr2 = 0;
  let sm = 0;
  let sm2 = 0;
  for (let i = 0; i < N; i++) {
    if (!land[i] || !known(i)) continue;
    const t = terrainOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (!t) continue;
    rel[i] = t[0];
    moist[i] = t[1];
    wt[i] = 1;
    count++;
    if (t[2]) natural++;
    sr += t[0];
    sr2 += t[0] * t[0];
    sm += t[1];
    sm2 += t[1] * t[1];
  }
  if (count < N * 0.01 || natural < count * 0.6) return { relief: null, moisture: null };
  const varR = sr2 / count - (sr / count) ** 2;
  const varM = sm2 / count - (sm / count) ** 2;
  const L = Math.max(W, H);
  return {
    relief: varR > 0.004 ? toBytes(blur(rel, W, H, Math.max(2, Math.round(L / 120)), wt)) : null,
    moisture: varM > 0.004 ? toBytes(blur(moist, W, H, Math.max(2, Math.round(L / 80)), wt)) : null,
  };
}

function readHeightmap(img: Rgba, opts: ImportOptions): Omit<GuideAnalysis, "landShare" | "landmasses"> {
  const { data, width: W, height: H } = img;
  const N = W * H;
  const lum = new Float32Array(N);
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    let l = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    if (opts.invert) l = 1 - l;
    lum[i] = l;
    hist[Math.round(l * 255)]++;
  }
  const seaLevel = opts.seaLevel >= 0 ? opts.seaLevel : autoSeaLevel(hist, N);
  // 8-bit steps would show as terraces
  const smooth = blur(lum, W, H, 1);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = smooth[i] >= seaLevel ? 1 : 0;
  despeckle(mask, W, H);
  let top = seaLevel;
  for (let k = 255, acc = 0; k >= 0; k--) {
    acc += hist[k];
    if (acc > N * 0.003) {
      top = Math.max(seaLevel + 0.05, k / 255);
      break;
    }
  }
  const relief = new Float32Array(N);
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    relief[i] = (smooth[i] - seaLevel) / (top - seaLevel);
    depth[i] = seaLevel > 0.01 ? smooth[i] / seaLevel : 0.5;
  }
  return {
    w: W,
    h: H,
    land: softLand(mask, W, H),
    relief: toBytes(relief),
    depth: toBytes(depth),
    moisture: null,
    kind: "heightmap",
    seaLevel,
  };
}

// Otsu's threshold: the brightness that best splits sea from land
function autoSeaLevel(hist: Uint32Array, N: number): number {
  let sum = 0;
  for (let k = 0; k < 256; k++) sum += k * hist[k];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let level = 0.3;
  for (let k = 0; k < 256; k++) {
    wB += hist[k];
    if (!wB) continue;
    const wF = N - wB;
    if (!wF) break;
    sumB += k * hist[k];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      level = (k + 0.5) / 255;
    }
  }
  return Math.max(0.04, Math.min(0.7, level));
}

function readColors(img: Rgba, paper: [number, number, number], opts: ImportOptions): Omit<GuideAnalysis, "landShare" | "landmasses"> {
  const { data, width: W, height: H } = img;
  const N = W * H;
  const L = Math.max(W, H);
  const paperIsSea = isBlue(...paper);
  const water = new Uint8Array(N);
  const nearPaper = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const d = Math.hypot(r - paper[0], g - paper[1], b - paper[2]);
    water[i] = isBlue(r, g, b) || (paperIsSea && d < 50) ? 1 : 0;
    nearPaper[i] = d < 35 ? 1 : 0;
  }
  // A plain margin around the map (paper, frame) is open sea, not land
  if (!paperIsSea) {
    const pc = labelComponents(W, H, nearPaper);
    const edge = new Set<number>();
    for (let x = 0; x < W; x++) {
      if (nearPaper[x]) edge.add(pc.labels[x]);
      if (nearPaper[(H - 1) * W + x]) edge.add(pc.labels[(H - 1) * W + x]);
    }
    for (let y = 0; y < H; y++) {
      if (nearPaper[y * W]) edge.add(pc.labels[y * W]);
      if (nearPaper[y * W + W - 1]) edge.add(pc.labels[y * W + W - 1]);
    }
    for (let i = 0; i < N; i++) if (nearPaper[i] && edge.has(pc.labels[i])) water[i] = 1;
  }
  // Borders and lettering are thin ink, rivers thin water; both go. Ink
  // first, before the gaps between letters can read as land.
  const r = Math.max(1.5, L / 300);
  const ground = new Uint8Array(N);
  for (let i = 0; i < N; i++) ground[i] = water[i] ? 0 : 1;
  const sea = open(open(ground, W, H, r).map((v) => 1 - v), W, H, r);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = opts.invert ? sea[i] : 1 - sea[i];
  despeckle(mask, W, H);

  let relief: Uint8Array | null = null;
  let moisture: Uint8Array | null = null;
  let depth: Uint8Array | null = null;
  if (!opts.invert) {
    ({ relief, moisture } = colorTerrain(img, mask, () => true));
    // Lighter blue is shallower
    const vals: number[] = [];
    const v = new Float32Array(N);
    const wt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (mask[i] || !water[i] || (!paperIsSea && nearPaper[i])) continue;
      v[i] = hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])[2];
      wt[i] = 1;
      if ((i & 7) === 0) vals.push(v[i]);
    }
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.05)] ?? 0;
    const hi = vals[Math.floor(vals.length * 0.95)] ?? 0;
    if (hi - lo > 0.06) {
      for (let i = 0; i < N; i++) v[i] = (v[i] - lo) / (hi - lo);
      depth = toBytes(blur(v, W, H, Math.max(2, Math.round(L / 120)), wt));
    }
  }
  return { w: W, h: H, land: softLand(mask, W, H), relief, depth, moisture, kind: "colors", seaLevel: -1 };
}

// Sketches and silhouettes. Ink is anything unlike the paper. Bulky ink is
// filled land; thin ink is an outline whose inside is land. Crossing an
// outline flips between sea and land, so a ring inside an island is a lake.
function readDrawing(
  img: Rgba,
  paper: [number, number, number],
  opts: ImportOptions,
  force: "auto" | "silhouette" | "outline",
): Omit<GuideAnalysis, "landShare" | "landmasses"> {
  const { data, width: iw, height: ih } = img;
  const L = Math.max(iw, ih);
  const g = Math.max(1, Math.round(opts.gaps * L));
  // A margin of paper so outlines touching the edge can still be closed
  const P = Math.max(g + 3, Math.round(L * 0.03));
  const W = iw + 2 * P;
  const H = ih + 2 * P;
  const N = W * H;
  const at = (x: number, y: number) => (y + P) * W + x + P;

  const ink = new Uint8Array(N);
  for (let y = 0; y < ih; y++)
    for (let x = 0; x < iw; x++) {
      const o = (y * iw + x) * 4;
      const d = Math.hypot(data[o] - paper[0], data[o + 1] - paper[1], data[o + 2] - paper[2]);
      if (d > FG_DIST) ink[at(x, y)] = 1;
    }

  // Bulk: area against the square of the mean stroke width. A ring or a line
  // is long for its width; a blob is not.
  const comps = labelComponents(W, H, ink);
  const notInk = new Uint8Array(N);
  for (let i = 0; i < N; i++) notInk[i] = ink[i] ? 0 : 1;
  const inner = distanceTransform(W, H, notInk).dist;
  const sumIn = new Float64Array(comps.sizes.length);
  for (let i = 0; i < N; i++) if (ink[i]) sumIn[comps.labels[i]] += inner[i] - 0.5;
  const minSpeck = Math.max(3, Math.round(iw * ih * 0.00001));
  const compKind = comps.sizes.map((area, c) => {
    if (area < minSpeck) return 0; // dust
    if (force === "silhouette") return 2;
    if (force === "outline") return 1;
    const width = (2 * sumIn[c]) / area;
    return area / (width * width) > 70 ? 1 : 2;
  });
  const line0 = new Uint8Array(N);
  const fill = new Uint8Array(N);
  let lineArea = 0;
  let fillArea = 0;
  for (let i = 0; i < N; i++) {
    if (!ink[i]) continue;
    const k = compKind[comps.labels[i]];
    if (k === 1) {
      line0[i] = 1;
      lineArea++;
    } else if (k === 2) {
      fill[i] = 1;
      fillArea++;
    }
  }

  // Thicken outlines to bridge small gaps in the pen stroke
  const toLine = distanceTransform(W, H, line0).dist;
  const line = new Uint8Array(N);
  for (let i = 0; i < N; i++) line[i] = toLine[i] <= g && !fill[i] ? 1 : 0;

  // 0-1 BFS from the margin; stepping off an outline costs one crossing
  const cost = new Int32Array(N).fill(0x7fffffff);
  let cur = new Int32Array(N);
  let next = new Int32Array(N);
  let nc = 0;
  let nn = 0;
  for (let x = 0; x < W; x++) {
    cost[x] = 0;
    cur[nc++] = x;
  }
  for (let k = 0; nc > 0; k++) {
    for (let qi = 0; qi < nc; qi++) {
      const p = cur[qi];
      if (cost[p] !== k) continue;
      const x = p % W;
      const nbs = [x + 1 < W ? p + 1 : -1, x > 0 ? p - 1 : -1, p + W < N ? p + W : -1, p - W];
      for (const q of nbs) {
        if (q < 0) continue;
        const c = k + (line[p] && !line[q] ? 1 : 0);
        if (c >= cost[q]) continue;
        cost[q] = c;
        if (c === k) cur[nc++] = q;
        else next[nn++] = q;
      }
    }
    [cur, next] = [next, cur];
    nc = nn;
    nn = 0;
  }

  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!line[i]) mask[i] = fill[i] || cost[i] & 1 ? 1 : 0;

  // Outline pixels: split between their two sides along the stroke's middle.
  // A stroke with sea on both sides is a sliver of an island; one inside the
  // land (a river, a mountain mark) stays land.
  const lc = labelComponents(W, H, line);
  const sides = new Uint8Array(lc.sizes.length); // bit 1: land, bit 2: sea
  const box = lc.sizes.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < N; i++) {
    if (!line[i]) continue;
    const c = lc.labels[i];
    const x = i % W;
    const y = (i - x) / W;
    for (const q of [i + 1, i - 1, i + W, i - W]) if (q >= 0 && q < N && !line[q]) sides[c] |= mask[q] ? 1 : 2;
    if (line0[i]) {
      const b = box[c];
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  }
  const nonLine = new Uint8Array(N);
  for (let i = 0; i < N; i++) nonLine[i] = line[i] ? 0 : 1;
  const nearest = distanceTransform(W, H, nonLine).nearest;
  const minStroke = L * 0.012;
  const islandWidth = Math.max(1.5, g * 0.5);
  for (let i = 0; i < N; i++) {
    if (!line[i]) continue;
    const c = lc.labels[i];
    if (sides[c] === 3) mask[i] = mask[nearest[i]];
    else if (sides[c] & 1) mask[i] = 1;
    else {
      const b = box[c];
      const big = Math.hypot(b[2] - b[0], b[3] - b[1]) >= minStroke;
      mask[i] = big && toLine[i] <= islandWidth ? 1 : 0;
    }
  }

  // Back to the picture's own frame
  const out = new Uint8Array(iw * ih);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) out[y * iw + x] = mask[at(x, y)];
  if (opts.invert) for (let i = 0; i < out.length; i++) out[i] ^= 1;
  despeckle(out, iw, ih);

  // Painted fills may carry terrain colors (green lowland, brown hills)
  let terrain: { relief: Uint8Array | null; moisture: Uint8Array | null } = { relief: null, moisture: null };
  if (!opts.invert && fillArea > 0) terrain = colorTerrain(img, out, (i) => fill[at(i % iw, Math.floor(i / iw))] === 1);

  return {
    w: iw,
    h: ih,
    land: softLand(out, iw, ih),
    relief: terrain.relief,
    depth: null,
    moisture: terrain.moisture,
    kind: lineArea > fillArea ? "outline" : "silhouette",
    seaLevel: -1,
  };
}

// Where the guide lands on a W x H world: "contain" keeps its proportions
// inside an ocean margin, "stretch" covers the whole map. Zoom scales it
// about the center; past 1 the picture's edges fall off the map.
export function guidePlacement(guide: Pick<TerrainGuide, "w" | "h" | "fit" | "zoom">, W: number, H: number) {
  let sx: number;
  let sy: number;
  if (guide.fit === "stretch") {
    sx = (W / guide.w) * guide.zoom;
    sy = (H / guide.h) * guide.zoom;
  } else {
    sx = sy = Math.min((W * 0.94) / guide.w, (H * 0.88) / guide.h) * guide.zoom;
  }
  return { sx, sy, ox: (W - guide.w * sx) / 2, oy: (H - guide.h * sy) / 2 };
}

// Bilinear resample onto the world grid; outside the picture is open ocean.
// `seed` lays out the islands (null leaves them out).
export function sampleGuide(guide: TerrainGuide, W: number, H: number, seed: number | null): GuideField {
  const { sx, sy, ox, oy } = guidePlacement(guide, W, H);
  const gw = guide.w;
  const gh = guide.h;
  const N = W * H;
  const read = (src: Uint8Array, outside: number) => {
    const out = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5 - oy) / sy - 0.5;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5 - ox) / sx - 0.5;
        if (u < -0.5 || v < -0.5 || u > gw - 0.5 || v > gh - 0.5) {
          out[y * W + x] = outside;
          continue;
        }
        const cu = Math.max(0, Math.min(gw - 1, u));
        const cv = Math.max(0, Math.min(gh - 1, v));
        const x0 = Math.min(gw - 2, Math.floor(cu));
        const y0 = Math.min(gh - 2, Math.floor(cv));
        const fx = cu - x0;
        const fy = cv - y0;
        const i = y0 * gw + x0;
        const top = src[i] + (src[i + 1] - src[i]) * fx;
        const bot = src[i + gw] + (src[i + gw + 1] - src[i + gw]) * fx;
        out[y * W + x] = (top + (bot - top) * fy) / 255;
      }
    }
    return out;
  };
  const inside = new Float32Array(N);
  const fade = Math.max(2, Math.min(W, H) * 0.05);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.min(x + 0.5 - ox, ox + gw * sx - x - 0.5, y + 0.5 - oy, oy + gh * sy - y - 0.5);
      inside[y * W + x] = Math.max(0, Math.min(1, d / fade));
    }
  return {
    land: read(guide.land, 0),
    relief: guide.relief && read(guide.relief, 0),
    depth: guide.depth && read(guide.depth, 0),
    moisture: guide.moisture && read(guide.moisture, 0.5),
    inside,
    roughness: guide.roughness,
    islands: guide.islands,
    islandSpecs: seed === null ? [] : layoutIslands(guide, W / H, seed),
  };
}

export interface IslandSpec {
  x: number; // center, fraction of the map width
  y: number; // center, fraction of the map height
  r: number; // half-width, fraction of the map width
  e: number; // length over width
  a: number; // heading of the long axis, radians
}

// Mulberry32
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Islands that follow the drawn land: chains carrying peninsulas and capes
// on out to sea, shrinking as they go, and stepping stones across the
// straits between landmasses. Laid out on a fixed 800-wide grid so the
// preview and every map size get the same islands.
export function layoutIslands(guide: TerrainGuide, aspect: number, seed: number): IslandSpec[] {
  const amt = guide.islands;
  if (amt <= 0) return [];
  const W = 800;
  const H = Math.max(100, Math.round(W / aspect));
  const N = W * H;
  const f = sampleGuide(guide, W, H, null);
  const land = new Uint8Array(N);
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (f.land[i] >= 0.5) land[i] = 1;
    else sea[i] = 1;
  }
  const toLand = distanceTransform(W, H, land);
  const toSea = distanceTransform(W, H, sea).dist;
  const mass = labelComponents(W, H, land);
  const big = (i: number) => mass.sizes[mass.labels[i]] >= 40;
  const rand = rng(Math.imul(seed, 2654435761) ^ 0x5bd1e995);
  const wrap = (x: number) => ((x % W) + W) % W;
  const wrapDx = (dx: number) => (dx > W / 2 ? dx - W : dx < -W / 2 ? dx + W : dx);
  const out: IslandSpec[] = [];

  // Room for an island reaching `ext` cells from (x, y), clear of land and
  // of the islands placed so far
  const fits = (x: number, y: number, ext: number) => {
    if (y < H * 0.05 || y > H * 0.95) return false;
    if (toLand.dist[Math.round(y) * W + wrap(Math.round(x))] < ext + 2) return false;
    return out.every((o) => Math.hypot(wrapDx(o.x * W - x), o.y * H - y) >= o.r * W * o.e + ext + 1.5);
  };
  const place = (x: number, y: number, r: number, e: number, a: number) => {
    if (r < 1.2 || !fits(x, y, r * e)) return false;
    out.push({ x: wrap(x) / W, y: y / H, r: r / W, e, a });
    return true;
  };

  // Stepping stones: for each pair of landmasses, the narrowest sea between
  // them, found where their nearest-land regions meet
  const best = new Map<number, { gap: number; a: number; b: number }>();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!sea[i]) continue;
      for (const j of [y * W + wrap(x + 1), y + 1 < H ? i + W : -1]) {
        if (j < 0 || !sea[j]) continue;
        const a = toLand.nearest[i];
        const b = toLand.nearest[j];
        if (a < 0 || b < 0) continue;
        const la = mass.labels[a];
        const lb = mass.labels[b];
        if (la === lb || !big(a) || !big(b)) continue;
        const gap = toLand.dist[i] + toLand.dist[j] + 1;
        const key = Math.min(la, lb) * N + Math.max(la, lb);
        const cur = best.get(key);
        if (!cur || gap < cur.gap) best.set(key, { gap, a, b });
      }
    }
  const straits = [...best.values()]
    .filter((p) => p.gap > 6 && p.gap < 20 + 100 * amt)
    .sort((p, q) => p.gap - q.gap)
    .slice(0, 1 + Math.round(amt * 8));
  for (const p of straits) {
    const ax = p.a % W;
    const ay = (p.a - ax) / W;
    const dx = wrapDx((p.b % W) - ax);
    const dy = Math.floor(p.b / W) - ay;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const m = Math.max(1, Math.min(9, Math.floor(len / (11 + rand() * 6))));
    for (let k = 1; k <= m; k++) {
      const t = k / (m + 1);
      const side = (rand() - 0.5) * len * 0.12;
      const r = Math.max(1.3, Math.min(7, (len / (m + 1)) * 0.25 * (0.7 + rand() * 0.6) * (0.6 + amt * 0.6)));
      place(ax + dx * t - Math.sin(ang) * side, ay + dy * t + Math.cos(ang) * side, r, 1 + rand() * 0.9, ang + (rand() - 0.5) * 0.6);
    }
  }

  // Tips: coast cells with little land around them, the land lying behind.
  // Summed-area tables give the land count and centroid in any box.
  const W1 = W + 1;
  const cnt = new Float64Array(W1 * (H + 1));
  const sx = new Float64Array(W1 * (H + 1));
  const sy = new Float64Array(W1 * (H + 1));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = land[y * W + x];
      const o = (y + 1) * W1 + x + 1;
      cnt[o] = v + cnt[o - W1] + cnt[o - 1] - cnt[o - W1 - 1];
      sx[o] = v * x + sx[o - W1] + sx[o - 1] - sx[o - W1 - 1];
      sy[o] = v * y + sy[o - W1] + sy[o - 1] - sy[o - W1 - 1];
    }
  const box = (A: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    A[(y1 + 1) * W1 + x1 + 1] - A[y0 * W1 + x1 + 1] - A[(y1 + 1) * W1 + x0] + A[y0 * W1 + x0];
  const R = 14;
  const tips: { x: number; y: number; dx: number; dy: number; score: number }[] = [];
  for (let y = R; y < H - R; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!land[i] || !big(i)) continue;
      if (land[y * W + wrap(x + 1)] && land[y * W + wrap(x - 1)] && land[i - W] && land[i + W]) continue;
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(W - 1, x + R);
      const c = box(cnt, x0, y - R, x1, y + R);
      const frac = c / ((x1 - x0 + 1) * (2 * R + 1));
      // More islands also start from blunter capes
      if (frac > 0.25 + 0.15 * amt) continue;
      const ox = x - box(sx, x0, y - R, x1, y + R) / c;
      const oy = y - box(sy, x0, y - R, x1, y + R) / c;
      const off = Math.hypot(ox, oy);
      if (off < R * 0.35) continue;
      tips.push({ x, y, dx: ox / off, dy: oy / off, score: frac - (off / R) * 0.1 });
    }
  tips.sort((a, b) => a.score - b.score);
  const chosen: typeof tips = [];
  const maxTips = 1 + Math.round(amt * 12);
  for (const t of tips) {
    if (chosen.length >= maxTips) break;
    if (chosen.some((c) => Math.hypot(wrapDx(c.x - t.x), c.y - t.y) < R * 3)) continue;
    chosen.push(t);
  }
  for (const t of chosen) {
    // Islands as wide as the peninsula they continue
    const back = Math.round(t.y - t.dy * R * 0.5) * W + wrap(Math.round(t.x - t.dx * R * 0.5));
    const width = Math.max(1.5, Math.min(8, toSea[back]));
    let r = Math.max(1.5, Math.min(9, width * (0.6 + rand() * 0.5) * (0.7 + amt * 0.5)));
    let e = 1.2 + rand() * 1.3;
    let ang = Math.atan2(t.dy, t.dx);
    const turn = (rand() - 0.5) * 0.5; // chains bend into arcs
    const lead = r * e + 2 + rand() * 4;
    let px = t.x + t.dx * lead;
    let py = t.y + t.dy * lead;
    const n = 1 + Math.floor(rand() * (1 + amt * 6));
    for (let k = 0; k < n; k++) {
      if (!place(px, py, r, e, ang + (rand() - 0.5) * 0.4)) break;
      const r2 = r * (0.65 + rand() * 0.3);
      const e2 = 1.2 + rand() * 1.3;
      const step = r * e + r2 * e2 + 2 + rand() * 5;
      ang += turn + (rand() - 0.5) * 0.3;
      px += Math.cos(ang) * step;
      py += Math.sin(ang) * step;
      r = r2;
      e = e2;
    }
  }
  return out;
}

// Signed distance to the coast in cells, land > 0: the drawn coast pushed
// about by noise into bays and capes, islets along the shelf, and the laid
// out islands. Shared by the generator and the import preview, so the
// preview shows the coast the world will get.
export async function shapeCoast(
  field: GuideField,
  W: number,
  H: number,
  noise: NoiseEngine,
  onProgress?: (pct: number) => void,
): Promise<Float32Array> {
  const N = W * H;
  const res = W / 800;
  const inv = 800 / W;
  const isLand = new Uint8Array(N);
  const isSea = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (field.land[i] >= 0.5) isLand[i] = 1;
    else isSea[i] = 1;
  }
  const toSea = distanceTransform(W, H, isSea).dist;
  const toLand = distanceTransform(W, H, isLand).dist;
  const rough = field.roughness * res;
  const isl = field.islands;
  const shelf = (3 + 6 * isl) * res;
  const out = new Float32Array(N);
  for (let x = 0; x < W; x++) {
    if (x % 50 === 0) {
      onProgress?.((x / W) * 90);
      await yieldFrame();
    }
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      let s = isLand[i] ? toSea[i] - 0.5 : 0.5 - toLand[i];
      if (rough > 0)
        s +=
          (noise.fbmCylinder(x + 900, y + 400, W, 4, 0.5, 2.0, 0.009 * inv) - 0.5) * 30 * rough +
          (noise.fbmCylinder(x + 300, y + 800, W, 4, 0.5, 2.0, 0.04 * inv) - 0.5) * 9 * rough;
      // Islets just off the shore
      if (isl > 0 && s < 0 && toLand[i] < shelf) {
        const n = noise.fbmCylinder(x + 5300, y + 1700, W, 4, 0.5, 2.0, 0.05 * inv);
        const thr = 0.74 - 0.14 * isl * (1 - toLand[i] / shelf);
        if (n > thr) s = Math.max(s, (n - thr) * 20 * res);
      }
      out[i] = s;
    }
  }
  for (const o of field.islandSpecs) {
    const cx = o.x * W;
    const cy = o.y * H;
    const r = o.r * W;
    // Far enough out that the island's shelf has sunk to open sea (the
    // generator's shelf reaches 16 cells at 800 wide), so it leaves no edge
    const ext = Math.ceil((r * 1.7 + 18 * res) * o.e);
    const ca = Math.cos(o.a);
    const sa = Math.sin(o.a);
    for (let y = Math.max(0, Math.floor(cy - ext)); y <= Math.min(H - 1, Math.ceil(cy + ext)); y++)
      for (let xx = Math.floor(cx - ext); xx <= Math.ceil(cx + ext); xx++) {
        const x = ((xx % W) + W) % W;
        const dx = xx + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.hypot((dx * ca + dy * sa) / o.e, dy * ca - dx * sa);
        const i = y * W + x;
        if (r - d <= out[i] - r) continue;
        // Ragged rather than oval near the shore, smooth further out
        const fade = Math.min(1, 3 - d / r);
        const jag = fade > 0 ? (noise.fbmCylinder(x + 7700, y + 300, W, 3, 0.5, 2.0, 0.05 * inv) - 0.5) * r * 1.4 * fade : 0;
        out[i] = Math.max(out[i], r - d + jag);
      }
  }
  onProgress?.(100);
  return out;
}
