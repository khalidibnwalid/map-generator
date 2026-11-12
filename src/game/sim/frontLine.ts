import type { WorldData } from "../WorldData";
import { relation } from "../politics";

// A front line drawn on the map (see Simulation.commandFront): a polyline in
// world cells, unwrapped (x may run past the map's edge where it wraps).

export type LinePoint = { x: number; y: number };
// A point on the line with its unit normal (left of the direction drawn)
export type LineSample = { x: number; y: number; nx: number; ny: number };

export function lineLength(line: LinePoint[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) len += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  return len;
}

// Evenly spaced points along the line, about one every `spacing` cells and at
// most `max`, each in the middle of an equal stretch of the line. A line too
// short to have a direction gives one point with a zero normal.
export function sampleLine(line: LinePoint[], spacing: number, max: number): LineSample[] {
  if (!line.length) return [];
  const len = lineLength(line);
  if (len < 1e-6) return [{ x: line[0].x, y: line[0].y, nx: 0, ny: 0 }];
  const k = Math.max(1, Math.min(max, Math.round(len / Math.max(1e-6, spacing))));
  const out: LineSample[] = [];
  let seg = 1;
  let segStart = 0; // distance along the line where segment `seg` starts
  for (let s = 0; s < k; s++) {
    const at = ((s + 0.5) / k) * len;
    for (;;) {
      const a = line[seg - 1];
      const b = line[seg];
      const sl = Math.hypot(b.x - a.x, b.y - a.y);
      if (segStart + sl >= at || seg === line.length - 1) {
        const t = sl > 0 ? Math.min(1, (at - segStart) / sl) : 0;
        const tx = sl > 0 ? (b.x - a.x) / sl : 0;
        const ty = sl > 0 ? (b.y - a.y) / sl : 0;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: -ty, ny: tx });
        break;
      }
      segStart += sl;
      seg++;
    }
  }
  return out;
}

// Ramer-Douglas-Peucker: drops points closer than `tol` to the simplified line
export function simplifyLine(line: LinePoint[], tol: number): LinePoint[] {
  if (line.length <= 2) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = line[i0];
    const b = line[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    let worst = -1;
    let wd = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const p = line[i];
      const d = l > 0 ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l : Math.hypot(p.x - a.x, p.y - a.y);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i0, worst], [worst, i1]);
  }
  return line.filter((_p, i) => keep[i]);
}

// Points along a front line drawn on a map `W` cells wide: one every ~12
// cells (scaled to the map, at most 8), and how near (in cells) a realm's
// land must be to a point for that point to strike it
export function frontSamples(line: LinePoint[], W: number): { samples: LineSample[]; near: number } {
  const rs = W / 800;
  return { samples: sampleLine(line, Math.max(4, 12 * rs), 8), near: Math.max(4, Math.round(8 * rs)) };
}

// Land cells within r of (x, y) (x may be unwrapped), counted by owner
export function landNear(w: WorldData, x: number, y: number, r: number, out: Map<number, number>) {
  const W = w.width;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  for (let dy = -r; dy <= r; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= w.height) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const c = w.grid[(((cx + dx) % W) + W) % W][yy];
      if (c.isWater) continue;
      const o = c.nationIndex ?? -1;
      if (o >= 0) out.set(o, (out.get(o) ?? 0) + 1);
    }
  }
}

// The realm a front line drawn for `attacker` strikes: the one with the most
// land near the line, preferring realms already at war with it. -1 when the
// line runs only over the sea or the attacker's own land.
export function lineTarget(w: WorldData, attacker: number, line: LinePoint[]): number {
  const { samples, near } = frontSamples(line, w.width);
  const count = new Map<number, number>();
  for (const s of samples) landNear(w, s.x, s.y, near, count);
  count.delete(attacker);
  let best = -1;
  let bestScore = 0;
  for (const [o, n] of count) {
    if (!w.nations[o]) continue;
    const score = n + (relation(w, attacker, o) === "War" ? 1e7 : 0);
    if (score > bestScore || (score === bestScore && o < best)) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}
