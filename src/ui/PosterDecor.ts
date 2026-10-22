import type { MapTheme, ThematicMode } from "../core/GPURenderer";
import { CELL_KM, CELL_KM2, type WorldData } from "../game/WorldData";
import { nationFlag } from "../game/flags";
import { RELATION_COLORS } from "../game/generators/generateDiplomacy";
import { compact, type Extent, type MapView } from "./AtlasRender";

// Poster composition. Everything here is in layout pixels: the long edge is
// always LAYOUT_LONG_EDGE, and the device size only changes the pixel ratio.

export const LAYOUT_LONG_EDGE = 1920;
const MAX_CANVAS_EDGE = 16384;
const MAX_CANVAS_AREA = 120e6;

export interface PosterSpec {
  extent: Extent; // world cells shown
  longEdge: number; // device pixels
  keep: Set<number> | null; // nations in focus (others dimmed), null = whole world
  legendNations: number[]; // nations for the legend and flags row, in order
  title: string | null;
  subtitle: string;
  compass: boolean;
  scaleBar: boolean;
  legend: boolean;
  frame: boolean;
  flags: boolean;
  theme: MapTheme;
  thematic: ThematicMode;
  imprint: string; // small print in the bottom margin
}

type Box = { x: number; y: number; w: number; h: number };

export interface PosterLayout {
  W: number; // device pixels
  H: number;
  pr: number; // device pixels per layout pixel
  map: Box; // layout pixels
  band: Box | null; // flags row
  margin: number;
}

interface Style {
  paper: string;
  edge: string; // aged / shaded paper edge
  ink: string;
  muted: string;
  accent: string;
  panel: string;
  line: string;
  title: string; // font families
  body: string;
  caps: boolean; // uppercase, letter-spaced titles
  margin: number;
}

const STYLES: Record<MapTheme, Style> = {
  Historical: {
    paper: "#eadcb8",
    edge: "rgba(120, 80, 35, 0.28)",
    ink: "#3b2a1c",
    muted: "#6e5538",
    accent: "#8b2f1f",
    panel: "rgba(243, 233, 208, 0.95)",
    line: "#3b2a1c",
    title: "'IM Fell English', 'Cormorant Garamond', Georgia, serif",
    body: "'IM Fell English', Georgia, serif",
    caps: false,
    margin: 64,
  },
  Atlas: {
    paper: "#ffffff",
    edge: "rgba(0, 0, 0, 0)",
    ink: "#26303a",
    muted: "#6a7682",
    accent: "#2f6fa3",
    panel: "rgba(255, 255, 255, 0.93)",
    line: "#26303a",
    title: "Inter, 'Segoe UI', system-ui, sans-serif",
    body: "Inter, 'Segoe UI', system-ui, sans-serif",
    caps: true,
    margin: 40,
  },
  Realistic: {
    paper: "#11151b",
    edge: "rgba(0, 0, 0, 0.35)",
    ink: "#efe4cc",
    muted: "#b9a17c",
    accent: "#d4a85a",
    panel: "rgba(16, 19, 24, 0.84)",
    line: "#d4a85a",
    title: "'Cormorant Garamond', Georgia, serif",
    body: "Inter, system-ui, sans-serif",
    caps: false,
    margin: 44,
  },
};

// Web fonts must be loaded before canvas text uses them
export async function loadPosterFonts() {
  const faces = ["700 48px 'Cormorant Garamond'", "48px 'IM Fell English'", "italic 24px 'IM Fell English'", "600 16px Inter", "400 16px Inter"];
  try {
    await Promise.all(faces.map((f) => document.fonts.load(f)));
  } catch {
    // fall back to the next family in each stack
  }
}

export function posterLayout(spec: PosterSpec): PosterLayout {
  const st = STYLES[spec.theme];
  const m = spec.frame ? st.margin : 0;
  const band = spec.flags && spec.legendNations.length ? 104 : 0;
  const ew = spec.extent.x1 - spec.extent.x0;
  const eh = spec.extent.y1 - spec.extent.y0;
  const a = ew / eh;
  // Fit map + band + margins so the long edge is LAYOUT_LONG_EDGE
  let cw = LAYOUT_LONG_EDGE - 2 * m;
  let ch = cw / a + band;
  if (ch + 2 * m > LAYOUT_LONG_EDGE) {
    ch = LAYOUT_LONG_EDGE - 2 * m;
    cw = (ch - band) * a;
  }
  const PW = cw + 2 * m;
  const PH = ch + 2 * m;
  let pr = spec.longEdge / Math.max(PW, PH);
  // Browsers refuse canvases past these limits
  pr = Math.min(pr, MAX_CANVAS_EDGE / Math.max(PW, PH), Math.sqrt(MAX_CANVAS_AREA / (PW * PH)));
  return {
    W: Math.round(PW * pr),
    H: Math.round(PH * pr),
    pr,
    map: { x: m, y: m, w: cw, h: ch - band },
    band: band ? { x: m, y: m + ch - band, w: cw, h: band } : null,
    margin: m,
  };
}

