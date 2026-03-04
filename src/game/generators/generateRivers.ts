import type { GeneratorContext } from './types';

export function generateRivers(ctx: GeneratorContext): void {
    const { world, noise, width, height } = ctx;
    // Basic hydrological carving
    const numRivers = Math.floor((width * height) / 5000);
    world.rivers = []; // Clear rivers

    const maxRiverLen = Math.floor(100 * (width / 800));

    for (let r = 0; r < numRivers; r++) {
        let x = Math.floor(noise.random() * width);
        let y = Math.floor(noise.random() * height);

        let cell = world.grid[x][y];
        // Start river only in mountains or high elevation
        if (cell.isWater || cell.elevation < 0.6) continue;

        let len = 0;
        let currentRiver: { x: number, y: number }[] = [];

        while (len < maxRiverLen) {
            cell.hasRiver = true;
            currentRiver.push({ x, y });

            let lowestNeighbor = null;
            let minElev = cell.elevation;
            let nextX = x, nextY = y;

            // Check 8 neighbors
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    let ny = y + dy;
                    if (ny >= 0 && ny < height) {
                        let nx = ((x + dx) % width + width) % width;
                        const nCell = world.grid[nx][ny];
                        if (nCell.elevation < minElev) {
                            minElev = nCell.elevation;
                            lowestNeighbor = nCell;
                            nextX = nx;
                            nextY = ny;
                        }
                    }
                }
            }

            if (lowestNeighbor) {
                x = nextX;
                y = nextY;
                cell = lowestNeighbor;
                if (cell.isWater) { // River reached ocean
                    currentRiver.push({ x, y });
                    break;
                }
            } else {
                // River trapped in depression (lake)
                break;
            }
            len++;
        }

        if (currentRiver.length > 2) {
            world.rivers.push(currentRiver);
        }
    }
}
