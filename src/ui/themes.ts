import type { MapTheme } from "../core/GPURenderer";

export interface CanvasTheme {
  river: string;
  riverHalo: string; // river label halo
  riverMinPx: number;
  roadCasing: string[]; // per tier
  roadFill: string[];
  roadDash: number[] | null;
  font: string; // font family stack
  nationLabel: string;
  nationHalo: string;
  provinceLabel: string;
  cityLabel: "box" | "ink" | "plain";
  ink: string;
  cityDot: string;
  districtLabel: string;
  seaRoute: string;
}

export const THEMES: Record<MapTheme, CanvasTheme> = {
  Realistic: {
    river: "#2f6f96",
    riverMinPx: 0.8,
    riverHalo: "rgba(255,255,255,0.55)",
    roadCasing: ["rgba(70,45,25,0.5)", "rgba(90,50,25,0.75)", "rgba(100,45,20,0.85)"],
    roadFill: ["rgba(201,160,103,0.9)", "rgba(222,176,105,1)", "rgba(240,196,110,1)"],
    roadDash: null,
    font: "system-ui, -apple-system, sans-serif",
    nationLabel: "rgba(35, 35, 40, 0.9)",
    nationHalo: "rgba(255, 255, 255, 0.6)",
    provinceLabel: "rgba(50, 50, 60, 0.75)",
    cityLabel: "box",
    ink: "#2b2520",
    cityDot: "#ffffff",
    districtLabel: "rgba(40, 30, 20, 0.85)",
    seaRoute: "rgba(225, 238, 248, 0.55)",
  },
  Historical: {
    river: "#4e6f7c",
    riverMinPx: 0.9,
    riverHalo: "rgba(255,255,255,0.55)",
    roadCasing: ["rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(0,0,0,0)"],
    roadFill: ["rgba(125,60,40,0.55)", "rgba(125,55,35,0.75)", "rgba(120,45,30,0.9)"],
    roadDash: [4, 3],
    font: "'IM Fell English', 'Palatino Linotype', Palatino, Georgia, serif",
    nationLabel: "rgba(70, 40, 25, 0.9)",
    nationHalo: "rgba(240, 225, 190, 0.7)",
    provinceLabel: "rgba(90, 60, 40, 0.8)",
    cityLabel: "ink",
    ink: "#3b2a1c",
    cityDot: "#3b2a1c",
    districtLabel: "rgba(70, 45, 25, 0.9)",
    seaRoute: "rgba(70, 50, 35, 0.55)",
  },
  Atlas: {
    river: "#5b9ccc",
    riverMinPx: 0.7,
    riverHalo: "rgba(255,255,255,0.55)",
    roadCasing: ["rgba(150,140,130,0.6)", "rgba(140,130,120,0.8)", "rgba(170,110,40,0.9)"],
    roadFill: ["rgba(255,255,255,0.9)", "rgba(255,255,255,1)", "rgba(255,214,120,1)"],
    roadDash: null,
    font: "'Segoe UI', system-ui, sans-serif",
    nationLabel: "rgba(30, 30, 35, 0.85)",
    nationHalo: "rgba(255, 255, 255, 0.75)",
    provinceLabel: "rgba(60, 60, 70, 0.7)",
    cityLabel: "plain",
    ink: "#333333",
    cityDot: "#222222",
    districtLabel: "rgba(50, 50, 60, 0.85)",
    seaRoute: "rgba(60, 110, 160, 0.55)",
  },
};

// Night variants for labels: pale lettering on dark halos over the moonlit map
const nightOf = (t: CanvasTheme): CanvasTheme => ({
  ...t,
  river: "#8fb8dc",
  riverHalo: "rgba(6, 10, 24, 0.7)",
  nationLabel: "rgba(236, 228, 208, 0.92)",
  nationHalo: "rgba(6, 10, 24, 0.72)",
  provinceLabel: "rgba(196, 206, 228, 0.8)",
  ink: "#ece2c8",
  districtLabel: "rgba(232, 222, 200, 0.9)",
});
export const NIGHT_THEMES: Record<MapTheme, CanvasTheme> = {
  Realistic: nightOf(THEMES.Realistic),
  Historical: nightOf(THEMES.Historical),
  Atlas: nightOf(THEMES.Atlas),
};

export function viewRect(width: number, height: number, scale: number, offsetX: number, offsetY: number) {
  return {
    x0: -offsetX / scale,
    y0: -offsetY / scale,
    x1: (width - offsetX) / scale,
    y1: (height - offsetY) / scale,
  };
}
