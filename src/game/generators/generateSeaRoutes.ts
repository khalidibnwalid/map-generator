import type { GeneratorContext } from "./types";
import type { City, Point } from "../WorldData";
import { decodeSdf } from "../../core/FieldNoise";
import { MinHeap, chaikin, yieldFrame } from "../util/grid";
import { sampleCurrent } from "./generateCurrents";

export interface SeaRoute {
  points: Point[]; // world cells, x unwrapped
  a: number; // city ids
  b: number;
  tier: number; // 2 = between major ports, 1 = towns, 0 = local
}

const S5 = Math.sqrt(5);
const DX = [1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2];
const STEP = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2, S5, S5, S5, S5, S5, S5, S5, S5];

// Shipping lanes between ports over water. Lanes keep a little off the coast
// (so they thread through straits), ride favourable currents, and merge into
// shared trunk lanes; paths are straightened by line of sight, then smoothed.
export async function generateSeaRoutes(ctx: GeneratorContext): Promise<void> {
  const { world, onProgress } = ctx;
  const W = world.width;
  const H = world.height;
  const s = Math.max(1, Math.round(W / 400));
  const Wc = Math.floor(W / s);
  const Hc = Math.floor(H / s);
  const cost = new Float32Array(Wc * Hc);
  const offshore = new Float32Array(Wc * Hc);
  for (let y = 0; y < Hc; y++)
    for (let x = 0; x < Wc; x++) {
      const i = (y * s + (s >> 1)) * W + x * s + (s >> 1);
      if (world.waterType[i] !== 1) {
        cost[y * Wc + x] = Infinity;
        continue;
      }
      const d = -decodeSdf(world.coastSdf[i]); // cells from shore
      offshore[y * Wc + x] = d;
      cost[y * Wc + x] = 1 + (d < 1.2 ? 1.5 : 0) + (d > 14 ? 0.2 : 0);
    }
  const onLane = new Uint8Array(Wc * Hc);
  const currents = world.currents;

  const ports = world.cities.filter((c) => c.isPort);
  const anchor = new Map<City, number>();
  for (const c of ports) {
    const cx = Math.floor(c.x / s);
    const cy = Math.floor(c.y / s);
    let best = -1;
    let bestD = Infinity;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= Hc) continue;
        const x = (cx + dx + Wc) % Wc;
        if (cost[y * Wc + x] === Infinity) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = y * Wc + x;
        }
      }
    if (best >= 0) anchor.set(c, best);
  }

  const g = new Float32Array(Wc * Hc);
  const parent = new Int32Array(Wc * Hc);
  const stamp = new Int32Array(Wc * Hc);
  let epoch = 0;
  const heap = new MinHeap(1 << 12);
  const search = (from: number, to: number): number[] | null => {
    epoch++;
    heap.clear();
    const tx = to % Wc;
    const ty = (to - tx) / Wc;
    const h = (c: number) => {
      const x = c % Wc;
      let dx = Math.abs(x - tx);
      if (dx > Wc / 2) dx = Wc - dx;
      return 0.9 * Math.hypot(dx, (c - x) / Wc - ty);
    };
    stamp[from] = epoch;
    g[from] = 0;
    parent[from] = -1;
    heap.push(h(from), from);
    let n = 0;
    while (heap.size > 0) {
      const c = heap.pop();
      if (c === to) {
        const path: number[] = [];
        for (let p = to; p >= 0; p = parent[p]) path.push(p);
        return path.reverse();
      }
      if (++n > 60000) return null;
      const x = c % Wc;
      const y = (c - x) / Wc;
      for (let k = 0; k < 16; k++) {
        const ny = y + DY[k];
        if (ny < 0 || ny >= Hc) continue;
        const nb = ny * Wc + ((x + DX[k] + Wc) % Wc);
        if (cost[nb] === Infinity) continue;
        if (k >= 8) {
          const m = (y + Math.trunc(DY[k] / 2)) * Wc + ((x + Math.trunc(DX[k] / 2) + Wc) % Wc);
          if (cost[m] === Infinity) continue;
        }
        let c2 = onLane[nb] ? 0.55 : cost[nb];
        if (currents) {
          // Sailing with the current is cheaper, against it dearer
          const [cu, cv] = sampleCurrent(currents, W, x * s + s / 2, y * s + s / 2);
          const along = (cu * DX[k] + cv * DY[k]) / STEP[k];
          c2 *= 1 - 0.3 * Math.max(-1, Math.min(1, along));
        }
        const ng = g[c] + STEP[k] * c2;
        if (stamp[nb] !== epoch || ng < g[nb]) {
          stamp[nb] = epoch;
          g[nb] = ng;
          parent[nb] = c;
          heap.push(ng + h(nb), nb);
        }
      }
    }
    return null;
  };

  // Is the straight segment between two coarse cells open, offshore water?
  const clearLine = (a: number, b: number) => {
    const ax = a % Wc;
    const ay = (a - ax) / Wc;
    let bx = b % Wc;
    const by = (b - bx) / Wc;
    if (bx - ax > Wc / 2) bx -= Wc;
    if (bx - ax < -Wc / 2) bx += Wc;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ((Math.round(ax + (bx - ax) * t) % Wc) + Wc) % Wc;
      const y = Math.round(ay + (by - ay) * t);
      const c = y * Wc + x;
      if (cost[c] === Infinity || offshore[c] < 0.8) return false;
    }
    return true;
  };
  const straighten = (path: number[]) => {
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = Math.min(path.length - 1, i + 40);
      while (j > i + 1 && !clearLine(path[i], path[j])) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  };

  const dist = (a: City, b: City) => {
    let dx = Math.abs(a.x - b.x);
    if (dx > W / 2) dx = W - dx;
    return Math.hypot(dx, a.y - b.y);
  };
  const rank = (c: City) => (c.isCapital || c.size >= 2 ? 2 : c.size === 1 ? 1 : 0);
  const routes: SeaRoute[] = [];
  const list = ports.filter((p) => anchor.has(p));

  const cand: { a: City; b: City; d: number; tier: number }[] = [];
  const seen = new Set<string>();
  const resScale = W / 800;
  const link = (a: City, minRank: number, k: number, maxD: number, tier: number) => {
    const near = list
      .filter((b) => b !== a && rank(b) >= minRank)
      .map((b) => ({ b, d: dist(a, b) }))
      .filter((e) => e.d < maxD * resScale)
      .sort((p, q) => p.d - q.d)
      .slice(0, k);
    for (const { b, d } of near) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cand.push({ a, b, d, tier });
    }
  };
  for (const a of list) {
    const r = rank(a);
    link(a, 0, 1, 25, 0); // local harbour hop
    if (r >= 1) link(a, 1, 2, 100, 1); // coastal trade between towns
    if (r >= 2) link(a, 2, 3, 240, 2); // long-haul lanes between major ports
  }
  // Major lanes first so lesser ones join them; spanning connections always kept
  cand.sort((p, q) => q.tier - p.tier || p.d - q.d);
  const uf = new Map<City, City>();
  const find = (c: City): City => {
    let r = c;
    while (uf.has(r) && uf.get(r) !== r) r = uf.get(r)!;
    uf.set(c, r);
    return r;
  };
  for (let i = 0; i < cand.length; i++) {
    const { a, b, tier } = cand[i];
    const ra = find(a);
    const rb = find(b);
    const joins = ra !== rb;
    if (!joins && tier === 0) continue;
    const path = search(anchor.get(a)!, anchor.get(b)!);
    if (path && path.length >= 3) {
      if (joins) uf.set(ra, rb);
      for (const c of path) onLane[c] = 1;
      const pts: Point[] = [{ x: a.x, y: a.y }];
      let prevX = a.x;
      for (const c of straighten(path)) {
        const p = { x: (c % Wc) * s + s / 2, y: Math.floor(c / Wc) * s + s / 2 };
        while (p.x - prevX > W / 2) p.x -= W;
        while (p.x - prevX < -W / 2) p.x += W;
        prevX = p.x;
        pts.push(p);
      }
      let bx = b.x;
      while (bx - prevX > W / 2) bx -= W;
      while (bx - prevX < -W / 2) bx += W;
      pts.push({ x: bx, y: b.y });
      // Bend long straight legs a little (with the current where there is
      // one) so lanes read as sailed arcs rather than ruled lines
      const bent: Point[] = [pts[0]];
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k - 1];
        const q = pts[k];
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        if (len > 6) {
          const mx = (p.x + q.x) / 2;
          const my = (p.y + q.y) / 2;
          const nx = -(q.y - p.y) / len;
          const ny = (q.x - p.x) / len;
          let side = Math.sin(mx * 0.37 + my * 0.91) * 0.12;
          if (currents) {
            const [cu, cv] = sampleCurrent(currents, W, mx, my);
            side += (cu * nx + cv * ny) * 0.1;
          }
          const ox = mx + nx * side * len;
          const oy = my + ny * side * len;
          const wx = ((Math.floor(ox) % W) + W) % W;
          const wy = Math.max(0, Math.min(H - 1, Math.floor(oy)));
          if (world.waterType[wy * W + wx] === 1 && -decodeSdf(world.coastSdf[wy * W + wx]) > 0.8) bent.push({ x: ox, y: oy });
        }
        bent.push(q);
      }
      routes.push({ points: chaikin(bent, bent.map(() => 0), 4).pts, a: a.id, b: b.id, tier });
    }
    if (i % 10 === 0) {
      onProgress?.((i / cand.length) * 100);
      await yieldFrame();
    }
  }
  world.seaRoutes = routes;
}
