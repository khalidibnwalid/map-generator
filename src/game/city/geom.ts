// Small convex-polygon toolkit for city generation. Units are meters.

export interface Vec {
  x: number;
  y: number;
}
export type Poly = Vec[];

export function area(p: Poly): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return a / 2;
}

export function centroid(p: Poly): Vec {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j].x * p[i].y - p[i].x * p[j].y;
    cx += (p[j].x + p[i].x) * f;
    cy += (p[j].y + p[i].y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const v of p) {
      sx += v.x;
      sy += v.y;
    }
    return { x: sx / p.length, y: sy / p.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// Keeps the part of `p` where nx*x + ny*y <= c.
export function clipHalfPlane(p: Poly, nx: number, ny: number, c: number): Poly {
  const out: Poly = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const da = nx * a.x + ny * a.y - c;
    const db = nx * b.x + ny * b.y - c;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

// Splits a convex polygon by the line through `o` with direction `d`, leaving a
// gap of `gap` meters between the halves.
export function splitConvex(p: Poly, o: Vec, d: Vec, gap: number): [Poly, Poly] {
  const len = Math.hypot(d.x, d.y) || 1;
  const nx = -d.y / len;
  const ny = d.x / len;
  const c = nx * o.x + ny * o.y;
  const a = clipHalfPlane(p, nx, ny, c - gap / 2);
  const b = clipHalfPlane(p, -nx, -ny, -c - gap / 2);
  return [a, b];
}

// Exact inset of a convex polygon (null if it collapses).
export function insetConvex(p: Poly, d: number): Poly | null {
  if (p.length < 3) return null;
  const s = area(p) > 0 ? 1 : -1;
  let q = p;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    // Outward normal for this orientation
    const nx = (-s * ey) / len;
    const ny = (s * ex) / len;
    q = clipHalfPlane(q, nx, ny, nx * a.x + ny * a.y - d);
    if (q.length < 3) return null;
  }
  return Math.abs(area(q)) > 1 ? q : null;
}

export function longestEdge(p: Poly): { i: number; len: number; dir: Vec } {
  let best = 0;
  let bl = -1;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > bl) {
      bl = l;
      best = i;
    }
  }
  const a = p[best];
  const b = p[(best + 1) % p.length];
  return { i: best, len: bl, dir: { x: (b.x - a.x) / (bl || 1), y: (b.y - a.y) / (bl || 1) } };
}

export function pointInPoly(p: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i];
    const b = p[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, py: number, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function circlePoly(r: number, n: number): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

// Voronoi cells of `sites` clipped to the convex `bounds`.
export function voronoi(sites: Vec[], bounds: Poly): Poly[] {
  const cells: Poly[] = [];
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const others = sites
      .map((o, j) => ({ o, j, d: (o.x - s.x) ** 2 + (o.y - s.y) ** 2 }))
      .filter((e) => e.j !== i)
      .sort((a, b) => a.d - b.d);
    let cell = bounds;
    for (const { o, d } of others) {
      // Stop once remaining sites are too far to affect the cell
      let maxR = 0;
      for (const v of cell) maxR = Math.max(maxR, (v.x - s.x) ** 2 + (v.y - s.y) ** 2);
      if (d > 4 * maxR) break;
      const nx = o.x - s.x;
      const ny = o.y - s.y;
      const c = (o.x * o.x + o.y * o.y - s.x * s.x - s.y * s.y) / 2;
      cell = clipHalfPlane(cell, nx, ny, c);
      if (cell.length < 3) break;
    }
    cells.push(cell);
  }
  return cells;
}

// Simple deterministic RNG (mulberry32)
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Marching squares over an n×n raster (row-major, spacing `res`, origin `o`).
// Returns closed loops around regions where v < 0. Border samples should be
// non-negative so every loop closes.
export function contours(v: Float32Array, n: number, res: number, o: number): Poly[] {
  const edgePoint = (id: number): Vec => {
    const horiz = (id & 1) === 0;
    const k = id >> 1;
    const i = k % n;
    const j = (k - i) / n;
    const a = v[j * n + i];
    const b = horiz ? v[j * n + i + 1] : v[(j + 1) * n + i];
    const t = a / (a - b);
    return horiz
      ? { x: o + (i + t) * res, y: o + j * res }
      : { x: o + i * res, y: o + (j + t) * res };
  };
  const next = new Map<number, number>();
  const link = (a: number, b: number) => next.set(a, b);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const tl = v[j * n + i] < 0 ? 1 : 0;
      const tr = v[j * n + i + 1] < 0 ? 1 : 0;
      const br = v[(j + 1) * n + i + 1] < 0 ? 1 : 0;
      const bl = v[(j + 1) * n + i] < 0 ? 1 : 0;
      const code = tl | (tr << 1) | (br << 2) | (bl << 3);
      if (code === 0 || code === 15) continue;
      const top = (j * n + i) * 2;
      const bottom = ((j + 1) * n + i) * 2;
      const left = (j * n + i) * 2 + 1;
      const right = (j * n + i + 1) * 2 + 1;
      // Orientation keeps the negative region on a consistent side
      switch (code) {
        case 1: link(left, top); break;
        case 2: link(top, right); break;
        case 3: link(left, right); break;
        case 4: link(right, bottom); break;
        case 5: link(left, bottom); link(right, top); break;
        case 6: link(top, bottom); break;
        case 7: link(left, bottom); break;
        case 8: link(bottom, left); break;
        case 9: link(bottom, top); break;
        case 10: link(top, left); link(bottom, right); break;
        case 11: link(bottom, right); break;
        case 12: link(right, left); break;
        case 13: link(right, top); break;
        case 14: link(top, left); break;
      }
    }
  }
  const loops: Poly[] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: Poly = [];
    let e = start;
    let guard = 0;
    while (!used.has(e) && guard++ < 1e6) {
      used.add(e);
      loop.push(edgePoint(e));
      const nx = next.get(e);
      if (nx === undefined) break;
      e = nx;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
