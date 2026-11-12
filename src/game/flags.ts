import type { WorldData } from "./WorldData";
import { cultureHint } from "./emblem";
import { APP_VERSION, atLeast } from "./version";

// Procedural flags. A flag is a field layout (up to three colors) plus an
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
  "sunrise",
  "wave",
  "tree",
  "wreath",
  "tower",
  "key",
  "anchor",
  "ship",
  "eagle",
  "bow",
  "axes",
  "hammers",
] as const;
export type FlagCharge = (typeof FLAG_CHARGES)[number];

export const CHARGE_NAMES: Record<FlagCharge, string> = {
  none: "None",
  "crescent-star": "Crescent & star",
  crescent: "Crescent",
  star: "Star",
  star8: "Eight-point star",
  sun: "Sun",
  disc: "Disc",
  ring: "Ring",
  "stars-row": "Three stars",
  "stars-ring": "Ring of stars",
  lozenge: "Lozenge",
  swords: "Crossed swords",
  mountain: "Mountain",
  crown: "Crown",
  sunrise: "Rising sun",
  wave: "Waves",
  tree: "Tree",
  wreath: "Laurel wreath",
  tower: "Tower",
  key: "Key",
  anchor: "Anchor",
  ship: "Ship",
  eagle: "Eagle",
  bow: "Bow & arrow",
  axes: "Crossed axes",
  hammers: "Crossed hammers",
};

// The 0.1 emblem set in its original order, so 0.1 worlds keep their generated
// flags and culture emblems; "sun" holds the slot of a retired emblem
export const LEGACY_CHARGES: readonly FlagCharge[] = [
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
  "sun",
];

// Charges no longer offered, as saved flags may still name them
const RETIRED: Record<string, FlagCharge> = { wheel: "sun" };

// A charge read from a saved flag: known, retired (mapped) or unknown ("none")
export function normalizeCharge(c: string): FlagCharge {
  return (FLAG_CHARGES as readonly string[]).includes(c) ? (c as FlagCharge) : (RETIRED[c] ?? "none");
}

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
  charges01: FlagCharge[]; // the 0.1 list, same length and order as it was
  chargeChance: number;
}

