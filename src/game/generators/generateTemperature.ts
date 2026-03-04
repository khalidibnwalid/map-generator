import type { GeneratorContext } from './types';

export function generateTemperature(ctx: GeneratorContext): void {
    const { world, width, height } = ctx;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];

            // Latitude temp (equator at center, colder at poles)
            const lat = Math.abs(y / height - 0.5) * 2;
            let baseTemp = 1.0 - lat; // 1 at equator, 0 at poles

            // Altitude decreases temperature
            if (!cell.isWater) {
                // Map elevation 0.45-1.0 to 0.0-1.0 altitude
                const altitude = (cell.elevation - 0.45) / 0.55;
                baseTemp -= altitude * 0.4; // High mountains are colder
            }

            // Ocean proximity tends to moderate temperature, but keep it simple
            cell.temperature = Math.max(0, Math.min(1, baseTemp));
        }
    }
}
