import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { UIManager } from "./UIManager";
import { CELL_KM2 } from "../game/WorldData";
import { FAMILY_KEYS, Language, familyIndexOf, familyLabel, hslHex } from "../game/names";
import { cityNameFor } from "../game/generators";
import { distanceTransform } from "../game/util/grid";
import { seededRand } from "../game/sim/Rulers";
import { createDropdown } from "./components/Dropdown";
import { emblemUrl } from "../game/emblem";
import { LogoEditor } from "./LogoEditor";

interface CultureStats {
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

// The Cultures tab: peoples with a name, color and race (language family),
// editable like nations, including painting their territory on the map.
export class CulturesManager {
  public selected = -1;
  public isEditing = false;
  public isPainting = false;
  public brushSize = 4;
  // Tells the app the culture layer changed (repaint the overlay) / edit mode flipped
  public onChanged: (() => void) | null = null;
  public onEditToggle: ((on: boolean) => void) | null = null;
  public onHover: ((id: number) => void) | null = null; // -1 when the mouse leaves a row

  private stats: CultureStats[] = [];
  private lastX: number | null = null;
  private lastY: number | null = null;
  private changedQueued = false;

  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private uiManager: UIManager;
  private logoEditor: LogoEditor | null = null; // built on first use

  constructor(generator: MapGenerator, canvasManager: CanvasManager, uiManager: UIManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.uiManager = uiManager;
  }

  private touch() {
    this.generator.getWorld().culturesEdited = true;
  }

