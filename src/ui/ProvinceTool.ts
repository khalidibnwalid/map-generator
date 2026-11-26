import type { CanvasManager } from "../core/CanvasManager";
import type { Nation, Province, WorldData } from "../game/WorldData";
import { colorForNewNation } from "../game/generators/generateNations";
import { nationFlagUrl } from "../game/flags";
import { makeVassal, transferProvinces, type NewRealm, type TransferResult } from "../game/politics";
import { createDropdown } from "./components/Dropdown";
import { toast } from "./components/Toast";
import { copiesInView } from "./WarRenderer";

// Redrawing borders by province, after grand strategy map editors: a panel
// over the map with two modes.
//  - Select: click provinces (or drag across them) to gather a selection,
//    then form a new realm from it, hand it to a realm, or release each
//    province as a realm of its own.
//  - Paint: pick a realm (or "new realm") and click or drag over provinces;
//    each stroke hands them over at once.
// Left drag selects or paints; right drag, middle drag or Shift+drag pans.
// Undo works through the edit session like any other map edit.

export interface ProvinceToolHost {
  world(): WorldData;
  canvas: CanvasManager;
  // The realm a fresh tool starts from (the Nations tab's selection)
  selectedNation(): number;
  // Land changed hands: refresh textures, caches and panels; select `nation`
  changed(nation: number): void;
  // The tool opened or closed (pan lock, cursor)
  toggled(open: boolean): void;
  // A peace is settled: the occupied land not handed over returns ("return"),
  // or history settles it the usual way ("history")
  settle(war: PeaceTable, how: "return" | "history"): void;
  // The last peace on the table is settled (history may carry on)
  conferenceDone(): void;
}

// A war that just ended in the History simulation, its peace left to the user
export interface PeaceTable {
  winner: Nation;
  loser: Nation;
  capitulated: boolean;
}
export interface Conference {
  year: number;
  wars: PeaceTable[]; // the first is on the table, the rest follow
}

type Mode = "select" | "paint";
type PickBy = "province" | "realm" | "region"; // what a click selects
const NEW = -2; // paint target: a new realm, formed by the first stroke

const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const km2 = (cells: number) => `${Math.round(cells).toLocaleString()} km²`;
const PICK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l5 15 2.5-6.5L19 9z"/><path d="m13 13 6 6"/></svg>`;
const MAX_CHIPS = 10;
const PICK_HINT: Record<PickBy, string> = {
  province: "Click provinces to select them, or drag across many.",
  realm: "Click a realm to select all its provinces.",
  region: "Click to select a natural region: the provinces up to the nearest rivers, ridges and coasts.",
};

// Provinces of the natural region around `start`: it spreads to neighbors
// across open borders and stops where a border largely follows a river or a
// mountain ridge (about 1,500 m and up), or the sea. Partly natural borders
// cost more to cross, and the region reaches only a few provinces out, so it
// stays a region (a valley, a plain) rather than a continent. Realm borders
// are no obstacle.
const RIDGE = 0.67;
export function naturalRegion(world: WorldData, start: Province): Province[] {
  const W = world.width;
  const H = world.height;
  const shared = new Map<number, number>(); // pair key -> border cells
  const natural = new Map<number, number>();
  const P = world.provinces.length;
  const key = (a: number, b: number) => (a < b ? a * P + b : b * P + a);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      const a = c.provinceIndex;
      if (c.isWater || a === undefined || a < 0) continue;
      for (const [nx, ny] of [[(x + 1) % W, y], [x, y + 1]]) {
        if (ny >= H) continue;
        const d = world.grid[nx][ny];
        const b = d.provinceIndex;
        if (d.isWater || b === undefined || b < 0 || b === a) continue;
        const k = key(a, b);
        shared.set(k, (shared.get(k) ?? 0) + 1);
        // A river cell on either side, or next to it, makes the edge a river edge
        const river = c.hasRiver || d.hasRiver || world.grid[x][Math.max(0, y - 1)].hasRiver || world.grid[nx][Math.min(H - 1, ny + 1)].hasRiver;
        if (river || Math.max(c.elevation, d.elevation) >= RIDGE) natural.set(k, (natural.get(k) ?? 0) + 1);
      }
    }
  // Open borders, with what it costs to cross them
  const next = new Map<number, { to: number; cost: number }[]>();
  for (const [k, n] of shared) {
    const frac = (natural.get(k) ?? 0) / n;
    if (frac >= 0.2 || n < 2) continue; // a natural border (or a mere corner)
    const a = Math.floor(k / P);
    const b = k % P;
    const cost = 1 + frac * 12;
    (next.get(a) ?? next.set(a, []).get(a)!).push({ to: b, cost });
    (next.get(b) ?? next.set(b, []).get(b)!).push({ to: a, cost });
  }
  // Cheapest spread from the start, within a budget
  const BUDGET = 3.5;
  const best = new Map<number, number>([[start.id, 0]]);
  const open = [start.id];
  while (open.length) {
    open.sort((a, b) => best.get(a)! - best.get(b)!);
    const a = open.shift()!;
    const ca = best.get(a)!;
    for (const { to, cost } of next.get(a) ?? []) {
      const c = ca + cost;
      if (c > BUDGET || c >= (best.get(to) ?? Infinity)) continue;
      best.set(to, c);
      open.push(to);
    }
  }
  return [...best.keys()].map((i) => world.provinces[i]).filter((p): p is Province => !!p && !!world.nations[p.nationIndex]);
}

