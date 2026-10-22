import { yieldFrame, distanceTransform } from "../util/grid";
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
    } else if (preset === 'Earthlike') {
        // Fewer, larger plates make continent-sized crust blocks
        numPlates = 26;
        baseScale = 0.006 * invResScale;
    } else { // Pangea
        numPlates = 25;
        baseScale = 0.0025 * invResScale;
    }

    // Pangea: a random supercontinent archetype, built as a thick "spine"
    // (polylines in height-normalised map units, x spans ±aspect/2)
    const aspect = width / height;
    const arc = (a0: number, a1: number, r: number, n: number) =>
        Array.from({ length: n }, (_, i) => {
            const a = a0 + ((a1 - a0) * i) / (n - 1);
            return [Math.cos(a) * r * 1.25, Math.sin(a) * r] as [number, number];
        });
    const ARCHETYPES: { name: string; lines: [number, number][][]; r: number }[] = [
        { name: "blob", lines: [[[0, 0], [0.05, 0.02]]], r: 0.34 },
        { name: "belt", lines: [[[-0.55, 0], [0, 0.04], [0.55, -0.02]]], r: 0.2 },
        { name: "meridian", lines: [[[0, -0.34], [0.05, 0], [-0.03, 0.34]]], r: 0.21 },
        { name: "L", lines: [[[-0.35, -0.3], [-0.35, 0.26], [0.45, 0.26]]], r: 0.17 },
        { name: "V", lines: [[[-0.5, -0.3], [0, 0.3], [0.5, -0.3]]], r: 0.16 },
        { name: "C", lines: [arc(0.7, 5.6, 0.3, 9)], r: 0.15 },
        { name: "S", lines: [[[-0.62, -0.18], [-0.22, 0.24], [0.2, -0.22], [0.6, 0.2]]], r: 0.15 },
        { name: "T", lines: [[[-0.5, -0.24], [0.5, -0.24]], [[0, -0.24], [0, 0.32]]], r: 0.16 },
    ];
    const shape = ARCHETYPES[Math.floor(noise.random() * ARCHETYPES.length)];
    const rot = (noise.random() - 0.5) * 0.6 + (noise.random() < 0.5 ? Math.PI : 0);
    const flip = noise.random() < 0.5 ? -1 : 1;
    const sc = 0.9 + noise.random() * 0.25;
    const segs: [number, number, number, number][] = [];
    for (const line of shape.lines) {
        const pts = line.map(([px, py]) => {
            const qx = px * flip * sc;
            const qy = py * sc;
            return [qx * Math.cos(rot) - qy * Math.sin(rot), qx * Math.sin(rot) + qy * Math.cos(rot)];
        });
        for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
    }
    const spineDist = (px: number, py: number) => {
        let best = Infinity;
        for (const [ax, ay, bx, by] of segs) {
            const dx = bx - ax;
            const dy = by - ay;
            const l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
            best = Math.min(best, Math.hypot(px - (ax + dx * t), py - (ay + dy * t)));
        }
        return best;
    };
    const innerSea = shape.name === "blob" || shape.name === "belt"
        ? { x: (noise.random() - 0.5) * 0.25, y: (noise.random() - 0.5) * 0.15, r: 0.05 + noise.random() * 0.04 }
        : null;

    // 1. Generate Base Elevation
    for (let x = 0; x < width; x++) {
        if (x % 50 === 0) {
            onProgress?.(Math.floor((x / width) * 10)); // 0-10% range
            await yieldFrame();
        }
        for (let y = 0; y < height; y++) {
            let e = noise.fbmCylinder(x, y, width, 6, 0.5, 2.0, baseScale);

            if (preset === 'Pangea') {
                // Domain-warped supercontinent whose rim radius varies with
                // angle (lobes, peninsulas, gulfs), with an inland sea
                const warpS = 0.0022 * invResScale;
                const wx = (x / width - 0.5) * aspect + (noise.fbmCylinder(x + 7100, y, width, 4, 0.5, 2.0, warpS) - 0.5) * 0.36;
                const wy = y / height - 0.5 + (noise.fbmCylinder(x, y + 3900, width, 4, 0.5, 2.0, warpS) - 0.5) * 0.3;
                // Spine thickness varies along the coast: peninsulas and gulfs
                const rim = shape.r * (1 + (noise.fbmCylinder(x + 1300, y + 1300, width, 4, 0.5, 2.0, 0.005 * invResScale) - 0.5) * 0.9);
                const d = spineDist(wx, wy) / Math.max(0.05, rim);
                // Coastal belt rising into a varied interior, not one high dome
                e = e + 0.15 - 0.8 * Math.max(0, d - 0.8);
                if (innerSea) {
                    const sea = Math.hypot(wx - innerSea.x, (wy - innerSea.y) * 1.4) / innerSea.r;
                    if (sea < 1.6) e -= (1.6 - sea) * 0.22;
                }
            } else if (preset === 'Earthlike') {
                // Detail only; continents come from plates below
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
            await yieldFrame();
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

    // 3b. Earthlike: continents are made of whole continental plates
    if (preset === 'Earthlike') {
        const N = width * height;
        const plateArea = new Array<number>(numPlates).fill(0);
        const touches: Set<number>[] = Array.from({ length: numPlates }, () => new Set());
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const p = world.grid[x][y].plateId;
                plateArea[p]++;
                const r = world.grid[(x + 1) % width][y].plateId;
                if (r !== p) { touches[p].add(r); touches[r].add(p); }
                if (y + 1 < height) {
                    const d = world.grid[x][y + 1].plateId;
                    if (d !== p) { touches[p].add(d); touches[d].add(p); }
                }
            }
        }
        // Clustered picks: grow from a few seeds so continents form, not confetti
        const continental = new Array<boolean>(numPlates).fill(false);
        let landArea = 0;
        const target = N * 0.38;
        let guard = 0;
        while (landArea < target && guard++ < numPlates * 4) {
            let pick = -1;
            if (landArea > 0 && noise.random() < 0.55) {
                const frontier = [...Array(numPlates).keys()].filter((p) => !continental[p] && [...touches[p]].some((q) => continental[q]));
                if (frontier.length) pick = frontier[Math.floor(noise.random() * frontier.length)];
            }
            if (pick < 0) {
                const free = [...Array(numPlates).keys()].filter((p) => !continental[p]);
                if (!free.length) break;
                pick = free[Math.floor(noise.random() * free.length)];
            }
            continental[pick] = true;
            landArea += plateArea[pick];
        }

        // Signed distance to the continent/ocean crust boundary
        const isCont = new Uint8Array(N);
        const isOcean = new Uint8Array(N);
        for (let x = 0; x < width; x++)
            for (let y = 0; y < height; y++) {
                if (continental[world.grid[x][y].plateId]) isCont[y * width + x] = 1;
                else isOcean[y * width + x] = 1;
            }
        const toOcean = distanceTransform(width, height, isOcean).dist;
        const toCont = distanceTransform(width, height, isCont).dist;
        onProgress?.(21);
        await yieldFrame();

        const shelf = 6 * resScale;
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const i = y * width + x;
                const cell = world.grid[x][y];
                const detail = cell.elevation; // fbm stored in step 1
                const sd = isCont[i] ? Math.min(toOcean[i], 200) : -Math.min(toCont[i], 200);
                // Coastline wanders far from the straight plate edges
                const warp =
                    (noise.fbmCylinder(x + 900, y + 400, width, 4, 0.5, 2.0, 0.009 * invResScale) - 0.5) * 34 * resScale +
                    (noise.fbmCylinder(x + 300, y + 800, width, 4, 0.5, 2.0, 0.04 * invResScale) - 0.5) * 9 * resScale;
                const t = Math.max(0, Math.min(1, (sd + warp + shelf) / (shelf * 2)));
                const tt = t * t * (3 - 2 * t);
                const ocean = 0.16 + detail * 0.22;
                // Interiors rise into plateaus and uplands
                const interior = Math.max(0, Math.min(1, (sd + warp - 25 * resScale) / (60 * resScale)));
                const land = 0.47 + detail * 0.2 + interior * 0.08 * detail;
                cell.elevation = Math.max(0, Math.min(1, ocean + (land - ocean) * tt));
            }
        }
    }

    // 4. Calculate Stress
    // Distance to the nearest plate boundary via an exact distance transform
    // (replaces scanning a (2r+1)^2 window around every cell).
    const N = width * height;
    const plateOf = new Int32Array(N);
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) plateOf[y * width + x] = world.grid[x][y].plateId;
    const isSite = new Uint8Array(N);
    const otherPlate = new Int32Array(N).fill(-1);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const p = plateOf[i];
            const nbs = [y * width + ((x + 1) % width), y * width + ((x - 1 + width) % width), y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
            for (const n of nbs) {
                if (n >= 0 && plateOf[n] !== p) {
                    isSite[i] = 1;
                    otherPlate[i] = plateOf[n];
                    break;
                }
            }
        }
    }
    onProgress?.(22);
    await yieldFrame();
    const { dist, nearest } = distanceTransform(width, height, isSite);
    const searchRadius = Math.min(8, Math.max(4, Math.round(4 * resScale)));

    for (let x = 0; x < width; x++) {
        if (x % 100 === 0) {
            onProgress?.(24 + Math.floor((x / width) * 6));
            await yieldFrame();
        }
        for (let y = 0; y < height; y++) {
            const i = y * width + x;
            const cell = world.grid[x][y];
            const myPlate = plates[cell.plateId];
            const s = nearest[i];
            let minBoundDist = 999;
            let neighborPlate: Plate | null = null;
            if (s >= 0) {
                if (plateOf[s] !== cell.plateId) {
                    neighborPlate = plates[plateOf[s]];
                    minBoundDist = Math.max(1, dist[i]);
                } else if (otherPlate[s] >= 0) {
                    neighborPlate = plates[otherPlate[s]];
                    minBoundDist = dist[i] + 1;
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
