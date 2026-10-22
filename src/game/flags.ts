import type { WorldData } from "./WorldData";

// Procedural flags. A flag is a field layout (up to three colours) plus an
// optional emblem; vassals fly their overlord's flag in the canton. Fields are
// rendered per pixel (supersampled) from a region function, emblems as paths.

export const FLAG_LAYOUTS = [
  "plain",
  "hbi",
  "htri",
  "fess",
  "vbi",
  "vtri",
  "pale",
  "diag",
  "bend",
  "hoist-tri",
  "chevron",
  "stripes",
  "border",
  "quartered",
  "canton",
  "hoist-band",
  "serrated",
  "rays",
  "waves",
  "tribar-hoist",
] as const;
export type FlagLayout = (typeof FLAG_LAYOUTS)[number];

export const FLAG_CHARGES = [
  "none",
  "crescent-star",
  "crescent",
  "star",
  "star8",
  "sun",
  "disc",
  "ring",
  "stars-row",
  "stars-ring",
  "lozenge",
  "swords",
  "mountain",
  "crown",
  "wheel",
] as const;
export type FlagCharge = (typeof FLAG_CHARGES)[number];

export type ChargePos = "center" | "hoist" | "canton";
export const FLAG_BADGES = ["none", "disc", "shield"] as const;
export type FlagBadge = (typeof FLAG_BADGES)[number];

export interface FlagSpec {
  layout: FlagLayout;
  colors: [string, string, string];
  charge: FlagCharge;
  chargeColor: string;
  chargePos: ChargePos;
  chargeScale: number; // 0.6 - 1.6
  fimbriation?: string | null; // thin metal line between fields
  badge?: FlagBadge; // roundel or shield behind the emblem
  badgeColor?: string;
}

const WHITE = "#f3efe2";
const GOLD = "#e3b23c";
const T = {
  red: "#b3202d",
  blue: "#1e408f",
  green: "#1d7a44",
  black: "#1c1a18",
  maroon: "#6e1d36",
  sky: "#3f8fd2",
  orange: "#d8661e",
  purple: "#5a2b86",
};

interface Style {
  colors: string[];
  metals: string[];
  layouts: FlagLayout[];
  charges: FlagCharge[];
  chargeChance: number;
}

