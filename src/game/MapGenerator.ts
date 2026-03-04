import { NoiseEngine } from '../core/NoiseEngine';
import { WorldData } from './WorldData';

export type Preset = 'Heavy Landmass' | 'Realistic Continents' | 'Mediterranean Archipelago' | 'Pangea';

export class MapGenerator {
    private width: number;
    private height: number;
    private world: WorldData;
    private noise: NoiseEngine;

    public currentPreset: Preset = 'Heavy Landmass';
    public currentSeed: number;

    constructor(width: number, height: number, seed: number) {
        this.width = width;
        this.height = height;
        this.currentSeed = seed;
        this.noise = new NoiseEngine(seed);
        this.world = new WorldData(width, height);
    }

    public getWidth() { return this.width; }
    public getHeight() { return this.height; }
    public setSize(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    public generate() {
        this.noise = new NoiseEngine(this.currentSeed);
        this.world = new WorldData(this.width, this.height);

        this.generateElevation();
        this.generateMoisture();
        this.generateTemperature();
        this.determineBiomes();
        this.generateRivers();
        this.generateNations();
        this.generateCities();

        return this.world;
    }

    private generateElevation() {
        let numPlates = 40;
        let baseScale = 0.005;

        const invResScale = 800 / this.width;
        const resScale = this.width / 800;

        if (this.currentPreset === 'Heavy Landmass') {
            numPlates = 30;
            baseScale = 0.0035 * invResScale;
        } else if (this.currentPreset === 'Realistic Continents') {
            numPlates = 40;
            baseScale = 0.005 * invResScale;
        } else if (this.currentPreset === 'Mediterranean Archipelago') {
            numPlates = 50;
            baseScale = 0.0075 * invResScale;
        } else { // Pangea
            numPlates = 25;
            baseScale = 0.0025 * invResScale;
        }

        // 1. Generate Base Elevation using purely fBM (for natural organic coastlines)
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                let e = this.noise.fbmCylinder(x, y, this.width, 6, 0.5, 2.0, baseScale);

                // Pangea radial mask drops elevation at the edges
                if (this.currentPreset === 'Pangea') {
                    const dx = x / this.width - 0.5;
                    const dy = y / this.height - 0.5;
                    const dist = Math.sqrt(dx * dx + dy * dy) * 2.2;
                    e = e + 0.5 - (dist * dist);
                } else if (this.currentPreset === 'Mediterranean Archipelago') {
                    // Inverted mask: pull center down into a sea basin, push edges up into continents
                    const dx = x / this.width - 0.5;
                    const dy = y / this.height - 0.5;
                    const dist = Math.sqrt(dx * dx + dy * dy) * 2.0;
                    e = e + (dist * dist * 1.2) - 0.4;
                } else if (this.currentPreset === 'Realistic Continents') {
                    // Push elevation down mathematically to allow massive, deep oceans separating distinct landmasses 
                    e -= 0.08;
                }

                // Push values slightly to polarize Oceans and Landmasses (avoid massive swamps everywhere)
                e = (e - 0.5) * 1.2 + 0.5;
                this.world.grid[x][y].elevation = Math.max(0, Math.min(1, e)); // raw elevation 0..1
            }
        }

        // 2. Generate Tectonic Plates definition
        interface Plate {
            id: number;
            seedX: number;
            seedY: number;
            vx: number;
            vy: number;
        }

        const plates: Plate[] = [];
        for (let i = 0; i < numPlates; i++) {
            const angle = this.noise.random() * Math.PI * 2;
            const speed = this.noise.random() * 0.5 + 0.5;
            plates.push({
                id: i,
                seedX: Math.floor(this.noise.random() * this.width),
                seedY: Math.floor(this.noise.random() * this.height),
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed
            });
        }

        // 3. Assign Plates with high-freq distortion to break lines into fractal boundary faults
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                let closestPlate = 0;
                let minDist = Infinity;