// Heraldic taste per language family (see names.ts)
const STYLES: Record<string, Style> = {
  Desert: {
    colors: [T.green, T.red, T.black, T.green, T.maroon],
    metals: [WHITE, WHITE, GOLD],
    layouts: ["plain", "hoist-band", "htri", "vbi", "pale", "border", "hoist-tri", "fess", "serrated", "serrated", "tribar-hoist"],
    charges: ["crescent-star", "crescent-star", "star8", "crescent", "star", "stars-row", "tower", "sunrise", "bow", "swords"],
    charges01: ["crescent-star", "crescent-star", "star8", "crescent", "star", "stars-row"],
    chargeChance: 0.85,
  },
  Eastern: {
    colors: [T.red, T.red, T.black, T.blue, T.orange],
    metals: [GOLD, WHITE],
    layouts: ["plain", "plain", "htri", "border", "canton", "fess", "vbi", "rays", "rays"],
    charges: ["sun", "disc", "star", "stars-ring", "ring", "sunrise", "wave", "tree", "bow"],
    charges01: ["sun", "disc", "star", "sun", "stars-ring", "ring"],
    chargeChance: 0.8,
  },
  Slavic: {
    colors: [T.red, T.blue, T.blue, T.maroon, T.sky],
    metals: [WHITE, WHITE, GOLD],
    layouts: ["htri", "htri", "hbi", "canton", "hoist-tri", "fess", "tribar-hoist"],
    charges: ["crown", "star", "sun", "lozenge", "eagle", "tower", "axes", "tree"],
    charges01: ["crown", "star", "sun", "lozenge"],
    chargeChance: 0.45,
  },
  Germanic: {
    colors: [T.black, T.red, T.red, T.blue, T.maroon],
    metals: [GOLD, WHITE],
    layouts: ["htri", "hbi", "quartered", "stripes", "border", "canton"],
    charges: ["crown", "swords", "lozenge", "ring", "eagle", "tower", "key", "hammers"],
    charges01: ["crown", "swords", "lozenge", "ring"],
    chargeChance: 0.45,
  },
  Nordic: {
    colors: [T.blue, T.red, T.sky, T.black],
    metals: [WHITE, GOLD],
    layouts: ["diag", "bend", "hbi", "border", "chevron", "canton", "waves"],
    charges: ["swords", "star", "ring", "mountain", "ship", "axes", "hammers", "anchor", "wave"],
    charges01: ["swords", "star", "ring", "mountain", "sun"],
    chargeChance: 0.5,
  },
  Latin: {
    colors: [T.red, T.green, T.blue, T.maroon, T.purple],
    metals: [WHITE, GOLD],
    layouts: ["vtri", "vtri", "pale", "vbi", "quartered", "stripes"],
    charges: ["crown", "sun", "star", "stars-ring", "lozenge", "wreath", "eagle", "tower", "key", "anchor"],
    charges01: ["crown", "sun", "star", "stars-ring", "lozenge"],
    chargeChance: 0.5,
  },
  Celtic: {
    colors: [T.green, T.green, T.orange, T.blue, T.black],
    metals: [WHITE, GOLD],
    layouts: ["vtri", "border", "stripes", "hoist-tri", "bend", "plain", "waves"],
    charges: ["ring", "lozenge", "mountain", "sun", "tree", "wreath", "wave", "ship"],
    charges01: ["ring", "sun", "lozenge", "mountain", "sun"],
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

// The nation's map color, deepened into a flag-worthy tincture
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

// Which color (0-2) covers the point (u, v) of the field, both in [0, 1]
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
      // Sunburst from just left of center
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

// Emblem spots as [u, v, size], u/v as shares of the width/height and size as a
// share of the height. The plain anchors suit any layout roughly...
type Spot = [number, number, number];
const ANCHORS: Record<ChargePos, Spot> = { center: [0.5, 0.5, 0.27], hoist: [0.24, 0.5, 0.25], canton: [0.21, 0.25, 0.15] };
// ...these fit each layout: inside a band, a triangle's incircle or a quarter,
// clear of seams and bands
const FIT: Partial<Record<FlagLayout, Partial<Record<ChargePos, Spot>>>> = {
  hbi: { hoist: [0.2, 0.25, 0.17], canton: [0.18, 0.25, 0.14] },
  htri: { center: [0.5, 0.5, 0.22], hoist: [0.2, 1 / 6, 0.14], canton: [0.16, 1 / 6, 0.12] },
  fess: { center: [0.5, 0.5, 0.2], hoist: [0.15, 0.125, 0.1], canton: [0.13, 0.125, 0.09] },
  vbi: { hoist: [0.25, 0.5, 0.24], canton: [0.2, 0.22, 0.15] },
  vtri: { center: [0.5, 0.5, 0.21], hoist: [1 / 6, 0.5, 0.21], canton: [1 / 6, 0.2, 0.14] },
  pale: { hoist: [0.125, 0.5, 0.16], canton: [0.125, 0.2, 0.13] },
  diag: { center: [0.3, 0.3, 0.2], hoist: [0.22, 0.32, 0.18], canton: [0.18, 0.22, 0.14] },
  bend: { center: [0.24, 0.28, 0.17], hoist: [0.2, 0.3, 0.17], canton: [0.17, 0.22, 0.14] },
  "hoist-tri": { hoist: [0.155, 0.5, 0.19], canton: [0.15, 0.5, 0.15] },
  chevron: { hoist: [0.178, 0.5, 0.21], canton: [0.17, 0.5, 0.16] },
  "tribar-hoist": { hoist: [0.15, 0.5, 0.19], canton: [0.15, 0.18, 0.13] },
  "hoist-band": { hoist: [0.13, 0.5, 0.17], canton: [0.13, 0.2, 0.13] },
  border: { center: [0.5, 0.5, 0.25], hoist: [0.27, 0.5, 0.2], canton: [0.25, 0.3, 0.13] },
  quartered: { hoist: [0.25, 0.25, 0.18], canton: [0.25, 0.25, 0.17] },
  canton: { hoist: [0.21, 0.25, 0.18], canton: [0.21, 0.25, 0.18] },
  serrated: { center: [0.64, 0.5, 0.25], hoist: [0.11, 0.5, 0.13], canton: [0.47, 0.22, 0.14] },
  rays: { center: [0.42, 0.5, 0.27] },
  waves: { center: [0.5, 0.25, 0.17], hoist: [0.24, 0.25, 0.17] },
};

// Emblem center and size in pixels; without a layout, the plain anchors
export function chargeCenter(pos: ChargePos, w: number, h: number, layout?: FlagLayout): [number, number, number] {
  const [u, v, k] = (layout && FIT[layout]?.[pos]) || ANCHORS[pos];
  return [w * u, h * v, h * k];
}

// A nation's flag nods to its culture: the culture's color often joins the field,
// and its logo's sigil often becomes the emblem
export interface CultureHint {
  color: string;
  charge: FlagCharge;
}

// `version` is the world's: 0.1 worlds draw from the emblems they had then
export function generateFlag(seedText: string, nationColor: string, family: string, salt = 0, hint?: CultureHint, version = APP_VERSION): FlagSpec {
  const rand = mulberry(hash(seedText) ^ Math.imul(salt + 1, 0x9e3779b1));
  const fit = atLeast(version, "0.2"); // 0.1 picked colors under the plain anchors
  const pick = <V>(a: readonly V[]) => a[Math.floor(rand() * a.length)];
  const st = STYLES[family] ?? STYLES.Latin;
  const own = deepen(nationColor);
  const c0 = rand() < 0.65 ? own : pick(st.colors);
  const metal = pick(st.metals);
  let c2 = pick(st.colors);
  for (let k = 0; k < 4 && c2 === c0; k++) c2 = pick([...st.colors, T.black, own]);
  const layout = pick(st.layouts);
  // Metal between colors keeps fields legible; some layouts read better swapped
  let colors: [string, string, string] = [c0, metal, c2];
  if (layout === "border" || layout === "canton") colors = [c0, rand() < 0.5 ? metal : c2, c2];
  if (layout === "stripes" || layout === "hbi") colors = rand() < 0.5 ? [metal, c0, c2] : [c0, metal, c2];
  if (layout === "serrated") colors = [c0, metal, c2];
  if (layout === "rays") colors = [c0, rand() < 0.5 ? metal : c2, c2];

  const wantCharge = layout === "plain" || rand() < st.chargeChance;
  const charge: FlagCharge = wantCharge ? pick(atLeast(version, "0.2") ? st.charges : st.charges01) : "none";
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
    const [bx, by] = chargeCenter(chargePos, 1.5, 1, fit ? layout : undefined);
    const under = colors[regionAt(layout, bx / 1.5, by)];
    spec.badgeColor = luminance(under) > 0.55 ? (colors.find((c) => luminance(c) < 0.45) ?? T.red) : metal;
  }
  spec.chargeColor = contrastCharge(spec, rand() < 0.5 ? GOLD : WHITE, fit);
  if (hint) {
    // Drawn after everything else, so a flag without a culture is unchanged
    if (rand() < 0.6) spec.colors[2] = deepen(hint.color);
    if (rand() < (spec.charge === "none" ? 0.55 : 0.8)) {
      if (spec.charge === "none" && spec.chargePos === "center" && rand() < 0.3) {
        spec.badge = "disc";
        spec.badgeColor = spec.colors[1];
      }
      spec.charge = hint.charge;
    }
    if (spec.charge !== "none") spec.chargeColor = contrastCharge(spec, spec.chargeColor, fit);
  }
  return spec;
}

// An emblem color that stands out from the field under it (`fit`: at its layout-fitted spot)
export function contrastCharge(spec: FlagSpec, preferred: string, fit = true): string {
  const [cx, cy] = chargeCenter(spec.chargePos, 1.5, 1, fit ? spec.layout : undefined);
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
  n.flag ??= generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0), 0, cultureHint(world, n.cultureId ?? 0), world.version);
  return n.flag;
}

