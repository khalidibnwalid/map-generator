import type { GeneratorContext } from "./types";
import { mulberry } from "../names";
import { MinHeap, distanceTransform, labelComponents } from "../util/grid";

// 0.2+: where peoples live, drawn like an ethnographic map rather than as one
// solid blob per culture.
//
// - Empty land: deserts, high peaks and ice keep no people at all.
// - Pockets: minorities hold enclaves inside other peoples' land: refuges in
//   the hills, colonies strung along foreign coasts, river valleys, quarters
//   in the bigger market towns (cities come later, so dense lowland spots
//   near water stand in for them).
// - Mixing: some frontiers blur into bands where both peoples live, as do
//   the surroundings of the largest towns; a cell then has a second group.
// - Races follow cultures loosely: their borders are offset from the
//   cultures', some pockets change culture but keep their race (or the other
//   way round), and mixing carries both races.
//
// Everything here draws from its own random stream, so the noise stream the
// rest of generation uses is untouched.

const BIOME_HARSH: Record<string, number> = {
  Glacier: 1.7,
  Snow: 1.4,
  "Rock & Scree": 1.0,
  Scorched: 1.2,
  Bare: 0.75,
  Tundra: 0.5,
  "Sand Dunes": 1.25,
  "Salt Flat": 1.25,
  "Subtropical Desert": 0.95,
  "Temperate Desert": 0.8,
  "Cold Desert": 0.8,
  Badlands: 0.6,
  "Alpine Meadow": 0.35,
  Bog: 0.15,
};

// Smooth noise sampled on a coarse lattice and interpolated (full-resolution
// fbm over a million cells is needlessly slow for a gentle field). ~[-0.5, 0.5]
function coarseNoise(ctx: GeneratorContext, offset: number, scale: number, step = 4): Float32Array {
  const { world, noise } = ctx;
  const W = world.width;
  const H = world.height;
  const CW = Math.ceil(W / step) + 1;
  const CH = Math.ceil(H / step) + 1;
  const s = scale * (800 / W);
  const lat = new Float32Array(CW * CH);
  for (let cy = 0; cy < CH; cy++)
    for (let cx = 0; cx < CW; cx++)
      lat[cy * CW + cx] = noise.fbmCylinder((cx * step) % W + offset, cy * step + offset, W, 3, 0.5, 2, s) - 0.5;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = y / step;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = x / step;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = lat[y0 * CW + x0];
      const b = lat[y0 * CW + x0 + 1];
      const c = lat[Math.min(CH - 1, y0 + 1) * CW + x0];
      const d = lat[Math.min(CH - 1, y0 + 1) * CW + x0 + 1];
      out[y * W + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

// Land nobody lives on: 1 where empty. Leaves most land inhabited, so realms
// and towns still have room.
export function emptyLand(ctx: GeneratorContext): Uint8Array {
  const { world } = ctx;
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const res = W / 800;
  const jitter = coarseNoise(ctx, 5300, 0.02);
  const harsh = new Float32Array(N).fill(-Infinity);
  const values: number[] = [];
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (world.waterType[i] !== 0) continue;
      const cell = world.grid[x][y];
      let shore = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        if (ny >= 0 && ny < H && world.waterType[ny * W + ((x + dx + W) % W)] !== 0) shore = true;
      }
      const h =
        (BIOME_HARSH[cell.biome] ?? 0) +
        Math.max(0, cell.elevation - 0.76) * 6 +
        Math.max(0, 0.14 - cell.temperature) * 5 -
        cell.populationDensity * 1.3 -
        (cell.hasRiver ? 0.9 : 0) -
        (shore ? 0.3 : 0) +
        jitter[i] * 0.9;
      harsh[i] = h;
      values.push(h);
    }
  // At most ~40% of the land lies empty, however harsh the world
  values.sort((a, b) => b - a);
  const cap = values[Math.floor(values.length * 0.4)] ?? Infinity;
  const threshold = Math.max(0.4, cap);
  let empty = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (harsh[i] > threshold) empty[i] = 1;
  // Opening (erode, then dilate): ridges a cell or two wide stay settled
  const morph = (src: Uint8Array, keep: 0 | 1) => {
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (world.waterType[i] !== 0) continue;
      const x = i % W;
      const y = (i - x) / W;
      let v = src[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const n = ny * W + ((x + dx + W) % W);
        if (world.waterType[n] !== 0) continue;
        if (src[n] !== v && src[n] === keep) v = keep;
      }
      out[i] = v;
    }
    return out;
  };
  empty = morph(morph(empty, 0), 1);
  for (let i = 0; i < N; i++) if (empty[i] && !(harsh[i] > threshold - 0.25)) empty[i] = 0;
  // Specks of emptiness inside settled land are noise, not deserts
  const { labels, sizes } = labelComponents(W, H, empty);
  const minArea = 14 * res * res;
  for (let i = 0; i < N; i++) if (empty[i] && sizes[labels[i]] < minArea) empty[i] = 0;
  return empty;
}