// The device-pixel map view for a layout
export function posterView(L: PosterLayout, spec: PosterSpec): MapView {
  const x = Math.round(L.map.x * L.pr);
  const y = Math.round(L.map.y * L.pr);
  const w = Math.round(L.map.w * L.pr);
  const h = Math.round(L.map.h * L.pr);
  const scale = w / (spec.extent.x1 - spec.extent.x0);
  return { x, y, w, h, scale, offsetX: -spec.extent.x0 * scale, offsetY: -spec.extent.y0 * scale, pixelRatio: L.pr, keep: spec.keep };
}

export function paintBackground(ctx: CanvasRenderingContext2D, L: PosterLayout, spec: PosterSpec) {
  const st = STYLES[spec.theme];
  ctx.setTransform(L.pr, 0, 0, L.pr, 0, 0);
  const PW = L.W / L.pr;
  const PH = L.H / L.pr;
  ctx.fillStyle = st.paper;
  ctx.fillRect(0, 0, PW, PH);
  if (spec.frame) {
    // Aged edges
    const g = ctx.createRadialGradient(PW / 2, PH / 2, Math.min(PW, PH) * 0.35, PW / 2, PH / 2, Math.hypot(PW, PH) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, st.edge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, PW, PH);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function paintDecorations(ctx: CanvasRenderingContext2D, L: PosterLayout, spec: PosterSpec, world: WorldData, landArea: number[]) {
  const st = STYLES[spec.theme];
  ctx.save();
  ctx.setTransform(L.pr, 0, 0, L.pr, 0, 0);
  const map = L.map;
  const inset = 24;
  if (L.band) paintFlagsRow(ctx, st, L.band, spec, world, L.pr);
  if (spec.frame) paintFrame(ctx, st, spec.theme, L);
  if (spec.title) paintCartouche(ctx, st, spec.theme, map, map.x + inset, map.y + inset, spec.title, spec.subtitle);
  if (spec.compass) paintCompass(ctx, st, spec.theme, map.x + map.w - inset - 64, map.y + inset + 78, 64);
  if (spec.scaleBar) {
    const cellPx = map.w / (spec.extent.x1 - spec.extent.x0); // layout px per cell
    paintScaleBar(ctx, st, spec.theme, map.x + inset, map.y + map.h - inset, CELL_KM / cellPx);
  }
  if (spec.legend) paintLegend(ctx, st, spec, world, landArea, map.x + map.w - inset, map.y + map.h - inset, L.pr);
  if (spec.frame && spec.imprint) {
    ctx.font = `12px ${st.body}`;
    ctx.fillStyle = st.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const bottom = (L.band ? L.band.y + L.band.h : map.y + map.h) + L.margin / 2 + (spec.theme === "Historical" ? 8 : 0);
    ctx.fillText(spec.imprint, map.x + map.w, Math.min(bottom, L.H / L.pr - 10));
  }
  ctx.restore();
}

// --- Frame ---

function paintFrame(ctx: CanvasRenderingContext2D, st: Style, theme: MapTheme, L: PosterLayout) {
  const c = { ...L.map };
  if (L.band) c.h = L.band.y + L.band.h - c.y;
  const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
  const stroke = (b: Box, lw: number, color = st.line) => {
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  };
  ctx.save();
  if (L.band) {
    ctx.beginPath();
    ctx.moveTo(L.band.x, L.band.y);
    ctx.lineTo(L.band.x + L.band.w, L.band.y);
    ctx.lineWidth = theme === "Historical" ? 1.5 : 1;
    ctx.strokeStyle = st.line;
    ctx.stroke();
  }
  if (theme === "Historical") {
    stroke(c, 1.5);
    // Graduated border: alternating ink and paper along a narrow band
    const inner = grow(c, 4);
    const outer = grow(c, 11);
    const seg = 36;
    ctx.fillStyle = st.ink;
    const run = (x0: number, y0: number, len: number, horizontal: boolean) => {
      for (let s = 0, k = 0; s < len; s += seg, k++) {
        if (k % 2) continue;
        const l = Math.min(seg, len - s);
        if (horizontal) ctx.fillRect(x0 + s, y0, l, 7);
        else ctx.fillRect(x0, y0 + s, 7, l);
      }
    };
    run(inner.x, outer.y, inner.w, true);
    run(inner.x, inner.y + inner.h, inner.w, true);
    run(outer.x, inner.y, inner.h, false);
    run(inner.x + inner.w, inner.y, inner.h, false);
    for (const [x, y] of [
      [outer.x, outer.y],
      [inner.x + inner.w, outer.y],
      [outer.x, inner.y + inner.h],
      [inner.x + inner.w, inner.y + inner.h],
    ])
      ctx.fillRect(x, y, 7, 7);
    stroke(inner, 0.8);
    stroke(outer, 0.8);
    // Ornate double rule
    const r1 = grow(c, 24);
    const r2 = grow(c, 29);
    stroke(r1, 3.2);
    stroke(r2, 1);
    for (const [x, y] of [
      [r1.x, r1.y],
      [r1.x + r1.w, r1.y],
      [r1.x, r1.y + r1.h],
      [r1.x + r1.w, r1.y + r1.h],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 11);
      ctx.lineTo(x + 11, y);
      ctx.lineTo(x, y + 11);
      ctx.lineTo(x - 11, y);
      ctx.closePath();
      ctx.fillStyle = st.paper;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = st.ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = st.accent;
      ctx.fill();
    }
  } else if (theme === "Atlas") {
    stroke(c, 1.2);
    stroke(grow(c, 6), 0.6);
  } else {
    stroke(c, 1);
    ctx.globalAlpha = 0.55;
    stroke(grow(c, 7), 2);
    ctx.globalAlpha = 1;
    // Brass corner brackets
    const o = grow(c, 14);
    const k = 26;
    ctx.lineWidth = 2;
    ctx.strokeStyle = st.accent;
    ctx.beginPath();
    for (const [x, y, sx, sy] of [
      [o.x, o.y, 1, 1],
      [o.x + o.w, o.y, -1, 1],
      [o.x, o.y + o.h, 1, -1],
      [o.x + o.w, o.y + o.h, -1, -1],
    ]) {
      ctx.moveTo(x + sx * k, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * k);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// --- Panels and text ---

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  // letterSpacing is recent; older engines simply ignore it
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Concave-cornered cartouche outline
function cartouchePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w, y, r, Math.PI, Math.PI / 2, true);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w, y + h, r, -Math.PI / 2, Math.PI, true);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x, y + h, r, 0, -Math.PI / 2, true);
  ctx.lineTo(x, y + r);
  ctx.arc(x, y, r, Math.PI / 2, 0, true);
  ctx.closePath();
}

// Panel background in the theme's style
function panel(ctx: CanvasRenderingContext2D, st: Style, theme: MapTheme, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = theme === "Atlas" ? 8 : 14;
  ctx.shadowOffsetY = 2;
  if (theme === "Historical") cartouchePath(ctx, x, y, w, h, 12);
  else roundRect(ctx, x, y, w, h, theme === "Atlas" ? 4 : 8);
  ctx.fillStyle = st.panel;
  ctx.fill();
  ctx.restore();
  ctx.save();
  if (theme === "Historical") {
    ctx.lineWidth = 2;
    ctx.strokeStyle = st.line;
    ctx.stroke();
    cartouchePath(ctx, x + 6, y + 6, w - 12, h - 12, 8);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  } else if (theme === "Atlas") {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(38, 48, 58, 0.35)";
    ctx.stroke();
  } else {
    ctx.lineWidth = 1;
    ctx.strokeStyle = st.line;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    roundRect(ctx, x + 4, y + 4, w - 8, h - 8, 5);
    ctx.globalAlpha = 0.3;
    ctx.stroke();
  }
  ctx.restore();
}

function paintCartouche(ctx: CanvasRenderingContext2D, st: Style, theme: MapTheme, map: Box, x: number, y: number, title: string, subtitle: string) {
  const text = st.caps ? title.toUpperCase() : title;
  const maxW = map.w * 0.55;
  let size = theme === "Atlas" ? 40 : 56;
  const spacing = st.caps ? 4 : 0.5;
  const titleFont = (s: number) => `${theme === "Historical" ? "" : "700 "}${s}px ${st.title}`;
  ctx.save();
  setSpacing(ctx, spacing);
  ctx.font = titleFont(size);
  while (size > 20 && ctx.measureText(text).width > maxW) ctx.font = titleFont((size -= 2));
  const tw = ctx.measureText(text).width;
  setSpacing(ctx, st.caps ? 1.5 : 0);
  const subSize = Math.round(size * 0.4);
  const subFont = `${theme === "Atlas" ? "500 " : "italic "}${subSize}px ${theme === "Atlas" ? st.body : st.title}`;
  ctx.font = subFont;
  const sub = subtitle ? fitText(ctx, st.caps ? subtitle.toUpperCase() : subtitle, maxW) : "";
  const sw = sub ? ctx.measureText(sub).width : 0;
  const padX = theme === "Historical" ? 40 : 28;
  const padY = theme === "Historical" ? 26 : 20;
  const gap = sub ? (theme === "Historical" ? 22 : 12) : 0;
  const w = Math.max(tw, sw) + padX * 2 + (theme === "Atlas" ? 8 : 0);
  const h = padY * 2 + size + (sub ? gap + subSize : 0);
  panel(ctx, st, theme, x, y, w, h);
  const cx = theme === "Atlas" ? x + padX + 8 : x + w / 2;
  ctx.textAlign = theme === "Atlas" ? "left" : "center";
  ctx.textBaseline = "alphabetic";
  if (theme === "Atlas") {
    ctx.fillStyle = st.accent;
    ctx.fillRect(x, y, 6, h);
  }
  setSpacing(ctx, spacing);
  ctx.font = titleFont(size);
  ctx.fillStyle = st.ink;
  const ty = y + padY + size * 0.8;
  ctx.fillText(text, cx, ty);
  if (sub) {
    if (theme === "Historical") {
      // Flourish: rule with a center lozenge
      const fy = ty + gap * 0.55;
      const half = Math.min(w / 2 - padX, 120);
      ctx.strokeStyle = st.ink;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - half, fy);
      ctx.lineTo(cx - 9, fy);
      ctx.moveTo(cx + 9, fy);
      ctx.lineTo(cx + half, fy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, fy - 4);
      ctx.lineTo(cx + 6, fy);
      ctx.lineTo(cx, fy + 4);
      ctx.lineTo(cx - 6, fy);
      ctx.closePath();
      ctx.fillStyle = st.accent;
      ctx.fill();
    }
    setSpacing(ctx, st.caps ? 1.5 : 0);
    ctx.font = subFont;
    ctx.fillStyle = st.muted;
    ctx.fillText(sub, cx, ty + gap + subSize);
  }
  ctx.restore();
}

