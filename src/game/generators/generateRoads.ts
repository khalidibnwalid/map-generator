import type { GeneratorContext } from "./types";
import type { City, Point, Road, WorldData } from "../WorldData";
import { hashU } from "../../core/FieldNoise";
import { MinHeap, chaikin, yieldFrame } from "../util/grid";

interface CoarseGrid {
  s: number;
  Wc: number;
  Hc: number;
  cost: Float32Array; // Infinity = impassable
  onRoad: Uint8Array;
  g: Float32Array;
  parent: Int32Array;
  stamp: Int32Array;
  epoch: number;
  heap: MinHeap;
  bridges: Set<number>; // coarse cells where a road crosses a river
}

const grids = new WeakMap<WorldData, CoarseGrid>();

function getGrid(world: WorldData): CoarseGrid {
  const cached = grids.get(world);
  if (cached) return cached;
  const W = world.width;
  const s = Math.max(1, Math.round(W / 800));
  const Wc = Math.floor(W / s);
  const Hc = Math.floor(world.height / s);
  const cost = new Float32Array(Wc * Hc);
  for (let y = 0; y < Hc; y++) {
    for (let x = 0; x < Wc; x++) {
      const cx = x * s + (s >> 1);
      const cy = y * s + (s >> 1);
      const cell = world.grid[cx][cy];
      if (cell.isWater) {
        cost[y * Wc + x] = Infinity;
        continue;
      }
      let c = 1;
      const right = world.grid[(cx + s) % W][cy];
      const down = world.grid[cx][Math.min(world.height - 1, cy + s)];
      const left = world.grid[(cx - s + W) % W][cy];
      const up = world.grid[cx][Math.max(0, cy - s)];
      const slope =
        Math.abs(right.elevation - left.elevation) + Math.abs(down.elevation - up.elevation);
      // Steep ground is avoided strongly, so roads wind through valleys and passes
      c += slope * 90 + slope * slope * 900;
      if (cell.elevation > 0.7) c += (cell.elevation - 0.7) * 30;
      if (cell.hasRiver) c += 3.5; // bridges are expensive: cross rarely
      else if (left.hasRiver || right.hasRiver || up.hasRiver || down.hasRiver) c -= 0.25; // follow valleys
      if (cell.biome === "Marsh") c += 1.5;
      if (cell.biome.includes("Forest")) c += 0.35;
      // Coherent jitter so routes wander naturally instead of running dead straight
      const n =
        (hashU(x >> 2, y >> 2, world.seed ^ 0x51ed) + hashU(x >> 1, y >> 1, world.seed ^ 0x2b7)) * 0.5;
      c *= 0.8 + 0.5 * n;
      cost[y * Wc + x] = Math.max(0.4, c);
    }
  }
  const N = Wc * Hc;
  const grid: CoarseGrid = {
    s,
    Wc,
    Hc,
    cost,
    onRoad: new Uint8Array(N),
    g: new Float32Array(N),
    parent: new Int32Array(N),
    stamp: new Int32Array(N),
    epoch: 0,
    heap: new MinHeap(1 << 12),
    bridges: new Set(),
  };
  grids.set(world, grid);
  return grid;
}

// 16 directions (incl. knight moves) avoid the 0/45/90 degree look of 8-way paths
const S5 = Math.sqrt(5);
const DX = [1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2];
const STEP = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2, S5, S5, S5, S5, S5, S5, S5, S5];

function astar(G: CoarseGrid, from: number, to: number, maxExpand: number): number[] | null {
  const { Wc, Hc, cost, onRoad, g, parent, stamp, heap } = G;
  G.epoch++;
  const ep = G.epoch;
  heap.clear();
  const tx = to % Wc;
  const ty = (to - tx) / Wc;
  const h = (c: number) => {
    const x = c % Wc;
    let dx = Math.abs(x - tx);
    if (dx > Wc / 2) dx = Wc - dx;
    const dy = Math.abs((c - x) / Wc - ty);
    // Weighted (inadmissible) heuristic: near-optimal routes, far fewer expansions
    return 1.1 * Math.hypot(dx, dy);
  };
  stamp[from] = ep;
  g[from] = 0;
  parent[from] = -1;
  heap.push(h(from), from);
  let expanded = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    if (c === to) {
      const path: number[] = [];
      for (let p = to; p >= 0; p = parent[p]) path.push(p);
      return path.reverse();
    }
    if (++expanded > maxExpand) return null;
    const x = c % Wc;
    const y = (c - x) / Wc;
    const gc = g[c];
    for (let k = 0; k < 16; k++) {
      const ny = y + DY[k];
      if (ny < 0 || ny >= Hc) continue;
      const n = ny * Wc + ((x + DX[k] + Wc) % Wc);
      const cn = cost[n];
      if (cn === Infinity && n !== to) continue;
      if (k >= 8) {
        // Knight moves may not hop across water
        const m = (y + Math.trunc(DY[k] / 2)) * Wc + ((x + Math.trunc(DX[k] / 2) + Wc) % Wc);
        if (cost[m] === Infinity) continue;
      }
      // Following an existing road is cheap, so routes merge into trunks
      const step = STEP[k] * (onRoad[n] ? 0.3 : Math.min(cn, 80));
      const ng = gc + step;
      if (stamp[n] !== ep || ng < g[n]) {
        stamp[n] = ep;
        g[n] = ng;
        parent[n] = c;
        heap.push(ng + h(n), n);
      }
    }
  }
  return null;
}

function cityCell(G: CoarseGrid, world: WorldData, c: City): number {
  const x = Math.floor(((c.x % world.width) + world.width) % world.width / G.s) % G.Wc;
  const y = Math.min(G.Hc - 1, Math.floor(c.y / G.s));
  return y * G.Wc + x;
}

