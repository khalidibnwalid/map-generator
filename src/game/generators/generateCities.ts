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
        world.cities.push({
            id: world.cities.length,
            name: nation.name,
            x: nation.capitalX,
            y: nation.capitalY,
            nationIndex: nation.id,
            isCapital: true,
            size: 2
        });
    }

    const totalNations = world.nations.length;
    // Count territory cells for each nation to approximate area
    const nationAreas = new Array(totalNations).fill(0);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];
            if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex >= 0 && cell.nationIndex < totalNations) {
                nationAreas[cell.nationIndex]++;
            }
        }
    }

    const resScale = width / 800;
    const minCityDist = 18 * resScale; // Reduced to allow higher density

    for (let i = 0; i < totalNations; i++) {
        const nation = world.nations[i];

        // Calculate cities based on territory area. 
        // e.g., 1 city per 800 px of territory, min 2, max 100 for large empires
        const area = nationAreas[i];
        const areaCities = Math.floor(area / (800 * resScale * resScale));
        const citiesPerNation = Math.max(2, Math.min(100, Math.floor((3 + areaCities) * resScale)));

        onProgress?.((i / totalNations) * 100);
        await new Promise(resolve => requestAnimationFrame(resolve));

        let placed = 0;
        let attempts = 0;

        while (placed < citiesPerNation && attempts < 2000) {
            attempts++;

            // Best Candidate Strategy: pick 5 random valid points and keep the best one
            let bestX = -1;
            let bestY = -1;
            let bestScore = -Infinity;
            let bestSize = 0;

            for (let c = 0; c < 5; c++) {
                const x = Math.floor(noise.random() * width);
                const y = Math.floor(noise.random() * height);
                const cell = world.grid[x][y];

                if (cell.isWater || (cell.nationIndex ?? -1) !== nation.id || cell.elevation > 0.75) continue;

                let coastBonus = 0;
                for (let dx = -3; dx <= 3; dx++) {
                    for (let dy = -3; dy <= 3; dy++) {
                        const nx = ((x + dx) % width + width) % width;
                        const ny = y + dy;
                        if (ny >= 0 && ny < height) {
                            if (world.grid[nx][ny].isWater) coastBonus++;
                            if (world.grid[nx][ny].hasRiver) coastBonus++;
                        }
                    }
                }

                // Allow inland cities occasionally, but strongly prefer coasts/rivers
                if (coastBonus === 0 && noise.random() < 0.7) continue;

                let tooClose = false;
                for (const c of world.cities) {
                    let dx = Math.abs(x - c.x);
                    if (dx > width / 2) dx = width - dx;
                    if (Math.hypot(dx, y - c.y) < minCityDist) { tooClose = true; break; }
                }
                if (tooClose) continue;

                // Score based on coast/river proximity and some randomness
                const score = coastBonus + noise.random() * 2;

                if (score > bestScore) {
                    bestScore = score;
                    bestX = x;
                    bestY = y;
                    bestSize = coastBonus >= 4 ? 1 : 0;
                }
            }

            if (bestX !== -1) {
                world.cities.push({
                    id: world.cities.length,
                    name: makeName(),
                    x: bestX,
                    y: bestY,
                    nationIndex: nation.id,
                    isCapital: false,
                    size: bestSize
                });
                placed++;
            }
        }
    }
}
