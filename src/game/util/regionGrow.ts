import type { WorldData } from "../WorldData";
import type { NoiseEngine } from "../../core/NoiseEngine";
import { MinHeap, distanceTransform } from "./grid";

export interface GrowSeed {
  cell: number; // flat index
  weight?: number; // > 1 expands further
}

export interface GrowOptions {
  mountainCost: number; // extra cost per unit of high ground
  slopeCost: number; // extra cost per unit of elevation change
  riverCost: number; // extra cost when stepping onto a river cell
  noiseAmp: number; // 0..1 multiplicative jitter for organic borders
  noiseScale: number; // in cells^-1
  noiseOffset: number;
}

// Per-cell terrain factors, computed once and shared between grow calls.
export interface CostField {
  opt: GrowOptions;
  elev: Float32Array;
  rough: Float32Array;
  river: Uint8Array;
}

// 16-neighborhood (incl. knight moves): distances are much closer to
// Euclidean than 8-neighbor Dijkstra, which draws octagonal, staircase borders.
const S5 = Math.sqrt(5);
const DX = [1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2];
const STEP = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2, S5, S5, S5, S5, S5, S5, S5, S5];

export function buildCostField(
  world: WorldData,
  noise: NoiseEngine,
  opt: GrowOptions,
): CostField {
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const elev = new Float32Array(N);
  const rough = new Float32Array(N);
  const river = new Uint8Array(N);
  const invRes = 800 / W;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      const cell = world.grid[x][y];
      elev[i] = cell.elevation;
      river[i] = cell.hasRiver ? 1 : 0;
      if (world.waterType[i] !== 0) continue;
      const n = opt.noiseAmp
        ? noise.fbmCylinder(
            x + opt.noiseOffset,
            y + opt.noiseOffset,
            W,
            3,
            0.5,
            2.0,
            opt.noiseScale * invRes,
          )
        : 0.5;
      rough[i] =
        1 +
        opt.mountainCost * Math.max(0, cell.elevation - 0.68) * 4 +
        opt.noiseAmp * (n - 0.5) * 2;
    }
  }
  return { opt, elev, rough, river };
}

// Reusable scratch buffers so repeated small grows don't allocate full-map arrays.
class Workspace {
  owner: Int32Array;
  dist: Float32Array;
  touched: number[] = [];
  heap = new MinHeap(1 << 14);
  constructor(N: number) {
    this.owner = new Int32Array(N).fill(-1);
    this.dist = new Float32Array(N).fill(Infinity);
  }
  reset() {
    for (const c of this.touched) {
      this.owner[c] = -1;
      this.dist[c] = Infinity;
    }
    this.touched.length = 0;
    this.heap.clear();
  }
}
const workspaces = new WeakMap<WorldData, Workspace>();

// Terrain-aware multi-source Dijkstra. Calls `visit(cell, seedIndex)` for every
// claimed cell. Cells must satisfy `allowed` (defaults to land).
export function growRegionsSparse(
  world: WorldData,
  field: CostField,
  seeds: GrowSeed[],
  visit: (cell: number, owner: number) => void,
  allowed: (cell: number) => boolean = (c) => world.waterType[c] === 0,
) {
  const W = world.width;
  const H = world.height;
  const N = W * H;
  let ws = workspaces.get(world);
  if (!ws || ws.owner.length !== N) {
    ws = new Workspace(N);
    workspaces.set(world, ws);
  }
  const { owner, dist, heap, touched } = ws;
  const { elev, rough, river, opt } = field;

  seeds.forEach((s, id) => {
    if (s.cell < 0 || s.cell >= N || dist[s.cell] === 0) return;
    dist[s.cell] = 0;
    owner[s.cell] = id;
    touched.push(s.cell);
    heap.push(0, s.cell);
  });
  const weights = seeds.map((s) => 1 / Math.max(0.2, s.weight ?? 1));

  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const o = owner[c];
    const w = weights[o];
    const x = c % W;
    const y = (c - x) / W;
    for (let k = 0; k < 16; k++) {
      const ny = y + DY[k];
      if (ny < 0 || ny >= H) continue;
      const n = ny * W + ((x + DX[k] + W) % W);
      if (!allowed(n)) continue;
      // Knight moves may not jump over a disallowed cell (e.g. a strait)
      if (k >= 8) {
        const mx = x + Math.trunc(DX[k] / 2);
        const my = y + Math.trunc(DY[k] / 2);
        if (!allowed(my * W + ((mx + W) % W))) continue;
      }
      let step =
        STEP[k] *
        Math.max(0.2, rough[n] + opt.slopeCost * Math.abs(elev[n] - elev[c]) * 10);
      if (river[n] && !river[c]) step += opt.riverCost;
      const nd = d + step * w;
      if (nd < dist[n]) {
        if (dist[n] === Infinity) touched.push(n);
        dist[n] = nd;
        owner[n] = o;
        heap.push(nd, n);
      }
    }
  }
  for (const c of touched) visit(c, owner[c]);
  ws.reset();
}

