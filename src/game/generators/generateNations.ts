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

// Territorial waters reach ~22 km (12 nautical miles) offshore.
export const TERRITORIAL_WATERS_CELLS = 4.4;

export async function generateNations(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  const W = width;
  const N = width * height;
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
  const landSite = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (owner[i] >= 0 && world.waterType[i] === 0) landSite[i] = 1;
  const { dist, nearest } = distanceTransform(W, height, landSite);
  for (let i = 0; i < N; i++) {
    if (world.waterType[i] === 0) continue;
    const isLake = world.waterType[i] === 2;
    owner[i] =
      nearest[i] >= 0 && (isLake || dist[i] <= TERRITORIAL_WATERS_CELLS)
        ? owner[nearest[i]]
        : -1;
  }

  // Enclosed seas: unclaimed pockets cut off from the open ocean by claimed
  // waters become internal waters (whole to a sole owner, else by proximity)
  const free = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (world.waterType[i] !== 0 && owner[i] < 0) free[i] = 1;
  const pockets = labelComponents(W, height, free);
  const maxPocket = N * 0.01;
  const members: number[][] = pockets.sizes.map(() => []);
  for (let i = 0; i < N; i++) if (free[i] && pockets.sizes[pockets.labels[i]] <= maxPocket) members[pockets.labels[i]].push(i);
  for (const cells of members) {
    if (cells.length === 0) continue;
    const owners = new Set<number>();
    let open = false;
    for (const c of cells) {
      const x = c % W;
      const y = (c - x) / W;
      if (y === 0 || y === height - 1) open = true;
      for (const n of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? c - W : -1, y < height - 1 ? c + W : -1]) {
        if (n >= 0 && !free[n] && owner[n] >= 0) owners.add(owner[n]);
      }
    }
    if (open || owners.size === 0) continue;
    if (owners.size === 1) {
      const o = [...owners][0];
      for (const c of cells) owner[c] = o;
    } else {
      for (const c of cells) if (nearest[c] >= 0) owner[c] = owner[nearest[c]];
    }
  }
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