export class ProvinceTool {
  public active = false;
  private host: ProvinceToolHost;
  private el: HTMLElement;
  private mode: Mode = "select";
  private selected = new Set<Province>();
  private pending = new Set<Province>(); // painted in the current stroke
  private stroke: { adding: boolean } | null = null;
  private target = -1; // realm index the provinces go to; NEW in paint mode
  private picking = false; // the next map click picks the target realm
  private hover: Province | null = null;
  private newName = "";
  private newColor = "";
  private colorTouched = false;
  private maskKey = 0; // bumped when land changes hands
  private world: WorldData | null = null;
  private conference: Conference | null = null;
  private pickBy: PickBy = "province";
  private renaming: HTMLInputElement | null = null; // inline name editor on the map

  constructor(host: ProvinceToolHost, el: HTMLElement) {
    this.host = host;
    this.el = el;
    // Events delegated once; the panel's markup is rebuilt on changes
    el.addEventListener("click", (e) => this.onPanelClick(e));
    el.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.classList.contains("pt-name")) this.newName = t.value;
      else if (t.classList.contains("pt-color")) {
        this.newColor = t.value;
        this.colorTouched = true;
      }
    });
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key === "Enter" && t.classList.contains("pt-name")) this.form();
    });
    window.addEventListener("keydown", (e) => {
      if (!this.active || e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (this.picking) this.picking = false;
      else if (this.selected.size) this.selected.clear();
      else if (!this.conference) return this.close();
      this.refresh();
    });
  }

  // --- Opening and closing ---

  public toggle() {
    if (this.active) this.close();
    else this.open();
  }

  public open() {
    if (this.active) return;
    this.active = true;
    this.syncWorld();
    const sel = this.host.selectedNation();
    if (!this.host.world().nations[this.target]) this.target = sel >= 0 ? sel : -1;
    this.host.toggled(true);
    this.refresh();
  }

  // Opens on wars that just ended: the first is on the table, its victor
  // receiving what is annexed, and the provinces it holds most of selected
  public openConference(c: Conference) {
    this.syncWorld();
    this.conference = c;
    this.mode = "select";
    if (!this.nextWar()) return;
    if (this.active) this.refresh();
    else this.open();
  }

  // Puts the next war still standing on the table; false (and closed) when none is left
  private nextWar(): boolean {
    const c = this.conference;
    const world = this.host.world();
    while (c && c.wars.length && !(world.nations.includes(c.wars[0].winner) && world.nations.includes(c.wars[0].loser))) c.wars.shift();
    if (!c || !c.wars.length) {
      this.conference = null;
      this.close();
      this.host.conferenceDone();
      return false;
    }
    const war = c.wars[0];
    const wi = world.nations.indexOf(war.winner);
    const li = world.nations.indexOf(war.loser);
    this.target = wi;
    // On the table: the loser's provinces the victor holds at least half of
    const held = new Map<number, number>();
    const all = new Map<number, number>();
    for (let x = 0; x < world.width; x++) {
      const col = world.grid[x];
      for (let y = 0; y < world.height; y++) {
        const cell = col[y];
        const p = cell.provinceIndex;
        if (cell.isWater || p === undefined || p < 0 || world.provinces[p]?.nationIndex !== li) continue;
        all.set(p, (all.get(p) ?? 0) + 1);
        if (cell.nationIndex === wi) held.set(p, (held.get(p) ?? 0) + 1);
      }
    }
    this.selected.clear();
    for (const [p, n] of held) if (n / all.get(p)! >= 0.5) this.selected.add(world.provinces[p]);
    return true;
  }

  private get war(): PeaceTable | null {
    return this.conference?.wars[0] ?? null;
  }

  // Both sides' indices: their occupied cells move with the provinces they sit in
  private occupiers(): number[] {
    const w = this.war;
    if (!w) return [];
    const world = this.host.world();
    return [world.nations.indexOf(w.winner), world.nations.indexOf(w.loser)].filter((i) => i >= 0);
  }

  private settle(how: "return" | "history") {
    const w = this.war;
    if (!w) return;
    this.host.settle(w, how);
    this.maskKey++;
    this.conference!.wars.shift();
    if (this.nextWar()) this.refresh();
  }

  // The selection becomes a realm of its own, bound to the victor
  private vassal() {
    const w = this.war;
    if (!w || !this.selected.size) return;
    const res = this.apply([...this.selected], this.newRealm());
    if (!res) return;
    const world = this.host.world();
    const lord = world.nations.indexOf(w.winner);
    if (lord >= 0) {
      makeVassal(world, res.nation, w.winner.overlord ?? lord); // vassals never have vassals
      this.host.changed(res.nation);
    }
    this.selected.clear();
    this.newName = "";
    this.colorTouched = false;
    this.refresh();
  }

  public get inConference() {
    return this.active && !!this.conference;
  }

  public close() {
    if (!this.active) return;
    this.conference = null;
    this.active = false;
    this.stroke = null;
    this.pending.clear();
    this.picking = false;
    this.hover = null;
    this.host.toggled(false);
    this.refresh();
  }

  // A new world: nothing selected carries over
  private syncWorld() {
    const world = this.host.world();
    if (world === this.world) return;
    this.world = world;
    this.selected.clear();
    this.pending.clear();
    this.target = -1;
    this.maskKey++;
  }

  // Undo or redo restored the world: the selection is re-checked, the overlay redrawn
  public invalidate() {
    this.maskKey++;
    if (this.active) this.refresh();
  }

  public worldReplaced() {
    this.syncWorld();
    if (this.active) this.refresh();
  }

  // --- Map input (screen coordinates) ---

  private provinceAt(clientX: number, clientY: number): Province | null {
    const world = this.host.world();
    const cm = this.host.canvas;
    const rect = cm.canvas.getBoundingClientRect();
    const fx = (clientX - rect.left - cm.offsetX) / cm.scale;
    const y = Math.floor((clientY - rect.top - cm.offsetY) / cm.scale);
    if (y < 0 || y >= world.height) return null;
    const x = ((Math.floor(fx) % world.width) + world.width) % world.width;
    const c = world.grid[x][y];
    if (c.isWater || c.provinceIndex === undefined || c.provinceIndex < 0) return null;
    const p = world.provinces[c.provinceIndex];
    return p && p.id === c.provinceIndex && world.nations[p.nationIndex] && this.belongs(p, c.nationIndex) ? p : null;
  }

  // A cell is part of province P when P's realm holds it, or (at a peace
  // conference) one of the two sides occupies it
  private belongs(p: Province, cellOwner: number | undefined): boolean {
    return cellOwner === p.nationIndex || (cellOwner !== undefined && cellOwner >= 0 && this.occupiers().includes(cellOwner));
  }

  // Left button or a finger: starts a selection or paint stroke. Returns
  // whether the tool took the event.
  public pointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0 || e.shiftKey) return false;
    this.syncWorld();
    const p = this.provinceAt(e.clientX, e.clientY);
    if (this.picking) {
      if (p) {
        this.target = p.nationIndex;
        this.picking = false;
        this.refresh();
      }
      return true;
    }
    if (this.mode === "paint" && !this.host.world().nations[this.target] && this.target !== NEW) {
      toast("Pick the realm to paint into first");
      return true;
    }
    // A whole realm or natural region at once (no stroke)
    if (this.mode === "select" && this.pickBy !== "province") {
      if (p) {
        const group = this.pickBy === "realm" ? this.host.world().provinces.filter((q) => q.nationIndex === p.nationIndex) : naturalRegion(this.host.world(), p);
        const add = !this.selected.has(p);
        for (const q of group) {
          if (add) this.selected.add(q);
          else this.selected.delete(q);
        }
        this.refresh();
      }
      return true;
    }
    this.stroke = { adding: this.mode === "paint" || !p || !this.selected.has(p) };
    this.pending.clear();
    if (p) this.strokeOver(p);
    try {
      this.host.canvas.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    return true;
  }

  public pointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    this.host.canvas.canvas.style.cursor = this.picking ? "pointer" : "crosshair";
    const p = this.provinceAt(e.clientX, e.clientY);
    if (p !== this.hover) {
      this.hover = p;
      this.host.canvas.scheduleRender();
    }
    if (!this.stroke) return false;
    if (p) this.strokeOver(p);
    return true;
  }

  // The stroke ends: a paint stroke hands its provinces over at once
  public pointerUp(): boolean {
    if (!this.stroke) return false;
    this.stroke = null;
    if (this.mode === "paint" && this.pending.size) {
      const list = [...this.pending];
      this.pending.clear();
      const res = this.apply(list, this.target === NEW ? this.newRealm() : this.target);
      if (res && this.target === NEW) this.target = res.nation; // the new realm takes the next strokes
    }
    this.refresh();
    return true;
  }

  // Double-click a province: rename it right there on the map
  public dblClick(e: MouseEvent): boolean {
    if (!this.active || this.mode !== "select") return false;
    const p = this.provinceAt(e.clientX, e.clientY);
    if (p) this.rename(p, e.clientX, e.clientY);
    return true;
  }

  private rename(p: Province, clientX: number, clientY: number) {
    this.renaming?.remove();
    const host = this.el.parentElement ?? document.body;
    const box = host.getBoundingClientRect();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pt-rename";
    input.value = p.name;
    input.maxLength = 48;
    input.setAttribute("aria-label", "Province name");
    input.style.left = `${clientX - box.left}px`;
    input.style.top = `${clientY - box.top}px`;
    host.appendChild(input);
    this.renaming = input;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.remove();
      if (this.renaming === input) this.renaming = null;
      if (keep && name && name !== p.name && this.host.world().provinces.includes(p)) {
        p.name = name;
        toast(`Province renamed ${name}`);
        this.host.changed(p.nationIndex);
      }
      this.refresh();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation(); // Esc and shortcuts stay with the field
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private strokeOver(p: Province) {
    if (this.mode === "paint") {
      if (p.nationIndex === this.target || this.pending.has(p)) return;
      this.pending.add(p);
    } else if (this.stroke!.adding) {
      if (this.selected.has(p)) return;
      this.selected.add(p);
    } else {
      if (!this.selected.has(p)) return;
      this.selected.delete(p);
    }
    this.refresh(this.mode === "paint");
  }

  // --- Actions ---

  private newRealm(): NewRealm {
    return { name: this.newName.trim() || undefined, color: this.colorTouched ? this.newColor : undefined };
  }

  private apply(list: Province[], to: number | NewRealm): TransferResult | null {
    const world = this.host.world();
    const ids = list.filter((p) => world.provinces.includes(p)).map((p) => p.id);
    if (!ids.length) return null;
    const res = transferProvinces(world, ids, to, this.occupiers());
    if (res.nation < 0) {
      toast(typeof to === "number" ? "Those provinces already belong to that realm" : "Nothing to form a realm from");
      return null;
    }
    const name = world.nations[res.nation].name;
    const gone = res.removed.length ? ` ${res.removed.join(", ")} ${res.removed.length === 1 ? "is" : "are"} gone.` : "";
    toast(
      typeof to === "number"
        ? `${name} takes ${res.moved} province${res.moved === 1 ? "" : "s"}.${gone}`
        : `${name} is formed from ${res.moved} province${res.moved === 1 ? "" : "s"}.${gone}`,
    );
    this.maskKey++;
    this.host.changed(res.nation);
    return res;
  }

  private form() {
    if (!this.selected.size) return;
    const res = this.apply([...this.selected], this.newRealm());
    if (!res) return;
    this.selected.clear();
    this.newName = "";
    this.colorTouched = false;
    this.target = res.nation;
    this.refresh();
  }

  private annex() {
    const world = this.host.world();
    if (!this.selected.size || !world.nations[this.target]) return;
    if (this.apply([...this.selected], this.target)) this.selected.clear();
    this.refresh();
  }

  // Each selected province becomes a realm of its own
  private release() {
    const list = [...this.selected];
    if (!list.length) return;
    const world = this.host.world();
    let made = 0;
    let last = -1;
    const gone: string[] = [];
    for (const p of list) {
      if (!world.provinces.includes(p)) continue;
      const res = transferProvinces(world, [p.id], {}, this.occupiers());
      if (res.nation < 0) continue;
      made++;
      last = res.nation;
      gone.push(...res.removed);
    }
    this.selected.clear();
    this.maskKey++;
    if (made) {
      toast(`${made} new realm${made === 1 ? "" : "s"} released.${gone.length ? ` ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} gone.` : ""}`);
      this.host.changed(last);
    }
    this.refresh();
  }

  private onPanelClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    const mode = t.closest<HTMLElement>("[data-mode]")?.dataset.mode as Mode | undefined;
    const by = t.closest<HTMLElement>("[data-pick]")?.dataset.pick as PickBy | undefined;
    if (by) {
      this.pickBy = by;
      this.refresh();
      return;
    }
    const rm = t.closest<HTMLElement>("[data-rm]");
    if (mode && mode !== this.mode) {
      this.mode = mode;
      this.picking = false;
      // Paint needs a realm: the one chosen so far, else a new one
      if (mode === "paint" && !this.host.world().nations[this.target]) this.target = NEW;
      if (mode === "select" && this.target === NEW) this.target = this.host.selectedNation();
      this.refresh();
      return;
    }
    if (rm) {
      const p = [...this.selected][Number(rm.dataset.rm)];
      if (p) this.selected.delete(p);
      this.refresh();
      return;
    }
    switch (act) {
      case "close":
        return this.close();
      case "sign":
        return this.settle("return");
      case "history":
        return this.settle("history");
      case "vassal":
        return this.vassal();
      case "clear":
        this.selected.clear();
        return this.refresh();
      case "pick":
        this.picking = !this.picking;
        return this.refresh();
      case "form":
        return this.form();
      case "annex":
        return this.annex();
      case "release":
        return this.release();
    }
  }

  // --- Panel ---

  private refresh(mapOnly = false) {
    this.host.canvas.scheduleRender();
    if (!mapOnly) this.render();
  }

  private liveSelection(): Province[] {
    const world = this.host.world();
    const out: Province[] = [];
    for (const p of this.selected) {
      if (world.provinces.includes(p) && world.nations[p.nationIndex]) out.push(p);
      else this.selected.delete(p);
    }
    return out;
  }

  private render() {
    const el = this.el;
    if (!this.active) {
      el.style.display = "none";
      return;
    }
    const world = this.host.world();
    if (this.target >= world.nations.length) this.target = -1;
    const sel = this.liveSelection();
    el.style.display = "flex";
    const flag = (i: number) => `<img class="pt-flag" src="${nationFlagUrl(world, i, 18, 12)}" alt="" />`;
    const seg = `<div class="picker segmented pt-mode">${(["select", "paint"] as Mode[])
      .map((m) => `<button type="button" class="pick ${m === this.mode ? "active" : ""}" data-mode="${m}"><span class="pick-label">${m === "select" ? "Select" : "Paint"}</span></button>`)
      .join("")}</div>`;
    const pickBtn = `<button type="button" class="icon-btn boxed pt-pick ${this.picking ? "active" : ""}" data-act="pick" title="Pick the realm on the map">${PICK_ICON}</button>`;
    let body: string;
    if (this.mode === "select") {
      const owners = new Map<number, number>();
      let area = 0;
      for (const p of sel) {
        owners.set(p.nationIndex, (owners.get(p.nationIndex) ?? 0) + 1);
        area += p.area ?? 0;
      }
      // A new realm's suggested color, unlike its neighbors'
      if (!this.colorTouched && (!this.newColor || !sel.length)) this.newColor = colorForNewNation(world, [...owners.keys()]);
      const none = sel.length ? "" : "disabled";
      const chips = sel
        .slice(0, MAX_CHIPS)
        .map((p, k) => `<span class="pt-chip" title="${esc(p.name)} · ${esc(world.nations[p.nationIndex].name)}">${flag(p.nationIndex)}<span>${esc(p.name)}</span><button type="button" data-rm="${k}" title="Deselect" aria-label="Deselect ${esc(p.name)}">✕</button></span>`)
        .join("");
      body = `
        <div class="pt-pickby">
          <span class="pt-label">Click picks</span>
          <div class="picker segmented pt-mode">${(["province", "realm", "region"] as PickBy[])
            .map((b) => `<button type="button" class="pick ${b === this.pickBy ? "active" : ""}" data-pick="${b}" title="${PICK_HINT[b]}"><span class="pick-label">${b[0].toUpperCase() + b.slice(1)}</span></button>`)
            .join("")}</div>
        </div>
        <p class="pt-hint">${this.picking ? "Click a realm on the map to hand the provinces to." : `${PICK_HINT[this.pickBy]} Double-click a province to rename it. Right-drag or Shift+drag moves the map.`}</p>
        <div class="pt-sel-head">
          <span><strong>${sel.length}</strong> province${sel.length === 1 ? "" : "s"}${area ? ` · ${km2(area)}` : ""}</span>
          <button type="button" class="btn-ghost pd-mini" data-act="clear" ${none}>Clear</button>
        </div>
        ${sel.length ? `<div class="pt-chips">${chips}${sel.length > MAX_CHIPS ? `<span class="pt-more">+${sel.length - MAX_CHIPS} more</span>` : ""}</div>` : ""}
        ${owners.size ? `<div class="pt-owners">From ${[...owners].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o, n]) => `${flag(o)} ${esc(world.nations[o].name)} (${n})`).join(" · ")}${owners.size > 6 ? ` and ${owners.size - 6} more` : ""}</div>` : ""}
        <div class="pt-section">
          <div class="pt-label">Form a new realm</div>
          <div class="pt-row">
            <input type="color" class="pt-color" value="${this.newColor}" title="Its color" />
            <input type="text" class="pt-name" placeholder="Name (from its people)" maxlength="48" value="${esc(this.newName)}" />
            <button type="button" class="btn-primary pt-go" data-act="form" ${none}>Form</button>
          </div>
        </div>
        <div class="pt-section">
          <div class="pt-label">Hand to a realm</div>
          <div class="pt-row">
            <div class="pt-target"></div>${pickBtn}
            <button type="button" class="btn-primary pt-go" data-act="annex" ${sel.length && world.nations[this.target] ? "" : "disabled"}>Annex</button>
          </div>
        </div>
        <button type="button" class="btn-ghost pt-release" data-act="release" ${none} title="Every selected province becomes a realm of its own">Release each as its own realm</button>`;
    } else {
      const into = this.target === NEW ? "a new realm" : (world.nations[this.target]?.name ?? "");
      body = `
        <p class="pt-hint">${this.picking ? "Click a realm on the map to paint into." : `Click or drag over provinces to hand them to ${esc(into) || "the realm picked below"}. Right-drag or Shift+drag moves the map.`}</p>
        <div class="pt-section">
          <div class="pt-label">Paint provinces into</div>
          <div class="pt-row"><div class="pt-target"></div>${pickBtn}</div>
        </div>
        ${
          this.target === NEW
            ? `<div class="pt-section">
                <div class="pt-label">The new realm</div>
                <div class="pt-row">
                  <input type="color" class="pt-color" value="${this.newColor || colorForNewNation(world, [])}" title="Its color" />
                  <input type="text" class="pt-name" placeholder="Name (from its people)" maxlength="48" value="${esc(this.newName)}" />
                </div>
              </div>`
            : ""
        }`;
    }
    const c = this.conference;
    const war = this.war;
    if (c && war) {
      // The peace on the table: what the victor holds is selected; annex it,
      // make it a vassal, free it, or hand it all back by signing
      const wi = world.nations.indexOf(war.winner);
      const li = world.nations.indexOf(war.loser);
      const W = esc(war.winner.name);
      const none = sel.length ? "" : "disabled";
      let area = 0;
      for (const p of sel) area += p.area ?? 0;
      if (!this.colorTouched && (!this.newColor || !sel.length)) this.newColor = colorForNewNation(world, [wi, li]);
      const chips = sel
        .slice(0, MAX_CHIPS)
        .map((p, k) => `<span class="pt-chip" title="${esc(p.name)} · ${esc(world.nations[p.nationIndex].name)}">${flag(p.nationIndex)}<span>${esc(p.name)}</span><button type="button" data-rm="${k}" title="Take off the table" aria-label="Deselect ${esc(p.name)}">✕</button></span>`)
        .join("");
      const more = c.wars.length > 1 ? `<small>${c.wars.length - 1} more peace${c.wars.length > 2 ? "s" : ""} after this one.</small>` : "";
      body = `
        <div class="pt-peace">
          <div class="pt-peace-title">Peace conference · year ${c.year}</div>
          <div class="pt-peace-line">${flag(wi)}<span>${war.capitulated ? `${W} defeats ${esc(war.loser.name)}` : `${W} and ${esc(war.loser.name)} make peace`}</span>${flag(li)}</div>
          <small>The map is as the war left it, occupied land shaded. The provinces ${W} holds most of are selected; click provinces to change that.</small>
          ${more}
        </div>
        <div class="pt-sel-head">
          <span><strong>${sel.length}</strong> province${sel.length === 1 ? "" : "s"} on the table${area ? ` · ${km2(area)}` : ""}</span>
          <button type="button" class="btn-ghost pd-mini" data-act="clear" ${none}>Clear</button>
        </div>
        ${sel.length ? `<div class="pt-chips">${chips}${sel.length > MAX_CHIPS ? `<span class="pt-more">+${sel.length - MAX_CHIPS} more</span>` : ""}</div>` : ""}
        <div class="pt-section">
          <div class="pt-label">Their fate</div>
          <div class="pt-actions">
            <button type="button" class="btn-primary pt-go" data-act="annex" ${none} title="${W} annexes them">Annex to ${W}</button>
            <button type="button" class="btn-ghost pt-go" data-act="vassal" ${none} title="They become a new realm bound to ${W}">Vassal of ${W}</button>
          </div>
          <div class="pt-row">
            <input type="color" class="pt-color" value="${this.newColor}" title="The new realm's color" />
            <input type="text" class="pt-name" placeholder="New realm's name (optional)" maxlength="48" value="${esc(this.newName)}" />
            <button type="button" class="btn-ghost pt-go" data-act="form" ${none} title="They become a free realm">Free</button>
          </div>
        </div>
        <div class="pt-section">
          <button type="button" class="btn-primary pt-sign" data-act="sign" title="Close the conference: land still occupied returns to its owner">Sign · keep the rest</button>
          <small class="pt-hint">Signing keeps every border as you left it: land still occupied goes back to its owner.</small>
          <button type="button" class="btn-ghost pt-release" data-act="history" title="Settle it the way history would have">Let history decide</button>
        </div>`;
    }
    el.innerHTML = `
      <div class="pt-head">
        <span class="pt-title">${c ? "Draw the peace" : "Redraw borders"}</span>
        ${c ? "" : `<button type="button" class="icon-btn pt-close" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>`}
      </div>
      ${c ? "" : seg}
      ${body}
      <small class="pt-foot">Ctrl+Z undoes a change.</small>`;
    if (this.mode === "paint" && !this.newColor) this.newColor = el.querySelector<HTMLInputElement>(".pt-color")?.value ?? "";
    const host = el.querySelector<HTMLElement>(".pt-target");
    if (host) {
      const area = (i: number) => world.provinces.reduce((s, p) => s + (p.nationIndex === i ? (p.area ?? 0) : 0), 0);
      const options = world.nations
        .map((n, i) => ({ n, i, a: area(i) }))
        .sort((a, b) => b.a - a.a)
        .map(({ n, i, a }) => ({ value: String(i), label: n.name, image: nationFlagUrl(world, i, 18, 12), hint: a ? km2(a) : "" }));
      if (this.mode === "paint") options.unshift({ value: String(NEW), label: "＋ New realm", image: "", hint: "" });
      else options.unshift({ value: "-1", label: "Choose a realm", image: "", hint: "" });
      host.replaceChildren(
        createDropdown({
          className: "pt-dd",
          title: "The realm that receives the provinces",
          value: String(this.target),
          options,
          onChange: (v) => {
            this.target = Number(v);
            this.picking = false;
            this.refresh();
          },
        }),
      );
    }
  }

  // --- Map overlay: selection, the stroke being painted, the hovered province ---
  // Drawn as vector shapes (cell edges chained into loops and rounded), so
  // they stay sharp at any zoom.

  private outlines = new Map<string, Path2D>();
  private shapes: { key: string; layers: { path: Path2D; fill: string; rim: string; casing: string; width: number }[] } | null = null;

  public draw(ctx: CanvasRenderingContext2D, scale: number, offX: number, offY: number, width: number) {
    if (!this.active) return;
    const world = this.host.world();
    const W = world.width;
    const paintColor = this.mode === "paint" ? (world.nations[this.target]?.color ?? (this.newColor || "#ffffff")) : "#ffd65a";
    const key = [
      world.seed,
      W,
      world.provinces.length,
      this.maskKey,
      this.mode,
      paintColor,
      [...this.selected].map((p) => p.id).join(","),
      [...this.pending].map((p) => p.id).join(","),
      this.hover?.id ?? -1,
    ].join("|");
    if (this.shapes?.key !== key) this.shapes = { key, layers: this.buildShapes(world, paintColor) };
    const layers = this.shapes.layers;
    if (!layers.length) return;
    const span = W * scale;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const k of copiesInView(0, W, W, scale, offX, width, 0)) {
      ctx.setTransform(scale, 0, 0, scale, offX + k * span, offY);
      for (const l of layers) {
        ctx.fillStyle = l.fill;
        ctx.fill(l.path, "evenodd");
        // Widths in screen pixels whatever the zoom
        ctx.strokeStyle = l.casing;
        ctx.lineWidth = (l.width + 2) / scale;
        ctx.stroke(l.path);
        ctx.strokeStyle = l.rim;
        ctx.lineWidth = l.width / scale;
        ctx.stroke(l.path);
      }
    }
    ctx.restore();
  }

  private buildShapes(world: WorldData, paintColor: string) {
    const rgba = (hex: string, a: number) => {
      const v = parseInt(hex.slice(1, 7), 16);
      return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
    };
    const groups: { ids: Set<number>; fill: string; rim: string; casing: string; width: number }[] = [];
    const hov = this.hover && !this.selected.has(this.hover) && !this.pending.has(this.hover) ? this.hover : null;
    if (hov)
      groups.push(
        this.mode === "paint"
          ? { ids: new Set([hov.id]), fill: rgba(paintColor, 0.5), rim: "#ffffff", casing: "rgba(20,16,11,0.75)", width: 2.5 }
          : { ids: new Set([hov.id]), fill: "rgba(255,248,226,0.42)", rim: "#ffffff", casing: "rgba(20,16,11,0.75)", width: 2.5 },
      );
    if (this.selected.size)
      groups.push({ ids: new Set([...this.selected].map((p) => p.id)), fill: "rgba(255,206,64,0.5)", rim: "#ffe58a", casing: "rgba(40,26,6,0.9)", width: 2.5 });
    if (this.pending.size)
      groups.push({ ids: new Set([...this.pending].map((p) => p.id)), fill: rgba(paintColor, 0.55), rim: "#fff6dc", casing: "rgba(20,16,11,0.8)", width: 2.2 });
    // Outlines are kept per set of provinces: hovering doesn't redo the selection's
    const cache = new Map<string, Path2D>();
    const out = groups.map((g) => {
      const occ = this.occupiers();
      const k = `${this.maskKey}|${occ.join(",")}|${[...g.ids].sort((a, b) => a - b).join(",")}`;
      const path = this.outlines.get(k) ?? outlinePath(world, g.ids, occ);
      cache.set(k, path);
      return { path, fill: g.fill, rim: g.rim, casing: g.casing, width: g.width };
    });
    this.outlines = cache;
    return out;
  }
}

