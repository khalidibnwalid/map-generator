import type { GeneratorContext } from './types';

export async function generateElevation(ctx: GeneratorContext): Promise<void> {
    const { world, noise, width, height, preset, onProgress } = ctx;
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

    // 1. Generate Base Elevation
    for (let x = 0; x < width; x++) {
        if (x % 50 === 0) {
            onProgress?.(Math.floor((x / width) * 10)); // 0-10% range
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        for (let y = 0; y < height; y++) {
            let e = noise.fbmCylinder(x, y, width, 6, 0.5, 2.0, baseScale);

            if (preset === 'Pangea') {
                const dx = x / width - 0.5;
                const dy = y / height - 0.5;
                const dist = Math.sqrt(dx * dx + dy * dy) * 2.2;
                e = e + 0.5 - (dist * dist);
            } else if (preset === 'Mediterranean Archipelago') {
                const dx = x / width - 0.5;
                const dy = y / height - 0.5;
                const dist = Math.sqrt(dx * dx + dy * dy) * 2.0;
                e = e + (dist * dist * 1.2) - 0.4;
            } else if (preset === 'Realistic Continents') {
                e -= 0.08;
            }

            e = (e - 0.5) * 1.2 + 0.5;
            world.grid[x][y].elevation = Math.max(0, Math.min(1, e));
        }
    }

    // 2. Generate Plates
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

    // 3. Assign Plates
    for (let x = 0; x < width; x++) {
        if (x % 25 === 0) {
            onProgress?.(10 + Math.floor((x / width) * 10)); // 10-20% range
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        for (let y = 0; y < height; y++) {
            let closestPlate = 0;
            let minDist = Infinity;

            const distortScale = 0.02 * invResScale;
            const distortStrength = 50 * resScale;
            const distortX = noise.fbmCylinder(x, y, width, 5, 0.5, 2.0, distortScale) * distortStrength;
            const distortY = noise.fbmCylinder(x + 5000, y + 5000, width, 5, 0.5, 2.0, distortScale) * distortStrength;

            for (let i = 0; i < numPlates; i++) {
                const p = plates[i];
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

    // 4. Calculate Stress
    for (let x = 0; x < width; x++) {
        if (x % 15 === 0) {
            onProgress?.(20 + Math.floor((x / width) * 10)); // 20-30% range
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
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
                const influence = Math.pow(1 - (minBoundDist / searchRadius), 2);

                if (collisionIntensity > 0) {
                    cell.elevation += (collisionIntensity * 0.45 * influence);
                } else {
                    cell.elevation += (collisionIntensity * 0.25 * influence);
                }
            }

            cell.elevation = Math.max(0, Math.min(1, cell.elevation));
            cell.isWater = cell.elevation < 0.45;
        }
    }
}
