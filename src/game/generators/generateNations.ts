import type { GeneratorContext } from "./types";
import { hslHex } from "../names";
import { growRegions, fillUnreached, warpOwnerArray } from "../util/regionGrow";
import { distanceTransform, yieldFrame } from "../util/grid";

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
    const hue = Math.floor(noise.random() * 360);
    world.nations.push({
      id,
      name: lang ? lang.nationName() : `Nation ${id + 1}`,
      color: hslHex(hue, 0.8, 0.6),
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
  onProgress?.(75);
  await yieldFrame();

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < height; y++) {
      world.grid[x][y].nationIndex = owner[y * W + x];
    }
  }

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
