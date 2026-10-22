import type { Point, River, Road, WorldData } from "../game/WorldData";
import { CELL_METERS } from "../core/FieldNoise";
import type { CanvasTheme } from "./themes";
import { viewRect } from "./themes";

type Box = [number, number, number, number];
const boxes = new WeakMap<object, Box>();
function boxOf(o: { points: Point[] }): Box {
  let b = boxes.get(o);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of o.points) {
      b[0] = Math.min(b[0], p.x);
      b[1] = Math.min(b[1], p.y);
      b[2] = Math.max(b[2], p.x);
      b[3] = Math.max(b[3], p.y);
    }
    boxes.set(o, b);
  }
  return b;
}

// Iterates the world copies (horizontal wrap) in which `b` intersects the view.
function copies(b: Box, W: number, v: ReturnType<typeof viewRect>, pad: number, fn: (dx: number) => void) {
  if (b[3] < v.y0 - pad || b[1] > v.y1 + pad) return;
  const k0 = Math.floor((v.x0 - pad - b[2]) / W);
  const k1 = Math.ceil((v.x1 + pad - b[0]) / W);
  for (let k = k0; k <= k1; k++) {
    if (b[2] + k * W < v.x0 - pad || b[0] + k * W > v.x1 + pad) continue;
    fn(k * W);
  }
}

// Draws pieces [from, to) of the quadratic B-spline used for curves.
function tracePieces(
  ctx: CanvasRenderingContext2D,
  P: Point[],
  from: number,
  to: number,
  tx: (x: number, y: number) => [number, number],
) {
  const n = P.length;
  if (n < 3) {
    const [x0, y0] = tx(P[0].x, P[0].y);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < n; i++) {
      const [x, y] = tx(P[i].x, P[i].y);
      ctx.lineTo(x, y);
    }
    return;
  }
  const start = from <= 1 ? P[0] : { x: (P[from - 1].x + P[from].x) / 2, y: (P[from - 1].y + P[from].y) / 2 };
  const [sx, sy] = tx(start.x, start.y);
  ctx.moveTo(sx, sy);
  for (let i = Math.max(1, from); i < Math.min(to, n - 1); i++) {
    const [cx, cy] = tx(P[i].x, P[i].y);
    const [ex, ey] = tx((P[i].x + P[i + 1].x) / 2, (P[i].y + P[i + 1].y) / 2);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
  }
  if (to >= n - 1) {
    const [lx, ly] = tx(P[n - 1].x, P[n - 1].y);
    ctx.lineTo(lx, ly);
  }
}

export class NetworkRenderer {
  public renderRivers(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    theme: CanvasTheme,
  ) {
    const v = viewRect(width, height, scale, offsetX, offsetY);
    const ppm = scale / CELL_METERS;
    // Smaller rivers appear as you zoom in
    const minFlow = scale < 1.2 ? 6 : scale < 2.5 ? 2.5 : scale < 5 ? 1.3 : 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = theme.river;
    const CHUNK = 6;
    for (const r of world.rivers) {
      if (r.flow < minFlow) continue;
      const fade = minFlow > 0 ? Math.min(1, (r.flow - minFlow) / minFlow + 0.35) : 1;
      copies(boxOf(r), world.width, v, 1, (dx) => {
        const tx = (x: number, y: number): [number, number] => [
          (x + dx) * scale + offsetX,
          y * scale + offsetY,
        ];
        ctx.globalAlpha = fade;
        for (let i = 0; i < r.points.length - 1; i += CHUNK) {
          const mid = Math.min(r.points.length - 1, i + (CHUNK >> 1));
          const wm = r.widths[mid];
          const minPx = theme.riverMinPx * Math.min(2.6, 0.55 + 0.3 * Math.log2(1 + r.flow));
          ctx.lineWidth = Math.max(minPx * Math.min(1, 0.4 + 0.12 * scale), wm * ppm);
          ctx.beginPath();
          tracePieces(ctx, r.points, i, i + CHUNK + 1, tx);
          ctx.stroke();
        }
      });
    }
    ctx.restore();
  }

  public renderRiverLabels(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    theme: CanvasTheme,
  ) {
    if (scale < 2 || scale > 400) return;
    const v = viewRect(width, height, scale, offsetX, offsetY);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `italic 500 ${Math.round(Math.min(15, 10 + scale * 0.3))}px ${theme.font}`;
    ctx.fillStyle = theme.river;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const r of world.rivers as River[]) {
      if (!r.name || r.flow < (scale < 4 ? 12 : 6) || r.points.length < 12) continue;
      copies(boxOf(r), world.width, v, 0, (dx) => {
        const i = Math.floor(r.points.length * 0.45);
        const a = r.points[i];
        const b = r.points[i + 4];
        const sx = (a.x + dx) * scale + offsetX;
        const sy = a.y * scale + offsetY;
        if (sx < 0 || sx > width || sy < 0 || sy > height) return;
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(ang);
        const off = -8 - (r.widths[i] * scale) / CELL_METERS / 2;
        ctx.strokeText(r.name, 0, off);
        ctx.fillText(r.name, 0, off);
        ctx.restore();
      });
    }
    ctx.restore();
  }

  public renderRoads(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    theme: CanvasTheme,
  ) {
    const v = viewRect(width, height, scale, offsetX, offsetY);
    const ppm = scale / CELL_METERS;
    const minTier = scale < 1.5 ? 2 : scale < 3 ? 1 : 0;
    const widthM = [5, 8, 12];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const byTier: Road[][] = [[], [], []];
    for (const r of world.worldRoads) if (r.tier >= minTier) byTier[r.tier].push(r);

    for (let pass = 0; pass < 2; pass++) {
      for (let tier = 0; tier < 3; tier++) {
        const roads = byTier[tier];
        if (roads.length === 0) continue;
        const basePx = (0.5 + tier * 0.3) * Math.min(2.2, 0.6 + Math.pow(scale, 0.45) * 0.25);
        const fillW = Math.max(basePx, widthM[tier] * ppm);
        if (pass === 0) {
          if (theme.roadDash) continue;
          ctx.strokeStyle = theme.roadCasing[tier];
          ctx.lineWidth = fillW + Math.max(0.8, fillW * 0.35);
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = theme.roadFill[tier];
          ctx.lineWidth = fillW;
          ctx.setLineDash(theme.roadDash ? theme.roadDash.map((d) => d * Math.max(1, fillW)) : []);
        }
        ctx.beginPath();
        for (const r of roads) {
          copies(boxOf(r), world.width, v, 0.5, (dx) =>
            tracePieces(ctx, r.points, 0, r.points.length, (x, y) => [
              (x + dx) * scale + offsetX,
              y * scale + offsetY,
            ]),
          );
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
