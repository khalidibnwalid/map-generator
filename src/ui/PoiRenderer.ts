import type { WorldData } from "../game/WorldData";
import type { Poi } from "../game/generators/generatePOIs";
import { CELL_METERS } from "../core/FieldNoise";
import type { MapTheme } from "../core/GPURenderer";
import { THEMES, viewRect } from "./themes";

// Points of interest: glyphs at regional zoom, real-size footprints up close.
export class PoiRenderer {
  public render(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    theme: MapTheme,
  ) {
    if (scale < 2.6 || world.pois.length === 0) return;
    const ct = THEMES[theme];
    const v = viewRect(width, height, scale, offsetX, offsetY);
    const W = world.width;
    const ppm = scale / CELL_METERS;
    const iconBase = 1 - Math.max(0, Math.min(1, (ppm - 0.025) / 0.02));
    const major = Math.min(1, (scale - 2.6) / 1.5);
    const minor = Math.max(0, Math.min(1, (scale - 6) / 2));
    const realA = Math.max(0, Math.min(1, (ppm - 0.012) / 0.012));
    const ink = ct.ink;
    const paper = theme === "Historical" ? "#efe2c2" : "#fbf7ee";

    ctx.save();
    for (const p of world.pois) {
      if (p.y < v.y0 - 0.2 || p.y > v.y1 + 0.2) continue;
      const k0 = Math.floor((v.x0 - 0.2 - p.x) / W);
      const k1 = Math.ceil((v.x1 + 0.2 - p.x) / W);
      for (let k = k0; k <= k1; k++) {
        const x = p.x + k * W;
        if (x < v.x0 - 0.2 || x > v.x1 + 0.2) continue;
        const sx = x * scale + offsetX;
        const sy = p.y * scale + offsetY;
        // Volcanoes are kilometres wide, so their relief shows from afar
        const rA = p.kind === "volcano" ? Math.max(0, Math.min(1, (ppm - 0.0012) / 0.0012)) : realA;
        if (rA > 0 && p.kind !== "port") {
          ctx.globalAlpha = rA;
          ctx.setTransform(ppm, 0, 0, ppm, sx, sy);
          ctx.rotate(p.angle);
          this.footprint(ctx, p, 1 / ppm, theme);
        }
        const isMajor = p.kind === "castle" || p.kind === "fort" || p.kind === "port" || p.kind === "volcano";
        const iconA = (p.kind === "volcano" ? 1 - Math.max(0, Math.min(1, (ppm - 0.002) / 0.002)) : iconBase) * (isMajor ? major : minor);
        if (iconA > 0.02) {
          ctx.globalAlpha = iconA * 0.9;
          ctx.setTransform(1, 0, 0, 1, sx, sy);
          this.glyph(ctx, p, ink, paper);
          if (scale > 14 && p.kind !== "bridge") {
            ctx.font = `italic 500 10px ${ct.font}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = ct.nationHalo;
            ctx.strokeText(p.name, 0, 9);
            ctx.fillStyle = ink;
            ctx.fillText(p.name, 0, 9);
          }
        }
      }
    }
    ctx.restore();
  }

  // Small filled silhouettes in a single ink colour with a paper halo, in the
  // style of printed atlas symbols. Drawn around (0, 0), roughly 10 px tall.
  private glyph(ctx: CanvasRenderingContext2D, p: Poi, ink: string, paper: string) {
    const shape = new Path2D();
    let strokeOnly = false;
    switch (p.kind) {
      case "castle":
        // Two towers and a curtain wall
        shape.rect(-5, -2, 10, 6);
        shape.rect(-6, -6, 3.2, 10);
        shape.rect(2.8, -6, 3.2, 10);
        shape.rect(-6, -7.2, 1, 1.4);
        shape.rect(-3.8, -7.2, 1, 1.4);
        shape.rect(2.8, -7.2, 1, 1.4);
        shape.rect(5, -7.2, 1, 1.4);
        break;
      case "fort":
        // Star fort
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? 5.5 : 3;
          const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
          if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        shape.closePath();
        break;
      case "watchtower":
        shape.moveTo(-2.2, 5);
        shape.lineTo(-1.5, -3);
        shape.lineTo(-3, -3);
        shape.lineTo(-3, -5.5);
        shape.lineTo(3, -5.5);
        shape.lineTo(3, -3);
        shape.lineTo(1.5, -3);
        shape.lineTo(2.2, 5);
        shape.closePath();
        break;
      case "ruins":
        // Broken colonnade
        shape.rect(-5.5, -2, 2, 7);
        shape.rect(-1, -5, 2, 10);
        shape.rect(3.5, 0, 2, 5);
        shape.rect(-6.5, 5, 13, 1.2);
        break;
      case "inn":
        shape.moveTo(-5, 4.5);
        shape.lineTo(-5, -0.5);
        shape.lineTo(0, -5);
        shape.lineTo(5, -0.5);
        shape.lineTo(5, 4.5);
        shape.closePath();
        break;
      case "bridge":
        shape.moveTo(-6, -3);
        shape.quadraticCurveTo(-3, 0, -6, 3);
        shape.moveTo(6, -3);
        shape.quadraticCurveTo(3, 0, 6, 3);
        strokeOnly = true;
        break;
      case "dam":
        shape.rect(-5.5, -1.5, 11, 3);
        break;
      case "mine":
        // Crossed hammers
        shape.moveTo(-4.5, -4.5);
        shape.lineTo(4.5, 4.5);
        shape.moveTo(4.5, -4.5);
        shape.lineTo(-4.5, 4.5);
        shape.moveTo(-6, -3);
        shape.lineTo(-3, -6);
        shape.moveTo(6, -3);
        shape.lineTo(3, -6);
        strokeOnly = true;
        break;
      case "monastery":
        // Domed lodge with a slim minaret
        shape.rect(-5, 0, 8, 4.5);
        shape.moveTo(2.6, 0);
        shape.arc(-1, 0, 3.6, 0, Math.PI, true);
        shape.rect(4.2, -5.5, 1.5, 10);
        break;
      case "volcano":
        // Cone with a crater notch
        shape.moveTo(-7, 5);
        shape.lineTo(-2, -4);
        shape.lineTo(-0.8, -2.8);
        shape.lineTo(0.8, -2.8);
        shape.lineTo(2, -4);
        shape.lineTo(7, 5);
        shape.closePath();
        break;
      case "port": {
        const ox = Math.cos(p.angle) * 11;
        const oy = Math.sin(p.angle) * 11;
        shape.moveTo(ox, oy - 5);
        shape.lineTo(ox, oy + 5);
        shape.moveTo(ox - 3.5, oy - 2.5);
        shape.lineTo(ox + 3.5, oy - 2.5);
        shape.moveTo(ox - 4.5, oy + 1.5);
        shape.quadraticCurveTo(ox, oy + 7.5, ox + 4.5, oy + 1.5);
        shape.moveTo(ox + 1.3, oy - 6.3);
        shape.arc(ox, oy - 6.3, 1.3, 0, Math.PI * 2);
        strokeOnly = true;
        break;
      }
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Halo first so the symbol stays legible on any terrain
    ctx.strokeStyle = paper;
    ctx.lineWidth = strokeOnly ? 3.6 : 3;
    ctx.globalAlpha *= 0.85;
    ctx.stroke(shape);
    ctx.globalAlpha /= 0.85;
    if (strokeOnly) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      ctx.stroke(shape);
    } else {
      ctx.fillStyle = ink;
      ctx.fill(shape, "nonzero");
    }
  }

  // Real-size footprint in meters (context already rotated to p.angle)
  private footprint(ctx: CanvasRenderingContext2D, p: Poi, px: number, theme: MapTheme) {
    const stone = theme === "Atlas" ? "#bdb6ab" : "#d9cfb6";
    const dark = theme === "Atlas" ? "#8d867b" : "#6f604c";
    const roof = theme === "Atlas" ? "#cfc6ba" : theme === "Historical" ? "#cdb08a" : "#a8553d";
    const lw = (m: number, minPx: number) => Math.max(m, minPx * px);
    const rect = (x: number, y: number, w: number, h: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.strokeStyle = dark;
      ctx.lineWidth = lw(0.8, 0.8);
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    };
    const tower = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = stone;
      ctx.fill();
      ctx.strokeStyle = dark;
      ctx.lineWidth = lw(1, 0.8);
      ctx.stroke();
    };
    switch (p.kind) {
      case "castle": {
        ctx.fillStyle = "#cbbf9f";
        ctx.fillRect(-40, -30, 80, 60);
        ctx.strokeStyle = dark;
        ctx.lineWidth = lw(7, 2);
        ctx.strokeRect(-40, -30, 80, 60);
        ctx.strokeStyle = stone;
        ctx.lineWidth = lw(4.5, 1.2);
        ctx.strokeRect(-40, -30, 80, 60);
        for (const [x, y] of [[-40, -30], [40, -30], [40, 30], [-40, 30]]) tower(x, y, 7);
        rect(-6, -4, 24, 20, "#8a8c8f");
        rect(18, 14, 18, 9, roof);
        tower(-6, -4, 5);
        break;
      }
      case "fort": {
        ctx.strokeStyle = "#7a5c3e";
        ctx.lineWidth = lw(2.5, 1.2);
        ctx.strokeRect(-24, -24, 48, 48);
        rect(0, -24, 10, 7, stone);
        rect(-10, 8, 16, 8, roof);
        rect(10, 8, 12, 8, roof);
        tower(16, -16, 4);
        break;
      }
      case "watchtower":
        ctx.beginPath();
        ctx.arc(0, 0, 13, 0, Math.PI * 2);
        ctx.strokeStyle = "#7a5c3e";
        ctx.lineWidth = lw(1.5, 1);
        ctx.stroke();
        tower(0, 0, 5);
        break;
      case "ruins": {
        ctx.strokeStyle = "#9b9488";
        ctx.lineCap = "round";
        ctx.lineWidth = lw(3, 1.2);
        const segs = [[-30, -22, 5, -22], [18, -22, 30, -22], [30, -22, 30, 4], [-30, -22, -30, -5], [-30, 14, -12, 22], [10, 22, 22, 22]];
        ctx.beginPath();
        for (const [a, b, c, d] of segs) {
          ctx.moveTo(a, b);
          ctx.lineTo(c, d);
        }
        ctx.stroke();
        ctx.fillStyle = "#a9a296";
        for (const [x, y, r] of [[-8, 4, 2.5], [6, -6, 2], [14, 10, 3], [-18, 0, 1.8]]) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "inn":
        ctx.fillStyle = "rgba(205,190,150,0.8)";
        ctx.fillRect(-16, -2, 34, 24);
        rect(-4, -10, 22, 11, roof);
        rect(12, 6, 10, 14, roof);
        break;
      case "bridge":
        ctx.fillStyle = dark;
        ctx.fillRect(-11, -45, 22, 90);
        ctx.fillStyle = stone;
        ctx.fillRect(-8, -45, 16, 90);
        ctx.fillStyle = dark;
        for (let y = -30; y <= 30; y += 15) ctx.fillRect(-12, y - 2, 24, 4);
        break;
      case "dam":
        ctx.fillStyle = dark;
        ctx.fillRect(-70, -9, 140, 18);
        ctx.fillStyle = stone;
        ctx.fillRect(-68, -6, 136, 12);
        ctx.fillStyle = "rgba(220,240,250,0.8)";
        ctx.fillRect(-12, 6, 24, 8);
        break;
      case "mine":
        ctx.fillStyle = "#8e877b";
        ctx.beginPath();
        ctx.ellipse(14, 10, 20, 11, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#2b2520";
        ctx.beginPath();
        ctx.arc(-6, -4, 4.5, 0, Math.PI * 2);
        ctx.fill();
        rect(-18, 8, 12, 9, roof);
        break;
      case "volcano": {
        // ~9 km cone with a ~700 m crater; lava runs on the sun-lit side
        const R = 4500;
        const g = ctx.createRadialGradient(-R * 0.25, -R * 0.25, R * 0.05, 0, 0, R);
        g.addColorStop(0, "rgba(120,105,95,0.95)");
        g.addColorStop(0.55, "rgba(95,80,70,0.75)");
        g.addColorStop(1, "rgba(80,70,60,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fill();
        // Radial ridges
        ctx.strokeStyle = "rgba(50,40,35,0.35)";
        ctx.lineWidth = lw(60, 0.8);
        ctx.beginPath();
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2 + Math.sin(i * 7.3) * 0.12;
          ctx.moveTo(Math.cos(a) * 500, Math.sin(a) * 500);
          ctx.lineTo(Math.cos(a) * R * (0.7 + 0.25 * Math.abs(Math.sin(i * 3.1))), Math.sin(a) * R * (0.7 + 0.25 * Math.abs(Math.sin(i * 3.1))));
        }
        ctx.stroke();
        ctx.strokeStyle = "rgba(230,90,30,0.85)";
        ctx.lineWidth = lw(90, 1.2);
        ctx.beginPath();
        ctx.moveTo(250, 200);
        ctx.quadraticCurveTo(1200, 900, 2100, 2300);
        ctx.moveTo(-200, 300);
        ctx.quadraticCurveTo(-600, 1500, -300, 2600);
        ctx.stroke();
        ctx.fillStyle = "#2a201b";
        ctx.beginPath();
        ctx.arc(0, 0, 380, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,120,40,0.9)";
        ctx.beginPath();
        ctx.arc(30, 20, 160, 0, Math.PI * 2);
        ctx.fill();
        // Ash plume drifting east
        ctx.fillStyle = "rgba(235,235,235,0.35)";
        for (let i = 1; i <= 5; i++) {
          ctx.beginPath();
          ctx.arc(i * 700, -i * 250, 300 + i * 160, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "monastery":
        ctx.fillStyle = "rgba(220,210,180,0.85)";
        ctx.fillRect(-26, -22, 52, 44);
        rect(0, -6, 26, 22, stone);
        ctx.beginPath();
        ctx.arc(0, -6, 8, 0, Math.PI * 2);
        ctx.fillStyle = "#79a6b6";
        ctx.fill();
        ctx.stroke();
        tower(16, -16, 2.6);
        rect(-14, 14, 20, 8, roof);
        break;
    }
  }
}
