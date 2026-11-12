import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { UIManager } from "./UIManager";
import type { CellData, WorldData } from "../game/WorldData";
import { CELL_KM2 } from "../game/WorldData";
import { distanceTransform } from "../game/util/grid";
import { compact } from "./AtlasRender";
import { syncSliders } from "./components/Slider";

// What the Cultures and Races tabs share: a sortable list of peoples with
// inline rename and recolor, details on expand, hover and click on the map,
// and a territory brush that paints, mixes, unmixes or erases. Edits change the
// world directly; the edit history records them like any other change.

export type PeopleKind = "cultures" | "races";
// paint: the group becomes the cell's only people · mix: it joins as a minority
// unmix: the minority leaves · erase: the land becomes uninhabited
export type BrushMode = "paint" | "mix" | "unmix" | "erase";
type SortKey = "name" | "area" | "population" | "realms";
type PrimaryField = "cultureIndex" | "raceIndex";
type SecondaryField = "culture2Index" | "race2Index";

export interface Group {
  id: number;
  name: string;
  color: string;
}

export interface PeopleStats {
  land: number; // cells where the group is the main people, shared or not
  shared: number; // of those, cells with a minority living alongside
  minority: number; // cells where the group is the minority
  weight: number; // land in effect: a shared cell counts half to each people
  population: number; // towns on shared cells count half to each
  nations: Map<number, number>; // realm -> cells of presence
  cx: number; // center of presence (x wraps around the world)
  cy: number;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "area", label: "Area" },
  { key: "population", label: "Pop." },
  { key: "realms", label: "Realms" },
];

const MODES: { key: BrushMode; label: string; title: string }[] = [
  { key: "paint", label: "Paint", title: "The selected group becomes the only people on painted land" },
  { key: "mix", label: "Mix", title: "Add the selected group as a minority on painted land (mixed land)" },
  { key: "unmix", label: "Unmix", title: "Remove the minority from painted land; the main people stays" },
  { key: "erase", label: "Erase", title: "Painted land becomes uninhabited" },
];

