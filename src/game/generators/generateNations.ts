import type { GeneratorContext } from "./types";
import type { WorldData } from "../WorldData";
import { hslHex } from "../names";
import { growRegions, fillUnreached, warpOwnerArray } from "../util/regionGrow";
import { distanceTransform, labelComponents, yieldFrame } from "../util/grid";

// Nation palette: lively but balanced (between neon and muted atlas tones).
// Hues are spread around the wheel except the blue/cyan band, so land never
// reads as water; alternating lightness keeps adjacent hues distinct.
const PALETTE_HUES = [0, 16, 30, 42, 54, 68, 88, 112, 140, 162, 268, 284, 300, 316, 332, 348];
export const NATION_PALETTE = PALETTE_HUES.map((h, i) => hslHex(h, 0.62, i % 2 ? 0.6 : 0.54));

function shade(hex: string, amt: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number) =>
    Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * (1 + amt))))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// Greedy map colouring: neighbours never share a palette colour; when a
// colour is reused elsewhere it gets a slightly different shade.
export function assignNationColors(world: WorldData) {
  const n = world.nations.length;
  const W = world.width;
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < world.height; y++) {
      const a = world.grid[x][y].nationIndex ?? -1;
      if (a < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nb = world.getCell(x + dx, y + dy);
        const b = nb?.nationIndex ?? -1;
        if (b >= 0 && b !== a && a < n && b < n) {
          adj[a].add(b);
          adj[b].add(a);
        }
      }
    }
  }
  const order = [...Array(n).keys()].sort((p, q) => adj[q].size - adj[p].size);
  const slot = new Array<number>(n).fill(-1);
  const uses = new Array<number>(NATION_PALETTE.length).fill(0);
  for (const i of order) {
    const taken = new Set([...adj[i]].map((j) => slot[j]).filter((s) => s >= 0));
    let best = -1;
    for (let k = 0; k < NATION_PALETTE.length; k++) {
      if (taken.has(k)) continue;
      if (best < 0 || uses[k] < uses[best]) best = k;
    }
    if (best < 0) best = i % NATION_PALETTE.length;
    slot[i] = best;
    const reuse = uses[best]++;
    const amt = reuse === 0 ? 0 : (reuse % 2 === 1 ? 1 : -1) * 0.07 * Math.ceil(reuse / 2);
    world.nations[i].color = shade(NATION_PALETTE[best], Math.max(-0.25, Math.min(0.2, amt)));
  }
}