// Heraldic taste per language family (see names.ts)
const STYLES: Record<string, Style> = {
  Desert: {
    colors: [T.green, T.red, T.black, T.green, T.maroon],
    metals: [WHITE, WHITE, GOLD],
    layouts: ["plain", "hoist-band", "htri", "vbi", "pale", "border", "hoist-tri", "fess", "serrated", "serrated", "tribar-hoist"],
    charges: ["crescent-star", "crescent-star", "star8", "crescent", "star", "stars-row"],
    chargeChance: 0.85,
  },
  Eastern: {
    colors: [T.red, T.red, T.black, T.blue, T.orange],
    metals: [GOLD, WHITE],
    layouts: ["plain", "plain", "htri", "border", "canton", "fess", "vbi", "rays", "rays"],
    charges: ["sun", "disc", "star", "wheel", "stars-ring", "ring"],
    chargeChance: 0.8,
  },
  Slavic: {
    colors: [T.red, T.blue, T.blue, T.maroon, T.sky],
    metals: [WHITE, WHITE, GOLD],
    layouts: ["htri", "htri", "hbi", "canton", "hoist-tri", "fess", "tribar-hoist"],
    charges: ["crown", "star", "sun", "lozenge"],
    chargeChance: 0.45,
  },
  Germanic: {
    colors: [T.black, T.red, T.red, T.blue, T.maroon],
    metals: [GOLD, WHITE],
    layouts: ["htri", "hbi", "quartered", "stripes", "border", "canton"],
    charges: ["crown", "swords", "lozenge", "ring"],
    chargeChance: 0.45,
  },
  Nordic: {
    colors: [T.blue, T.red, T.sky, T.black],
    metals: [WHITE, GOLD],
    layouts: ["diag", "bend", "hbi", "border", "chevron", "canton", "waves"],
    charges: ["swords", "star", "ring", "mountain", "wheel"],
    chargeChance: 0.5,
  },
  Latin: {
    colors: [T.red, T.green, T.blue, T.maroon, T.purple],
    metals: [WHITE, GOLD],
    layouts: ["vtri", "vtri", "pale", "vbi", "quartered", "stripes"],
    charges: ["crown", "sun", "star", "stars-ring", "lozenge"],
    chargeChance: 0.5,
  },
  Celtic: {
    colors: [T.green, T.green, T.orange, T.blue, T.black],
    metals: [WHITE, GOLD],
    layouts: ["vtri", "border", "stripes", "hoist-tri", "bend", "plain", "waves"],
    charges: ["ring", "wheel", "lozenge", "mountain", "sun"],
    chargeChance: 0.6,
  },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function luminance(hex: string) {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// The nation's map colour, deepened into a flag-worthy tincture
function deepen(hex: string): string {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  const d = mx - mn;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = 0.36;
  const s = Math.max(0.55, d / (1 - Math.abs(mx + mn - 1) || 1));
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

// Which colour (0-2) covers the point (u, v) of the field, both in [0, 1]
export function regionAt(layout: FlagLayout, u: number, v: number): number {
  switch (layout) {
    case "plain":
      return 0;
    case "hbi":
      return v < 0.5 ? 0 : 1;
    case "htri":
      return v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2;
    case "fess": {
      const d = Math.abs(v - 0.5);
      return d < 0.19 ? 1 : d < 0.25 ? 2 : 0;
    }
    case "vbi":
      return u < 0.5 ? 0 : 1;
    case "vtri":
      return u < 1 / 3 ? 0 : u < 2 / 3 ? 1 : 2;
    case "pale":
      return Math.abs(u - 0.5) < 0.25 ? 1 : 0;
    case "diag":
      return u + v < 1 ? 0 : 1;
    case "bend": {
      const d = (u * 1.5 + v - 1.25) / 1.8;
      return d < -0.13 ? 0 : d > 0.13 ? 2 : 1;
    }
    case "hoist-tri":
      return u * 1.5 < 0.62 * (1 - Math.abs(2 * v - 1)) ? 2 : v < 0.5 ? 0 : 1;
    case "chevron":
      return u * 1.5 < 0.75 * (1 - Math.abs(2 * v - 1)) ? 2 : Math.abs(v - 0.5) < 1 / 6 ? 1 : 0;
    case "stripes":
      return Math.floor(v * 7) % 2 === 0 ? 0 : 1;
    case "border":
      return u < 0.08 || u > 0.92 || v < 0.12 || v > 0.88 ? 1 : 0;
    case "quartered":
      return u < 0.5 === v < 0.5 ? 0 : 1;
    case "canton":
      return u < 0.42 && v < 0.5 ? 1 : 0;
    case "hoist-band":
      return u < 0.26 ? 2 : v < 0.5 ? 0 : 1;
    case "serrated": {
      // Metal hoist with a saw-tooth edge (nine points)
      const t = (v * 9) % 1;
      return u < 0.22 + 0.09 * (1 - Math.abs(2 * t - 1)) ? 1 : 0;
    }
    case "rays": {
      // Sunburst from just left of centre
      const a = Math.atan2(v - 0.5, (u - 0.42) * 1.5);
      return Math.floor(((a + Math.PI) / (2 * Math.PI)) * 16) % 2 === 0 ? 0 : 1;
    }
    case "waves": {
      if (v < 0.5) return 0;
      const w = v + Math.sin(u * Math.PI * 6) * 0.035;
      return Math.floor((w - 0.5) * 10) % 2 === 0 ? 1 : 2;
    }
    case "tribar-hoist":
      return u < 0.3 ? 2 : v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 0;
  }
}

function chargeCenter(pos: ChargePos, w: number, h: number): [number, number, number] {
  if (pos === "hoist") return [w * 0.24, h * 0.5, h * 0.25];
  if (pos === "canton") return [w * 0.21, h * 0.25, h * 0.15];
  return [w * 0.5, h * 0.5, h * 0.27];
}

export function generateFlag(seedText: string, nationColor: string, family: string, salt = 0): FlagSpec {
  const rand = mulberry(hash(seedText) ^ Math.imul(salt + 1, 0x9e3779b1));
  const pick = <V>(a: readonly V[]) => a[Math.floor(rand() * a.length)];
  const st = STYLES[family] ?? STYLES.Latin;
  const own = deepen(nationColor);
  const c0 = rand() < 0.65 ? own : pick(st.colors);
  const metal = pick(st.metals);
  let c2 = pick(st.colors);
  for (let k = 0; k < 4 && c2 === c0; k++) c2 = pick([...st.colors, T.black, own]);
  const layout = pick(st.layouts);
  // Metal between colours keeps fields legible; some layouts read better swapped
  let colors: [string, string, string] = [c0, metal, c2];
  if (layout === "border" || layout === "canton") colors = [c0, rand() < 0.5 ? metal : c2, c2];
  if (layout === "stripes" || layout === "hbi") colors = rand() < 0.5 ? [metal, c0, c2] : [c0, metal, c2];
  if (layout === "serrated") colors = [c0, metal, c2];
  if (layout === "rays") colors = [c0, rand() < 0.5 ? metal : c2, c2];

  const wantCharge = layout === "plain" || rand() < st.chargeChance;
  const charge: FlagCharge = wantCharge ? pick(st.charges) : "none";
  const chargePos: ChargePos =
    layout === "hoist-band" || layout === "hoist-tri" || layout === "chevron" || layout === "tribar-hoist"
      ? "hoist"
      : layout === "stripes" || layout === "quartered" || layout === "canton"
        ? "canton"
        : "center";
  const spec: FlagSpec = { layout, colors, charge, chargeColor: WHITE, chargePos, chargeScale: 0.85 + rand() * 0.35 };
  // Fimbriation between dark fields that would otherwise touch
  const darkFields = new Set(colors.filter((c) => luminance(c) < 0.55)).size;
  const fimbriable = !["plain", "border", "stripes", "rays", "serrated", "waves"].includes(layout);
  if (fimbriable && darkFields >= 2 && rand() < 0.45) spec.fimbriation = metal === GOLD && rand() < 0.5 ? GOLD : WHITE;
  // Emblems on a roundel or shield
  if (charge !== "none" && chargePos === "center" && rand() < 0.3) {
    spec.badge = family === "Germanic" || family === "Latin" || family === "Slavic" ? (rand() < 0.7 ? "shield" : "disc") : "disc";
    const [bx, by] = chargeCenter(chargePos, 1.5, 1);
    const under = colors[regionAt(layout, bx / 1.5, by)];
    spec.badgeColor = luminance(under) > 0.55 ? (colors.find((c) => luminance(c) < 0.45) ?? T.red) : metal;
  }
  spec.chargeColor = contrastCharge(spec, rand() < 0.5 ? GOLD : WHITE);
  return spec;
}

// An emblem colour that stands out from the field under it
export function contrastCharge(spec: FlagSpec, preferred: string): string {
  const [cx, cy] = chargeCenter(spec.chargePos, 1.5, 1);
  const under = spec.badge && spec.badge !== "none" && spec.badgeColor ? spec.badgeColor : spec.colors[regionAt(spec.layout, cx / 1.5, cy)];
  const lu = luminance(under);
  if (Math.abs(luminance(preferred) - lu) > 0.35) return preferred;
  if (lu > 0.55) return spec.colors.find((c) => luminance(c) < 0.4) ?? T.red;
  return Math.abs(luminance(GOLD) - lu) > Math.abs(luminance(WHITE) - lu) ? GOLD : WHITE;
}

function familyOf(world: WorldData, cultureId: number): string {
  return world.languages[cultureId]?.family.key ?? "Latin";
}

// The nation's flag, created on first use and stored on the nation (so it is saved)
export function flagOf(world: WorldData, idx: number): FlagSpec | null {
  const n = world.nations[idx];
  if (!n) return null;
  n.flag ??= generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0));
  return n.flag;
}

export function randomFlagFor(world: WorldData, idx: number): FlagSpec {
  const n = world.nations[idx];
  return generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0), 1 + Math.floor(Math.random() * 1e6));
}