// --- Compass rose ---

function paintCompass(ctx: CanvasRenderingContext2D, st: Style, theme: MapTheme, cx: number, cy: number, R: number) {
  ctx.save();
  ctx.translate(cx, cy);
  const ink = st.ink;
  const light = theme === "Realistic" ? "#2a2f37" : theme === "Historical" ? "#f3e9d0" : "#ffffff";
  if (theme === "Atlas") {
    // Clean north arrow
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.52);
    ctx.lineTo(R * 0.18, R * 0.3);
    ctx.lineTo(0, R * 0.16);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.52);
    ctx.lineTo(-R * 0.18, R * 0.3);
    ctx.lineTo(0, R * 0.16);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();
    ctx.font = `700 ${Math.round(R * 0.3)}px ${st.body}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = ink;
    ctx.fillText("N", 0, -R * 0.72);
    ctx.restore();
    return;
  }
  // Disc and rings
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.8, 0, Math.PI * 2);
  ctx.fillStyle = theme === "Realistic" ? "rgba(16,19,24,0.7)" : "rgba(243,233,208,0.75)";
  ctx.fill();
  ctx.strokeStyle = theme === "Realistic" ? st.accent : ink;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2);
  ctx.lineWidth = 0.6;
  ctx.stroke();
  for (let a = 0; a < 360; a += 10) {
    const t = (a * Math.PI) / 180;
    const r0 = a % 30 === 0 ? R * 0.64 : R * 0.67;
    ctx.beginPath();
    ctx.moveTo(Math.sin(t) * r0, -Math.cos(t) * r0);
    ctx.lineTo(Math.sin(t) * R * 0.7, -Math.cos(t) * R * 0.7);
    ctx.stroke();
  }
  // Star: each point split into a dark and a light half
  const point = (angle: number, len: number, width: number, dark: string, pale: string) => {
    const s = Math.sin(angle);
    const c = -Math.cos(angle);
    const px = -c;
    const py = s;
    for (const side of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(s * len, c * len);
      ctx.lineTo(px * width * side, py * width * side);
      ctx.closePath();
      ctx.fillStyle = side > 0 ? dark : pale;
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = ink;
      ctx.stroke();
    }
  };
  const main = theme === "Realistic" ? st.accent : ink;
  for (let k = 0; k < 8; k++) point(Math.PI / 8 + (k * Math.PI) / 4, R * 0.42, R * 0.05, main, light);
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, R * 0.66, R * 0.09, main, light);
  for (let k = 0; k < 4; k++) point((k * Math.PI) / 2, R, R * 0.13, k === 0 ? st.accent : main, light);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.06, 0, Math.PI * 2);
  ctx.fillStyle = st.accent;
  ctx.fill();
  ctx.font = `${theme === "Historical" ? "" : "700 "}${Math.round(R * 0.34)}px ${st.title}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = theme === "Realistic" ? st.ink : st.accent;
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme === "Realistic" ? "rgba(16,19,24,0.8)" : "rgba(243,233,208,0.9)";
  ctx.strokeText("N", 0, -R - 6);
  ctx.fillText("N", 0, -R - 6);
  ctx.restore();
}