// A palette colour for a nation founded in the editor, avoiding its neighbours
export function colorForNewNation(world: WorldData, neighbours: number[]): string {
  const used = new Set(neighbours.map((j) => world.nations[j]?.color));
  const free = NATION_PALETTE.filter((c) => !used.has(c));
  const pool = free.length ? free : NATION_PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Coast geometry for sea claims never changes, so it is computed once per
// world: nearest land for every water cell, which water is claimable
// (territorial band, plus gulf mouths and straits narrower than twice the
// closing radius, which also links close islands to the mainland), and the
// enclosed pockets behind those closed mouths.
interface WaterGeometry {
  nearest: Int32Array; // nearest land cell of each water cell
  claim: Uint8Array; // 1 claimable sea, 2 lake, 0 land or open sea
  pockets: { cells: Int32Array; rim: Int32Array }[]; // rim: nearest land of the claimed water around it
}
const GULF_CLOSE_CELLS = 10; // closes mouths up to ~100 km wide
const waterGeometryCache = new WeakMap<WorldData, WaterGeometry>();

function waterGeometry(world: WorldData): WaterGeometry {
  const cached = waterGeometryCache.get(world);
  if (cached) return cached;
  const W = world.width;
  const H = world.height;
  const N = W * H;
  const landSite = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (world.waterType[i] === 0) landSite[i] = 1;
  const { dist, nearest } = distanceTransform(W, H, landSite);
  // Morphological closing of the land: water out of reach of any open-sea
  // disc of the closing radius is a narrow gulf or strait
  const far = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (world.waterType[i] === 1 && dist[i] > GULF_CLOSE_CELLS) far[i] = 1;
  const distFar = distanceTransform(W, H, far).dist;
  const claim = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = world.waterType[i];
    if (t === 2) claim[i] = 2;
    else if (t !== 0 && nearest[i] >= 0 && (dist[i] <= TERRITORIAL_WATERS_CELLS || distFar[i] > GULF_CLOSE_CELLS)) claim[i] = 1;
  }
  // Enclosed seas: open water cut off from the ocean by claimed water
  const free = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (world.waterType[i] === 1 && claim[i] === 0) free[i] = 1;
  const comps = labelComponents(W, H, free);
  const maxPocket = N * 0.015;
  const members: number[][] = comps.sizes.map(() => []);
  for (let i = 0; i < N; i++) if (free[i] && comps.sizes[comps.labels[i]] <= maxPocket) members[comps.labels[i]].push(i);
  const pockets: WaterGeometry["pockets"] = [];
  for (const cells of members) {
    if (!cells.length) continue;
    const rim = new Set<number>();
    let open = false;
    for (const c of cells) {
      const x = c % W;
      const y = (c - x) / W;
      if (y === 0 || y === H - 1) open = true;
      for (const n of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
        if (n >= 0 && !free[n] && nearest[n] >= 0) rim.add(world.waterType[n] === 0 ? n : nearest[n]);
      }
    }
    if (!open && rim.size) pockets.push({ cells: Int32Array.from(cells), rim: Int32Array.from(rim) });
  }
  const geo = { nearest, claim, pockets };
  waterGeometryCache.set(world, geo);
  return geo;
}

// Fills the water entries of a flat owner array from its land entries:
// claimable sea follows the nearest coast, lakes their shores, and enclosed
// pockets go whole to a sole surrounding owner (else by proximity).
export function claimWaters(world: WorldData, owner: Int32Array | Int16Array) {
  const { nearest, claim, pockets } = waterGeometry(world);
  const N = owner.length;
  for (let i = 0; i < N; i++) {
    if (world.waterType[i] === 0) continue;
    owner[i] = claim[i] ? owner[nearest[i]] : -1;
  }
  for (const { cells, rim } of pockets) {
    let sole = -1;
    let mixed = false;
    for (let k = 0; k < rim.length; k++) {
      const o = owner[rim[k]];
      if (o < 0) continue;
      if (sole < 0) sole = o;
      else if (o !== sole) mixed = true;
    }
    if (sole < 0) continue;
    for (let k = 0; k < cells.length; k++) owner[cells[k]] = mixed ? owner[nearest[cells[k]]] : sole;
  }
}

// Re-derives sea control after land changed hands. Returns false if nothing
// changed; `rows` grows to cover the rows that did.
// A caller that already keeps a flat owner array passes it to skip the grid read.
export function refreshTerritorialWaters(
  world: WorldData,
  rows?: { y0: number; y1: number },
  flatOwner?: Int16Array | Int32Array,
): boolean {
  const W = world.width;
  const H = world.height;
  if (flatOwner) {
    // The grid already matches the flat array: write back only what changed
    const before = flatOwner.slice();
    claimWaters(world, flatOwner);
    let changed = false;
    for (let i = 0; i < flatOwner.length; i++) {
      if (before[i] === flatOwner[i]) continue;
      const y = (i / W) | 0;
      world.grid[i % W][y].nationIndex = flatOwner[i];
      changed = true;
      if (rows) {
        if (y < rows.y0) rows.y0 = y;
        if (y > rows.y1) rows.y1 = y;
      }
    }
    return changed;
  }
  const owner = new Int32Array(W * H);
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) owner[y * W + x] = col[y].nationIndex ?? -1;
  }
  claimWaters(world, owner);
  let changed = false;
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (world.waterType[i] === 0) continue;
      if ((col[y].nationIndex ?? -1) !== owner[i]) {
        col[y].nationIndex = owner[i];
        changed = true;
        if (rows) {
          if (y < rows.y0) rows.y0 = y;
          if (y > rows.y1) rows.y1 = y;
        }
      }
    }
  }
  return changed;
}