// The land of provinces `ids` (cells their realm holds) as closed, rounded
// loops in cell coordinates: boundary edges chained clockwise, their
// midpoints joined, then corners cut twice (staircases become curves)
function outlinePath(world: WorldData, ids: Set<number>, occupiers: number[] = []): Path2D {
  const W = world.width;
  const H = world.height;
  const inside = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < H; y++) {
      const c = col[y];
      const pi = c.provinceIndex;
      if (c.isWater || pi === undefined || pi < 0 || !ids.has(pi)) continue;
      const own = world.provinces[pi]?.nationIndex;
      if (own === c.nationIndex || (c.nationIndex !== undefined && occupiers.includes(c.nationIndex))) inside[y * W + x] = 1;
    }
  }
  const VW = W + 1;
  const next = new Map<number, number[]>(); // vertex -> ends of the edges leaving it
  const add = (a: number, b: number) => {
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  };
  const at = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H && inside[y * W + x] === 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!inside[y * W + x]) continue;
      if (!at(x, y - 1)) add(y * VW + x, y * VW + x + 1);
      if (!at(x + 1, y)) add(y * VW + x + 1, (y + 1) * VW + x + 1);
      if (!at(x, y + 1)) add((y + 1) * VW + x + 1, (y + 1) * VW + x);
      if (!at(x - 1, y)) add((y + 1) * VW + x, y * VW + x);
    }
  const path = new Path2D();
  for (const [start] of next) {
    for (;;) {
      const out = next.get(start);
      if (!out?.length) break;
      // One loop: follow edges until back at the start
      const loop: number[] = [start];
      let v = out.pop()!;
      while (v !== start) {
        loop.push(v);
        const o = next.get(v);
        if (!o?.length) break;
        v = o.pop()!;
      }
      if (loop.length < 3) continue;
      const pts = roundLoop(loop.map((q) => [q % VW, Math.floor(q / VW)]));
      path.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) path.lineTo(pts[k][0], pts[k][1]);
      path.closePath();
    }
  }
  return path;
}

function roundLoop(p: number[][]): number[][] {
  const n = p.length;
  let q: number[][] = [];
  for (let k = 0; k < n; k++) {
    const a = p[k];
    const b = p[(k + 1) % n];
    q.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  for (let it = 0; it < 2; it++) {
    const m = q.length;
    const r: number[][] = [];
    for (let k = 0; k < m; k++) {
      const a = q[k];
      const b = q[(k + 1) % m];
      r.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    q = r;
  }
  return q;
}
