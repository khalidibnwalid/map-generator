import type { GeneratorContext } from './types';

export async function generateTemperature(ctx: GeneratorContext): Promise<void> {
    const { world, width, height, onProgress } = ctx;
    for (let x = 0; x < width; x++) {
        if (x % 100 === 0) {
            onProgress?.((x / width) * 100);
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        for (let y = 0; y < height; y++) {
            const latitude = Math.abs(y / height - 0.5) * 2;
            const elevation = world.grid[x][y].elevation;
            let temp = 1.0 - latitude;
            temp -= (elevation > 0.45 ? (elevation - 0.45) * 0.5 : 0);
            world.grid[x][y].temperature = Math.max(0, Math.min(1, temp));
        }
    }
}
