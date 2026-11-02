import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { UIManager } from "./UIManager";
import { CELL_KM2 } from "../game/WorldData";
import { FAMILY_KEYS, Language, familyIndexOf, familyLabel, hslHex, randomRaceName } from "../game/names";
import { distanceTransform } from "../game/util/grid";
import { seededRand } from "../game/sim/Rulers";
import { createDropdown } from "./components/Dropdown";

interface RaceStats {
  land: number;
  population: number;
  nations: Map<number, number>; // nation index -> land cells
  cx: number;
  cy: number;
}

function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return Math.round(n).toString();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// The Races tab: peoples (Arabian, Hungarian...) as a layer of their own. A race
// has a name, a color, a language family and territory painted on the map;
// cultures belong to a race and speak its language.
export class RacesManager {
  public selected = -1;
  public isEditing = false;
  public isPainting = false;
  public brushSize = 6;
  public onChanged: (() => void) | null = null;
  public onEditToggle: ((on: boolean) => void) | null = null;
  public onHover: ((id: number) => void) | null = null; // -1 when the mouse leaves a row

  private stats: RaceStats[] = [];
  private lastX: number | null = null;
  private lastY: number | null = null;
  private changedQueued = false;
  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private uiManager: UIManager;

  constructor(generator: MapGenerator, canvasManager: CanvasManager, uiManager: UIManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.uiManager = uiManager;
  }

  private touch() {
    this.generator.getWorld().culturesEdited = true;
  }

  private queueChanged() {
    if (this.changedQueued) return;
    this.changedQueued = true;
    requestAnimationFrame(() => {
      this.changedQueued = false;
      this.onChanged?.();
    });
  }

