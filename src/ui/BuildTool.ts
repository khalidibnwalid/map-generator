import type { MapGenerator } from "../game/MapGenerator";
import type { City } from "../game/WorldData";
import type { Poi, PoiKind } from "../game/generators/generatePOIs";
import { POI_LABELS } from "../game/generators/generatePOIs";
import { cityNameFor, connectCity, finalizeCity, setCityPopulation } from "../game/generators";
import { nationFlagUrl } from "../game/flags";
import type { NationsManager } from "./NationsManager";
import { installSteppers } from "./components/NumberInput";

type SettlementTool = "village" | "town" | "city";
export type BuildToolKind = SettlementTool | PoiKind;
type Selection = { type: "city"; city: City } | { type: "poi"; poi: Poi } | null;

const SETTLEMENTS: { kind: SettlementTool; label: string; size: number }[] = [
  { kind: "village", label: "Village", size: 0 },
  { kind: "town", label: "Town", size: 1 },
  { kind: "city", label: "City", size: 2 },
];

const LANDMARKS: PoiKind[] = ["castle", "fort", "watchtower", "ruins", "inn", "bridge", "dam", "mine", "monastery", "port", "volcano"];

// Simple pictograms for the palette
const GLYPH: Record<string, string> = {
  village: `<circle cx="12" cy="13" r="3.2" fill="currentColor"/>`,
  town: `<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  city: `<rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9.5" y="9.5" width="5" height="5" fill="currentColor"/>`,
  castle: `<path d="M5 20V9h3V6h2v3h4V6h2v3h3v11z" fill="currentColor"/>`,
  fort: `<path d="M4 19V10l4-3 4 3 4-3 4 3v9z" fill="none" stroke="currentColor" stroke-width="2"/>`,
  watchtower: `<path d="M9 21l1-12h4l1 12M8 9h8l-1-4h-6z" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
  ruins: `<path d="M5 20v-8h3v8M10.5 20v-11h3v11M16 20v-6h3v6M3 20h18" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
  inn: `<path d="M4 20V11l8-6 8 6v9h-5v-5H9v5z" fill="currentColor"/>`,
  bridge: `<path d="M3 15h18M5 15v4M19 15v4M5 15c2-4 12-4 14 0" fill="none" stroke="currentColor" stroke-width="2"/>`,
  dam: `<path d="M4 7h16l-3 12H7z" fill="currentColor"/><path d="M2 21c3-1.5 5-1.5 8 0s5 1.5 8 0" stroke="currentColor" fill="none" stroke-width="1.6"/>`,
  mine: `<path d="M5 19l9-9M14 5l5 5-2 2-5-5zM6 14l4 4" fill="none" stroke="currentColor" stroke-width="2"/>`,
  monastery: `<path d="M6 20v-7a6 6 0 0 1 12 0v7zM12 3v3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="3" r="1.2" fill="currentColor"/>`,
  port: `<path d="M12 4v15M7 13c0 4 2.5 6 5 6s5-2 5-6M9 7h6" fill="none" stroke="currentColor" stroke-width="2"/>`,
  volcano: `<path d="M3 20l6-10h6l6 10zM10 6l1 3M14 6l-1 3M12 3v4" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
};
const glyph = (k: string) => `<svg viewBox="0 0 24 24" width="18" height="18">${GLYPH[k] ?? ""}</svg>`;

// Places, selects, edits and removes settlements and landmarks on the map
export class BuildTool {
  public tool: BuildToolKind | null = null;
  public selected: Selection = null;
  public onChanged: (() => void) | null = null;
  private generator: MapGenerator;
  private nations: NationsManager;

  constructor(generator: MapGenerator, nations: NationsManager) {
    this.generator = generator;
    this.nations = nations;
  }

  public setTool(t: BuildToolKind | null) {
    this.tool = this.tool === t ? null : t;
    this.render();
  }

  // Nearest settlement or landmark within a few screen pixels
  public pick(x: number, y: number, scale: number): Selection {
    const world = this.generator.getWorld();
    const W = world.width;
    const reach = Math.max(0.15, 14 / scale);
    const dist = (px: number, py: number) => {
      let dx = Math.abs(px - x);
      if (dx > W / 2) dx = W - dx;
      return Math.hypot(dx, py - y);
    };
    let best: Selection = null;
    let bestD = reach;
    for (const p of world.pois) {
      const d = dist(p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = { type: "poi", poi: p };
      }
    }
    for (const c of world.cities) {
      const d = dist(c.x, c.y) * 0.9; // settlements win close ties
      if (d < bestD) {
        bestD = d;
        best = { type: "city", city: c };
      }
    }
    return best;
  }

  public place(x: number, y: number): boolean {
    const t = this.tool;
    if (!t) return false;
    const world = this.generator.getWorld();
    const cell = world.getCell(x, y);
    if (!cell) return false;
    const settlement = SETTLEMENTS.find((s) => s.kind === t);
    if (settlement) {
      if (world.sampler.isWater(x, y)) return false;
      const nationIndex = cell.isWater ? -1 : (cell.nationIndex ?? -1);
      const city: City = {
        id: world.cities.length,
        name: cityNameFor(world, x, y, Math.random),
        x,
        y,
        nationIndex,
        provinceIndex: cell.provinceIndex ?? -1,
        isCapital: false,
        size: settlement.size,
        population: 0,
        radiusM: 0,
        seed: 0,
      };
      finalizeCity(world, city, cell.populationDensity);
      world.cities.push(city);
      connectCity(world, city);
      world.roadsEdited = true;
      this.selected = { type: "city", city };
    } else {
      const kind = t as PoiKind;
      const lang = world.languages[cell.cultureIndex ?? 0];
      const word = lang ? lang.word() : "Old";
      const names: Partial<Record<PoiKind, string>> = {
        fort: `${word} Gate`,
        inn: `${word} Inn`,
        watchtower: `${word} Watch`,
        monastery: `Zawiya of ${word}`,
        ruins: `Ruins of ${word}`,
        volcano: `Mount ${word}`,
        port: `Port of ${word}`,
      };
      const poi: Poi = {
        kind,
        x,
        y,
        angle: 0,
        name: names[kind] ?? `${word} ${POI_LABELS[kind]}`,
        nationIndex: cell.nationIndex ?? -1,
      };
      world.pois.push(poi);
      world.poisEdited = true;
      this.selected = { type: "poi", poi };
    }
    this.changed();
    return true;
  }

  public remove(sel: Selection) {
    if (!sel) return;
    const world = this.generator.getWorld();
    if (sel.type === "city") this.nations.deleteCity(sel.city.id);
    else {
      world.pois = world.pois.filter((p) => p !== sel.poi);
      world.poisEdited = true;
    }
    if (this.selected && (this.selected.type === "city" ? this.selected.city : this.selected.poi) === (sel.type === "city" ? sel.city : sel.poi))
      this.selected = null;
    this.changed();
  }

  private changed() {
    this.render();
    this.onChanged?.();
  }

  // Ring around the selected object (screen space)
  public drawOverlay(ctx: CanvasRenderingContext2D, scale: number, offX: number, offY: number, width: number) {
    const s = this.selected;
    if (!s) return;
    const world = this.generator.getWorld();
    const p = s.type === "city" ? s.city : s.poi;
    const r = Math.max(10, Math.min(28, scale * 0.6));
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#d4a85a";
    for (let copy = -1; copy <= 1; copy++) {
      const sx = (p.x + copy * world.width) * scale + offX;
      const sy = p.y * scale + offY;
      if (sx < -40 || sx > width + 40) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  public render() {
    const host = document.getElementById("build-panel");
    if (!host) return;
    const world = this.generator.getWorld();
    const btn = (k: string, label: string) =>
      `<button class="build-btn ${this.tool === k ? "active" : ""}" data-tool="${k}" title="${label}">${glyph(k)}<span>${label}</span></button>`;
    let html = `<p class="muted build-hint">${
      this.tool
        ? `Click the map to place a <strong>${(SETTLEMENTS.find((s) => s.kind === this.tool)?.label ?? POI_LABELS[this.tool as PoiKind]).toLowerCase()}</strong>. Esc to stop.`
        : "Pick something to place. Click an object on the map to edit it; right-click removes it."
    }</p>
      <div class="field-label">Settlements</div>
      <div class="build-grid">${SETTLEMENTS.map((s) => btn(s.kind, s.label)).join("")}</div>
      <div class="field-label">Landmarks</div>
      <div class="build-grid">${LANDMARKS.map((k) => btn(k, POI_LABELS[k].replace(" (Sufi lodge)", ""))).join("")}</div>`;

    const s = this.selected;
    if (s) {
      const owner = world.nations[s.type === "city" ? s.city.nationIndex : s.poi.nationIndex];
      const flag = owner ? `<img class="diplo-flag" src="${nationFlagUrl(world, world.nations.indexOf(owner), 18, 12)}" alt="">` : "";
      const kindLabel = s.type === "city" ? ["Village", "Town", "City"][s.city.size] ?? "Settlement" : POI_LABELS[s.poi.kind];
      html += `<div class="build-edit">
        <div class="build-edit-head">${glyph(s.type === "city" ? SETTLEMENTS[Math.min(2, s.city.size)].kind : s.poi.kind)}<span>${kindLabel}</span>
          <span class="build-owner">${flag}${owner ? owner.name : "Unclaimed"}</span></div>
        <label class="build-field"><span>Name</span><input id="build-name" type="text" /></label>
        ${
          s.type === "city"
            ? `<label class="build-field"><span>Population</span><input id="build-pop" type="number" min="0" step="1000" data-stepper /></label>
               <label class="build-check"><input id="build-capital" type="checkbox" ${s.city.isCapital ? "checked" : ""} ${s.city.nationIndex < 0 ? "disabled" : ""}/> Capital of its nation</label>`
            : ""
        }
        <button class="btn-ghost build-delete" id="build-delete">Remove</button>
      </div>`;
    }
    host.innerHTML = html;
    installSteppers(host);

    host.querySelectorAll<HTMLButtonElement>(".build-btn").forEach((b) =>
      b.addEventListener("click", () => this.setTool(b.dataset.tool as BuildToolKind)),
    );
    if (!s) return;
    const name = host.querySelector<HTMLInputElement>("#build-name")!;
    name.value = s.type === "city" ? s.city.name : s.poi.name;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v) return;
      if (s.type === "city") s.city.name = v;
      else {
        s.poi.name = v;
        world.poisEdited = true;
      }
      this.onChanged?.();
    });
    host.querySelector("#build-delete")!.addEventListener("click", () => this.remove(s));
    if (s.type !== "city") return;
    const pop = host.querySelector<HTMLInputElement>("#build-pop")!;
    pop.value = String(s.city.population);
    pop.addEventListener("change", () => {
      const v = Math.round(Number(pop.value));
      if (!(v > 0)) return;
      setCityPopulation(s.city, v);
      this.changed();
    });
    host.querySelector<HTMLInputElement>("#build-capital")!.addEventListener("change", (e) => {
      const c = s.city;
      const on = (e.target as HTMLInputElement).checked;
      const nation = world.nations[c.nationIndex];
      if (!nation) return;
      if (on) {
        for (const o of world.cities) if (o.nationIndex === c.nationIndex) o.isCapital = false;
        c.isCapital = true;
        nation.capitalX = c.x;
        nation.capitalY = c.y;
      } else c.isCapital = false;
      this.changed();
    });
  }
}
