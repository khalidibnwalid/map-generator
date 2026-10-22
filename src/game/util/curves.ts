import type { Point } from "../WorldData";

// River/road curves are drawn as a quadratic B-spline through their control
// points (moveTo P0, quadraticCurveTo(Pi, mid(Pi, Pi+1)) ..., lineTo Pn).
// This samples exactly that curve so generated geometry matches the drawing.
export function sampleCurve(
  pts: Point[],
  vals: number[],
  step: number,
  visit: (x: number, y: number, v: number) => void,
) {
  const n = pts.length;
  if (n === 0) return;
  if (n < 3) {
    for (let i = 0; i < n - 1; i++) segment(pts[i], pts[i + 1], vals[i], vals[i + 1], step, visit, i === 0);
    if (n === 1) visit(pts[0].x, pts[0].y, vals[0]);
    return;
  }
  let sx = pts[0].x;
  let sy = pts[0].y;
  let sv = vals[0];
  visit(sx, sy, sv);
  for (let i = 1; i < n - 1; i++) {
    const c = pts[i];
    const ex = (c.x + pts[i + 1].x) / 2;
    const ey = (c.y + pts[i + 1].y) / 2;
    const ev = (vals[i] + vals[i + 1]) / 2;
    const len = Math.hypot(c.x - sx, c.y - sy) + Math.hypot(ex - c.x, ey - c.y);
    const k = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= k; s++) {
      const t = s / k;
      const u = 1 - t;
      visit(
        u * u * sx + 2 * u * t * c.x + t * t * ex,
        u * u * sy + 2 * u * t * c.y + t * t * ey,
        u * u * sv + 2 * u * t * vals[i] + t * t * ev,
      );
    }
    sx = ex;
    sy = ey;
    sv = ev;
  }
  segment({ x: sx, y: sy }, pts[n - 1], sv, vals[n - 1], step, visit, false);
}

function segment(
  a: Point,
  b: Point,
  va: number,
  vb: number,
  step: number,
  visit: (x: number, y: number, v: number) => void,
  includeStart: boolean,
) {
  const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  for (let s = includeStart ? 0 : 1; s <= k; s++) {
    const t = s / k;
    visit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, va + (vb - va) * t);
  }
}

export function traceCurve(ctx: CanvasRenderingContext2D | Path2D, pts: Point[], tx: (p: Point) => Point) {
  const n = pts.length;
  if (n === 0) return;
  const p0 = tx(pts[0]);
  ctx.moveTo(p0.x, p0.y);
  if (n < 3) {
    for (let i = 1; i < n; i++) {
      const p = tx(pts[i]);
      ctx.lineTo(p.x, p.y);
    }
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const c = tx(pts[i]);
    const nx = tx(pts[i + 1]);
    ctx.quadraticCurveTo(c.x, c.y, (c.x + nx.x) / 2, (c.y + nx.y) / 2);
  }
  const last = tx(pts[n - 1]);
  ctx.lineTo(last.x, last.y);
}
