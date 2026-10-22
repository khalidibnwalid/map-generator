import { yieldFrame } from "../util/grid";
import { BiomeType, WorldData, WaterType } from "../WorldData";
import type { GeneratorContext } from "./types";

export async function determineBiomes(ctx: GeneratorContext): Promise<void> {
  const { world, width, height, onProgress } = ctx;
  for (let x = 0; x < width; x++) {
    if (x % 100 === 0) {
      onProgress?.((x / width) * 100);
      await yieldFrame();
    }
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      if (world.waterType[y * width + x] === WaterType.LAKE) {
        cell.biome = BiomeType.LAKE;
      } else if (cell.isWater) {
        cell.biome = WorldData.getBiome(Math.min(cell.elevation, 0.449), 0, 0);
      } else {
        cell.biome = WorldData.getBiome(
          Math.max(cell.elevation, 0.48),
          cell.temperature,
          cell.moisture,
        );
      }
    }
  }
}