export interface Peoples {
  culture: Int32Array; // -1 = none (water or empty land)
  culture2: Int32Array;
  race: Int32Array;
  race2: Int32Array;
}

const N8X = [1, -1, 0, 0, 1, 1, -1, -1];
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1];
const N8D = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// Lays pockets, mixed bands and races over the grown homelands
export function settlePeoples(ctx: GeneratorContext, home: Int32Array, empty: Uint8Array): Peoples {
  const { world } = ctx;
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const res = W / 800;
  const rand = mulberry(world.seed ^ 0x2c1b3c6d);
  const C = world.cultures.length;
  const raceOf = (c: number) => (c >= 0 ? (world.cultures[c]?.raceId ?? -1) : -1);
  const cellOf = (i: number) => world.grid[i % W][(i - (i % W)) / W];
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const wdx = (a: number, b: number) => {
    let d = Math.abs(a - b);
    if (d > W / 2) d = W - d;
    return d;
  };
  const dist = (a: number, b: number) => Math.hypot(wdx(a % W, b % W), Math.floor(a / W) - Math.floor(b / W));

  const culture = new Int32Array(N).fill(-1);
  const culture2 = new Int32Array(N).fill(-1);
  const race = new Int32Array(N).fill(-1);
  const race2 = new Int32Array(N).fill(-1);
  // Ragged frontiers: homelands reach into each other in tongues and inlets
  const fdx = coarseNoise(ctx, 2900, 0.09, 2);
  const fdy = coarseNoise(ctx, 7300, 0.09, 2);
  const famp = 30 * res;
  const ragged = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (world.waterType[i] !== 0 || home[i] < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const sx = ((Math.round(x + fdx[i] * famp) % W) + W) % W;
    const sy = Math.round(y + fdy[i] * famp);
    const s = sy >= 0 && sy < H ? sy * W + sx : -1;
    ragged[i] = s >= 0 && world.waterType[s] === 0 && home[s] >= 0 ? home[s] : home[i];
  }
  const homeland = ragged;
  let inhabited = 0;
  for (let i = 0; i < N; i++)
    if (world.waterType[i] === 0 && !empty[i] && homeland[i] >= 0) {
      culture[i] = homeland[i];
      inhabited++;
    }
  if (!C || !inhabited) return { culture, culture2, race, race2 };
  // Typical homeland radius
  const R = Math.max(6 * res, Math.sqrt(inhabited / C / Math.PI));

  // --- Frontiers: which peoples border which, and how far each cell is from the other side ---
  const adj: Map<number, number>[] = Array.from({ length: C }, () => new Map());
  const front = new Float64Array(N).fill(Infinity);
  const across = new Int32Array(N).fill(-1);
  const heap = new MinHeap(1 << 12);
  for (let i = 0; i < N; i++) {
    const a = culture[i];
    if (a < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (let k = 0; k < 4; k++) {
      const ny = y + N8Y[k];
      if (ny < 0 || ny >= H) continue;
      const b = culture[ny * W + ((x + N8X[k] + W) % W)];
      if (b < 0 || b === a) continue;
      adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
      if (front[i] > 0.5) {
        front[i] = 0.5;
        across[i] = b;
        heap.push(0.5, i);
      }
    }
  }
  const maxBand = 12 * res;
  while (heap.size) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > front[c] || d > maxBand) continue;
    const x = c % W;
    const y = (c - x) / W;
    for (let k = 0; k < 8; k++) {
      const ny = y + N8Y[k];
      if (ny < 0 || ny >= H) continue;
      const n = ny * W + ((x + N8X[k] + W) % W);
      if (culture[n] !== culture[c]) continue;
      const nd = d + N8D[k];
      if (nd < front[n]) {
        front[n] = nd;
        across[n] = across[c];
        heap.push(nd, n);
      }
    }
  }

  // Mixed bands: some frontiers blur, wider in places, sharp in others
  const pairMix = new Map<number, number>();
  const mixOf = (a: number, b: number) => {
    const key = Math.min(a, b) * 4096 + Math.max(a, b);
    let w = pairMix.get(key);
    if (w === undefined) {
      w = rand() < 0.65 ? (3 + rand() * 8) * res : 0;
      pairMix.set(key, w);
    }
    return w;
  };
  const along = coarseNoise(ctx, 8800, 0.035);
  for (let i = 0; i < N; i++) {
    if (culture[i] < 0 || across[i] < 0 || front[i] > maxBand) continue;
    const w = mixOf(culture[i], across[i]) * Math.max(0, Math.min(1.8, (along[i] + 0.32) * 2.6));
    if (front[i] < w) culture2[i] = across[i];
  }

  // --- Races: their borders wander off the cultures' ---
  const rdx = coarseNoise(ctx, 1700, 0.025);
  const rdy = coarseNoise(ctx, 6100, 0.025);
  const amp = 22 * res;
  for (let i = 0; i < N; i++) {
    if (culture[i] < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const sx = (((Math.round(x + rdx[i] * amp) % W) + W) % W);
    const sy = Math.round(y + rdy[i] * amp);
    const src = sy >= 0 && sy < H ? homeland[sy * W + sx] : -1;
    race[i] = raceOf(src >= 0 && world.waterType[sy * W + sx] === 0 ? src : culture[i]);
    // Where the race line has moved off the culture line the other race lingers
    if (race[i] !== raceOf(culture[i]) && rand() < 0.5) race2[i] = raceOf(culture[i]);
    if (culture2[i] >= 0 && raceOf(culture2[i]) !== race[i]) race2[i] = raceOf(culture2[i]);
  }

  // --- Terrain cues for pockets ---
  const ocean = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (world.waterType[i] === 1) ocean[i] = 1;
  const { dist: coastDist } = distanceTransform(W, H, ocean);
  const jit = (i: number) => {
    const s = Math.sin(i * 12.9898 + world.seed * 0.0001) * 43758.5453;
    return s - Math.floor(s);
  };
  // Lobed rather than round pockets
  const lobe = (i: number) => Math.exp(fdy[i] * 5) - 1 + jit(i) * 0.2;

  // Cheap bounded Dijkstra over inhabited land
  const pd = new Float64Array(N).fill(Infinity); // float64 like the heap keys, or stale-entry checks misfire
  const touched: number[] = [];
  const grow = (seed: number, budget: number, cost: (n: number) => number): { cells: number[]; d: number[] } => {
    const cells: number[] = [];
    const ds: number[] = [];
    heap.clear();
    pd[seed] = 0;
    touched.push(seed);
    heap.push(0, seed);
    while (heap.size) {
      const d = heap.peekKey();
      const c = heap.pop();
      if (d > pd[c]) continue;
      cells.push(c);
      ds.push(d);
      const x = c % W;
      const y = (c - x) / W;
      for (let k = 0; k < 8; k++) {
        const ny = y + N8Y[k];
        if (ny < 0 || ny >= H) continue;
        const n = ny * W + ((x + N8X[k] + W) % W);
        if (culture[n] < 0) continue;
        const nd = d + N8D[k] * cost(n);
        if (nd <= budget && nd < pd[n]) {
          if (pd[n] === Infinity) touched.push(n);
          pd[n] = nd;
          heap.push(nd, n);
        }
      }
    }
    for (const c of touched) pd[c] = Infinity;
    touched.length = 0;
    return { cells, d: ds };
  };

  // Spaced candidate sites
  const taken: number[] = [];
  const farFromTaken = (c: number, minD: number) => taken.every((t) => dist(t, c) >= minD);
  const sample = (ok: (i: number) => boolean, stride: number) => {
    const out: number[] = [];
    const s = Math.max(1, Math.round(stride));
    const ox = Math.floor(rand() * s);
    const oy = Math.floor(rand() * s);
    for (let y = oy; y < H; y += s) for (let x = ox; x < W; x += s) if (ok(y * W + x)) out.push(y * W + x);
    return out;
  };
  // A neighbor people for host h: bordering ones first, then theirs
  const neighborOf = (h: number): number => {
    const w = new Map<number, number>();
    for (const [b, n] of adj[h]) {
      w.set(b, (w.get(b) ?? 0) + 3 * Math.sqrt(n));
      for (const [b2, n2] of adj[b]) if (b2 !== h) w.set(b2, (w.get(b2) ?? 0) + Math.sqrt(n2));
    }
    let total = 0;
    for (const v of w.values()) total += v;
    if (!total) {
      // An island people: the nearest hearth
      let best = -1;
      let bd = Infinity;
      world.cultures.forEach((c, k) => {
        if (k === h) return;
        const d = Math.hypot(wdx(c.centerX, world.cultures[h].centerX), c.centerY - world.cultures[h].centerY);
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      return best;
    }
    let r = rand() * total;
    for (const [k, v] of w) if ((r -= v) <= 0) return k;
    return -1;
  };

  // Writes a pocket of people p over the grown cells: a core where they are
  // the majority, a rim where they live among the hosts. "culture" pockets
  // keep the host race (converts), "race" pockets keep the host culture.
  const pocketMark = new Uint8Array(N);
  const settle = (p: number, grown: { cells: number[]; d: number[] }, budget: number, coreFrac: number, kind: "both" | "culture" | "race") => {
    const pr = raceOf(p);
    grown.cells.forEach((c, k) => {
      if (pocketMark[c]) return;
      const host = culture[c];
      if (host < 0 || host === p) return;
      pocketMark[c] = 1;
      const hostRace = race[c];
      const core = grown.d[k] <= budget * coreFrac;
      if (kind !== "race") {
        if (core) {
          culture[c] = p;
          culture2[c] = -1;
        } else culture2[c] = p;
      }
      if (kind !== "culture" && pr >= 0 && pr !== hostRace) {
        if (core) {
          race[c] = pr;
          race2[c] = kind === "race" ? hostRace : -1;
        } else race2[c] = pr;
      } else if (kind === "culture" && core && pr >= 0 && pr !== hostRace && rand() < 0.3) race2[c] = pr;
    });
  };
  const kindRoll = (): "both" | "culture" | "race" => {
    const r = rand();
    return r < 0.18 ? "culture" : r < 0.33 ? "race" : "both";
  };
  // People and kind for a pocket inside host land; a race pocket wants a
  // people of another race (or it would show nothing)
  const pocketPeople = (host: number): [number, "both" | "culture" | "race"] => {
    const kind = kindRoll();
    let p = neighborOf(host);
    for (let t = 0; kind === "race" && t < 6 && p >= 0 && raceOf(p) === raceOf(host); t++) p = neighborOf(host);
    return [p, kind];
  };

  // Mixed surroundings of the largest market towns (before pockets claim cells)
  const towns = sample((i) => culture[i] >= 0 && cellOf(i).populationDensity > 0.6, 3 * res).sort(
    (a, b) => cellOf(b).populationDensity - cellOf(a).populationDensity,
  );
  const bigTowns: number[] = [];
  for (const t of towns) {
    if (bigTowns.length >= Math.max(2, Math.min(8, Math.round(C / 2)))) break;
    if (bigTowns.every((b) => dist(b, t) > 30 * res)) bigTowns.push(t);
  }
  for (const t of bigTowns) {
    const host = culture[t];
    const other = neighborOf(host);
    if (other < 0) continue;
    const budget = R * (0.08 + rand() * 0.1);
    const g = grow(t, budget, (n) => 1 + lobe(n));
    const or = raceOf(other);
    for (const c of g.cells) {
      if (culture[c] === other || culture2[c] >= 0) continue;
      culture2[c] = other;
      if (or !== race[c]) race2[c] = or;
    }
    taken.push(t);
  }

  // Mountain refuges: an older people holding out in the hills
  const hills = sample((i) => {
    if (culture[i] < 0) return false;
    const e = cellOf(i).elevation;
    return e > 0.63 && e < 0.86;
  }, 4 * res);
  const refuges = Math.round(C * 1.2);
  for (let n = 0, tries = 0; n < refuges && tries < refuges * 12 && hills.length; tries++) {
    const s = pick(hills);
    if (!farFromTaken(s, R * 0.5)) continue;
    const [p, kind] = pocketPeople(culture[s]);
    if (p < 0) continue;
    const budget = R * (0.12 + rand() * 0.2);
    const g = grow(s, budget, (c) => 1 + (cellOf(c).elevation < 0.56 ? 0.6 : 0) + lobe(c));
    settle(p, g, budget, 0.55 + rand() * 0.3, kind);
    taken.push(s);
    n++;
  }

  // River valleys: a people that came up (or down) the river
  const riverSites = sample((i) => culture[i] >= 0 && cellOf(i).hasRiver && world.flow[i] > 0, 3 * res);
  const valleys = Math.round(C * 0.8);
  for (let n = 0, tries = 0; n < valleys && tries < valleys * 12 && riverSites.length; tries++) {
    const s = pick(riverSites);
    if (!farFromTaken(s, R * 0.5)) continue;
    const [p, kind] = pocketPeople(culture[s]);
    if (p < 0) continue;
    const budget = R * (0.15 + rand() * 0.2);
    const g = grow(s, budget, (c) => 1 + (cellOf(c).hasRiver ? 0 : 1.2) + (cellOf(c).elevation > 0.68 ? 1.5 : 0) + lobe(c) * 0.5);
    settle(p, g, budget, 0.5 + rand() * 0.35, kind);
    taken.push(s);
    n++;
  }

  // Seafaring peoples string trading colonies along other peoples' coasts
  const shores = sample((i) => culture[i] >= 0 && coastDist[i] <= 1.5 && cellOf(i).populationDensity > 0.35, 2 * res);
  const coastOf = new Float64Array(C);
  for (const s of shores) coastOf[culture[s]]++;
  const seafarers: number[] = [];
  const seaCount = Math.max(1, Math.min(4, Math.round(C / 5)));
  for (let k = 0; k < seaCount; k++) {
    let total = 0;
    for (let c = 0; c < C; c++) if (!seafarers.includes(c)) total += coastOf[c];
    if (!total) break;
    let r = rand() * total;
    for (let c = 0; c < C; c++) {
      if (seafarers.includes(c)) continue;
      if ((r -= coastOf[c]) <= 0) {
        seafarers.push(c);
        break;
      }
    }
  }
  for (const p of seafarers) {
    const hearth = Math.floor(world.cultures[p].centerY) * W + Math.floor(world.cultures[p].centerX);
    const reach = Math.max(W * 0.16, R * 6);
    const sites = shores.filter((s) => culture[s] !== p && dist(s, hearth) < reach);
    const colonies = 3 + Math.floor(rand() * 5);
    for (let n = 0, tries = 0; n < colonies && tries < colonies * 15 && sites.length; tries++) {
      const s = pick(sites);
      if (!farFromTaken(s, R * 0.3)) continue;
      const budget = R * (0.07 + rand() * 0.1);
      const g = grow(s, budget, (c) => 1 + coastDist[c] * 0.7 + lobe(c) * 0.5);
      settle(p, g, budget, rand() < 0.4 ? 0.25 : 0.6 + rand() * 0.25, rand() < 0.25 ? "culture" : "both");
      taken.push(s);
      n++;
    }
  }

  // Scattered diaspora: a few households of a far people in market towns
  const dots = Math.round(C * 2);
  for (let n = 0, tries = 0; n < dots && tries < dots * 10 && towns.length; tries++) {
    const s = pick(towns);
    if (pocketMark[s] || !farFromTaken(s, 6 * res)) continue;
    const host = culture[s];
    const p = seafarers.length && rand() < 0.5 ? pick(seafarers) : Math.floor(rand() * C);
    if (p === host) continue;
    const budget = (1.5 + rand() * 2.2) * res;
    settle(p, grow(s, budget, () => 1), budget, rand() < 0.35 ? 0.5 : 0, rand() < 0.2 ? "culture" : "both");
    taken.push(s);
    n++;
  }

  // Race islands: people of another stock who took up the local tongue
  // (culture unchanged, race different), in hills and quiet country alike
  const raceCount = world.races.length;
  if (raceCount > 1) {
    const sites = sample((i) => culture[i] >= 0 && !pocketMark[i], 5 * res);
    const islands = Math.round(C * 0.8);
    for (let n = 0, tries = 0; n < islands && tries < islands * 12 && sites.length; tries++) {
      const s = pick(sites);
      if (pocketMark[s] || !farFromTaken(s, R * 0.35)) continue;
      // A neighbor's race when it differs, else any other race
      let r = raceOf(neighborOf(culture[s]));
      if (r < 0 || r === race[s]) r = (race[s] + 1 + Math.floor(rand() * (raceCount - 1))) % raceCount;
      if (r === race[s]) continue;
      const budget = R * (0.07 + rand() * 0.14);
      const coreFrac = 0.5 + rand() * 0.35;
      const g = grow(s, budget, (c) => Math.max(0.4, 1 + lobe(c) - (cellOf(c).elevation > 0.63 ? 0.3 : 0)));
      g.cells.forEach((c, k) => {
        if (pocketMark[c] || race[c] === r) return;
        pocketMark[c] = 1;
        if (g.d[k] <= budget * coreFrac) {
          race2[c] = rand() < 0.15 ? race[c] : -1;
          race[c] = r;
        } else race2[c] = r;
      });
      taken.push(s);
      n++;
    }
  }

  // Wobble every outline a little (pockets would otherwise stay round)
  const wx = coarseNoise(ctx, 4400, 0.16, 2);
  const wy = coarseNoise(ctx, 9900, 0.16, 2);
  const wamp = 9 * res;
  const layers = [culture, culture2, race, race2];
  const copies = layers.map((a) => a.slice());
  for (let i = 0; i < N; i++) {
    if (copies[0][i] < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const sx = ((Math.round(x + wx[i] * wamp) % W) + W) % W;
    const sy = Math.round(y + wy[i] * wamp);
    if (sy < 0 || sy >= H) continue;
    const s = sy * W + sx;
    if (copies[0][s] < 0) continue;
    for (let k = 0; k < 4; k++) layers[k][i] = copies[k][s];
  }

  // Tidy: no group mixes with itself
  for (let i = 0; i < N; i++) {
    if (culture[i] < 0) {
      culture2[i] = race[i] = race2[i] = -1;
      continue;
    }
    if (race[i] < 0) race[i] = raceOf(culture[i]);
    if (culture2[i] === culture[i]) culture2[i] = -1;
    if (race2[i] === race[i]) race2[i] = -1;
  }
  return { culture, culture2, race, race2 };
}

