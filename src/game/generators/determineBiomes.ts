import { WorldData } from '../WorldData';
import type { GeneratorContext } from './types';

export async function determineBiomes(ctx: GeneratorContext): Promise<void> {
    const { world, width, height, onProgress } = ctx;
    for (let x = 0; x < width; x++) {
        if (x % 100 === 0) {
            onProgress?.((x / width) * 100);
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];
            cell.biome = WorldData.getBiome(cell.elevation, cell.moisture, cell.temperature);
        }
    }
}
