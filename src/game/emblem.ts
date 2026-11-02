import { FLAG_CHARGES, contrastCharge, renderFlag, type FlagCharge, type FlagSpec } from "./flags";
import type { Culture, WorldData } from "./WorldData";

// Logos for cultures: a round emblem built from the flag charges (a sigil on a
// field in the culture's color), or a custom image the user uploaded.

const GOLD = "#e3b23c";
const WHITE = "#f3efe2";

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

// Scales a #rrggbb color's brightness
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, "0")).join("")}`;
}

export function emblemSpec(c: Culture, family: string): FlagSpec {
  if (c.logoSpec) return c.logoSpec;
  const h = hash(`${c.name}|${family}|${c.logoSeed ?? 0}`);
  const charges = FLAG_CHARGES.filter((x) => x !== "none");
  const field = shade(c.color, 0.5);
  const spec: FlagSpec = {
    layout: "plain",
    colors: [field, field, field],
    charge: charges[h % charges.length],
    chargeColor: WHITE,
    chargePos: "center",
    chargeScale: 1.25,
  };
  const badge = (h >>> 9) % 3;
  if (badge === 1) Object.assign(spec, { badge: "disc", badgeColor: shade(c.color, 0.95) });
  else if (badge === 2) Object.assign(spec, { badge: "shield", badgeColor: shade(c.color, 0.95) });
  spec.chargeColor = contrastCharge(spec, (h >>> 4) & 1 ? GOLD : WHITE);
  return spec;
}

// What a nation's flag borrows from its culture: the color and the sigil of its logo
export function cultureHint(world: WorldData, cultureId: number): { color: string; charge: FlagCharge } | undefined {
  const c = world.cultures[cultureId];
  if (!c) return undefined;
  return { color: c.color, charge: emblemSpec(c, world.languages[cultureId]?.family.key ?? "Latin").charge };
}

// A round emblem: the design clipped to a circle with a gold ring
export function renderEmblem(spec: FlagSpec, px: number): HTMLCanvasElement {
  const flag = renderFlag(spec, px, px);
  const cv = document.createElement("canvas");
  cv.width = cv.height = px;
  const ctx = cv.getContext("2d")!;
  const r = px / 2 - 1.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(flag, 0, 0);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, px / 16);
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  return cv;
}

const urls = new Map<string, string>();

// Data URL for an <img>: the custom logo when there is one, else the emblem design
export function emblemUrl(c: Culture, family: string, size = 24): string {
  if (c.logo) return c.logo;
  const key = `${c.name}|${c.color}|${family}|${c.logoSeed ?? 0}|${JSON.stringify(c.logoSpec ?? null)}|${size}`;
  const hit = urls.get(key);
  if (hit) return hit;
  const url = renderEmblem(emblemSpec(c, family), size * 2).toDataURL(); // 2x: sharp on dense screens
  if (urls.size > 400) urls.clear();
  urls.set(key, url);
  return url;
}

// An uploaded picture, cropped to a square and shrunk so saved worlds stay small
export function logoFromFile(file: File, size = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const cv = document.createElement("canvas");
      cv.width = cv.height = size;
      cv.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(src);
      resolve(cv.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("Could not read this image"));
    };
    img.src = src;
  });
}
