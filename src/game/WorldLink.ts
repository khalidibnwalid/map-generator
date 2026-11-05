import type { Preset } from "./MapGenerator";
import { DEFAULT_SETTINGS, type WorldSettings } from "./generators/types";

// A world's recipe as a URL hash: the seed and every generation option, so a
// link reproduces the same world anywhere. Edits are not part of it (they
// travel as .world files). Only non-default options are written, to keep
// links short: #seed=982332&land=medium&size=800x450

export interface WorldRecipe {
  seed: number;
  preset: Preset;
  width: number;
  height: number;
  greatPowers: number;
  settings: WorldSettings;
}

const LANDS: Record<string, Preset> = {
  giant: "Heavy Landmass",
  medium: "Earthlike",
  small: "Realistic Continents",
  super: "Pangea",
  landworld: "Landworld",
};
const LAND_OF = Object.fromEntries(Object.entries(LANDS).map(([k, v]) => [v, k])) as Record<Preset, string>;

export const SIZES = ["400x225", "800x450", "1600x900"];
const DEFAULT_SIZE = "800x450";
const DEFAULT_POWERS = 1;

// Settings as short keys; fractions are written as percentages
const OPTS: { key: keyof WorldSettings; param: string; scale: number }[] = [
  { key: "seaLevel", param: "sea", scale: 100 },
  { key: "mountains", param: "mountains", scale: 100 },
  { key: "climate", param: "climate", scale: 100 },
  { key: "rainfall", param: "rain", scale: 100 },
  { key: "settlements", param: "towns", scale: 100 },
  { key: "nations", param: "realms", scale: 1 },
];

export function recipeToHash(r: WorldRecipe): string {
  const p = new URLSearchParams();
  p.set("seed", String(r.seed));
  p.set("land", LAND_OF[r.preset] ?? "giant");
  const size = `${r.width}x${r.height}`;
  if (size !== DEFAULT_SIZE) p.set("size", size);
  if (r.greatPowers !== DEFAULT_POWERS) p.set("powers", String(r.greatPowers));
  for (const o of OPTS) {
    const v = r.settings[o.key];
    if (v !== DEFAULT_SETTINGS[o.key]) p.set(o.param, String(Math.round(v * o.scale * 1000) / 1000));
  }
  return "#" + p.toString();
}

// Null when the hash is not a world link (or is broken)
export function recipeFromHash(hash: string): WorldRecipe | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const seed = Number(p.get("seed"));
  if (!p.has("seed") || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
  const preset = LANDS[p.get("land") ?? "giant"];
  if (!preset) return null;
  const size = p.get("size") ?? DEFAULT_SIZE;
  if (!SIZES.includes(size)) return null;
  const [width, height] = size.split("x").map(Number);
  const powers = p.has("powers") ? Number(p.get("powers")) : DEFAULT_POWERS;
  const settings = { ...DEFAULT_SETTINGS };
  for (const o of OPTS) {
    if (!p.has(o.param)) continue;
    const v = Number(p.get(o.param));
    if (Number.isFinite(v)) settings[o.key] = v / o.scale;
  }
  return {
    seed,
    preset,
    width,
    height,
    greatPowers: Number.isInteger(powers) ? Math.max(0, Math.min(3, powers)) : DEFAULT_POWERS,
    settings,
  };
}