// Whole-map convenience wrapper returning an owner array (-1 = unclaimed).
export function growRegions(
  world: WorldData,
  noise: NoiseEngine,
  seeds: GrowSeed[],
  opt: GrowOptions,
): Int32Array {
  const owner = new Int32Array(world.width * world.height).fill(-1);
  const field = buildCostField(world, noise, opt);
  growRegionsSparse(world, field, seeds, (c, o) => (owner[c] = o));
  return owner;
}

// Smooth per-world displacement field used to give region borders an organic
// wobble (the grid growth alone looks too regular).
const warpFields = new WeakMap<WorldData, { dx: Float32Array; dy: Float32Array }>();
function warpField(world: WorldData, noise: NoiseEngine) {
  let f = warpFields.get(world);
  if (f) return f;
  const W = world.width;
  const H = world.height;
  const dx = new Float32Array(W * H);
  const dy = new Float32Array(W * H);
  const s = 0.03 * (800 / W);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      dx[y * W + x] = noise.fbmCylinder(x + 4100, y, W, 3, 0.5, 2, s) * 2 - 1;
      dy[y * W + x] = noise.fbmCylinder(x, y + 9300, W, 3, 0.5, 2, s) * 2 - 1;
    }
  f = { dx, dy };
  warpFields.set(world, f);
  return f;
}

// Re-samples ownership at domain-warped positions. `cells` are the cells to
// update; `ownerAt` reads the current owner (-1 if not part of the domain).
export function warpOwners(
  world: WorldData,
  noise: NoiseEngine,
  cells: Iterable<number>,
  ownerAt: (c: number) => number,
  amp: number,
): [number, number][] {
  const W = world.width;
  const H = world.height;
  const { dx, dy } = warpField(world, noise);
  const out: [number, number][] = [];
  for (const c of cells) {
    const x = c % W;
    const y = (c - x) / W;
    const sx = Math.round(x + dx[c] * amp);
    const sy = Math.round(y + dy[c] * amp);
    if (sy < 0 || sy >= H) continue;
    const o = ownerAt(sy * W + ((sx % W) + W) % W);
    if (o >= 0) out.push([c, o]);
  }
  return out;
}

export function warpOwnerArray(world: WorldData, noise: NoiseEngine, owner: Int32Array, amp: number) {
  const cells: number[] = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && world.waterType[i] === 0) cells.push(i);
  const land = (c: number) => (world.waterType[c] === 0 ? owner[c] : -1);
  for (const [c, o] of warpOwners(world, noise, cells, land, amp)) owner[c] = o;
}

// Assigns land cells left unclaimed by growRegions (islands, enclaves) to the
// owner of the nearest claimed land cell.
export function fillUnreached(world: WorldData, owner: Int32Array) {
  const N = world.width * world.height;
  const site = new Uint8Array(N);
  let missing = false;
  for (let i = 0; i < N; i++) {
    if (owner[i] >= 0) site[i] = 1;
    else if (world.waterType[i] === 0) missing = true;
  }
  if (!missing) return;
  const { nearest } = distanceTransform(world.width, world.height, site);
  for (let i = 0; i < N; i++) {
    if (owner[i] < 0 && world.waterType[i] === 0 && nearest[i] >= 0)
      owner[i] = owner[nearest[i]];
  }
}

// Picks up to `count` land cells, spaced at least `minDist` apart, preferring
// high `score` cells.
export function pickSpacedSeeds(
  world: WorldData,
  rand: () => number,
  count: number,
  minDist: number,
  score: (cell: number) => number,
): number[] {
  const W = world.width;
  const cand: { c: number; s: number }[] = [];
  const stride = Math.max(1, Math.floor(minDist / 6));
  for (let y = 0; y < world.height; y += stride) {
    for (let x = 0; x < W; x += stride) {
      const c = y * W + x;
      if (world.waterType[c] !== 0) continue;
      cand.push({ c, s: score(c) * (0.5 + rand()) });
    }
  }
  cand.sort((a, b) => b.s - a.s);
  const out: number[] = [];
  for (const { c } of cand) {
    if (out.length >= count) break;
    const x = c % W;
    const y = (c - x) / W;
    let ok = true;
    for (const o of out) {
      const ox = o % W;
      let dx = Math.abs(ox - x);
      if (dx > W / 2) dx = W - dx;
      if (Math.hypot(dx, (o - ox) / W - y) < minDist) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(c);
  }
  return out;
}
