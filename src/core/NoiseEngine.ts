export class NoiseEngine {
    private p: Uint8Array;
    private perm: Uint8Array;
    private permMod12: Uint8Array;
    public random: () => number;

    // Seed random generator (Mulberry32)
    private mulberry32(a: number) {
        return function () {
            var t = a += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }

    constructor(seed: string | number) {
        let seedRef = typeof seed === 'string' ? this.hashString(seed) : seed;
        this.random = this.mulberry32(seedRef);

        this.p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            this.p[i] = Math.floor(this.random() * 256);
        }

        this.perm = new Uint8Array(512);
        this.permMod12 = new Uint8Array(512);
        for (let i = 0; i < 512; i++) {
            this.perm[i] = this.p[i & 255];
            this.permMod12[i] = (this.perm[i] % 12);
        }
    }

    private hashString(str: string) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            let char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }

    // 2D Simplex Noise implementation
    public noise2D(xin: number, yin: number): number {
        const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
        const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

        let n0, n1, n2; // Noise contributions from the three corners

        // Skew the input space to determine which simplex cell we're in
        let s = (xin + yin) * F2; // Hairy factor for 2D
        let i = Math.floor(xin + s);
        let j = Math.floor(yin + s);
        let t = (i + j) * G2;
        let X0 = i - t; // Unskew the cell origin back to (x,y) space
        let Y0 = j - t;
        let x0 = xin - X0; // The x,y distances from the cell origin
        let y0 = yin - Y0;

        // Determine which simplex we are in
        let i1, j1; // Offsets for second (middle) corner of simplex in (i,j) coords
        if (x0 > y0) { i1 = 1; j1 = 0; } // lower triangle, XY order: (0,0)->(1,0)->(1,1)
        else { i1 = 0; j1 = 1; } // upper triangle, YX order: (0,0)->(0,1)->(1,1)

        // Calculate the contributions from the three corners
        let x1 = x0 - i1 + G2;
        let y1 = y0 - j1 + G2;
        let x2 = x0 - 1.0 + 2.0 * G2;
        let y2 = y0 - 1.0 + 2.0 * G2;

        let ii = i & 255;
        let jj = j & 255;

        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 < 0) n0 = 0.0;
        else {
            t0 *= t0;
            n0 = t0 * t0 * this.grad(this.permMod12[ii + this.perm[jj]], x0, y0);
        }

        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 < 0) n1 = 0.0;
        else {
            t1 *= t1;
            n1 = t1 * t1 * this.grad(this.permMod12[ii + i1 + this.perm[jj + j1]], x1, y1);
        }

        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 < 0) n2 = 0.0;
        else {
            t2 *= t2;
            n2 = t2 * t2 * this.grad(this.permMod12[ii + 1 + this.perm[jj + 1]], x2, y2);
        }

        return 70.0 * (n0 + n1 + n2);
    }

    private grad(hash: number, x: number, y: number) {
        const h = hash & 7; // Convert low 3 bits of hash code
        const u = h < 4 ? x : y; // into 8 simple gradient directions,
        const v = h < 4 ? y : x; // and compute the dot product with (x,y).
        return ((h & 1) ? -u : u) + ((h & 2) ? -2.0 * v : 2.0 * v);
    }

    // Fractal Brownian Motion (fBm)
    public fbm2D(x: number, y: number, octaves: number, persistence: number, lacunarity: number, scale: number): number {
        let total = 0;
        let frequency = scale;
        let amplitude = 1;
        let maxValue = 0; // Used for normalizing result to 0.0 - 1.0

        for (let i = 0; i < octaves; i++) {
            total += this.noise2D(x * frequency, y * frequency) * amplitude;

            maxValue += amplitude;

            amplitude *= persistence;
            frequency *= lacunarity;
        }

        return (total / maxValue + 1) / 2; // Normalize to 0-1
    }

    // 3D Simplex Noise for Seamless East-West Wrapping
    private grad3(hash: number, x: number, y: number, z: number) {
        const h = hash & 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    }

    public noise3D(xin: number, yin: number, zin: number): number {
        const F3 = 1.0 / 3.0;
        const G3 = 1.0 / 6.0;
        let n0, n1, n2, n3;

        let s = (xin + yin + zin) * F3;
        let i = Math.floor(xin + s);
        let j = Math.floor(yin + s);
        let k = Math.floor(zin + s);

        let t = (i + j + k) * G3;
        let X0 = i - t; let Y0 = j - t; let Z0 = k - t;
        let x0 = xin - X0; let y0 = yin - Y0; let z0 = zin - Z0;

        let i1, j1, k1; let i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
        } else {
            if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
            else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
            else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        }

        let x1 = x0 - i1 + G3; let y1 = y0 - j1 + G3; let z1 = z0 - k1 + G3;
        let x2 = x0 - i2 + 2.0 * G3; let y2 = y0 - j2 + 2.0 * G3; let z2 = z0 - k2 + 2.0 * G3;
        let x3 = x0 - 1.0 + 3.0 * G3; let y3 = y0 - 1.0 + 3.0 * G3; let z3 = z0 - 1.0 + 3.0 * G3;

        let ii = i & 255; let jj = j & 255; let kk = k & 255;

        let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        if (t0 < 0) n0 = 0.0;
        else { t0 *= t0; n0 = t0 * t0 * this.grad3(this.perm[ii + this.perm[jj + this.perm[kk]]], x0, y0, z0); }

        let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        if (t1 < 0) n1 = 0.0;
        else { t1 *= t1; n1 = t1 * t1 * this.grad3(this.perm[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]], x1, y1, z1); }

        let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        if (t2 < 0) n2 = 0.0;
        else { t2 *= t2; n2 = t2 * t2 * this.grad3(this.perm[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]], x2, y2, z2); }

        let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        if (t3 < 0) n3 = 0.0;
        else { t3 *= t3; n3 = t3 * t3 * this.grad3(this.perm[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]], x3, y3, z3); }

        return 32.0 * (n0 + n1 + n2 + n3);
    }

    public fbmCylinder(x: number, y: number, mapWidth: number, octaves: number, persistence: number, lacunarity: number, scale: number): number {
        let total = 0;
        let frequency = scale;
        let amplitude = 1;
        let maxValue = 0;

        for (let i = 0; i < octaves; i++) {
            // Map X to an angle around a cylinder
            const angle = (x / mapWidth) * Math.PI * 2;
            const radius = mapWidth / (Math.PI * 2);

            // Map 2D surface to 3D cylinder
            const nx = Math.cos(angle) * radius * frequency;
            const nz = Math.sin(angle) * radius * frequency;
            const ny = y * frequency;

            total += this.noise3D(nx, ny, nz) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }

        return (total / maxValue + 1) / 2;
    }
}