  // The map overlay is rebuilt at most once per frame while painting
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
    const n = world.cultures.length;
    this.stats = world.cultures.map(() => ({ land: 0, population: 0, nations: new Map(), cx: 0, cy: 0 }));
    const sinX = new Float64Array(n);
    const cosX = new Float64Array(n);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        const c = cell.cultureIndex ?? -1;
        if (c < 0 || c >= n || cell.isWater) continue;
        const st = this.stats[c];
        st.land++;
        st.cy += y;
        sinX[c] += Math.sin((x / W) * Math.PI * 2);
        cosX[c] += Math.cos((x / W) * Math.PI * 2);
        const nat = cell.nationIndex ?? -1;
        if (nat >= 0) st.nations.set(nat, (st.nations.get(nat) ?? 0) + 1);
      }
    }
    this.stats.forEach((st, c) => {
      if (!st.land) return;
      st.cy = st.cy / st.land + 0.5;
      st.cx = (((Math.atan2(sinX[c], cosX[c]) / (Math.PI * 2)) * W + W) % W) + 0.5;
    });
    for (const city of world.cities) {
      const c = world.getCell(city.x, city.y)?.cultureIndex ?? -1;
      if (c >= 0 && c < n) this.stats[c].population += city.population;
    }
  }

  public renderList() {
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === "INPUT" && active.closest("#cultures-list")) {
      active.dispatchEvent(new Event("change"));
      active.blur();
    }
    const list = document.getElementById("cultures-list");
    const head = document.getElementById("cultures-head");
    if (!list || !head) return;

    const world = this.generator.getWorld();
    this.computeStats();
    const landTotal = Math.max(1, this.stats.reduce((a, s) => a + s.land, 0));
    if (this.selected >= world.cultures.length) this.selected = -1;

    // --- Header: new culture, edit toggle, brush ---
    head.innerHTML = "";
    const addBtn = document.createElement("button");
    addBtn.className = "nation-add-btn";
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg><span>NEW CULTURE</span>`;
    addBtn.addEventListener("click", () => this.addCulture());
    head.appendChild(addBtn);

    const edit = document.createElement("div");
    edit.className = `edit-mode-controls ${this.isEditing ? "edit-mode-active" : ""}`;
    edit.innerHTML = `
      <button class="btn-ghost" title="Paint the selected culture's territory"><span>Paint territory</span></button>
      <div class="brush-size-control">
        <span class="brush-label-overlay">Brush</span>
        <input type="range" id="culture-brush" min="1" max="20" value="${Math.min(20, this.brushSize)}" />
        <input type="number" id="culture-brush-input" class="brush-number-input" min="1" max="100" value="${this.brushSize}" />
      </div>`;
    edit.querySelector("button")!.addEventListener("click", () => this.setEditing(!this.isEditing));
    const slider = edit.querySelector<HTMLInputElement>("#culture-brush")!;
    const num = edit.querySelector<HTMLInputElement>("#culture-brush-input")!;
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
      hint.textContent = "Select a culture below, then drag on the map to paint it.";
      head.appendChild(hint);
    }

    // --- Rows, largest first ---
    list.innerHTML = "";
    const order = world.cultures.map((_, i) => i).sort((a, b) => this.stats[b].land - this.stats[a].land);
    for (const idx of order) {
      const culture = world.cultures[idx];
      const st = this.stats[idx];
      const item = document.createElement("div");
      item.className = `nation-item ${this.selected === idx ? "selected" : ""}`;

      const swatch = document.createElement("div");
      swatch.className = "nation-color-swatch-container";
      swatch.style.backgroundColor = culture.color;
      const color = document.createElement("input");
      color.type = "color";
      color.className = "nation-color-input";
      color.value = culture.color;
      color.addEventListener("input", () => {
        culture.color = color.value;
        swatch.style.backgroundColor = culture.color;
        this.touch();
        this.queueChanged();
      });
      color.addEventListener("mousedown", (e) => e.stopPropagation());
      color.addEventListener("click", (e) => e.stopPropagation());
      swatch.appendChild(color);

      const name = document.createElement("input");
      name.type = "text";
      name.className = "nation-name-input";
      name.value = culture.name;
      name.addEventListener("change", () => {
        culture.name = name.value.trim() || culture.name;
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
      del.title = "Delete culture";
      del.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (world.cultures.length <= 1) {
          await this.uiManager.confirm("DELETE CULTURE", "A world needs at least one culture.");
          return;
        }
        const ok = await this.uiManager.confirm(
          "DELETE CULTURE",
          `Delete ${culture.name}? Its land passes to the nearest neighboring culture.`,
        );
        if (ok) this.deleteCulture(idx);
      });

      const logo = document.createElement("img");
      logo.className = "culture-logo";
      logo.src = emblemUrl(culture, world.languages[idx]?.family.key ?? "Latin", 22);
      logo.alt = "";
      logo.title = "Edit logo";
      logo.addEventListener("click", (e) => {
        e.stopPropagation();
        this.editLogo(idx);
      });
      item.append(swatch, logo, name, metric, del);
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

  private detailsFor(idx: number, st: CultureStats, landTotal: number): HTMLElement {
    const world = this.generator.getWorld();
    const culture = world.cultures[idx];
    const family = world.languages[idx]?.family.key ?? FAMILY_KEYS[0];
    const box = document.createElement("div");
    box.className = "culture-details";

    const spans = [...st.nations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([n, cells]) => `${esc(world.nations[n]?.name ?? "?")} ${Math.round((cells / Math.max(1, st.land)) * 100)}%`)
      .join(" · ");
    box.innerHTML = `
      <div class="culture-logo-row">
        <img class="culture-logo big" src="${emblemUrl(culture, family, 52)}" alt="" title="Edit logo" />
        <button class="btn-ghost" data-act="edit-logo">Edit logo</button>
      </div>
      <div class="culture-race"><span>Race</span><span class="culture-race-slot"></span></div>
      <div class="culture-facts">
        <span>Area</span><b>${compact(st.land * CELL_KM2)} km²</b>
        <span>Share of land</span><b>${((st.land / landTotal) * 100).toFixed(1)}%</b>
        <span>Population</span><b>${compact(st.population)}</b>
        <span>Realms</span><b>${st.nations.size}</b>
      </div>
      ${spans ? `<p class="muted culture-spans">${spans}</p>` : ""}
      <button class="btn-ghost culture-rename" title="Give this culture's towns and realms new names in its language">Rename its towns and realms</button>`;

    box.addEventListener("click", (e) => e.stopPropagation());
    box.querySelector(".culture-logo")!.addEventListener("click", () => this.editLogo(idx));
    box.querySelector('[data-act="edit-logo"]')!.addEventListener("click", () => this.editLogo(idx));
    box.querySelector(".culture-race-slot")!.appendChild(
      createDropdown({
        options: world.races.map((r) => ({ value: String(r.id), label: r.name, color: r.color })),
        value: String(culture.raceId ?? 0),
        onChange: (v) => {
          this.setRace(idx, Number(v));
          this.renderList();
        },
      }),
    );
    box.querySelector(".culture-rename")!.addEventListener("click", async () => {
      const ok = await this.uiManager.confirm(
        "RENAME PLACES",
        `Give the towns and realms of ${culture.name} new names (${familyLabel(family)})?`,
      );
      if (ok) this.renamePlaces(idx);
    });
    return box;
  }

  private editLogo(idx: number) {
    this.logoEditor ??= new LogoEditor();
    this.logoEditor.open(this.generator.getWorld(), idx, () => {
      this.renderList();
      this.onChanged?.();
    });
  }

  public setEditing(on: boolean) {
    if (this.isEditing === on) return;
    this.isEditing = on;
    if (!on) this.stopPainting();
    this.onEditToggle?.(on);
    this.renderList();
  }

  // --- Edits ---

  // A culture speaks its race's language family
  private setRace(idx: number, raceId: number) {
    const world = this.generator.getWorld();
    const key = world.races[raceId]?.family ?? world.languages[idx].family.key;
    world.cultures[idx].raceId = raceId;
    world.languages[idx] = new Language(seededRand(world.seed ^ (idx * 7919) ^ (familyIndexOf(key) * 104729)), familyIndexOf(key));
    this.touch();
  }

  // Towns and realms of this culture get names from its (possibly new) language
  private renamePlaces(idx: number) {
    const world = this.generator.getWorld();
    const lang = world.languages[idx];
    if (!lang) return;
    for (const city of world.cities) {
      if ((world.getCell(city.x, city.y)?.cultureIndex ?? -1) === idx) city.name = cityNameFor(world, city.x, city.y, Math.random);
    }
    const taken = new Set(world.nations.map((n) => n.name));
    for (const nation of world.nations) {
      if (nation.cultureId !== idx) continue;
      let name = lang.nationName();
      for (let k = 0; k < 12 && taken.has(name); k++) name = lang.nationName();
      taken.add(name);
      nation.name = name;
      nation.flag = undefined; // regenerated for the new name and race
    }
    this.touch();
    this.canvasManager.scheduleRender();
    this.onChanged?.();
  }

  public addCulture() {
    const world = this.generator.getWorld();
    const id = world.cultures.length;
    const race = world.races[Math.floor(Math.random() * world.races.length)];
    const family = race?.family ?? FAMILY_KEYS[0];
    const lang = new Language(seededRand(world.seed ^ (id * 7919) ^ Date.now()), familyIndexOf(family));
    world.languages.push(lang);
    world.cultures.push({
      id,
      name: lang.cultureName(),
      color: hslHex((id * 137.508 + 20) % 360, 0.5, 0.58),
      centerX: world.width / 2,
      centerY: world.height / 2,
      raceId: race?.id,
    });
    this.selected = id;
    this.touch();
    this.setEditing(true); // the new culture has no land: paint some
    this.renderList();
    this.onChanged?.();
  }

  public deleteCulture(id: number) {
    const world = this.generator.getWorld();
    if (world.cultures.length <= 1) return;
    const W = world.width;
    const H = world.height;
    const N = W * H;
    // Orphaned land joins the nearest other culture
    const site = new Uint8Array(N);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const c = world.grid[x][y].cultureIndex ?? -1;
        if (c >= 0 && c !== id) site[y * W + x] = 1;
      }
    const { nearest } = distanceTransform(W, H, site);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.cultureIndex !== id) continue;
        const n = nearest[y * W + x];
        cell.cultureIndex = n >= 0 ? world.grid[n % W][Math.floor(n / W)].cultureIndex : 0;
      }
    for (const nation of world.nations) {
      if (nation.cultureId === id) nation.cultureId = world.getCell(nation.capitalX, nation.capitalY)?.cultureIndex ?? 0;
    }
    const shift = (v: number) => (v > id ? v - 1 : v);
    world.cultures.splice(id, 1);
    world.languages.splice(id, 1);
    world.cultures.forEach((c, i) => (c.id = i));
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.cultureIndex !== undefined) cell.cultureIndex = shift(cell.cultureIndex);
      }
    for (const nation of world.nations) if (nation.cultureId !== undefined) nation.cultureId = shift(nation.cultureId);
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
    // Walk from the previous point so quick strokes leave no gaps
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
        if (!cell.isWater) cell.cultureIndex = this.selected;
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
