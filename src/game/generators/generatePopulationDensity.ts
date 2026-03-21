import type { GeneratorContext } from "./types";
import { BiomeType } from "../WorldData";

export async function generatePopulationDensity(ctx: GeneratorContext) {
    const { world, width, height } = ctx;

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];

            if (cell.isWater) {
                cell.populationDensity = 0;
                continue;
            }

            let score = 0;

            // 1. Elevation: prefer lowlands and plains, penalty for high mountains
            if (cell.elevation < 0.6) {
                score += 1.0;
            } else if (cell.elevation < 0.75) {
                score += 0.5;
            } else if (cell.elevation > 0.85) {
                score -= 0.5; // High mountains are sparse
            }

            // 2. Temperature: prefer moderate temperatures (0.4 to 0.7)
            const idealTemp = 0.55;
            const tempDiff = Math.abs(cell.temperature - idealTemp);
            if (tempDiff < 0.15) {
                score += 1.0;
            } else if (tempDiff < 0.3) {
                score += 0.5;
            } else {
                score -= 0.5; // Too hot or too cold
            }

            // 3. Moisture & Biomes: prefer moderate/high moisture, penalty for deserts and ice
            if (cell.biome === BiomeType.SUBTROPICAL_DESERT || cell.biome === BiomeType.TEMPERATE_DESERT || cell.biome === BiomeType.SCORCHED) {
                score -= 1.0;
            } else if (cell.biome === BiomeType.SNOW || cell.biome === BiomeType.BARE || cell.biome === BiomeType.TUNDRA) {
                score -= 0.8;
            } else if (cell.moisture > 0.4 && cell.moisture < 0.8) {
                score += 0.5; // Ideal agricultural land
            }

            // 4. Proximity to water: Huge bonus for coastlines and rivers
            let waterBonus = 0;
            if (cell.hasRiver) {
                waterBonus += 1.5;
            }

            // Check neighbors for water (coastline)
            let isCoast = false;
            const neighbors = [
                [0, -1], [1, 0], [0, 1], [-1, 0]
            ];
            for (const [dx, dy] of neighbors) {
                const nx = (x + dx + width) % width;
                const ny = y + dy;
                if (ny >= 0 && ny < height) {
                    if (world.grid[nx][ny].isWater) {
                        isCoast = true;
                        break;
                    }
                }
            }

            if (isCoast) {
                waterBonus += 1.0;
            }

            // Add water bonus but clamp it to avoid coastlines dominating everything, 
            // though major settlements are often coastal or on rivers
            score += Math.min(waterBonus, 2.0);

            // Base random variation to simulate organic spreading and minor settlements
            score += (ctx.noise.noise2D(x * 0.1, y * 0.1) * 0.5);

            // Normalize score into density (0.0 to 1.0 roughly, we will clamp later)
            cell.populationDensity = score;
        }
    }

    // Multiple smoothing / diffusion passes to create large organic gradients
    let currentDensity = new Array(width)
        .fill(0)
        .map((_, x) => new Float32Array(height).map((_, y) => world.grid[x][y].populationDensity));
    let nextDensity = new Array(width).fill(0).map(() => new Float32Array(height));

    const passes = 3; // 3 passes of 3x3 box blur is equivalent to a wider Gaussian blur

    for (let pass = 0; pass < passes; pass++) {
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                if (world.grid[x][y].isWater) continue;

                let sum = currentDensity[x][y] * 2.0;
                let count = 2.0;

                for (let dx = -2; dx <= 2; dx++) {
                    for (let dy = -2; dy <= 2; dy++) {
                        if (dx === 0 && dy === 0) continue;

                        const nx = (x + dx + width) % width;
                        const ny = y + dy;

                        if (ny >= 0 && ny < height && !world.grid[nx][ny].isWater) {
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            const weight = 1.0 / dist; // Distance-based weighting
                            sum += currentDensity[nx][ny] * weight;
                            count += weight;
                        }
                    }
                }
                nextDensity[x][y] = sum / count;
            }
        }

        // Swap buffers
        let temp = currentDensity;
        currentDensity = nextDensity;
        nextDensity = temp;
    }

    // Find max for normalization
    let maxDensity = 0;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (!world.grid[x][y].isWater && currentDensity[x][y] > maxDensity) {
                maxDensity = currentDensity[x][y];
            }
        }
    }

    // Normalization
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (!world.grid[x][y].isWater && maxDensity > 0) {
                // Apply a gentle curve
                const normalized = currentDensity[x][y] / maxDensity;
                world.grid[x][y].populationDensity = Math.pow(normalized, 1.2);
            } else {
                world.grid[x][y].populationDensity = 0;
            }
        }
    }
}