export function defaultFlagFor(world: WorldData, idx: number): FlagSpec {
  const n = world.nations[idx];
  return generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0));
}

// --- Rendering ---

function star(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, points = 5, inner = 0.4, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? R * inner : R;
    const a = rot + (i * Math.PI) / points;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

// Draws the emblem into its own layer so cut-outs (crescents) stay transparent
function drawCharge(target: CanvasRenderingContext2D, spec: FlagSpec, w: number, h: number) {
  if (spec.charge === "none" && (!spec.badge || spec.badge === "none")) return;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const ctx = layer.getContext("2d")!;
  const [x, y, base] = chargeCenter(spec.chargePos, w, h);
  const s = base * spec.chargeScale;
  if (spec.badge && spec.badge !== "none" && spec.badgeColor) {
    const bs = s * 1.45;
    target.fillStyle = spec.badgeColor;
    target.strokeStyle = spec.chargeColor;
    target.lineWidth = Math.max(1, bs * 0.06);
    target.beginPath();
    if (spec.badge === "disc") target.arc(x, y, bs, 0, Math.PI * 2);
    else {
      // Heater shield
      target.moveTo(x - bs * 0.8, y - bs * 0.85);
      target.lineTo(x + bs * 0.8, y - bs * 0.85);
      target.lineTo(x + bs * 0.8, y + bs * 0.05);
      target.quadraticCurveTo(x + bs * 0.75, y + bs * 0.75, x, y + bs * 1.05);
      target.quadraticCurveTo(x - bs * 0.75, y + bs * 0.75, x - bs * 0.8, y + bs * 0.05);
      target.closePath();
    }
    target.fill();
    target.stroke();
  }
  if (spec.charge === "none") return;
  ctx.fillStyle = spec.chargeColor;
  ctx.strokeStyle = spec.chargeColor;
  const cut = (fn: () => void) => {
    ctx.globalCompositeOperation = "destination-out";
    fn();
    ctx.globalCompositeOperation = "source-over";
  };
  const crescent = (cx: number, cy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    cut(() => {
      ctx.beginPath();
      ctx.arc(cx + r * 0.32, cy - r * 0.05, r * 0.82, 0, Math.PI * 2);
      ctx.fill();
    });
  };
  switch (spec.charge) {
    case "disc":
      ctx.beginPath();
      ctx.arc(x, y, s * 0.85, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "ring":
      ctx.lineWidth = s * 0.22;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.75, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "star":
      star(ctx, x, y, s);
      break;
    case "star8":
      for (const a of [0, Math.PI / 4]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillRect(-s * 0.68, -s * 0.68, s * 1.36, s * 1.36);
        ctx.restore();
      }
      cut(() => {
        ctx.beginPath();
        ctx.arc(x, y, s * 0.4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.beginPath();
      ctx.arc(x, y, s * 0.24, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "sun":
      ctx.beginPath();
      ctx.arc(x, y, s * 0.46, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const da = Math.PI / 22;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a - da) * s * 0.56, y + Math.sin(a - da) * s * 0.56);
        ctx.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
        ctx.lineTo(x + Math.cos(a + da) * s * 0.56, y + Math.sin(a + da) * s * 0.56);
        ctx.fill();
      }
      break;
    case "crescent":
      crescent(x, y, s * 0.85);
      break;
    case "crescent-star":
      crescent(x - s * 0.18, y, s * 0.8);
      star(ctx, x + s * 0.5, y - s * 0.05, s * 0.3, 5, 0.4, -Math.PI / 2 + 0.3);
      break;
    case "stars-row":
      for (const dx of [-1, 0, 1]) star(ctx, x + dx * s * 0.95, y, s * 0.4);
      break;
    case "stars-ring":
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        star(ctx, x + Math.cos(a) * s * 0.75, y + Math.sin(a) * s * 0.75, s * 0.21);
      }
      break;
    case "lozenge":
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.68, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s * 0.68, y);
      ctx.closePath();
      ctx.fill();
      break;
    case "swords":
      for (const a of [-0.7, 0.7]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, -s * 1.05);
        ctx.lineTo(s * 0.09, -s * 0.85);
        ctx.lineTo(s * 0.09, s * 0.55);
        ctx.lineTo(-s * 0.09, s * 0.55);
        ctx.lineTo(-s * 0.09, -s * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(-s * 0.32, s * 0.52, s * 0.64, s * 0.1); // guard
        ctx.fillRect(-s * 0.06, s * 0.6, s * 0.12, s * 0.3); // grip
        ctx.restore();
      }
      break;
    case "mountain":
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.6);
      ctx.lineTo(x - s * 0.45, y - s * 0.2);
      ctx.lineTo(x - s * 0.15, y + s * 0.15);
      ctx.lineTo(x + s * 0.25, y - s * 0.75);
      ctx.lineTo(x + s, y + s * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
    case "crown":
      ctx.beginPath();
      ctx.moveTo(x - s * 0.8, y + s * 0.5);
      ctx.lineTo(x - s * 0.85, y - s * 0.35);
      ctx.lineTo(x - s * 0.4, y + s * 0.05);
      ctx.lineTo(x, y - s * 0.6);
      ctx.lineTo(x + s * 0.4, y + s * 0.05);
      ctx.lineTo(x + s * 0.85, y - s * 0.35);
      ctx.lineTo(x + s * 0.8, y + s * 0.5);
      ctx.closePath();
      ctx.fill();
      for (const dx of [-0.85, 0, 0.85]) {
        ctx.beginPath();
        ctx.arc(x + dx * s, y + (dx === 0 ? -0.68 : -0.43) * s, s * 0.11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillRect(x - s * 0.8, y + s * 0.58, s * 1.6, s * 0.16);
      break;
    case "wheel":
      ctx.lineWidth = s * 0.14;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * s * 0.8, y + Math.sin(a) * s * 0.8);
        ctx.lineWidth = s * 0.08;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  target.drawImage(layer, 0, 0);
}

function paintFlag(ctx: CanvasRenderingContext2D, spec: FlagSpec, w: number, h: number) {
  // Field: 2x2 supersampled so diagonal edges stay smooth
  const img = ctx.createImageData(w, h);
  const cols = spec.colors.map(rgb);
  const fim = spec.fimbriation ? rgb(spec.fimbriation) : null;
  const fv = 0.028;
  const fu = fv / 1.5;
  const d = img.data;
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const u = (px + 0.25 + sx * 0.5) / w;
          const v = (py + 0.25 + sy * 0.5) / h;
          const k = regionAt(spec.layout, u, v);
          // A field edge within the fimbriation width shows the metal line
          const edge =
            fim &&
            (regionAt(spec.layout, u + fu, v) !== k ||
              regionAt(spec.layout, u - fu, v) !== k ||
              regionAt(spec.layout, u, v + fv) !== k ||
              regionAt(spec.layout, u, v - fv) !== k);
          const c = edge ? fim : cols[k];
          r += c[0];
          g += c[1];
          b += c[2];
        }
      const o = (py * w + px) * 4;
      d[o] = r / 4;
      d[o + 1] = g / 4;
      d[o + 2] = b / 4;
      d[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  drawCharge(ctx, spec, w, h);
}

const cache = new Map<string, HTMLCanvasElement>();

// A rendered flag (with the overlord's flag in the canton for vassals)
export function renderFlag(spec: FlagSpec, w: number, h: number, canton: FlagSpec | null = null): HTMLCanvasElement {
  w = Math.max(3, Math.round(w));
  h = Math.max(2, Math.round(h));
  const key = JSON.stringify([spec, canton, w, h]);
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 600) cache.clear();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  // Vassals keep their emblem clear of the canton
  paintFlag(ctx, canton && spec.chargePos === "canton" ? { ...spec, chargePos: "center" } : spec, w, h);
  if (canton) {
    const cw = Math.round(w * 0.42);
    const ch = Math.round(h * 0.5);
    ctx.drawImage(renderFlag(canton, cw, ch), 0, 0);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(cw, 0, Math.max(1, w / 120), ch);
    ctx.fillRect(0, ch, cw, Math.max(1, h / 80));
  }
  cache.set(key, c);
  return c;
}

export function nationFlag(world: WorldData, idx: number, w: number, h: number): HTMLCanvasElement | null {
  const spec = flagOf(world, idx);
  if (!spec) return null;
  const o = world.nations[idx].overlord;
  const canton = o !== undefined ? flagOf(world, o) : null;
  return renderFlag(spec, w, h, canton);
}

const urlCache = new Map<HTMLCanvasElement, string>();
// Data URL for <img> use in the UI (rendered at 2x for sharpness)
export function nationFlagUrl(world: WorldData, idx: number, w: number, h: number): string {
  const c = nationFlag(world, idx, w * 2, h * 2);
  if (!c) return "";
  let url = urlCache.get(c);
  if (!url) {
    if (urlCache.size > 600) urlCache.clear();
    url = c.toDataURL();
    urlCache.set(c, url);
  }
  return url;
}
