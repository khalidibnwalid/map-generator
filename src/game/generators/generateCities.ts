import type { GeneratorContext } from './types';

export function generateCities(ctx: GeneratorContext): void {
    const { world, noise, width, height } = ctx;
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
            name: nation.name, // capital shares nation name
            x: nation.capitalX,
            y: nation.capitalY,
            nationIndex: nation.id,
            isCapital: true,
            size: 2
        });
    }

    // Then: place additional towns / villages
    const resScale = width / 800;
    const citiesPerNation = Math.max(2, Math.floor(3 * resScale));
    const minCityDist = 30 * resScale;

    for (const nation of world.nations) {
        let placed = 0;
        let attempts = 0;

        while (placed < citiesPerNation && attempts < 800) {
            attempts++;
            const x = Math.floor(noise.random() * width);
            const y = Math.floor(noise.random() * height);
            const cell = world.grid[x][y];

            // Must be land, in this nation, moderate elevation
            if (cell.isWater || (cell.nationIndex ?? -1) !== nation.id || cell.elevation > 0.75) continue;

            // Prefer coastal or river cells (score)
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
            // Coastal/river cells are preferred but not required
            if (coastBonus === 0 && noise.random() < 0.6) continue;

            // Check minimum distance from all existing cities
            let tooClose = false;
            for (const c of world.cities) {
                let dx = Math.abs(x - c.x);
                if (dx > width / 2) dx = width - dx;
                if (Math.hypot(dx, y - c.y) < minCityDist) { tooClose = true; break; }
            }
            if (tooClose) continue;

            const size = coastBonus >= 4 ? 1 : 0; // town or village
            world.cities.push({
                id: world.cities.length,
                name: makeName(),
                x, y,
                nationIndex: nation.id,
                isCapital: false,
                size
            });
            placed++;
        }
    }
}
