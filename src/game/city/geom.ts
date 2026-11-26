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

// --- General (not only convex) polygons ---

// Where segment a-b crosses segment c-d: t along a-b and u along c-d (both 0..1), or null
export function segIntersect(a: Vec, b: Vec, c: Vec, d: Vec): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

// Inset of a simple polygon, each edge moved inward by its own distance
// (d[i] for the edge from p[i] to p[i+1]). Works on mildly concave polygons:
// corners are mitered (and clamped), and edges that collapse are dropped.
// Null when the polygon vanishes.
export function insetPoly(p: Poly, d: number | number[]): Poly | null {
  if (p.length < 3) return null;
  const s = area(p) > 0 ? 1 : -1;
  // Each edge as an offset line: a point on it, its direction, and the original end points
  type Line = { x: number; y: number; dx: number; dy: number; a: Vec; b: Vec; d: number };
  let lines: Line[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const di = typeof d === "number" ? d : d[i];
    // Inward normal for this orientation (area() > 0 keeps the inside to the right)
    const nx = (s * ey) / len;
    const ny = (-s * ex) / len;
    lines.push({ x: a.x + nx * di, y: a.y + ny * di, dx: ex / len, dy: ey / len, a, b, d: di });
  }
  for (let pass = 0; pass < p.length && lines.length >= 3; pass++) {
    const n = lines.length;
    const out: Poly = [];
    for (let i = 0; i < n; i++) {
      const L1 = lines[(i - 1 + n) % n];
      const L2 = lines[i];
      const den = L1.dx * L2.dy - L1.dy * L2.dx;
      if (Math.abs(den) < 1e-6) {
        out.push({ x: L2.x, y: L2.y });
        continue;
      }
      const t = ((L2.x - L1.x) * L2.dy - (L2.y - L1.y) * L2.dx) / den;
      const m = { x: L1.x + L1.dx * t, y: L1.y + L1.dy * t };
      // Very sharp corners would shoot far out: clamp the miter
      const base = L2.a;
      const lim = 4 * Math.max(L1.d, L2.d, 1);
      const mx = m.x - base.x;
      const my = m.y - base.y;
      const ml = Math.hypot(mx, my);
      out.push(ml > lim ? { x: base.x + (mx / ml) * lim, y: base.y + (my / ml) * lim } : m);
    }
    // An edge whose inset runs backwards has collapsed: drop it, corners are re-mitered
    const keep = lines.filter((L, i) => {
      const a = out[i];
      const b = out[(i + 1) % n];
      return (b.x - a.x) * L.dx + (b.y - a.y) * L.dy > 0.01;
    });
    if (keep.length === n) {
      if (Math.abs(area(out)) < 2 || Math.sign(area(out)) !== s || selfIntersects(out)) return null;
      return out;
    }
    lines = keep;
  }
  return null;
}

// Whether any two non-adjacent edges of the polygon cross
export function selfIntersects(p: Poly): boolean {
  const n = p.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersect(a, b, p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Drops vertices where the outline barely turns (keeps the per-edge data in step)
export function simplifyPoly<T>(p: Poly, data: T[], minTurn = 0.06, minLen = 2): { poly: Poly; data: T[] } {
  const poly = p.slice();
  const dat = data.slice();
  for (let changed = true; changed && poly.length > 3; ) {
    changed = false;
    for (let i = 0; i < poly.length && poly.length > 3; i++) {
      const n = poly.length;
      const a = poly[(i - 1 + n) % n];
      const b = poly[i];
      const c = poly[(i + 1) % n];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const cross = ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) / Math.max(1e-9, l1 * l2);
      const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / Math.max(1e-9, l1 * l2);
      if (l1 < minLen || (Math.abs(cross) < minTurn && dot > 0)) {
        // Vertex b goes: the edge before it takes over
        poly.splice(i, 1);
        dat.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return { poly, data: dat };
}

// Distance from (x, y) along direction (dx, dy) to the polygon's boundary (Infinity if none)
export function rayToPoly(p: Poly, x: number, y: number, dx: number, dy: number): number {
  let best = Infinity;
  const far = { x: x + dx * 1e5, y: y + dy * 1e5 };
  const o = { x, y };
  for (let i = 0; i < p.length; i++) {
    const r = segIntersect(o, far, p[i], p[(i + 1) % p.length]);
    if (r && r.t * 1e5 > 0.01) best = Math.min(best, r.t * 1e5);
  }
  return best;
}
