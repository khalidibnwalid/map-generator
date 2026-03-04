import { WorldData } from '../WorldData';
import type { GeneratorContext } from './types';

export function determineBiomes(ctx: GeneratorContext): void {
    const { world, width, height } = ctx;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];
            cell.biome = WorldData.getBiome(cell.elevation, cell.temperature, cell.moisture);
        }
    }
}
