import type { GeneratorContext } from './types';

export async function generateCities(ctx: GeneratorContext): Promise<void> {
    const { world, noise, width, height, onProgress } = ctx;
    world.cities = [];

    const cityPrefixes = ['Al', 'El', 'Fort', 'New', 'Port', 'San', 'Vel', 'Mar', 'Dun', 'Kas', 'Ark', 'Tor'];
    const citySuffixes = ['haven', 'holm', 'ford', 'burg', 'ton', 'gate', 'deep', 'reach', 'fell', 'moor', 'vale', 'mere', 'cross', 'bay', 'point'];
    const makeName = () => {
        const p = cityPrefixes[Math.floor(noise.random() * cityPrefixes.length)];
        const s = citySuffixes[Math.floor(noise.random() * citySuffixes.length)];
        return `${p}${s}`;
    };

    // First: add capitals as cities
    for (const nation of world.nations) {
        let bestCapX = nation.capitalX;
        let bestCapY = nation.capitalY;
        let maxPop = -1;

        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const cell = world.grid[x][y];
                if (!cell.isWater && cell.nationIndex === nation.id) {
                    if (cell.populationDensity > maxPop) {
                        maxPop = cell.populationDensity;
                        bestCapX = x;
                        bestCapY = y;
                    }
                }
            }
        }

        nation.capitalX = bestCapX;
        nation.capitalY = bestCapY;

        world.cities.push({
            id: world.cities.length,
            name: nation.name,
            x: bestCapX,
            y: bestCapY,
            nationIndex: nation.id,
            isCapital: true,
            size: 2
        });
    }

    const resScale = width / 800;
    const minCityDist = 18 * resScale;
    const totalNations = world.nations.length;

    for (let i = 0; i < totalNations; i++) {
        const nation = world.nations[i];

        onProgress?.((i / totalNations) * 100);
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Group valid cells for this nation
        const validCells: { x: number, y: number, density: number }[] = [];
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const cell = world.grid[x][y];
                // Skip water, wrong nation, or if it's the exact capital spot
                if (!cell.isWater && cell.nationIndex === nation.id) {
                    if (x !== nation.capitalX || y !== nation.capitalY) {
                        validCells.push({ x, y, density: cell.populationDensity });
                    }
                }
            }
        }

        // Sort by density descending to check the hot spots first
        validCells.sort((a, b) => b.density - a.density);

        let placed = 1; // 1 for capital
        const maxCitiesPerNation = 300;

        for (const cell of validCells) {
            if (placed >= maxCitiesPerNation) break;

            let chance = 0;
            if (cell.density >= 0.8) {
                chance = 1.0; // Very hot spot: absolutely guaranteed at peak
            } else if (cell.density >= 0.6) {
                chance = 0.1; // Hot spot: virtually guaranteed to saturate area
            } else if (cell.density >= 0.4) {
                chance = 0.005; // Moderate: ~75% chance per available city-sized area (frequent but with gaps)
            } else if (cell.density >= 0.2) {
                chance = 0.0005; // Cold/Green: sparse, occasional village (~15% chance per area)
            } else {
                chance = 0.00005; // Non-existent: very rare, maybe 1 or 0 per massive empty province
            }

            if (noise.random() < chance) {
                let tooClose = false;
                for (const c of world.cities) {
                    let dx = Math.abs(cell.x - c.x);
                    if (dx > width / 2) dx = width - dx;
                    if (Math.hypot(dx, cell.y - c.y) < minCityDist) {
                        tooClose = true;
                        break;
                    }
                }

                if (!tooClose) {
                    let citySize = 0;
                    if (cell.density >= 0.7) citySize = 1; // Larger cities in hot spots

                    world.cities.push({
                        id: world.cities.length,
                        name: makeName(),
                        x: cell.x,
                        y: cell.y,
                        nationIndex: nation.id,
                        isCapital: false,
                        size: citySize
                    });
                    placed++;
                }
            }
        }
    }
}
