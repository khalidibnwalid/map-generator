import type { GeneratorContext } from "./types";
import { WaterType } from "../WorldData";
import { encodeSdf } from "../../core/FieldNoise";
import {
  MinHeap,
  distanceTransform,
  labelComponents,
  yieldFrame,
} from "../util/grid";

const SEA_LEVEL = 0.45;

// Cleans the raw heightmap into coherent water bodies, routes drainage, and
// builds the coast signed-distance field used for rendering.
//  1. Tiny water specks become land; enclosed water becomes lakes.
//  2. Priority-flood from the ocean gives every land cell a drainage path.
//  3. Deep enclosed depressions become lakes.
//  4. Signed distance to the coast -> world.coastSdf.
export async function generateCoast(ctx: GeneratorContext): Promise<void> {
  const { world, width: W, height: H, noise, onProgress } = ctx;
  const N = W * H;
  const resScale = W / 800;
  const minLake = Math.max(6, Math.round(24 * resScale * resScale));

  const elev = new Float32Array(N);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) elev[y * W + x] = world.grid[x][y].elevation;

  // --- 1. Water components ---
  const water = new Uint8Array(N);
  for (let i = 0; i < N; i++) water[i] = elev[i] < SEA_LEVEL ? 1 : 0;
  const wc = labelComponents(W, H, water);
  let largest = 0;
  for (let i = 1; i < wc.sizes.length; i++)
    if (wc.sizes[i] > wc.sizes[largest]) largest = i;

  const compType = wc.sizes.map((size, id) => {
    if (id === largest || size > N * 0.02) return WaterType.OCEAN;
    if (size < minLake) return WaterType.LAND;
    return WaterType.LAKE;
  });

  const type = world.waterType;
  for (let i = 0; i < N; i++) {
    if (!water[i]) {
      type[i] = WaterType.LAND;
      continue;
    }
    const t = compType[wc.labels[i]];
    type[i] = t;
    if (t === WaterType.LAND) elev[i] = SEA_LEVEL + 0.012;
  }

  // Single-cell islands read as noise; sink them.
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = type[i] === WaterType.LAND ? 1 : 0;
  const lc = labelComponents(W, H, land);
  for (let i = 0; i < N; i++) {
    if (land[i] && lc.sizes[lc.labels[i]] <= 1) {
      type[i] = WaterType.OCEAN;
      elev[i] = SEA_LEVEL - 0.02;
    }
  }
  onProgress?.(25);
  await yieldFrame();

  // --- 2. Priority flood from ocean coasts ---
  const fill = new Float32Array(N);
  const receiver = world.receiver;
  receiver.fill(-1);
  const visited = new Uint8Array(N);
  const heap = new MinHeap(1 << 16);
  const neighbor = (c: number, k: number): number => {
    const x = c % W;
    const y = (c - x) / W;
    const dx = NB_DX[k];
    const ny = y + NB_DY[k];
    if (ny < 0 || ny >= H) return -1;
    return ny * W + ((x + dx + W) % W);
  };

  for (let i = 0; i < N; i++) {
    if (type[i] !== WaterType.OCEAN) continue;
    visited[i] = 1;
    fill[i] = elev[i];
    let coastal = false;
    for (let k = 0; k < 8; k++) {
      const n = neighbor(i, k);
      if (n >= 0 && type[n] !== WaterType.OCEAN) {
        coastal = true;
        break;
      }
    }
    if (coastal) heap.push(elev[i], i);
  }

  const order = world.flowOrder;
  let oc = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    order[oc++] = c;
    for (let k = 0; k < 8; k++) {
      const n = neighbor(c, k);
      if (n < 0 || visited[n]) continue;
      visited[n] = 1;
      // Small jitter keeps drainage across flats from running in straight lines
      const eps = 1e-5 * (1 + noise.random());
      fill[n] = Math.max(elev[n], fill[c] + eps);
      receiver[n] = c;
      heap.push(fill[n], n);
    }
    if ((oc & 0x3ffff) === 0) {
      onProgress?.(25 + (oc / N) * 40);
      await yieldFrame();
    }
  }
  // Cells never reached (e.g. landlocked worlds with no ocean) drain nowhere.
  world.flowOrderLength = oc;

  // --- 3. Depression lakes ---
  const pit = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (type[i] === WaterType.OCEAN) continue;
    // Even shallow basins hold water; leaving them as flats makes rivers run
    // across them in unnaturally straight lines.
    if (type[i] === WaterType.LAKE || fill[i] - elev[i] > 0.004) pit[i] = 1;
  }
  const pc = labelComponents(W, H, pit);
  for (let i = 0; i < N; i++) {
    if (!pit[i]) continue;
    const size = pc.sizes[pc.labels[i]];
    const keep = size >= minLake && size <= N * 0.05;
    type[i] = keep ? WaterType.LAKE : WaterType.LAND;
    if (!keep && elev[i] < SEA_LEVEL) elev[i] = SEA_LEVEL + 0.012;
  }
  onProgress?.(75);
  await yieldFrame();

  // --- Write back ---
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      const cell = world.grid[x][y];
      cell.elevation = elev[i];
      cell.isWater = type[i] !== WaterType.LAND;
    }
  }

  // Landmasses (for road connectivity)
  for (let i = 0; i < N; i++) land[i] = type[i] === WaterType.LAND ? 1 : 0;
  const lm = labelComponents(W, H, land);
  world.landmass.set(lm.labels);

  // --- 4. Signed distance field to the coast ---
  const isWaterSite = new Uint8Array(N);
  const isLandSite = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (type[i] === WaterType.LAND) isLandSite[i] = 1;
    else isWaterSite[i] = 1;
  }
  const toWater = distanceTransform(W, H, isWaterSite);
  onProgress?.(88);
  await yieldFrame();
  const toLand = distanceTransform(W, H, isLandSite);
  for (let i = 0; i < N; i++) {
    const d = isLandSite[i] ? toWater.dist[i] - 0.5 : -(toLand.dist[i] - 0.5);
    world.coastSdf[i] = encodeSdf(d);
  }
  world.invalidateSampler();
  onProgress?.(100);
}

const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DY = [0, 0, 1, -1, 1, -1, 1, -1];
