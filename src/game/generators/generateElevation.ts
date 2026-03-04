import type { GeneratorContext } from './types';

export function generateElevation(ctx: GeneratorContext): void {
    const { world, noise, width, height, preset } = ctx;
    let numPlates = 40;
    let baseScale = 0.005;

    const invResScale = 800 / width;
    const resScale = width / 800;

    if (preset === 'Heavy Landmass') {
        numPlates = 30;
        baseScale = 0.0035 * invResScale;
    } else if (preset === 'Realistic Continents') {
        numPlates = 40;
        baseScale = 0.005 * invResScale;
    } else if (preset === 'Mediterranean Archipelago') {
        numPlates = 50;
        baseScale = 0.0075 * invResScale;
    } else { // Pangea
        numPlates = 25;
        baseScale = 0.0025 * invResScale;
    }

    // 1. Generate Base Elevation using purely fBM (for natural organic coastlines)
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let e = noise.fbmCylinder(x, y, width, 6, 0.5, 2.0, baseScale);

            // Pangea radial mask drops elevation at the edges
            if (preset === 'Pangea') {
                const dx = x / width - 0.5;
                const dy = y / height - 0.5;
                const dist = Math.sqrt(dx * dx + dy * dy) * 2.2;
                e = e + 0.5 - (dist * dist);
            } else if (preset === 'Mediterranean Archipelago') {
                // Inverted mask: pull center down into a sea basin, push edges up into continents
                const dx = x / width - 0.5;
                const dy = y / height - 0.5;
                const dist = Math.sqrt(dx * dx + dy * dy) * 2.0;
                e = e + (dist * dist * 1.2) - 0.4;
            } else if (preset === 'Realistic Continents') {
                // Push elevation down mathematically to allow massive, deep oceans separating distinct landmasses 
                e -= 0.08;
            }

            // Push values slightly to polarize Oceans and Landmasses (avoid massive swamps everywhere)
            e = (e - 0.5) * 1.2 + 0.5;
            world.grid[x][y].elevation = Math.max(0, Math.min(1, e)); // raw elevation 0..1
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
        const angle = noise.random() * Math.PI * 2;
        const speed = noise.random() * 0.5 + 0.5;
        plates.push({
            id: i,
            seedX: Math.floor(noise.random() * width),
            seedY: Math.floor(noise.random() * height),
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed
        });
    }

    // 3. Assign Plates with high-freq distortion to break lines into fractal boundary faults
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let closestPlate = 0;
            let minDist = Infinity;

            // Warp space strongly for fractal faults
            const distortScale = 0.02 * invResScale;
            const distortStrength = 50 * resScale;
            const distortX = noise.fbmCylinder(x, y, width, 5, 0.5, 2.0, distortScale) * distortStrength;
            const distortY = noise.fbmCylinder(x + 5000, y + 5000, width, 5, 0.5, 2.0, distortScale) * distortStrength;

            for (let i = 0; i < numPlates; i++) {
                const p = plates[i];

                // Wrapping East/West for continuous Toroid Torus map
                let dx = Math.abs((x + distortX) - p.seedX);
                while (dx > width) dx -= width;
                if (dx > width / 2) dx = width - dx;

                let dy = (y + distortY) - p.seedY;
                let dist = dx * dx + dy * dy;

                if (dist < minDist) {
                    minDist = dist;
                    closestPlate = i;
                }
            }
            world.grid[x][y].plateId = closestPlate;
        }
    }

    // 4. Calculate Stress and modify organic elevation to build ranges and trenches
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const cell = world.grid[x][y];
            const myPlate = plates[cell.plateId];

            let minBoundDist = 999;
            let neighborPlate: Plate | null = null;

            const searchRadius = Math.min(8, Math.max(4, Math.round(4 * resScale)));
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                for (let dy = -searchRadius; dy <= searchRadius; dy++) {
                    const ny = y + dy;
                    if (ny >= 0 && ny < height) {
                        const nx = ((x + dx) % width + width) % width;
                        const nCell = world.grid[nx][ny];
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
                if (dx > width / 2) dx -= width;
                else if (dx < -width / 2) dx += width;

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