// Territorial waters reach ~22 km (12 nautical miles) offshore.
export const TERRITORIAL_WATERS_CELLS = 4.4;

export async function generateNations(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  const W = width;
  world.nations = [];

  // Base number of nations based on map scale
  const numNations = Math.floor((width * height) / 6000);
  const minDistance = 40 * (width / 800);

  // 1. Pick Capitals (bucketed so the spacing check stays cheap on large maps)
  const bucket = Math.max(8, Math.floor(minDistance));
  const bucketsX = Math.ceil(W / bucket);
  const buckets = new Map<number, number[]>();
  const tooClose = (x: number, y: number) => {
    const bx = Math.floor(x / bucket);
    const by = Math.floor(y / bucket);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const key = (by + oy) * bucketsX + ((bx + ox + bucketsX) % bucketsX);
        for (const id of buckets.get(key) ?? []) {
          const n = world.nations[id];
          let dx = Math.abs(x - n.capitalX);
          if (dx > W / 2) dx = W - dx;
          if (Math.hypot(dx, y - n.capitalY) < minDistance) return true;
        }
      }
    }
    return false;
  };

  let capitalAttempts = 0;
  while (world.nations.length < numNations && capitalAttempts < 4000) {
    capitalAttempts++;
    const x = Math.floor(noise.random() * width);
    const y = Math.floor(noise.random() * height);
    const cell = world.grid[x][y];
    if (cell.isWater || cell.elevation >= 0.7) continue;
    // Prefer habitable land for capitals
    if (noise.random() > 0.25 + cell.populationDensity) continue;
    if (tooClose(x, y)) continue;

    const id = world.nations.length;
    const cultureId = cell.cultureIndex ?? 0;
    const lang = world.languages[cultureId];
    world.nations.push({
      id,
      name: lang ? lang.nationName() : `Nation ${id + 1}`,
      color: NATION_PALETTE[id % NATION_PALETTE.length],
      capitalX: x,
      capitalY: y,
      cultureId,
      religionId: cell.religionIndex ?? 0,
    });
    const key = Math.floor(y / bucket) * bucketsX + Math.floor(x / bucket);
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
  onProgress?.(15);
  await yieldFrame();

  // 2. Grow land borders over terrain (ridges and rivers make natural frontiers)
  const owner = growRegions(
    world,
    noise,
    world.nations.map((n) => ({
      cell: n.capitalY * W + n.capitalX,
      weight: 0.75 + noise.random() * 0.6,
    })),
    {
      mountainCost: 2.5,
      slopeCost: 1.2,
      riverCost: 1.5,
      noiseAmp: 0.35,
      noiseScale: 0.02,
      noiseOffset: 0,
    },
  );
  // Islands without a capital become overseas territories of the nearest state
  fillUnreached(world, owner);
  warpOwnerArray(world, noise, owner, 5 * (width / 800));
  onProgress?.(55);
  await yieldFrame();

  // 3. Territorial waters: each water cell belongs to the nearest coast's
  // owner within the limit; lakes are internal waters of their shores.
  // Enclosed seas, gulfs and straits between close shores become internal waters.
  claimWaters(world, owner);
  onProgress?.(75);
  await yieldFrame();

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < height; y++) {
      world.grid[x][y].nationIndex = owner[y * W + x];
    }
  }
  assignNationColors(world);

  // 4. Pre-compute land border flags
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      if (cell.isWater || cell.nationIndex === undefined || cell.nationIndex < 0) {
        cell.isNationBorder = false;
        continue;
      }
      const nid = cell.nationIndex;
      let border = false;
      outerLoop: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          const nx = (((x + dx) % width) + width) % width;
          if (ny >= 0 && ny < height) {
            const nb = world.grid[nx][ny];
            if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
              border = true;
              break outerLoop;
            }
          }
        }
      }
      cell.isNationBorder = border;
    }
  }
  onProgress?.(100);
}