  private computeStats() {
    const world = this.generator.getWorld();
    const W = world.width;
    const H = world.height;
    const n = world.races.length;
    this.stats = world.races.map(() => ({ land: 0, population: 0, nations: new Map(), cx: 0, cy: 0 }));
    const sinX = new Float64Array(n);
    const cosX = new Float64Array(n);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        const r = cell.raceIndex ?? -1;
        if (r < 0 || r >= n || cell.isWater) continue;
        const st = this.stats[r];
        st.land++;
        st.cy += y;
        sinX[r] += Math.sin((x / W) * Math.PI * 2);
        cosX[r] += Math.cos((x / W) * Math.PI * 2);
        const nat = cell.nationIndex ?? -1;
        if (nat >= 0) st.nations.set(nat, (st.nations.get(nat) ?? 0) + 1);
      }
    }
    this.stats.forEach((st, r) => {
      if (!st.land) return;
      st.cy = st.cy / st.land + 0.5;
      st.cx = (((Math.atan2(sinX[r], cosX[r]) / (Math.PI * 2)) * W + W) % W) + 0.5;
    });
    for (const city of world.cities) {
      const r = world.getCell(city.x, city.y)?.raceIndex ?? -1;
      if (r >= 0 && r < n) this.stats[r].population += city.population;
    }
  }

  public renderList() {
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === "INPUT" && active.closest("#races-list")) {
      active.dispatchEvent(new Event("change"));
      active.blur();
    }
    const list = document.getElementById("races-list");
    const head = document.getElementById("races-head");
    if (!list || !head) return;

    const world = this.generator.getWorld();
    this.computeStats();
    const landTotal = Math.max(1, this.stats.reduce((a, s) => a + s.land, 0));
    if (this.selected >= world.races.length) this.selected = -1;

    head.innerHTML = "";
    const addBtn = document.createElement("button");
    addBtn.className = "nation-add-btn";
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg><span>NEW RACE</span>`;
    addBtn.addEventListener("click", () => this.addRace());
    head.appendChild(addBtn);

    const edit = document.createElement("div");
    edit.className = `edit-mode-controls ${this.isEditing ? "edit-mode-active" : ""}`;
    edit.innerHTML = `
      <button class="btn-ghost" title="Paint the selected race's territory"><span>Paint territory</span></button>
      <div class="brush-size-control">
        <span class="brush-label-overlay">Brush</span>
        <input type="range" id="race-brush" min="1" max="20" value="${Math.min(20, this.brushSize)}" />
        <input type="number" id="race-brush-input" class="brush-number-input" min="1" max="100" value="${this.brushSize}" />
      </div>`;
    edit.querySelector("button")!.addEventListener("click", () => this.setEditing(!this.isEditing));
    const slider = edit.querySelector<HTMLInputElement>("#race-brush")!;
    const num = edit.querySelector<HTMLInputElement>("#race-brush-input")!;
    slider.addEventListener("input", () => {
      this.brushSize = Number(slider.value) || 1;
      num.value = String(this.brushSize);
    });
    num.addEventListener("change", () => {
      this.brushSize = Math.max(1, Math.min(100, Number(num.value) || 1));
      num.value = String(this.brushSize);
      slider.value = String(Math.min(20, this.brushSize));
    });
    head.appendChild(edit);
    if (this.isEditing && this.selected < 0) {
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.textContent = "Select a race below, then drag on the map to paint it.";
      head.appendChild(hint);
    }

    list.innerHTML = "";
    const order = world.races.map((_, i) => i).sort((a, b) => this.stats[b].land - this.stats[a].land);
    for (const idx of order) {
      const race = world.races[idx];
      const st = this.stats[idx];
      const item = document.createElement("div");
      item.className = `nation-item ${this.selected === idx ? "selected" : ""}`;

      const swatch = document.createElement("div");
      swatch.className = "nation-color-swatch-container";
      swatch.style.backgroundColor = race.color;
      const color = document.createElement("input");
      color.type = "color";
      color.className = "nation-color-input";
      color.value = race.color;
      color.addEventListener("input", () => {
        race.color = color.value;
        swatch.style.backgroundColor = race.color;
        this.touch();
        this.queueChanged();
      });
      color.addEventListener("mousedown", (e) => e.stopPropagation());
      color.addEventListener("click", (e) => e.stopPropagation());
      swatch.appendChild(color);

      const name = document.createElement("input");
      name.type = "text";
      name.className = "nation-name-input";
      name.value = race.name;
      name.addEventListener("change", () => {
        race.name = name.value.trim() || race.name;
        this.touch();
      });
      name.addEventListener("mousedown", (e) => e.stopPropagation());
      name.addEventListener("click", (e) => e.stopPropagation());

      const metric = document.createElement("span");
      metric.className = "nation-metric";
      const count = document.createElement("span");
      count.className = "nation-territory-count";
      count.textContent = `${((st.land / landTotal) * 100).toFixed(1)}%`;
      metric.appendChild(count);

      const del = document.createElement("button");
      del.className = "nation-delete-btn";
      del.title = "Delete race";
      del.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (world.races.length <= 1) {
          await this.uiManager.confirm("DELETE RACE", "A world needs at least one race.");
          return;
        }
        const ok = await this.uiManager.confirm("DELETE RACE", `Delete ${race.name}? Its land passes to the nearest neighboring race.`);
        if (ok) this.deleteRace(idx);
      });

      item.append(swatch, name, metric, del);
      item.addEventListener("mouseenter", () => this.onHover?.(idx));
      item.addEventListener("mouseleave", () => this.onHover?.(-1));
      item.addEventListener("click", () => {
        this.selected = idx;
        if (st.land) this.canvasManager.lookAt(st.cx, st.cy);
        this.renderList();
        this.canvasManager.scheduleRender();
      });
      list.appendChild(item);

      if (this.selected === idx) list.appendChild(this.detailsFor(idx, st, landTotal));
    }
  }

  private detailsFor(idx: number, st: RaceStats, landTotal: number): HTMLElement {
    const world = this.generator.getWorld();
    const race = world.races[idx];
    const box = document.createElement("div");
    box.className = "culture-details";
    const cultures = world.cultures.filter((c) => c.raceId === idx);
    const spans = [...st.nations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([n, cells]) => `${esc(world.nations[n]?.name ?? "?")} ${Math.round((cells / Math.max(1, st.land)) * 100)}%`)
      .join(" · ");
    box.innerHTML = `
      <div class="culture-race"><span>Language</span><span class="culture-race-slot"></span></div>
      <div class="culture-facts">
        <span>Area</span><b>${compact(st.land * CELL_KM2)} km²</b>
        <span>Share of land</span><b>${((st.land / landTotal) * 100).toFixed(1)}%</b>
        <span>Population</span><b>${compact(st.population)}</b>
        <span>Cultures</span><b>${cultures.length}</b>
        <span>Realms</span><b>${st.nations.size}</b>
      </div>
      ${cultures.length ? `<p class="muted culture-spans">${cultures.slice(0, 6).map((c) => esc(c.name)).join(" · ")}${cultures.length > 6 ? " …" : ""}</p>` : ""}
      ${spans ? `<p class="muted culture-spans">${spans}</p>` : ""}
      <button class="btn-ghost culture-rename" title="Give the towns and realms on this race's land new names in its language">Rename its towns and realms</button>`;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.querySelector(".culture-race-slot")!.appendChild(
      createDropdown({
        options: FAMILY_KEYS.map((k) => ({ value: k, label: familyLabel(k) })),
        value: race.family,
        onChange: (v) => {
          this.setFamily(idx, v);
          this.renderList();
        },
      }),
    );
    box.querySelector(".culture-rename")!.addEventListener("click", async () => {
      const ok = await this.uiManager.confirm("RENAME PLACES", `Give the towns and realms of ${race.name} new names (${familyLabel(race.family)})?`);
      if (ok) this.renamePlaces(idx);
    });
    return box;
  }

  public setEditing(on: boolean) {
    if (this.isEditing === on) return;
    this.isEditing = on;
    if (!on) this.stopPainting();
    this.onEditToggle?.(on);
    this.renderList();
  }

  // --- Edits ---

  private languageFor(id: number, family: string) {
    const world = this.generator.getWorld();
    return new Language(seededRand(world.seed ^ (id * 7919) ^ (familyIndexOf(family) * 104729)), familyIndexOf(family));
  }

  // Every culture of the race now speaks the new family
  private setFamily(idx: number, family: string) {
    const world = this.generator.getWorld();
    const race = world.races[idx];
    race.family = family;
    for (const c of world.cultures) if (c.raceId === idx) world.languages[c.id] = this.languageFor(c.id, family);
    this.touch();
  }

  // Towns and realms on the race's land get names from its language
  private renamePlaces(idx: number) {
    const world = this.generator.getWorld();
    const lang = this.languageFor(1000 + idx, world.races[idx].family);
    for (const city of world.cities) {
      if ((world.getCell(city.x, city.y)?.raceIndex ?? -1) === idx) city.name = lang.townName();
    }
    const taken = new Set(world.nations.map((n) => n.name));
    for (const nation of world.nations) {
      if ((world.getCell(nation.capitalX, nation.capitalY)?.raceIndex ?? -1) !== idx) continue;
      let name = lang.nationName();
      for (let k = 0; k < 12 && taken.has(name); k++) name = lang.nationName();
      taken.add(name);
      nation.name = name;
      nation.flag = undefined;
    }
    this.touch();
    this.canvasManager.scheduleRender();
    this.onChanged?.();
  }

  public addRace() {
    const world = this.generator.getWorld();
    const id = world.races.length;
    // A family no race speaks yet, when there is one
    const used = new Set(world.races.map((r) => r.family));
    const free = FAMILY_KEYS.filter((k) => !used.has(k));
    const pool = free.length ? free : FAMILY_KEYS;
    const family = pool[Math.floor(Math.random() * pool.length)];
    world.races.push({ id, name: randomRaceName(Math.random, familyIndexOf(family)), color: hslHex((id * 83 + 12) % 360, 0.55, 0.55), family });
    this.selected = id;
    this.touch();
    this.setEditing(true); // a new race has no land: paint some
    this.renderList();
    this.onChanged?.();
  }

  public deleteRace(id: number) {
    const world = this.generator.getWorld();
    if (world.races.length <= 1) return;
    const W = world.width;
    const H = world.height;
    const site = new Uint8Array(W * H);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const r = world.grid[x][y].raceIndex ?? -1;
        if (r >= 0 && r !== id) site[y * W + x] = 1;
      }
    const { nearest } = distanceTransform(W, H, site);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.raceIndex !== id) continue;
        const n = nearest[y * W + x];
        cell.raceIndex = n >= 0 ? world.grid[n % W][Math.floor(n / W)].raceIndex : 0;
      }
    // Cultures of the deleted race join the race that now holds most of their land
    const tally = new Map<number, Map<number, number>>();
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        const c = cell.cultureIndex ?? -1;
        if (c < 0 || world.cultures[c]?.raceId !== id || cell.raceIndex === undefined) continue;
        const m = tally.get(c) ?? new Map<number, number>();
        m.set(cell.raceIndex, (m.get(cell.raceIndex) ?? 0) + 1);
        tally.set(c, m);
      }
    for (const culture of world.cultures) {
      if (culture.raceId !== id) continue;
      const m = tally.get(culture.id);
      culture.raceId = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
    }
    const shift = (v: number) => (v > id ? v - 1 : v);
    world.races.splice(id, 1);
    world.races.forEach((r, i) => (r.id = i));
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.raceIndex !== undefined) cell.raceIndex = shift(cell.raceIndex);
      }
    for (const culture of world.cultures) {
      culture.raceId = shift(culture.raceId ?? 0);
      world.languages[culture.id] = this.languageFor(culture.id, world.races[culture.raceId]?.family ?? FAMILY_KEYS[0]);
    }
    this.selected = -1;
    this.touch();
    this.renderList();
    this.canvasManager.scheduleRender();
    this.onChanged?.();
  }

  // --- Painting ---

  public startPainting() {
    if (this.selected < 0) return;
    this.isPainting = true;
    this.lastX = null;
    this.lastY = null;
  }

  public handlePainting(clientX: number, clientY: number) {
    if (!this.isPainting || this.selected < 0) return;
    const cm = this.canvasManager;
    const rect = cm.canvas.getBoundingClientRect();
    const wx = Math.floor((clientX - rect.left - cm.offsetX) / cm.scale);
    const wy = Math.floor((clientY - rect.top - cm.offsetY) / cm.scale);
    const x0 = this.lastX ?? wx;
    const y0 = this.lastY ?? wy;
    const steps = Math.max(1, Math.ceil(Math.hypot(wx - x0, wy - y0) / Math.max(1, this.brushSize / 3)));
    for (let s = 1; s <= steps; s++) this.paintAt(Math.round(x0 + ((wx - x0) * s) / steps), Math.round(y0 + ((wy - y0) * s) / steps));
    this.lastX = wx;
    this.lastY = wy;
    this.touch();
    this.queueChanged();
  }

  private paintAt(cx: number, cy: number) {
    const world = this.generator.getWorld();
    const r = this.brushSize / 2;
    const reach = Math.ceil(r);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        if (dx * dx + dy * dy > r * r + 0.25) continue;
        const y = cy + dy;
        if (y < 0 || y >= world.height) continue;
        const x = (((cx + dx) % world.width) + world.width) % world.width;
        const cell = world.grid[x][y];
        if (!cell.isWater) cell.raceIndex = this.selected;
      }
    }
  }

  public stopPainting() {
    if (!this.isPainting) return;
    this.isPainting = false;
    this.lastX = null;
    this.lastY = null;
    this.renderList();
    this.canvasManager.scheduleRender();
  }
}