// --- Scale bar ---

function niceKm(target: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

function paintScaleBar(ctx: CanvasRenderingContext2D, st: Style, theme: MapTheme, x: number, bottom: number, kmPerPx: number) {
  const km = niceKm(240 * kmPerPx);
  const len = km / kmPerPx;
  const pad = 16;
  const w = len + pad * 2 + 30;
  const h = 58;
  const y = bottom - h;
  panel(ctx, st, theme, x, y, w, h);
  ctx.save();
  const bx = x + pad;
  const by = y + 34;
  const fmt = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? (theme === "Realistic" ? "#2a2f37" : "#ffffff") : theme === "Realistic" ? st.accent : st.ink;
    ctx.fillRect(bx + (len / 4) * i, by, len / 4, 7);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme === "Realistic" ? st.accent : st.ink;
  ctx.strokeRect(bx, by, len, 7);
  ctx.font = `600 12px ${st.body}`;
  ctx.fillStyle = st.ink;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.fillText("0", bx, by - 7);
  ctx.fillText(fmt(km / 2), bx + len / 2, by - 7);
  ctx.textAlign = "left";
  ctx.fillText(`${fmt(km)} km`, bx + len - 8, by - 7);
  ctx.restore();
}

// --- Legend ---

const LEGEND_ROWS = 10;

function paintLegend(
  ctx: CanvasRenderingContext2D,
  st: Style,
  spec: PosterSpec,
  world: WorldData,
  landArea: number[],
  right: number,
  bottom: number,
  pr: number,
) {
  const theme = spec.theme;
  type Row = { label: string; value?: string; color?: string; flag?: number };
  let title = "Realms";
  let rows: Row[] = [];
  let more = 0;
  if (spec.thematic === "cultures" || spec.thematic === "religions") {
    const cult = spec.thematic === "cultures";
    title = cult ? "Cultures" : "Faiths";
    // Only those present in view, by land share
    const count = new Map<number, number>();
    const W = world.width;
    const e = spec.extent;
    for (let x = Math.floor(e.x0); x < Math.ceil(e.x1); x++) {
      const col = world.grid[((x % W) + W) % W];
      for (let y = Math.max(0, Math.floor(e.y0)); y < Math.min(world.height, Math.ceil(e.y1)); y++) {
        const c = col[y];
        if (c.isWater) continue;
        const n = c.nationIndex ?? -1;
        if (spec.keep && !spec.keep.has(n)) continue;
        const id = (cult ? c.cultureIndex : c.religionIndex) ?? -1;
        if (id >= 0) count.set(id, (count.get(id) ?? 0) + 1);
      }
    }
    const list = cult ? world.cultures : world.religions;
    const ids = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => list[id]);
    more = Math.max(0, ids.length - LEGEND_ROWS);
    rows = ids.slice(0, LEGEND_ROWS).map((id) => ({ label: list[id].name, color: list[id].color }));
  } else if (spec.thematic === "wealth") {
    title = "Provincial wealth";
    rows = [
      { label: "Poorest", color: "rgb(120,110,100)" },
      { label: "Average", color: "rgb(160,180,70)" },
      { label: "Richest", color: "rgb(240,200,30)" },
    ];
  } else if (spec.thematic === "diplomacy") {
    title = "Diplomacy";
    rows = [{ label: "Focus nation", color: "#e6be3c" }, ...Object.entries(RELATION_COLORS).map(([k, v]) => ({ label: k, color: v }))];
  } else {
    const list = spec.legendNations;
    more = Math.max(0, list.length - LEGEND_ROWS);
    rows = list.slice(0, LEGEND_ROWS).map((i) => ({
      label: world.nations[i].name,
      value: `${compact((landArea[i] || 0) * CELL_KM2)} km²`,
      color: world.nations[i].color,
      flag: i,
    }));
  }
  if (!rows.length) return;

  ctx.save();
  const rowH = 26;
  const pad = 18;
  const titleH = 34;
  ctx.font = `14px ${st.body}`;
  const labelW = Math.min(220, Math.max(90, ...rows.map((r) => ctx.measureText(r.label).width)));
  ctx.font = `12px ${st.body}`;
  const valueW = Math.max(0, ...rows.map((r) => (r.value ? ctx.measureText(r.value).width : 0)));
  const iconW = rows.some((r) => r.flag !== undefined) ? 34 : 22;
  const w = pad * 2 + iconW + labelW + (valueW ? valueW + 14 : 0);
  const h = pad * 2 + titleH + rows.length * rowH + (more ? 20 : 0) - 6;
  const x = right - w;
  const y = bottom - h;
  panel(ctx, st, theme, x, y, w, h);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  setSpacing(ctx, st.caps ? 2 : 0.5);
  ctx.font = `${theme === "Historical" ? "" : "700 "}${theme === "Atlas" ? 13 : 20}px ${theme === "Atlas" ? st.body : st.title}`;
  ctx.fillStyle = st.ink;
  ctx.fillText(st.caps ? title.toUpperCase() : title, x + pad, y + pad + 10);
  setSpacing(ctx, 0);
  let ry = y + pad + titleH + rowH / 2 - 4;
  for (const r of rows) {
    if (r.flag !== undefined) {
      const fw = 27;
      const fh = 18;
      const flag = nationFlag(world, r.flag, Math.round(fw * pr), Math.round(fh * pr));
      if (flag) ctx.drawImage(flag, x + pad, ry - fh / 2, fw, fh);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeRect(x + pad, ry - fh / 2, fw, fh);
    } else if (r.color) {
      ctx.fillStyle = r.color;
      ctx.fillRect(x + pad, ry - 7, 14, 14);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.strokeRect(x + pad, ry - 7, 14, 14);
    }
    ctx.font = `14px ${st.body}`;
    ctx.fillStyle = st.ink;
    ctx.fillText(fitText(ctx, r.label, labelW), x + pad + iconW, ry);
    if (r.value) {
      ctx.font = `12px ${st.body}`;
      ctx.fillStyle = st.muted;
      ctx.textAlign = "right";
      ctx.fillText(r.value, x + w - pad, ry);
      ctx.textAlign = "left";
    }
    ry += rowH;
  }
  if (more) {
    ctx.font = `italic 12px ${st.body}`;
    ctx.fillStyle = st.muted;
    ctx.fillText(`and ${more} more`, x + pad + iconW, ry - 4);
  }
  ctx.restore();
}

