import { yieldFrame } from "../util/grid";
import type { GeneratorContext } from './types';

export async function generateMoisture(ctx: GeneratorContext): Promise<void> {
    const { world, noise, width, height, onProgress } = ctx;
    const invResScale = 800 / width;
    const scale = 0.005 * invResScale;

    for (let x = 0; x < width; x++) {
        if (x % 100 === 0) {
            onProgress?.((x / width) * 100);
            await yieldFrame();
        }
        for (let y = 0; y < height; y++) {
            let m = noise.fbmCylinder(x + 100000, y + 100000, width, 4, 0.5, 2.0, scale);
            const cell = world.grid[x][y];
            if (cell.isWater) {
                m += 0.5;
            }
            cell.moisture = Math.max(0, Math.min(1, m));
        }
    }
}
