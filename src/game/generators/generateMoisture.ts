import type { GeneratorContext } from './types';

export function generateMoisture(ctx: GeneratorContext): void {
    const { world, noise, width, height } = ctx;
    const invResScale = 800 / width;
    // Reduced frequency to ensure giant sweeping forests/deserts like real geography
    const scale = 0.005 * invResScale;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            // Different random offset for moisture
            let m = noise.fbmCylinder(x + 100000, y + 100000, width, 4, 0.5, 2.0, scale);

            const cell = world.grid[x][y];
            // Oceans increase nearby moisture
            if (cell.isWater) {
                m += 0.5;
            }
            cell.moisture = Math.max(0, Math.min(1, m));
        }
    }
}
