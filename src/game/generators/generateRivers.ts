import type { GeneratorContext } from "./types";
import type { Point, River } from "../WorldData";
import { chaikin, yieldFrame } from "../util/grid";

const RIVER_PREFIX = ["Ar", "Bel", "Cor", "Dra", "El", "Fen", "Gal", "Hal", "Is", "Lor", "Mer", "Nor", "Or", "Rha", "Sel", "Tam", "Ul", "Ver", "Wen", "Yr"];
const RIVER_SUFFIX = ["an", "ava", "ein", "ent", "ra", "is", "on", "une", "ore", "wyn", "ath", "elle", "ube", "ess"];

// Rivers follow the drainage tree computed by generateCoast. Each river is a
// smoothed polyline that starts at a source (or lake outlet) and ends where it
// meets the sea, a lake, or a larger river.
export async function generateRivers(ctx: GeneratorContext): Promise<void> {
  const { world, width: W, height: H, noise, onProgress } = ctx;
  const N = W * H;
  const resScale = W / 800;
  const T = 80 * resScale * resScale;
  world.rivers = [];

  // Flow accumulation: rainfall summed downstream along the receiver tree.
  const acc = world.flow;
  acc.fill(0);
  const order = world.flowOrder;
  const len = world.flowOrderLength;
  for (let i = 0; i < len; i++) {
    const c = order[i];
    const x = c % W;
    const y = (c - x) / W;
    const cell = world.grid[x][y];
    if (world.waterType[c] !== 1) acc[c] = 0.4 + cell.moisture;
  }
  for (let i = len - 1; i >= 0; i--) {
    const c = order[i];
    const r = world.receiver[c];
    if (r >= 0) acc[r] += acc[c];
  }
  onProgress?.(30);
  await yieldFrame();

  const isWater = (i: number) => world.waterType[i] !== 0;
  const isRiver = (i: number) => !isWater(i) && acc[i] >= T;

  // Main upstream branch of every cell: the tributary carrying the most water.
  const mainUp = new Int32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    if (!isRiver(c)) continue;
    const r = world.receiver[c];
    if (r >= 0 && (mainUp[r] < 0 || acc[c] > acc[mainUp[r]])) mainUp[r] = c;
  }

  // Trace chains from every source; a chain stops at the sea, a lake, or when
  // it joins a river that is not its own continuation.
  const chainOf = new Int32Array(N).fill(-1);
  const chains: { cells: number[] }[] = [];
  for (let c = 0; c < N; c++) {
    if (!isRiver(c) || mainUp[c] >= 0) continue;
    const cells = [c];
    let cur = c;
    let guard = 0;
    while (guard++ < N) {
      const r = world.receiver[cur];
      if (r < 0) break;
      cells.push(r);
      if (isWater(r) || mainUp[r] !== cur) break;
      cur = r;
    }
    chains.push({ cells });
  }
  // Longest chains first so main stems get the low ids
  chains.sort((a, b) => b.cells.length - a.cells.length);
  chains.forEach((ch, id) => {
    for (let i = 0; i < ch.cells.length - 1; i++) chainOf[ch.cells[i]] = id;
  });
  onProgress?.(55);
  await yieldFrame();

  // Per-cell meander offset (shared by every chain touching a cell so that
  // confluences stay connected).
  const offset = (c: number): Point => {
    const x = c % W;
    const y = (c - x) / W;
    return {
      x: x + 0.5 + noise.noise2D(x * 0.37 + 11.3, y * 0.37) * 0.3,
      y: y + 0.5 + noise.noise2D(x * 0.37, y * 0.37 + 71.9) * 0.3,
    };
  };

  const sampler = world.sampler;
  const usedNames = new Set<string>();
  const built: (River | null)[] = [];

  for (let id = 0; id < chains.length; id++) {
    const cells = chains[id].cells;
    if (cells.length < 3) {
      built.push(null);
      continue;
    }
    const pts: Point[] = [];
    const flows: number[] = [];
    let prevX = 0;
    for (let i = 0; i < cells.length; i++) {
      const p = offset(cells[i]);
      if (i > 0) {
        // Unwrap across the date line so the polyline stays continuous
        while (p.x - prevX > W / 2) p.x -= W;
        while (p.x - prevX < -W / 2) p.x += W;
      }
      prevX = p.x;
      pts.push(p);
      flows.push(acc[cells[Math.max(0, i === cells.length - 1 ? i - 1 : i)]] / T);
    }
    const sm = chaikin(pts, flows, 3);
    let P = sm.pts;
    let F = sm.vals;

    // Trim at the rendered shoreline
    for (let i = 1; i < P.length; i++) {
      if (sampler.coastField(P[i].x, P[i].y) < -0.02) {
        P = P.slice(0, i + 1);
        F = F.slice(0, i + 1);
        break;
      }
    }

    const maxFlow = Math.max(...F);
    let name = "";
    if (maxFlow > 6) {
      for (let tries = 0; tries < 10; tries++) {
        const n =
          RIVER_PREFIX[Math.floor(noise.random() * RIVER_PREFIX.length)] +
          RIVER_SUFFIX[Math.floor(noise.random() * RIVER_SUFFIX.length)];
        if (!usedNames.has(n) || tries === 9) {
          name = n;
          usedNames.add(n);
          break;
        }
      }
    }

    for (let i = 0; i < cells.length - 1; i++) {
      const c = cells[i];
      const x = c % W;
      world.grid[x][(c - x) / W].hasRiver = true;
    }

    built.push({
      id,
      name,
      points: P,
      widths: F.map((f) => Math.min(700, 12 * Math.pow(Math.max(1, f), 0.55))),
      flow: maxFlow,
      parent: -1,
    });
  }
  onProgress?.(85);
  await yieldFrame();

  // Snap tributary mouths onto the parent's smoothed course
  for (let id = 0; id < chains.length; id++) {
    const river = built[id];
    if (!river) continue;
    const cells = chains[id].cells;
    const last = cells[cells.length - 1];
    const parentId = chainOf[last];
    const parent = parentId >= 0 ? built[parentId] : null;
    if (!parent) continue;
    river.parent = parentId;
    const end = river.points[river.points.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < parent.points.length; i++) {
      const q = parent.points[i];
      let dx = q.x - end.x;
      while (dx > W / 2) dx -= W;
      while (dx < -W / 2) dx += W;
      const d = dx * dx + (q.y - end.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD < 4) {
      const q = parent.points[best];
      let dx = q.x - end.x;
      while (dx > W / 2) dx -= W;
      while (dx < -W / 2) dx += W;
      river.points[river.points.length - 1] = { x: end.x + dx, y: q.y };
    }
  }

  world.rivers = built.filter((r): r is River => r !== null);
  // Re-number ids to array positions, remapping parents
  const remap = new Map<number, number>();
  world.rivers.forEach((r, i) => remap.set(r.id, i));
  world.rivers.forEach((r, i) => {
    r.id = i;
    r.parent = remap.get(r.parent) ?? -1;
  });
  onProgress?.(100);
}
