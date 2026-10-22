import { yieldFrame, distanceTransform } from "../util/grid";
import { BiomeType, WorldData, WaterType, classifyLandBiome, biomeFromIndex } from "../WorldData";
import { decodeSdf } from "../../core/FieldNoise";
import type { GeneratorContext } from "./types";

// Runs after rivers so riparian, lakeside and coastal biomes can be placed.
export async function determineBiomes(ctx: GeneratorContext): Promise<void> {
  const { world, width, height, onProgress } = ctx;
  const N = width * height;
  const wetSite = new Uint8Array(N);
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++)
      if (world.grid[x][y].hasRiver || world.waterType[y * width + x] === WaterType.LAKE) wetSite[y * width + x] = 1;
  const wet = distanceTransform(width, height, wetSite).dist;
  const elev = (x: number, y: number) =>
    world.grid[((x % width) + width) % width][Math.max(0, Math.min(height - 1, y))].elevation;

  for (let x = 0; x < width; x++) {
    if (x % 100 === 0) {
      onProgress?.((x / width) * 100);
      await yieldFrame();
    }
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      const cell = world.grid[x][y];
      if (world.waterType[i] === WaterType.LAKE) {
        cell.biome = BiomeType.LAKE;
      } else if (cell.isWater) {
        cell.biome = WorldData.getBiome(Math.min(cell.elevation, 0.449), 0, 0);
      } else {
        const slope = Math.hypot(elev(x + 1, y) - elev(x - 1, y), elev(x, y + 1) - elev(x, y - 1)) * 0.5;
        cell.biome = biomeFromIndex(
          classifyLandBiome(
            Math.max(cell.elevation, 0.481),
            cell.temperature,
            cell.moisture,
            slope,
            wet[i],
            decodeSdf(world.coastSdf[i]),
          ),
        );
      }
    }
  }
}