function buildRoad(world: WorldData, G: CoarseGrid, a: City, b: City, tier: number): Road | null {
  const from = cityCell(G, world, a);
  const to = cityCell(G, world, b);
  if (from === to) return null;
  const path = astar(G, from, to, 25000);
  if (!path) return null;
  for (const c of path) G.onRoad[c] = 1;

  const pts: Point[] = [{ x: a.x, y: a.y }];
  let prevX = a.x;
  for (let i = 1; i < path.length - 1; i++) {
    const c = path[i];
    const x = c % G.Wc;
    const p = { x: x * G.s + G.s / 2, y: (c - x) / G.Wc * G.s + G.s / 2 };
    while (p.x - prevX > world.width / 2) p.x -= world.width;
    while (p.x - prevX < -world.width / 2) p.x += world.width;
    prevX = p.x;
    pts.push(p);
  }
  let bx = b.x;
  while (bx - prevX > world.width / 2) bx -= world.width;
  while (bx - prevX < -world.width / 2) bx += world.width;
  pts.push({ x: bx, y: b.y });
  // Relax the grid path (moving average) so it flows instead of zig-zagging;
  // the terrain costs already supply the large-scale curvature
  const sampler = world.sampler;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const nx = (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4;
      const ny = (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4;
      if (sampler.coastField(nx, ny, 4) > 0.15) pts[i] = { x: nx, y: ny };
    }
  }
  for (const c of path) {
    const x = (c % G.Wc) * G.s;
    const y = Math.floor(c / G.Wc) * G.s;
    if (world.grid[x][y].hasRiver) G.bridges.add(c);
  }
  const sm = chaikin(pts, pts.map(() => 0), 3);
  return { points: sm.pts, tier, a: a.id, b: b.id };
}

// Road class follows the lesser endpoint: highways only join cities
function tierFor(a: City, b: City): number {
  const rank = (c: City) => (c.isCapital || c.size >= 2 ? 2 : c.size === 1 ? 1 : 0);
  return Math.min(rank(a), rank(b));
}

function dist(world: WorldData, a: City, b: City) {
  let dx = Math.abs(a.x - b.x);
  if (dx > world.width / 2) dx = world.width - dx;
  return Math.hypot(dx, a.y - b.y);
}

function landmassOf(world: WorldData, c: City) {
  const x = Math.floor(((c.x % world.width) + world.width) % world.width);
  return world.landmass[Math.floor(c.y) * world.width + x];
}

export async function generateRoads(ctx: GeneratorContext): Promise<void> {
  const { world, noise, onProgress } = ctx;
  grids.delete(world);
  const G = getGrid(world);
  const roads: Road[] = [];
  const cities = world.cities;
  const resScale = world.width / 800;
  const maxD = 55 * resScale;

  // Candidate edges: k nearest same-landmass neighbors
  const edges: { a: number; b: number; d: number }[] = [];
  const seen = new Set<string>();
  for (const a of cities) {
    const lm = landmassOf(world, a);
    const near = cities
      .filter((b) => b !== a && landmassOf(world, b) === lm)
      .map((b) => ({ b, d: dist(world, a, b) }))
      .filter((e) => e.d < maxD)
      .sort((p, q) => p.d - q.d)
      .slice(0, a.size >= 1 || a.isCapital ? 4 : 2);
    for (const { b, d } of near) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: a.id, b: b.id, d });
    }
  }

  // MST (Kruskal) keeps every landmass connected; extra short links add loops
  edges.sort((p, q) => p.d - q.d);
  const uf = cities.map((_, i) => i);
  const find = (i: number): number => (uf[i] === i ? i : (uf[i] = find(uf[i])));
  const chosen: { a: City; b: City; tier: number; d: number }[] = [];
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    const A = cities[e.a];
    const B = cities[e.b];
    if (ra !== rb) {
      uf[ra] = rb;
      chosen.push({ a: A, b: B, tier: tierFor(A, B), d: e.d });
    } else if (e.d < maxD * 0.6 && noise.random() < (A.size + B.size >= 1 ? 0.75 : 0.25)) {
      chosen.push({ a: A, b: B, tier: tierFor(A, B), d: e.d });
    }
  }
  // Highways first so lesser roads join them
  chosen.sort((p, q) => q.tier - p.tier || p.d - q.d);

  for (let i = 0; i < chosen.length; i++) {
    const e = chosen[i];
    const road = buildRoad(world, G, e.a, e.b, e.tier);
    if (road) roads.push(road);
    if (i % 25 === 0) {
      onProgress?.((i / chosen.length) * 100);
      await yieldFrame();
    }
  }
  world.worldRoads = roads;
}

// Coarse cells (as world cell centers) where roads cross rivers
export function roadBridges(world: WorldData): Point[] {
  const G = getGrid(world);
  return [...G.bridges].map((c) => ({
    x: (c % G.Wc) * G.s + G.s / 2,
    y: Math.floor(c / G.Wc) * G.s + G.s / 2,
  }));
}

// Links a newly founded city to its nearest neighbors (editor use).
export function connectCity(world: WorldData, city: City) {
  const G = getGrid(world);
  const lm = landmassOf(world, city);
  const near = world.cities
    .filter((b) => b !== city && landmassOf(world, b) === lm)
    .sort((p, q) => dist(world, city, p) - dist(world, city, q))
    .slice(0, 2);
  for (const b of near) {
    const road = buildRoad(world, G, city, b, tierFor(city, b));
    if (road) world.worldRoads.push(road);
  }
}
