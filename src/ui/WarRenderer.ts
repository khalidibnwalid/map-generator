import type { Battle, FrontLine, Offensive } from "../game/sim/Simulation";
import type { WorldMark } from "../game/sim/worldLife";

// Wars overlay: dashed frontiers of active wars, this year's offensive
// arrows and crossed-swords markers for recent battles that fade with age.

const RED = "#b8322a";
const BRASS = "#d4a85a";
const INK = "rgba(28, 14, 8, 0.7)";
export const BATTLE_FADE_YEARS = 8;
// At most this many marks per country (as winner or loser), newest first
export const BATTLE_MARKS_PER_NATION = 8;

// The copies k of the wrapping world (drawn shifted by k map widths) in which
// something spanning x = minX..maxX (cells, may be unwrapped) shows on a
// screen `width` pixels wide. The view's offset is never wrapped, so after a
// long pan the visible copy can be any k, not just -1..1.
export function copiesInView(minX: number, maxX: number, worldW: number, scale: number, offX: number, width: number, pad = 40): number[] {
  const span = worldW * scale;
  if (!(span > 0)) return [];
  const k0 = Math.ceil((-pad - offX - maxX * scale) / span);
  const k1 = Math.floor((width + pad - offX - minX * scale) / span);
  const out: number[] = [];
  for (let k = k0; k <= k1 && out.length < 64; k++) out.push(k);
  return out;
}

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
  const shown = new Map<string, number>();
  for (let k = battles.length - 1; k >= 0; k--) {
    const b = battles[k];
    const age = year - b.year;
    if (age < 0) continue;
    if (age > BATTLE_FADE_YEARS) break; // oldest first: the rest are older still
    const rank = Math.max(shown.get(b.winner) ?? 0, shown.get(b.loser) ?? 0);
    if (rank >= BATTLE_MARKS_PER_NATION) continue;
    shown.set(b.winner, (shown.get(b.winner) ?? 0) + 1);
    shown.set(b.loser, (shown.get(b.loser) ?? 0) + 1);
    const alpha = Math.pow(1 - age / (BATTLE_FADE_YEARS + 1), 1.4) * (1 - (rank / BATTLE_MARKS_PER_NATION) * 0.7);
    const r = Math.min(15, 4 + Math.sqrt(b.size) * 0.7) * zoom;
    for (const copy of copiesInView(b.x, b.x, worldW, scale, offX, width, 20)) {
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
  // Front chains may run past the seam (unwrapped): allow half a map either side
  for (const copy of copiesInView(-worldW * 0.5, worldW * 1.5, worldW, scale, offX, width, 0)) {
    const ox = offX + copy * span;
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
    for (const copy of copiesInView(Math.min(o.x0, o.x1), Math.max(o.x0, o.x1), worldW, scale, offX, width, 30)) {
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

// A front line being drawn for an attack (see Interface's "Attack line"): the
// line in the army's colour, dashed while drawing, with arrows where its
// prongs will push (x may be unwrapped)
export function drawAttackLine(
  ctx: CanvasRenderingContext2D,
  line: { x: number; y: number }[],
  arrows: { x: number; y: number; dx: number; dy: number }[],
  color: string,
  dashed: boolean,
  alpha: number,
  worldW: number,
  width: number,
  scale: number,
  offX: number,
  offY: number,
) {
  if (!line.length) return;
  const lw = Math.max(3, Math.min(6, scale * 0.9));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const span = worldW * scale;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of line) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
  }
  for (const copy of copiesInView(minX, maxX, worldW, scale, offX, width)) {
    const ox = offX + copy * span;
    const xs = line.map((p) => p.x * scale + ox);
    const path = new Path2D();
    path.moveTo(xs[0], line[0].y * scale + offY);
    for (let k = 1; k < line.length; k++) path.lineTo(xs[k], line[k].y * scale + offY);
    ctx.setLineDash([]);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lw + 3;
    ctx.stroke(path);
    ctx.setLineDash(dashed ? [lw * 2.4, lw * 1.6] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke(path);
    ctx.setLineDash([]);
    // Arrowheads just past the line, pointing the way the army pushes
    const head = Math.max(9, Math.min(16, lw * 2.6));
    for (const a of arrows) {
      const bx = a.x * scale + ox + a.dx * lw * 1.2;
      const by = a.y * scale + offY + a.dy * lw * 1.2;
      const tx = bx + a.dx * head;
      const ty = by + a.dy * head;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(bx - a.dy * head * 0.6, by + a.dx * head * 0.6);
      ctx.lineTo(bx + a.dy * head * 0.6, by - a.dx * head * 0.6);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = INK;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Plague, famine and migrations on the map (0.3+ history): a calamity is a
// dashed ring over the land it struck with its sign, fading over the years;
// a migration is its route in its people's color, an arrow at its head
// (dashed while under way).
const MARK_FADE = 12;
const PLAGUE = "#5f7d2e";
const FAMINE = "#b07a1e";
export function drawWorldMarks(
  ctx: CanvasRenderingContext2D,
  marks: WorldMark[],
  year: number,
  worldW: number,
  width: number,
  scale: number,
  offX: number,
  offY: number,
  font: string,
) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const m of marks) {
    const age = Math.max(0, year - m.year);
    const alpha = m.active ? 1 : Math.max(0, 1 - age / MARK_FADE);
    if (alpha <= 0.02) continue;
    ctx.globalAlpha = alpha;
    if (m.kind === "migration" && m.path && m.path.length > 1) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const p of m.path) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
      }
      const color = m.color ?? "#c9a24a";
      const lw = Math.max(2.5, Math.min(6, scale * 0.8));
      for (const k of copiesInView(minX, maxX, worldW, scale, offX, width)) {
        const ox = offX + k * worldW * scale;
        const pts = m.path.map((p) => [p.x * scale + ox, p.y * scale + offY]);
        const path = new Path2D();
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          path.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const [hx, hy] = pts[pts.length - 1];
        path.lineTo(hx, hy);
        ctx.setLineDash([]);
        ctx.strokeStyle = INK;
        ctx.lineWidth = lw + 3;
        ctx.stroke(path);
        ctx.setLineDash(m.active ? [lw * 2.2, lw * 1.4] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.stroke(path);
        ctx.setLineDash([]);
        // Arrowhead along the last stretch
        const [px, py] = pts[Math.max(0, pts.length - 3)];
        const a = Math.atan2(hy - py, hx - px);
        const head = Math.max(10, lw * 3);
        ctx.beginPath();
        ctx.moveTo(hx + Math.cos(a) * head * 0.6, hy + Math.sin(a) * head * 0.6);
        ctx.lineTo(hx + Math.cos(a + 2.5) * head, hy + Math.sin(a + 2.5) * head);
        ctx.lineTo(hx + Math.cos(a - 2.5) * head, hy + Math.sin(a - 2.5) * head);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = INK;
        ctx.stroke();
        label(ctx, m.name, hx, hy - head - 4, font);
      }
      continue;
    }
    const color = m.kind === "plague" ? PLAGUE : FAMINE;
    for (const k of copiesInView(m.x - m.r, m.x + m.r, worldW, scale, offX, width)) {
      const sx = (m.x + k * worldW) * scale + offX;
      const sy = m.y * scale + offY;
      const r = Math.max(16, m.r * scale);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === "plague" ? "rgba(95,125,46,0.13)" : "rgba(176,122,30,0.13)";
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      sign(ctx, m.kind, sx, sy, color);
      if (scale > 1.6) label(ctx, `${m.name} · ${m.year}`, sx, sy - 19, font);
    }
  }
  ctx.restore();
}

// The sign of a calamity in a disc: pox marks for plague, an ear of grain for famine
function sign(ctx: CanvasRenderingContext2D, kind: "plague" | "famine" | "migration", x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = "#f6ecd2";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (kind === "plague") {
    for (const [dx, dy, r] of [[-3.2, -2.5, 2.2], [3, -1.8, 1.8], [0, 3.2, 2.4], [-3.5, 3.5, 1.1], [3.8, 3.8, 1.2]]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y + 7);
    ctx.lineTo(x, y - 6);
    ctx.stroke();
    for (let k = 0; k < 3; k++) {
      const gy = y - 4 + k * 3.4;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(x + s * 2.4, gy, 2.1, 1.1, s * -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string) {
  ctx.font = `italic 600 12px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(246, 236, 214, 0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#2a1d12";
  ctx.fillText(text, x, y);
}