// --- Flags row ---

function paintFlagsRow(ctx: CanvasRenderingContext2D, st: Style, band: Box, spec: PosterSpec, world: WorldData, pr: number) {
  const slotMin = 92;
  const n = Math.min(spec.legendNations.length, Math.floor(band.w / slotMin));
  if (n <= 0) return;
  const list = spec.legendNations.slice(0, n);
  const slot = Math.min(150, band.w / n);
  const x0 = band.x + (band.w - slot * n) / 2;
  const fw = 48;
  const fh = 32;
  ctx.save();
  ctx.fillStyle = st.paper;
  ctx.fillRect(band.x, band.y, band.w, band.h);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  list.forEach((idx, k) => {
    const cx = x0 + slot * (k + 0.5);
    const fy = band.y + 22;
    const flag = nationFlag(world, idx, Math.round(fw * pr), Math.round(fh * pr));
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    if (flag) ctx.drawImage(flag, cx - fw / 2, fy, fw, fh);
    ctx.restore();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.strokeRect(cx - fw / 2, fy, fw, fh);
    ctx.font = `${st.caps ? "600 " : ""}12px ${st.body}`;
    ctx.fillStyle = st.ink;
    ctx.fillText(fitText(ctx, world.nations[idx].name, slot - 10), cx, fy + fh + 20);
  });
  ctx.restore();
}