                // Warp space strongly for fractal faults
                const distortScale = 0.02 * invResScale;
                const distortStrength = 50 * resScale;
                const distortX = this.noise.fbmCylinder(x, y, this.width, 5, 0.5, 2.0, distortScale) * distortStrength;
                const distortY = this.noise.fbmCylinder(x + 5000, y + 5000, this.width, 5, 0.5, 2.0, distortScale) * distortStrength;

                for (let i = 0; i < numPlates; i++) {
                    const p = plates[i];

                    // Wrapping East/West for continuous Toroid Torus map
                    let dx = Math.abs((x + distortX) - p.seedX);
                    while (dx > this.width) dx -= this.width;
                    if (dx > this.width / 2) dx = this.width - dx;

                    let dy = (y + distortY) - p.seedY;
                    let dist = dx * dx + dy * dy;

                    if (dist < minDist) {
                        minDist = dist;
                        closestPlate = i;
                    }
                }
                this.world.grid[x][y].plateId = closestPlate;
            }
        }

        // 4. Calculate Stress and modify organic elevation to build ranges and trenches
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                const cell = this.world.grid[x][y];
                const myPlate = plates[cell.plateId];

                let minBoundDist = 999;
                let neighborPlate: Plate | null = null;

                const searchRadius = Math.min(8, Math.max(4, Math.round(4 * resScale)));
                for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
                        const ny = y + dy;
                        if (ny >= 0 && ny < this.height) {
                            const nx = ((x + dx) % this.width + this.width) % this.width;
                            const nCell = this.world.grid[nx][ny];
                            if (nCell.plateId !== cell.plateId) {
                                const d = Math.hypot(dx, dy);
                                if (d < minBoundDist) {
                                    minBoundDist = d;
                                    neighborPlate = plates[nCell.plateId];
                                }
                            }
                        }
                    }
                }

                cell.distanceToBoundary = minBoundDist;

                if (neighborPlate && minBoundDist <= searchRadius) {
                    const relVx = myPlate.vx - neighborPlate.vx;
                    const relVy = myPlate.vy - neighborPlate.vy;

                    let dx = neighborPlate.seedX - myPlate.seedX;
                    if (dx > this.width / 2) dx -= this.width;
                    else if (dx < -this.width / 2) dx += this.width;

                    const dy = neighborPlate.seedY - myPlate.seedY;
                    const len = Math.hypot(dx, dy) || 1;
                    const collisionIntensity = ((dx / len) * relVx + (dy / len) * relVy);

                    // Square the influence so ranges push up as steep ridges cleanly
                    const influence = Math.pow(1 - (minBoundDist / searchRadius), 2);

                    if (collisionIntensity > 0) { // Convergent -> Mountain ranges
                        // Add elevation sharply
                        cell.elevation += (collisionIntensity * 0.45 * influence);
                    } else { // Divergent -> Trenches or valleys
                        // Subtract elevation cleanly
                        cell.elevation += (collisionIntensity * 0.25 * influence);
                    }
                }

                // Finalize water mask and bounds
                cell.elevation = Math.max(0, Math.min(1, cell.elevation));
                cell.isWater = cell.elevation < 0.45;
            }
        }
    }

    private generateMoisture() {
        const invResScale = 800 / this.width;
        // Reduced frequency to ensure giant sweeping forests/deserts like real geography
        const scale = 0.005 * invResScale;
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                // Different random offset for moisture
                let m = this.noise.fbmCylinder(x + 100000, y + 100000, this.width, 4, 0.5, 2.0, scale);

                const cell = this.world.grid[x][y];
                // Oceans increase nearby moisture
                if (cell.isWater) {
                    m += 0.5;
                }
                cell.moisture = Math.max(0, Math.min(1, m));
            }
        }
    }

    private generateTemperature() {
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                const cell = this.world.grid[x][y];

                // Latitude temp (equator at center, colder at poles)
                const lat = Math.abs(y / this.height - 0.5) * 2;
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
    } private determineBiomes() {
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                const cell = this.world.grid[x][y];
                cell.biome = WorldData.getBiome(cell.elevation, cell.temperature, cell.moisture);
            }
        }
    }

    private generateRivers() {
        // Basic hydrological carving
        const numRivers = Math.floor((this.width * this.height) / 5000);
        this.world.rivers = []; // Clear rivers

        const maxRiverLen = Math.floor(100 * (this.width / 800));

        for (let r = 0; r < numRivers; r++) {
            let x = Math.floor(this.noise.random() * this.width);
            let y = Math.floor(this.noise.random() * this.height);

            let cell = this.world.grid[x][y];
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
                        if (ny >= 0 && ny < this.height) {
                            let nx = ((x + dx) % this.width + this.width) % this.width;
                            const nCell = this.world.grid[nx][ny];
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
                this.world.rivers.push(currentRiver);
            }
        }
    }

    private generateNations() {
        this.world.nations = [];

        // Base number of nations based on map scale
        const numNations = Math.floor((this.width * this.height) / 12000);

        const names = [
            "Aethelgard", "Vanguard", "Karak", "Zion", "Oblivion", "Nebula",
            "Cynosure", "Dominion", "Republic of Terra", "Empire of the Sun",
            "Zenith", "Apex", "Nadir", "Horizon", "Meridian", "Equinox", "Solstice",
            "Oasis", "Sanctuary", "Bastion", "Citadel", "Aegis", "Vortex"
        ];

        // 1. Pick Capitals
        let capitalAttempts = 0;
        while (this.world.nations.length < numNations && capitalAttempts < 2000) {
            const x = Math.floor(this.noise.random() * this.width);
            const y = Math.floor(this.noise.random() * this.height);
            const cell = this.world.grid[x][y];

            // Capitals on land, not too high up, and preferably near coasts or rivers
            if (!cell.isWater && cell.elevation < 0.7) {
                // Check distance to other capitals to spread them out
                let tooClose = false;
                for (const n of this.world.nations) {
                    let dx = Math.abs(x - n.capitalX);
                    if (dx > this.width / 2) dx = this.width - dx;
                    const dy = Math.abs(y - n.capitalY);

                    const minDistance = 40 * (this.width / 800); // Scale distance with resolution
                    if (Math.hypot(dx, dy) < minDistance) {
                        tooClose = true;
                        break;
                    }
                }

                if (!tooClose) {
                    // Generate a "sci-fi" neon color for the nation
                    const hue = Math.floor(this.noise.random() * 360);
                    // Conversion to hex to keep it consistent
                    const s = 0.8;
                    const l = 0.6;

                    const k = (n: number) => (n + hue / 30) % 12;
                    const a = s * Math.min(l, 1 - l);
                    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

                    const toHex = (c: number) => {
                        const hex = Math.round(c * 255).toString(16);
                        return hex.length === 1 ? '0' + hex : hex;
                    };
                    const colorHex = `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;

                    // Generate name
                    let name = names[Math.floor(this.noise.random() * names.length)];
                    // add random suffix to ensure uniqueness
                    const suffix = String.fromCharCode(65 + Math.floor(this.noise.random() * 26)) +
                        String.fromCharCode(65 + Math.floor(this.noise.random() * 26));
                    name = `${name}-${suffix}`;

                    this.world.nations.push({
                        id: this.world.nations.length,
                        name,
                        color: colorHex,
                        capitalX: x,
                        capitalY: y
                    });
                }
            }
            capitalAttempts++;
        }

        // 2. Expand Borders (Distance Field with Fractal Noise)
        const invResScale = 800 / this.width;

        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                const cell = this.world.grid[x][y];
                if (cell.isWater) continue;

                let minScore = Infinity;
                let closestNation = -1;

                // Add fractal noise for organic border fault lines
                const noiseScale = 0.02 * invResScale;
                const noiseStrength = 25 * (this.width / 800);
                const noiseX = this.noise.fbmCylinder(x, y, this.width, 4, 0.5, 2.0, noiseScale) * noiseStrength;
                const noiseY = this.noise.fbmCylinder(x + 5000, y + 5000, this.width, 4, 0.5, 2.0, noiseScale) * noiseStrength;

                const px = x + noiseX;
                const py = y + noiseY;

                for (const n of this.world.nations) {
                    // calculate cylindrical distance across toroid map
                    let dx = Math.abs(px - n.capitalX);
                    while (dx > this.width) dx -= this.width;
                    if (dx > this.width / 2) dx = this.width - dx;

                    let dy = py - n.capitalY;
                    let dist = Math.hypot(dx, dy);

                    if (dist < minScore) {
                        minScore = dist;
                        closestNation = n.id;
                    }
                }

                cell.nationIndex = closestNation;
            }
        }

        // 3. Pre-compute border flags once (avoids per-pixel neighbor lookups at render time)
        for (let x = 0; x < this.width; x++) {
            for (let y = 0; y < this.height; y++) {
                const cell = this.world.grid[x][y];
                if (cell.isWater || cell.nationIndex === undefined || cell.nationIndex < 0) {
                    cell.isNationBorder = false;
                    continue;
                }
                const nid = cell.nationIndex;
                let border = false;
                outerLoop:
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const ny = y + dy;
                        const nx = ((x + dx) % this.width + this.width) % this.width;
                        if (ny >= 0 && ny < this.height) {
                            const nb = this.world.grid[nx][ny];
                            if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
                                border = true;
                                break outerLoop;
                            }
                        }
                    }
                }
                cell.isNationBorder = border;
            }
        }
    }

    private generateCities() {
        this.world.cities = [];

        const cityPrefixes = ['Al', 'El', 'Fort', 'New', 'Port', 'San', 'Vel', 'Mar', 'Dun', 'Kas', 'Ark', 'Tor'];
        const citySuffixes = ['haven', 'holm', 'ford', 'burg', 'ton', 'gate', 'deep', 'reach', 'fell', 'moor', 'vale', 'mere', 'cross', 'bay', 'point'];
        const makeName = () => {
            const p = cityPrefixes[Math.floor(this.noise.random() * cityPrefixes.length)];
            const s = citySuffixes[Math.floor(this.noise.random() * citySuffixes.length)];
            return `${p}${s}`;
        };

        // First: add capitals as cities
        for (const nation of this.world.nations) {
            this.world.cities.push({
                id: this.world.cities.length,
                name: nation.name, // capital shares nation name
                x: nation.capitalX,
                y: nation.capitalY,
                nationIndex: nation.id,
                isCapital: true,
                size: 2
            });
        }

        // Then: place additional towns / villages
        const resScale = this.width / 800;
        const citiesPerNation = Math.max(2, Math.floor(3 * resScale));
        const minCityDist = 30 * resScale;

        for (const nation of this.world.nations) {
            let placed = 0;
            let attempts = 0;

            while (placed < citiesPerNation && attempts < 800) {
                attempts++;
                const x = Math.floor(this.noise.random() * this.width);
                const y = Math.floor(this.noise.random() * this.height);
                const cell = this.world.grid[x][y];

                // Must be land, in this nation, moderate elevation
                if (cell.isWater || (cell.nationIndex ?? -1) !== nation.id || cell.elevation > 0.75) continue;

                // Prefer coastal or river cells (score)
                let coastBonus = 0;
                for (let dx = -3; dx <= 3; dx++) {
                    for (let dy = -3; dy <= 3; dy++) {
                        const nx = ((x + dx) % this.width + this.width) % this.width;
                        const ny = y + dy;
                        if (ny >= 0 && ny < this.height) {
                            if (this.world.grid[nx][ny].isWater) coastBonus++;
                            if (this.world.grid[nx][ny].hasRiver) coastBonus++;
                        }
                    }
                }
                // Coastal/river cells are preferred but not required
                if (coastBonus === 0 && this.noise.random() < 0.6) continue;

                // Check minimum distance from all existing cities
                let tooClose = false;
                for (const c of this.world.cities) {
                    let dx = Math.abs(x - c.x);
                    if (dx > this.width / 2) dx = this.width - dx;
                    if (Math.hypot(dx, y - c.y) < minCityDist) { tooClose = true; break; }
                }
                if (tooClose) continue;

                const size = coastBonus >= 4 ? 1 : 0; // town or village
                this.world.cities.push({
                    id: this.world.cities.length,
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

    public getWorld() {
        return this.world;
    }
}
