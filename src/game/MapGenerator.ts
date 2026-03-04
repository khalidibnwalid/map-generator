import { NoiseEngine } from '../core/NoiseEngine';
import { WorldData, BiomeType } from './WorldData';

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

    public generate() {
        this.noise = new NoiseEngine(this.currentSeed);
        this.world = new WorldData(this.width, this.height);

        this.generateElevation();
        this.generateMoisture();
        this.generateTemperature();
        this.determineBiomes();
        this.generateRivers();
        // Optional: generate nations borders here

        return this.world;
    }

    private generateElevation() {
        let numPlates = 40;
        let baseScale = 0.005;

        if (this.currentPreset === 'Heavy Landmass') {
            numPlates = 30;
            baseScale = 0.0035;
        } else if (this.currentPreset === 'Realistic Continents') {
            numPlates = 40;
            baseScale = 0.005;
        } else if (this.currentPreset === 'Mediterranean Archipelago') {
            numPlates = 50;
            baseScale = 0.0075;
        } else { // Pangea
            numPlates = 25;
            baseScale = 0.0025;
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
                const distortX = this.noise.fbmCylinder(x, y, this.width, 5, 0.5, 2.0, 0.02) * 50;
                const distortY = this.noise.fbmCylinder(x + 5000, y + 5000, this.width, 5, 0.5, 2.0, 0.02) * 50;

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

                const searchRadius = 4;
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
        // Reduced frequency to ensure giant sweeping forests/deserts like real geography
        const scale = 0.005;
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

        for (let r = 0; r < numRivers; r++) {
            let x = Math.floor(this.noise.random() * this.width);
            let y = Math.floor(this.noise.random() * this.height);

            let cell = this.world.grid[x][y];
            // Start river only in mountains or high elevation
            if (cell.isWater || cell.elevation < 0.6) continue;

            let len = 0;
            let currentRiver: { x: number, y: number }[] = [];

            while (len < 100) {
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

    public getWorld() {
        return this.world;
    }
}
