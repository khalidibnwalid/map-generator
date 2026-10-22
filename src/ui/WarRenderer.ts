import type { Battle, FrontLine, Offensive } from "../game/sim/Simulation";

// Wars overlay: dashed frontiers of active wars, this year's offensive
// arrows and crossed-swords markers for recent battles that fade with age.

const RED = "#b8322a";
const BRASS = "#d4a85a";
const INK = "rgba(28, 14, 8, 0.7)";
export const BATTLE_FADE_YEARS = 25;

// Crossed swords centered on (x, y), r = half the blade length in pixels
export function drawSwords(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  for (const s of [-1, 1]) {
    // Blade from the lower corner to the upper opposite corner
    const bx = x - s * r;
    const by = y + r;
    const tx = x + s * r;
    const ty = y - r;
    const gx = bx + (tx - bx) * 0.28; // crossguard position
    const gy = by + (ty - by) * 0.28;
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? "#f3e6c8" : INK;
      ctx.lineWidth = pass ? Math.max(1.4, r * 0.2) : Math.max(3, r * 0.42);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.strokeStyle = pass ? BRASS : INK;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(gx, gy);
      ctx.stroke();
      // Crossguard, perpendicular to the blade
      const k = r * 0.32;
      ctx.beginPath();
      ctx.moveTo(gx - k, gy - s * k);
      ctx.lineTo(gx + k, gy + s * k);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawBattles(
  ctx: CanvasRenderingContext2D,
  battles: Battle[],
  year: number,
  worldW: number,
  width: number,
  height: number,
  scale: number,
  offX: number,
  offY: number,
) {
  const zoom = Math.max(0.75, Math.min(1.6, scale / 3));
  for (const b of battles) {
    const age = year - b.year;
    if (age < 0 || age > BATTLE_FADE_YEARS) continue;
    const alpha = Math.pow(1 - age / (BATTLE_FADE_YEARS + 1), 1.4);
    const r = Math.min(15, 4 + Math.sqrt(b.size) * 0.7) * zoom;
    for (let copy = -1; copy <= 1; copy++) {
      const sx = (b.x + copy * worldW) * scale + offX;
      const sy = b.y * scale + offY;
      if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;
      drawSwords(ctx, sx, sy, r, alpha);
    }
  }
}

export function drawFronts(
  ctx: CanvasRenderingContext2D,
  fronts: FrontLine[],
  offensives: Offensive[],
  worldW: number,
  width: number,
  scale: number,
  offX: number,
  offY: number,
) {
  const lw = Math.max(1.6, Math.min(3.5, scale * 0.6));
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  const span = worldW * scale;
  for (let copy = -1; copy <= 1; copy++) {
    const ox = offX + copy * span;
    if (ox > width || ox + span * 1.5 < 0) continue;
    const path = new Path2D();
    for (const f of fronts)
      for (const c of f.chains) {
        path.moveTo(c[0] * scale + ox, c[1] * scale + offY);
        for (let k = 2; k < c.length; k += 2) path.lineTo(c[k] * scale + ox, c[k + 1] * scale + offY);
      }
    // Dark casing, brass core, red dashes over it
    ctx.setLineDash([]);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw + 2.5;
    ctx.stroke(path);
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = lw;
    ctx.stroke(path);
    ctx.setLineDash([lw * 3, lw * 2.2]);
    ctx.strokeStyle = RED;
    ctx.stroke(path);
  }
  ctx.setLineDash([]);

  // Offensive arrows
  for (const o of offensives) {
    for (let copy = -1; copy <= 1; copy++) {
      const x0 = (o.x0 + copy * worldW) * scale + offX;
      const y0 = o.y0 * scale + offY;
      const x1 = (o.x1 + copy * worldW) * scale + offX;
      const y1 = o.y1 * scale + offY;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 12) continue;
      if (Math.max(x0, x1) < -30 || Math.min(x0, x1) > width + 30) continue;
      const ux = (x1 - x0) / len;
      const uy = (y1 - y0) / len;
      const head = Math.min(14, 5 + len * 0.25);
      const w = Math.max(2, Math.min(5, Math.sqrt(o.size) * 0.4));
      const hx = x1 - ux * head;
      const hy = y1 - uy * head;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = INK;
      ctx.lineWidth = w + 2.5;
      ctx.stroke();
      ctx.strokeStyle = RED;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(hx - uy * head * 0.6, hy + ux * head * 0.6);
      ctx.lineTo(hx + uy * head * 0.6, hy - ux * head * 0.6);
      ctx.closePath();
      ctx.fillStyle = RED;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = INK;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