export function randomFlagFor(world: WorldData, idx: number): FlagSpec {
  const n = world.nations[idx];
  return generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0), 1 + Math.floor(Math.random() * 1e6), cultureHint(world, n.cultureId ?? 0), world.version);
}

export function defaultFlagFor(world: WorldData, idx: number): FlagSpec {
  const n = world.nations[idx];
  return generateFlag(n.name, n.color, familyOf(world, n.cultureId ?? 0), 0, cultureHint(world, n.cultureId ?? 0), world.version);
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
function drawCharge(target: CanvasRenderingContext2D, spec: FlagSpec, w: number, h: number, fit: boolean) {
  const charge = normalizeCharge(spec.charge);
  if (charge === "none" && (!spec.badge || spec.badge === "none")) return;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const ctx = layer.getContext("2d")!;
  const [x, y, base] = chargeCenter(spec.chargePos, w, h, fit ? spec.layout : undefined);
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
  if (charge === "none") return;
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
  // Filled shapes in units of s around (ox, oy)
  const poly = (pts: number[], ox = x, oy = y) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(ox + pts[i] * s, oy + pts[i + 1] * s);
    ctx.closePath();
    ctx.fill();
  };
  const box = (dx: number, dy: number, bw: number, bh: number, ox = x, oy = y) => ctx.fillRect(ox + dx * s, oy + dy * s, bw * s, bh * s);
  const dot = (dx: number, dy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  };
  const mirror = (pts: number[]) => pts.map((v, i) => (i % 2 ? v : -v));
  switch (charge) {
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
    case "sunrise": {
      // Half sun on the horizon with a fan of rays
      const hy = y + s * 0.4;
      ctx.beginPath();
      ctx.arc(x, hy, s * 0.5, Math.PI, 0);
      ctx.fill();
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + ((i + 0.5) * Math.PI) / 7;
        const da = Math.PI / 30;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a - da) * s * 0.6, hy + Math.sin(a - da) * s * 0.6);
        ctx.lineTo(x + Math.cos(a) * s * 1.05, hy + Math.sin(a) * s * 1.05);
        ctx.lineTo(x + Math.cos(a + da) * s * 0.6, hy + Math.sin(a + da) * s * 0.6);
        ctx.fill();
      }
      box(-1, 0.48, 2, 0.14);
      break;
    }
    case "wave":
      ctx.lineWidth = s * 0.17;
      ctx.lineCap = "round";
      for (const dy of [-0.45, 0, 0.45]) {
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          ctx.lineTo(x + (t * 2 - 1) * s * 0.9, y + (dy + Math.sin(t * Math.PI * 3) * 0.12) * s);
        }
        ctx.stroke();
      }
      break;
    case "tree":
      poly([-0.1, 0.3, 0.1, 0.3, 0.12, 0.72, 0.3, 0.92, -0.3, 0.92, -0.12, 0.72]);
      dot(0, -0.42, 0.42);
      dot(-0.4, -0.05, 0.36);
      dot(0.4, -0.05, 0.36);
      dot(0, 0.05, 0.4);
      break;
    case "wreath":
      // Two laurel branches rising from the base; d = 1 left, -1 right
      for (const d of [1, -1]) {
        const R = s * 0.7;
        ctx.lineWidth = s * 0.07;
        ctx.beginPath();
        ctx.arc(x, y, R, Math.PI / 2 + d * 0.15, Math.PI / 2 + d * 2.4, d < 0);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 2 + d * (0.4 + i * 0.38);
          const t = a + (d * Math.PI) / 2; // along the branch, toward its tip
          for (const [off, tilt] of [[0.11, -0.45], [-0.11, 0.45]]) {
            ctx.beginPath();
            ctx.ellipse(x + Math.cos(a) * (R + off * s), y + Math.sin(a) * (R + off * s), s * 0.17, s * 0.075, t + d * tilt, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;
    case "tower":
      poly([-0.4, 0.88, -0.34, -0.3, 0.34, -0.3, 0.4, 0.88]);
      box(-0.5, -0.52, 1, 0.26);
      for (const dx of [-0.5, -0.13, 0.24]) box(dx, -0.84, 0.26, 0.34);
      cut(() => {
        box(-0.14, 0.4, 0.28, 0.48);
        dot(0, 0.4, 0.14);
        box(-0.06, -0.12, 0.12, 0.24);
      });
      break;
    case "key":
      dot(0, -0.52, 0.4);
      box(-0.1, -0.2, 0.2, 1.1);
      box(0.08, 0.46, 0.32, 0.16);
      box(0.08, 0.7, 0.4, 0.2);
      cut(() => dot(0, -0.52, 0.17));
      break;
    case "anchor":
      ctx.lineWidth = s * 0.12;
      ctx.beginPath();
      ctx.arc(x, y - s * 0.76, s * 0.15, 0, Math.PI * 2);
      ctx.stroke();
      box(-0.07, -0.62, 0.14, 1.34);
      box(-0.42, -0.48, 0.84, 0.13);
      ctx.lineWidth = s * 0.13;
      ctx.beginPath();
      ctx.arc(x, y + s * 0.08, s * 0.62, Math.PI * 0.12, Math.PI * 0.88);
      ctx.stroke();
      for (const d of [1, -1]) poly([0.66 * d, 0.04, 0.44 * d, 0.34, 0.76 * d, 0.38]);
      break;
    case "ship":
      poly([-1, 0.2, -0.8, 0.36, 0.8, 0.36, 1, 0.2, 0.78, 0.7, -0.78, 0.7]);
      box(-0.045, -0.92, 0.09, 1.3);
      // Square sail bellied by the wind
      ctx.beginPath();
      ctx.moveTo(x - s * 0.6, y - s * 0.72);
      ctx.lineTo(x + s * 0.6, y - s * 0.72);
      ctx.quadraticCurveTo(x + s * 0.8, y - s * 0.25, x + s * 0.62, y + s * 0.2);
      ctx.lineTo(x - s * 0.62, y + s * 0.2);
      ctx.quadraticCurveTo(x - s * 0.8, y - s * 0.25, x - s * 0.6, y - s * 0.72);
      ctx.fill();
      poly([0.045, -0.92, 0.42, -0.85, 0.045, -0.78]);
      break;
    case "eagle": {
      // Displayed: spread wings with feathered tips, fanned tail
      const wing = [-0.1, -0.2, -0.45, -0.6, -0.98, -0.78, -0.86, -0.5, -1, -0.42, -0.86, -0.22, -0.98, -0.12, -0.8, 0.04, -0.88, 0.16, -0.55, 0.22, -0.12, 0.2];
      poly(wing);
      poly(mirror(wing));
      ctx.beginPath();
      ctx.ellipse(x, y + s * 0.1, s * 0.2, s * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
      dot(0, -0.46, 0.17);
      poly([0.1, -0.54, 0.34, -0.44, 0.1, -0.38]);
      poly([-0.16, 0.45, 0.16, 0.45, 0.32, 0.86, 0, 0.74, -0.32, 0.86]);
      break;
    }
    case "bow": {
      // Drawn bow with its arrow pointing to the fly
      const cx = x - s * 0.55;
      const R = s * 0.95;
      ctx.lineWidth = s * 0.17;
      ctx.beginPath();
      ctx.arc(cx, y, R, -0.95, 0.95);
      ctx.stroke();
      const ex = cx + Math.cos(0.95) * R;
      const ey = Math.sin(0.95) * R;
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.moveTo(ex, y - ey);
      ctx.lineTo(x - s * 0.6, y);
      ctx.lineTo(ex, y + ey);
      ctx.stroke();
      box(-0.68, -0.05, 1.42, 0.1);
      poly([0.7, -0.16, 0.95, 0, 0.7, 0.16]);
      poly([-0.68, -0.04, -0.84, -0.18, -0.56, -0.18, -0.44, -0.04]);
      poly([-0.68, 0.04, -0.84, 0.18, -0.56, 0.18, -0.44, 0.04]);
      break;
    }
    case "axes":
      // Blades face outward
      for (const d of [-1, 1]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(d * 0.62);
        ctx.scale(d, 1);
        box(-0.06, -0.8, 0.12, 1.75, 0, 0);
        poly([0.05, -0.78, 0.42, -0.98, 0.56, -0.62, 0.42, -0.26, 0.05, -0.46], 0, 0);
        ctx.restore();
      }
      break;
    case "hammers":
      for (const d of [-1, 1]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(d * 0.7);
        box(-0.065, -0.6, 0.13, 1.55, 0, 0);
        box(-0.36, -0.9, 0.72, 0.34, 0, 0);
        ctx.restore();
      }
      break;
  }
  target.drawImage(layer, 0, 0);
}

function paintFlag(ctx: CanvasRenderingContext2D, spec: FlagSpec, w: number, h: number, fit = true) {
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
  drawCharge(ctx, spec, w, h, fit);
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
  // Vassals keep their emblem clear of the canton, back on the plain anchor when
  // the fitted spot falls under it
  const own: FlagSpec = canton && spec.chargePos === "canton" ? { ...spec, chargePos: "center" } : spec;
  const [u, v] = chargeCenter(own.chargePos, 1, 1, own.layout);
  paintFlag(ctx, own, w, h, !canton || u >= 0.42 || v >= 0.5);
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
  return canvasUrl(nationFlag(world, idx, w * 2, h * 2));
}

// The same for any flag (coalition flags)
export function flagUrl(spec: FlagSpec, w: number, h: number): string {
  return canvasUrl(renderFlag(spec, w * 2, h * 2));
}

function canvasUrl(c: HTMLCanvasElement | null): string {
  if (!c) return "";
  let url = urlCache.get(c);
  if (!url) {
    if (urlCache.size > 600) urlCache.clear();
    url = c.toDataURL();
    urlCache.set(c, url);
  }
  return url;
}