export const PLUS = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.59,16.59L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.59Z"/></svg>`;
const PIN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12,2c-4.42,0-8,3.58-8,8c0,5.25,8,12,8,12s8-6.75,8-12C20,5.58,16.42,2,12,2z M12,13c-1.66,0-3-1.34-3-3s1.34-3,3-3s3,1.34,3,3S13.66,13,12,13z"/></svg>`;
const BRUSH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/></svg>`;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export abstract class PeopleManager<T extends Group> {
  public selected = -1;
  public isEditing = false;
  public isPainting = false;
  public brushSize = 4;
  public mode: BrushMode = "paint";
  // The layer changed: repaint the map overlay. `meta`: names, colors or the
  // groups themselves changed (the legend follows), not just painted cells.
  public onChanged: ((meta?: boolean) => void) | null = null;
  public onEditToggle: ((on: boolean) => void) | null = null;
  public onHover: ((id: number) => void) | null = null; // -1 when nothing is hovered

  protected abstract readonly kind: PeopleKind;
  protected abstract readonly noun: string; // "culture"
  protected abstract readonly field: PrimaryField;
  protected abstract readonly field2: SecondaryField;

  protected stats: PeopleStats[] = [];
  private uninhabited = 0;
  private landCells = 1;
  private expanded = new Set<number>();
  private sortKey: SortKey = "area";
  private sortDesc = true;
  private mapHover = -1; // group under the mouse on the map
  private lastX: number | null = null;
  private lastY: number | null = null;
  private changedQueued = false;

  protected generator: MapGenerator;
  protected canvasManager: CanvasManager;
  protected uiManager: UIManager;

  constructor(generator: MapGenerator, canvasManager: CanvasManager, uiManager: UIManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.uiManager = uiManager;
    // Escape leaves paint mode
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isEditing && this.isOpen()) this.setEditing(false);
    });
  }

  // --- What each kind of people provides ---

  protected abstract items(world: WorldData): T[];
  // The group's round emblem, or null for none
  protected abstract emblem(idx: number, size: number): string | null;
  // Opens an emblem editor; absent = emblems cannot be edited
  protected editEmblem?(idx: number): void;
  // Rows of the details box above the shared facts (race, language...)
  protected abstract detailRows(box: HTMLElement, idx: number): void;
  // Buttons of the details box after the shared ones
  protected abstract detailActions(box: HTMLElement, idx: number): void;
  // Adds a group and returns its index
  protected abstract create(world: WorldData): number;
  // Before the group is removed: other objects that point at it follow
  // (cells already belong to the neighbors that took its land)
  protected abstract beforeRemove(world: WorldData, id: number): void;
  // After the group was removed: indices above `id` moved down by one
  protected abstract afterRemove(world: WorldData, id: number, shift: (v: number) => number): void;

  // --- Shared plumbing ---

  private isOpen() {
    return !!document.getElementById(`content-${this.kind}`)?.classList.contains("active");
  }

  protected touch() {
    this.generator.getWorld().culturesEdited = true;
  }

  // The map overlay is rebuilt at most once per frame while painting
  protected queueChanged() {
    if (this.changedQueued) return;
    this.changedQueued = true;
    requestAnimationFrame(() => {
      this.changedQueued = false;
      this.onChanged?.();
    });
  }

  // Names, colors or the groups themselves changed
  protected metaChanged() {
    this.touch();
    this.onChanged?.(true);
  }

  private cellAt(clientX: number, clientY: number): CellData | null {
    const cm = this.canvasManager;
    const world = this.generator.getWorld();
    const rect = cm.canvas.getBoundingClientRect();
    const wx = Math.floor((clientX - rect.left - cm.offsetX) / cm.scale);
    const wy = Math.floor((clientY - rect.top - cm.offsetY) / cm.scale);
    if (wy < 0 || wy >= world.height) return null;
    return world.grid[((wx % world.width) + world.width) % world.width][wy];
  }

  private groupAt(clientX: number, clientY: number): number {
    const cell = this.cellAt(clientX, clientY);
    const n = this.items(this.generator.getWorld()).length;
    const id = cell && !cell.isWater ? (cell[this.field] ?? -1) : -1;
    return id < n ? id : -1;
  }

  // The brush needs a group to put down (painting and mixing do)
  public get needsGroup() {
    return this.mode === "paint" || this.mode === "mix";
  }

  // The brush ring on the map: the color it lays down
  public brushColor(): string {
    if (this.mode === "erase") return "rgba(239, 107, 107, 0.95)";
    if (this.mode === "unmix") return "rgba(239, 228, 204, 0.9)";
    return this.items(this.generator.getWorld())[this.selected]?.color ?? "rgba(212, 168, 90, 0.9)";
  }

  // --- Map interaction (called by the interface) ---

  // A click on the map: selects the group there, unless it is a brush stroke
  public clickMap(clientX: number, clientY: number) {
    if (this.isEditing && !(this.needsGroup && this.selected < 0)) return;
    this.pickAt(clientX, clientY);
  }

  // Selects the group under the cursor and scrolls the list to it
  public pickAt(clientX: number, clientY: number): boolean {
    const id = this.groupAt(clientX, clientY);
    if (id < 0) return false;
    if (id !== this.selected) {
      this.selected = id;
      this.renderList();
      this.canvasManager.scheduleRender();
    }
    this.revealSelected();
    return true;
  }

  // The mouse moved over the map: light up the group under it and its row
  public hoverMap(clientX: number | null, clientY = 0) {
    const id = clientX === null || this.isPainting ? -1 : this.groupAt(clientX, clientY);
    if (id !== this.mapHover) {
      this.mapHover = id;
      document.querySelectorAll(`#${this.kind}-list .nation-item.hovered`).forEach((el) => el.classList.remove("hovered"));
      if (id >= 0) document.querySelector(`#${this.kind}-list .nation-item[data-index="${id}"]`)?.classList.add("hovered");
    }
    this.onHover?.(id); // the interface ignores repeats
  }

  // Scrolls the list to the selected group (after a map click)
  public revealSelected() {
    document.querySelector(`#${this.kind}-list .nation-item.selected`)?.scrollIntoView({ block: "nearest" });
  }

  // Frames the group's land: where it is the main people, else where it is a
  // minority. Far-flung pockets are left out so the core fills the view.
  public locate(idx: number) {
    const world = this.generator.getWorld();
    const st = this.stats[idx];
    if (!st || !(st.land + st.minority)) return;
    const W = world.width;
    const f = st.land ? this.field : this.field2;
    const { cx, cy } = st;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = 0; x < W; x++)
      for (let y = 0; y < world.height; y++) {
        const cell = world.grid[x][y];
        if (cell.isWater || cell[f] !== idx) continue;
        xs.push(x + 0.5);
        ys.push(y + 0.5);
      }
    const spread = (d: number[]) => d.sort((a, b) => a - b)[Math.floor((d.length - 1) * 0.92)] ?? 0;
    const ex = spread(xs.map((x) => Math.min(Math.abs(x - cx), W - Math.abs(x - cx))));
    const ey = spread(ys.map((y) => Math.abs(y - cy)));
    const cm = this.canvasManager;
    const fit = Math.min(cm.getWidth() / (2 * ex + 6), cm.getHeight() / (2 * ey + 6)) * 0.75;
    cm.lookAt(cx, cy, Math.max(0.5, Math.min(fit, 40)));
  }

  // --- Stats ---

  private computeStats() {
    const world = this.generator.getWorld();
    const W = world.width;
    const H = world.height;
    const n = this.items(world).length;
    const f = this.field;
    const f2 = this.field2;
    this.stats = Array.from({ length: n }, () => ({ land: 0, shared: 0, minority: 0, weight: 0, population: 0, nations: new Map(), cx: 0, cy: 0 }));
    // Center sums per group: [2i] where it is the main people, [2i+1] where a minority
    const sinX = new Float64Array(2 * n);
    const cosX = new Float64Array(2 * n);
    const sumY = new Float64Array(2 * n);
    let land = 0;
    let empty = 0;
    const present = (id: number, x: number, y: number, nat: number, minority: number) => {
      const st = this.stats[id];
      const k = 2 * id + minority;
      sumY[k] += y;
      sinX[k] += Math.sin((x / W) * Math.PI * 2);
      cosX[k] += Math.cos((x / W) * Math.PI * 2);
      if (nat >= 0) st.nations.set(nat, (st.nations.get(nat) ?? 0) + 1);
    };
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell.isWater) continue;
        land++;
        const p = cell[f] ?? -1;
        if (p < 0 || p >= n) {
          empty++;
          continue;
        }
        const s = cell[f2] ?? -1;
        const mixed = s >= 0 && s < n && s !== p;
        const nat = cell.nationIndex ?? -1;
        const st = this.stats[p];
        st.land++;
        st.weight += mixed ? 0.5 : 1;
        present(p, x, y, nat, 0);
        if (mixed) {
          st.shared++;
          this.stats[s].minority++;
          this.stats[s].weight += 0.5;
          present(s, x, y, nat, 1);
        }
      }
    }
    // Centered on its own land, or on where it lives as a minority when it has none
    this.stats.forEach((st, i) => {
      const cells = st.land || st.minority;
      if (!cells) return;
      const k = 2 * i + (st.land ? 0 : 1);
      st.cy = sumY[k] / cells + 0.5;
      st.cx = (((Math.atan2(sinX[k], cosX[k]) / (Math.PI * 2)) * W + W) % W) + 0.5;
    });
    for (const city of world.cities) {
      const cell = world.getCell(city.x, city.y);
      const p = cell?.[f] ?? -1;
      if (p < 0 || p >= n) continue;
      const s = cell?.[f2] ?? -1;
      if (s >= 0 && s < n && s !== p) {
        this.stats[p].population += city.population / 2;
        this.stats[s].population += city.population / 2;
      } else this.stats[p].population += city.population;
    }
    this.landCells = Math.max(1, land);
    this.uninhabited = empty;
  }

  private share(st: PeopleStats) {
    return `${((st.weight / this.landCells) * 100).toFixed(1)}%`;
  }

  private metricText(idx: number): string {
    const st = this.stats[idx];
    switch (this.sortKey) {
      case "population":
        return `${compact(st.population)} ppl`;
      case "realms":
        return `${st.nations.size} realms`;
      default:
        return `${compact(st.weight * CELL_KM2)} km²`;
    }
  }

  // --- The list ---

  public renderList() {
    // Commit a half-typed name before the inputs are rebuilt
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === "INPUT" && active.closest(`#${this.kind}-list`)) {
      active.dispatchEvent(new Event("change"));
      active.blur();
    }
    const list = document.getElementById(`${this.kind}-list`);
    const head = document.getElementById(`${this.kind}-head`);
    if (!list || !head) return;

    const world = this.generator.getWorld();
    const groups = this.items(world);
    this.computeStats();
    if (this.selected >= groups.length) this.selected = -1;
    for (const i of this.expanded) if (i >= groups.length) this.expanded.delete(i);

    head.innerHTML = "";
    head.appendChild(this.paintControls());
    const addBtn = document.createElement("button");
    addBtn.className = "nation-add-btn";
    addBtn.innerHTML = `${PLUS}<span>NEW ${this.noun.toUpperCase()}</span>`;
    addBtn.title = `Add a ${this.noun}, then paint its land`;
    addBtn.addEventListener("click", () => this.addGroup());
    head.appendChild(addBtn);
    head.appendChild(this.sortBar());

    list.innerHTML = "";
    const value = (i: number): number | string => {
      const st = this.stats[i];
      switch (this.sortKey) {
        case "name":
          return groups[i].name.toLowerCase();
        case "population":
          return st.population;
        case "realms":
          return st.nations.size;
        default:
          return st.weight;
      }
    };
    const order = groups.map((_, i) => i);
    order.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return this.sortDesc ? -c : c;
    });
    for (const idx of order) {
      list.appendChild(this.row(idx));
      if (this.expanded.has(idx)) list.appendChild(this.details(idx));
    }

    // Land no people lives on
    if (this.uninhabited) {
      const item = document.createElement("div");
      item.className = "nation-item unaffiliated";
      item.title = "Land without people (deserts, peaks, ice...). Paint a group there to settle it, or erase to clear land.";
      item.innerHTML = `<span class="nation-toggle-btn"></span><div class="nation-color-swatch-container"><div class="nation-color-swatch" style="background:#666"></div></div><span class="nation-name-label" style="color:var(--faint)">UNINHABITED</span><span class="nation-territory-count">${compact(this.uninhabited * CELL_KM2)} km² · ${((this.uninhabited / this.landCells) * 100).toFixed(1)}%</span>`;
      list.appendChild(item);
    }
  }

  private sortBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "nation-sort";
    for (const { key, label } of SORTS) {
      const b = document.createElement("button");
      b.className = `nation-sort-btn ${this.sortKey === key ? "active" : ""}`;
      b.textContent = label;
      b.title = `Sort by ${label.toLowerCase()}`;
      b.addEventListener("click", () => {
        if (this.sortKey === key) this.sortDesc = !this.sortDesc;
        else {
          this.sortKey = key;
          this.sortDesc = key !== "name";
        }
        this.renderList();
      });
      bar.appendChild(b);
    }
    const dir = document.createElement("button");
    dir.className = "nation-sort-dir";
    dir.title = this.sortDesc ? "Descending" : "Ascending";
    dir.textContent = this.sortDesc ? "↓" : "↑";
    dir.addEventListener("click", () => {
      this.sortDesc = !this.sortDesc;
      this.renderList();
    });
    bar.appendChild(dir);
    return bar;
  }

  private row(idx: number): HTMLElement {
    const world = this.generator.getWorld();
    const group = this.items(world)[idx];
    const st = this.stats[idx];
    const item = document.createElement("div");
    item.className = `nation-item ${this.selected === idx ? "selected" : ""} ${this.mapHover === idx ? "hovered" : ""}`;
    item.dataset.index = String(idx);

    const toggle = document.createElement("button");
    toggle.className = `nation-toggle-btn ${this.expanded.has(idx) ? "expanded" : ""}`;
    toggle.title = this.expanded.has(idx) ? "Hide details" : "Show details";
    toggle.innerHTML = CHEVRON;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.expanded.delete(idx)) this.expanded.add(idx);
      this.renderList();
    });

    const swatch = document.createElement("div");
    swatch.className = "nation-color-swatch-container";
    swatch.style.backgroundColor = group.color;
    const color = document.createElement("input");
    color.type = "color";
    color.className = "nation-color-input";
    color.value = group.color;
    color.title = "Change color";
    color.addEventListener("input", () => {
      group.color = color.value;
      swatch.style.backgroundColor = group.color;
      this.touch();
      this.queueChanged();
    });
    color.addEventListener("change", () => {
      this.metaChanged();
      this.renderList();
    });
    color.addEventListener("mousedown", (e) => e.stopPropagation());
    color.addEventListener("click", (e) => e.stopPropagation());
    swatch.appendChild(color);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "nation-name-input";
    name.value = group.name;
    name.title = `Rename the ${this.noun}`;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v && v !== group.name) {
        group.name = v;
        this.metaChanged();
      } else name.value = group.name;
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") {
        name.value = group.name;
        name.blur();
      }
    });
    name.addEventListener("mousedown", (e) => e.stopPropagation());
    name.addEventListener("click", (e) => e.stopPropagation());

    // The figure follows the sort; a locate button takes its place on hover
    const metric = document.createElement("span");
    metric.className = "nation-metric";
    const count = document.createElement("span");
    count.className = "nation-territory-count";
    count.textContent = this.metricText(idx);
    count.title = `${this.share(st)} of all land${st.shared + st.minority ? ` · ${compact((st.shared + st.minority) * CELL_KM2)} km² mixed` : ""}`;
    const locate = document.createElement("button");
    locate.className = "nation-info-btn";
    locate.title = st.land + st.minority ? "Show on the map" : "No land yet";
    locate.innerHTML = PIN;
    locate.addEventListener("click", (e) => {
      e.stopPropagation();
      this.select(idx, false);
      this.locate(idx);
    });
    metric.append(count, locate);

    const del = document.createElement("button");
    del.className = "nation-delete-btn";
    del.title = `Delete ${this.noun}`;
    del.innerHTML = TRASH;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.confirmDelete(idx);
    });

    item.append(toggle, swatch);
    const url = this.emblem(idx, 22);
    if (url) {
      const logo = document.createElement("img");
      logo.className = "culture-logo";
      logo.src = url;
      logo.alt = "";
      if (this.editEmblem) {
        logo.title = "Edit logo";
        logo.addEventListener("click", (e) => {
          e.stopPropagation();
          this.editEmblem!(idx);
        });
      } else logo.style.cursor = "default";
      item.appendChild(logo);
    }
    item.append(name, metric, del);

    item.addEventListener("click", () => {
      // A second click on the selected row opens or closes its details
      if (this.selected === idx && !this.expanded.delete(idx)) this.expanded.add(idx);
      this.select(idx, true);
    });
    item.addEventListener("mouseenter", () => {
      if (!this.isPainting) this.onHover?.(idx);
    });
    item.addEventListener("mouseleave", () => {
      if (!this.isPainting) this.onHover?.(-1);
    });
    return item;
  }

  private select(idx: number, look: boolean) {
    this.selected = idx;
    const st = this.stats[idx];
    if (look && st && st.land + st.minority) this.canvasManager.lookAt(st.cx, st.cy);
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  private details(idx: number): HTMLElement {
    const world = this.generator.getWorld();
    const st = this.stats[idx];
    const box = document.createElement("div");
    box.className = "culture-details";
    box.addEventListener("click", (e) => e.stopPropagation());

    if (this.editEmblem) {
      const row = document.createElement("div");
      row.className = "culture-logo-row";
      row.innerHTML = `<img class="culture-logo big" src="${this.emblem(idx, 52)}" alt="" title="Edit logo" /><button class="btn-ghost">Edit logo</button>`;
      row.querySelectorAll("img, button").forEach((el) => el.addEventListener("click", () => this.editEmblem!(idx)));
      box.appendChild(row);
    }
    this.detailRows(box, idx);

    const mixed = st.shared + st.minority;
    const facts = document.createElement("div");
    facts.className = "culture-facts";
    facts.innerHTML = `
      <span title="Shared land counts half">Area</span><b>${compact(st.weight * CELL_KM2)} km²</b>
      <span>Share of land</span><b>${this.share(st)}</b>
      <span title="Towns on shared land count half">Population</span><b>${compact(st.population)}</b>
      <span>Realms</span><b>${st.nations.size}</b>
      ${mixed ? `<span title="Land shared with another ${this.noun}">Mixed land</span><b>${compact(mixed * CELL_KM2)} km²</b>` : ""}
      ${st.minority ? `<span title="Land where it lives as a minority">As a minority</span><b>${compact(st.minority * CELL_KM2)} km²</b>` : ""}`;
    box.appendChild(facts);

    const spans = [...st.nations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([n, cells]) => `${esc(world.nations[n]?.name ?? "?")} ${Math.round((cells / Math.max(1, st.land + st.minority)) * 100)}%`)
      .join(" · ");
    if (spans) {
      const p = document.createElement("p");
      p.className = "muted culture-spans";
      p.innerHTML = spans;
      box.appendChild(p);
    }
    if (!st.land && !st.minority) {
      const p = document.createElement("p");
      p.className = "muted culture-spans";
      p.textContent = `No land yet: paint some with the brush above.`;
      box.appendChild(p);
    }

    const actions = document.createElement("div");
    actions.className = "culture-logo-actions";
    const button = (text: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.className = "btn-ghost";
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", run);
      actions.appendChild(b);
      return b;
    };
    button("Paint", `Paint ${this.items(world)[idx].name}'s land`, () => {
      this.selected = idx;
      if (!this.needsGroup) this.mode = "paint";
      if (this.isEditing) this.renderList();
      else this.setEditing(true);
    });
    if (st.minority)
      button("Remove minority", `Remove ${this.items(world)[idx].name} from land where it lives as a minority`, () => this.clearMinority(idx));
    this.detailActions(actions, idx);
    box.appendChild(actions);
    return box;
  }

  // The paint toggle, brush size, brush mode and what the brush puts down
  private paintControls(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "people-paint";
    const edit = document.createElement("div");
    edit.className = `edit-mode-controls ${this.isEditing ? "edit-mode-active" : ""}`;
    edit.innerHTML = `
      <button class="btn-ghost" title="Paint ${this.noun} land on the map (Esc to stop)">${BRUSH}<span>${this.isEditing ? "Painting" : "Paint land"}</span></button>
      <div class="brush-size-control">
        <span class="brush-label-overlay">Brush</span>
        <input type="range" min="1" max="20" value="${Math.min(20, this.brushSize)}" />
        <input type="number" class="brush-number-input" min="1" max="100" value="${this.brushSize}" />
      </div>`;
    edit.querySelector("button")!.addEventListener("click", () => this.setEditing(!this.isEditing));
    const slider = edit.querySelector<HTMLInputElement>('input[type="range"]')!;
    const num = edit.querySelector<HTMLInputElement>('input[type="number"]')!;
    slider.addEventListener("input", () => {
      this.brushSize = Number(slider.value) || 1;
      num.value = String(this.brushSize);
      this.canvasManager.scheduleRender();
    });
    num.addEventListener("change", () => {
      this.brushSize = Math.max(1, Math.min(100, Math.round(Number(num.value)) || 1));
      num.value = String(this.brushSize);
      slider.value = String(Math.min(20, this.brushSize));
      syncSliders(edit);
      this.canvasManager.scheduleRender();
    });
    syncSliders(edit);
    wrap.appendChild(edit);
    if (!this.isEditing) return wrap;

    const modes = document.createElement("div");
    modes.className = "segmented radio-seg people-modes";
    for (const m of MODES) {
      const label = document.createElement("label");
      label.title = m.title;
      label.innerHTML = `<input type="radio" name="${this.kind}-brush-mode" value="${m.key}" ${this.mode === m.key ? "checked" : ""} /><span>${m.label}</span>`;
      label.querySelector("input")!.addEventListener("change", () => {
        this.mode = m.key;
        this.renderList();
        this.canvasManager.scheduleRender();
      });
      modes.appendChild(label);
    }
    wrap.appendChild(modes);

    const status = document.createElement("div");
    status.className = "people-status";
    const group = this.items(this.generator.getWorld())[this.selected];
    const chip = group ? `<span class="people-chip" style="background:${group.color}"></span><b>${esc(group.name)}</b>` : "";
    const pan = `<span class="muted">Shift+drag pans · right-click picks</span>`;
    if (this.needsGroup && !group) status.innerHTML = `<span>Click a ${this.noun} on the map or in the list to paint with it</span>`;
    else if (this.mode === "paint") status.innerHTML = `<span>Painting</span>${chip}${pan}`;
    else if (this.mode === "mix") status.innerHTML = `<span>Adding</span>${chip}<span>as a minority</span>${pan}`;
    else if (this.mode === "unmix") status.innerHTML = `<span>Removing minorities from painted land</span>${pan}`;
    else status.innerHTML = `<span>Erasing: painted land becomes uninhabited</span>${pan}`;
    wrap.appendChild(status);
    return wrap;
  }

  public setEditing(on: boolean) {
    if (this.isEditing === on) return;
    this.isEditing = on;
    if (!on) this.stopPainting();
    this.hoverMap(null); // the brush takes over from the hover highlight
    this.onEditToggle?.(on);
    this.renderList();
  }

  // --- Edits ---

  public addGroup() {
    const world = this.generator.getWorld();
    const id = this.create(world);
    this.selected = id;
    this.expanded.add(id);
    this.mode = "paint";
    this.metaChanged();
    if (this.isEditing) this.renderList();
    else this.setEditing(true); // a new group has no land: paint some
    this.revealSelected();
  }

  private async confirmDelete(idx: number) {
    const world = this.generator.getWorld();
    const groups = this.items(world);
    const group = groups[idx];
    if (groups.length <= 1) {
      await this.uiManager.confirm(`DELETE ${this.noun.toUpperCase()}`, `A world needs at least one ${this.noun}.`);
      return;
    }
    const st = this.stats[idx];
    const where = st && st.land ? " Its land passes to the nearest neighboring " + this.noun + "." : "";
    const ok = await this.uiManager.confirm(`DELETE ${this.noun.toUpperCase()}`, `Delete ${group.name}?${where} You can undo this.`);
    if (ok && this.items(this.generator.getWorld())[idx] === group) this.deleteGroup(idx);
  }

  public deleteGroup(id: number) {
    const world = this.generator.getWorld();
    const groups = this.items(world);
    if (groups.length <= 1 || !groups[id]) return;
    const W = world.width;
    const H = world.height;
    const f = this.field;
    const f2 = this.field2;
    // Its land joins the nearest other people (uninhabited land stays empty)
    const site = new Uint8Array(W * H);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const c = world.grid[x][y][f] ?? -1;
        if (c >= 0 && c !== id) site[y * W + x] = 1;
      }
    const { nearest } = distanceTransform(W, H, site);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell[f2] === id) cell[f2] = undefined;
        if (cell[f] !== id) continue;
        const n = nearest[y * W + x];
        cell[f] = n >= 0 ? world.grid[n % W][Math.floor(n / W)][f] : undefined;
        if (cell[f2] === cell[f]) cell[f2] = undefined;
      }
    this.beforeRemove(world, id);
    const shift = (v: number) => (v > id ? v - 1 : v);
    groups.splice(id, 1);
    groups.forEach((g, i) => (g.id = i));
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const cell = world.grid[x][y];
        if (cell[f] !== undefined) cell[f] = shift(cell[f]!);
        if (cell[f2] !== undefined) cell[f2] = shift(cell[f2]!);
      }
    this.afterRemove(world, id, shift);
    this.selected = -1;
    this.expanded = new Set([...this.expanded].filter((i) => i !== id).map(shift));
    this.metaChanged();
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  // The group leaves every cell where it lives as a minority
  public clearMinority(idx: number) {
    const world = this.generator.getWorld();
    for (const col of world.grid) for (const cell of col) if (cell[this.field2] === idx) cell[this.field2] = undefined;
    this.touch();
    this.onChanged?.();
    this.renderList();
  }

  // --- Painting ---

  public startPainting() {
    if (this.needsGroup && this.selected < 0) return;
    this.isPainting = true;
    this.lastX = null;
    this.lastY = null;
    this.onHover?.(-1);
  }

  public handlePainting(clientX: number, clientY: number) {
    if (!this.isPainting) return;
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
        if (!cell.isWater) this.paintCell(cell);
      }
    }
  }

  private paintCell(cell: CellData) {
    const f = this.field;
    const f2 = this.field2;
    const sel = this.selected;
    switch (this.mode) {
      case "paint":
        cell[f] = sel;
        cell[f2] = undefined;
        break;
      case "mix":
        // Empty land has no one to mix with: the group simply settles it
        if (cell[f] === undefined) cell[f] = sel;
        else if (cell[f] !== sel) cell[f2] = sel;
        break;
      case "unmix":
        cell[f2] = undefined;
        break;
      case "erase":
        cell[f] = undefined;
        cell[f2] = undefined;
        break;
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
