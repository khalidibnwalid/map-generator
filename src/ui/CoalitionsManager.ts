import type { MapGenerator } from "../game/MapGenerator";
import type { CanvasManager } from "../core/CanvasManager";
import type { UIManager } from "./UIManager";
import type { NationsManager } from "./NationsManager";
import type { Coalition } from "../game/WorldData";
import { CELL_KM2 } from "../game/WorldData";
import { flagUrl, nationFlagUrl } from "../game/flags";
import {
  canUnite,
  createCoalition,
  defaultCoalitionFlag,
  dissolveCoalition,
  freshCoalitionColor,
  isMember,
  joinCoalition,
  leaveCoalition,
  membersOf,
  coalitionById,
  coalitionFlag,
  coalitionName,
  coalitionsOf,
} from "../game/coalitions";
import { createDropdown, type DropdownOption } from "./components/Dropdown";
import { toast } from "./components/Toast";
import { compact } from "./AtlasRender";
import { FlagEditor } from "./FlagEditor";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PLUS = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19V4Z M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`;

// Coalition flags as <img> HTML (also used by the legend and the Diplomacy tab)
export function coalitionFlagImg(world: Parameters<typeof coalitionFlag>[0], u: Coalition, w = 18, h = 12, cls = "diplo-flag"): string {
  return `<img class="${cls}" src="${flagUrl(coalitionFlag(world, u), w, h)}" alt="">`;
}

// The Coalitions tab: every coalition with its members, and a form to found new ones.
// Members can be picked from the list or by clicking realms on the map.
// Edits change the world directly; the edit history records them like any
// other change, and onChanged repaints the map.
export class CoalitionsManager {
  public selected = -1; // coalition id whose details are open
  public hovered = -1; // coalition id whose row is under the mouse
  public onChanged: (() => void) | null = null;

  // The coalition being founded, while the form is open
  private draft: { members: number[]; name: string; named: boolean; color: string } | null = null;
  // Map clicks add or remove realms: of the draft, or of an existing coalition
  private picking: "draft" | number | null = null;
  private flagEditor: FlagEditor | null = null;

  private generator: MapGenerator;
  private canvasManager: CanvasManager;
  private uiManager: UIManager;
  private nations: NationsManager;

  constructor(generator: MapGenerator, canvasManager: CanvasManager, uiManager: UIManager, nations: NationsManager) {
    this.generator = generator;
    this.canvasManager = canvasManager;
    this.uiManager = uiManager;
    this.nations = nations;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.picking !== null) this.stopPicking();
    });
  }

  get isPicking() {
    return this.picking !== null;
  }

  // A new world: nothing selected, no half-founded coalition
  public reset() {
    this.selected = -1;
    this.hovered = -1;
    this.draft = null;
    this.stopPicking(false);
  }

  // Realms to light up on the map: those being picked, else a hovered coalition's
  public highlight(): { members: number[]; color: string } | null {
    const world = this.generator.getWorld();
    if (this.picking === "draft" && this.draft) return { members: this.draft.members, color: this.draft.color };
    const u = coalitionById(world, typeof this.picking === "number" ? this.picking : this.hovered >= 0 ? this.hovered : undefined);
    return u ? { members: membersOf(world, u.id), color: u.color } : null;
  }

  // A realm clicked on the map while picking: in it goes, or out if it was in
  public pickOnMap(idx: number) {
    const world = this.generator.getWorld();
    const n = world.nations[idx];
    if (!n || this.picking === null) return;
    if (!canUnite(world, idx)) {
      toast(`${n.name} is a vassal. Vassals can't join a coalition.`);
      return;
    }
    if (this.picking === "draft" && this.draft) {
      const d = this.draft;
      d.members = d.members.includes(idx) ? d.members.filter((i) => i !== idx) : [...d.members, idx];
      this.renderList();
    } else if (typeof this.picking === "number") {
      const id = this.picking;
      if (isMember(n, id)) leaveCoalition(world, idx, id);
      else joinCoalition(world, idx, id);
      // Down to one member the coalition dissolves, and picking ends with it
      if (!coalitionById(world, id)) this.stopPicking(false);
      this.changed();
    }
  }

  private startPicking(target: "draft" | number) {
    this.picking = target;
    this.canvasManager.canvas.style.cursor = "crosshair";
    this.renderList();
    this.canvasManager.scheduleRender();
  }

  public stopPicking(render = true) {
    if (this.picking === null) return;
    this.picking = null;
    this.canvasManager.canvas.style.cursor = "grab";
    if (render) this.renderList();
    this.canvasManager.scheduleRender();
  }

  private changed() {
    this.renderList();
    this.onChanged?.();
  }

  private hoverNation(i: number) {
    this.nations.hoveredNationIndex = i;
    this.canvasManager.scheduleRender();
  }

  private hoverCoalition(id: number) {
    this.hovered = id;
    this.canvasManager.scheduleRender();
  }

  private lookAtNation(i: number) {
    const n = this.generator.getWorld().nations[i];
    if (n) this.canvasManager.lookAt(n.capitalX, n.capitalY);
  }

  private editFlag(coalition: Coalition) {
    const world = this.generator.getWorld();
    this.flagEditor ??= new FlagEditor();
    this.flagEditor.edit({
      title: `Flag of the ${coalition.name}`,
      spec: coalitionFlag(world, coalition),
      random: () => defaultCoalitionFlag(world, coalition, 1 + Math.floor(Math.random() * 1e6)),
      reset: () => defaultCoalitionFlag(world, coalition),
      save: (f) => {
        coalition.flag = f;
        this.changed();
        // The editor lives outside the app, so tell the edit history something changed
        document.getElementById("coalitions-list")?.dispatchEvent(new Event("change", { bubbles: true }));
      },
    });
  }

  // Independent realms, by name, with the coalitions each is in as a hint
  private realmOptions(exclude: (i: number) => boolean): DropdownOption[] {
    const world = this.generator.getWorld();
    return world.nations
      .map((n, i) => ({ n, i }))
      .filter((e) => canUnite(world, e.i) && !exclude(e.i))
      .sort((a, b) => a.n.name.localeCompare(b.n.name))
      .map((e) => ({
        value: String(e.i),
        label: e.n.name,
        image: nationFlagUrl(world, e.i, 18, 12),
        hint: coalitionsOf(world, e.i)
          .map((u) => u.name)
          .join(", ") || undefined,
      }));
  }

  public renderList() {
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === "INPUT" && active.closest("#coalitions-list, #coalitions-head")) {
      active.dispatchEvent(new Event("change"));
      active.blur();
    }
    const list = document.getElementById("coalitions-list");
    const head = document.getElementById("coalitions-head");
    if (!list || !head) return;
    const world = this.generator.getWorld();
    if (this.draft) this.draft.members = this.draft.members.filter((i) => canUnite(world, i));
    if (typeof this.picking === "number" && !coalitionById(world, this.picking)) this.stopPicking(false);

    head.innerHTML = "";
    const addBtn = document.createElement("button");
    addBtn.className = "nation-add-btn";
    addBtn.innerHTML = `${PLUS}<span>NEW COALITION</span>`;
    addBtn.addEventListener("click", () => {
      this.draft = this.draft ? null : { members: [], name: "", named: false, color: freshCoalitionColor(world) };
      if (this.draft) this.startPicking("draft");
      else this.stopPicking();
    });
    head.appendChild(addBtn);
    if (this.draft) head.appendChild(this.draftForm());

    list.innerHTML = "";
    if (!world.coalitions.length) {
      const empty = document.createElement("p");
      empty.className = "muted coalition-empty";
      empty.textContent = "No coalitions yet. A coalition binds two or more independent realms under one name, and a realm may be in several. Found one with New coalition.";
      list.appendChild(empty);
      return;
    }

    // Area and people of each realm, summed per coalition
    const pop = new Float64Array(world.nations.length);
    for (const c of world.cities) if (c.nationIndex >= 0) pop[c.nationIndex] += c.population;
    const rows = world.coalitions.map((u) => {
      const members = membersOf(world, u.id);
      const land = members.reduce((a, i) => a + (this.nations.nationLandArea[i] || 0), 0);
      return { u, members, land, people: members.reduce((a, i) => a + pop[i], 0) };
    });
    rows.sort((a, b) => b.land - a.land);
    for (const r of rows) {
      list.appendChild(this.coalitionRow(r.u, r.members, r.land));
      if (this.selected === r.u.id) list.appendChild(this.details(r.u, r.members, r.land, r.people));
    }
  }

  private coalitionRow(coalition: Coalition, members: number[], land: number): HTMLElement {
    const world = this.generator.getWorld();
    const item = document.createElement("div");
    item.className = `nation-item ${this.selected === coalition.id ? "selected" : ""}`;

    const swatch = document.createElement("div");
    swatch.className = "nation-color-swatch-container";
    swatch.style.backgroundColor = coalition.color;
    const color = document.createElement("input");
    color.type = "color";
    color.className = "nation-color-input";
    color.value = coalition.color;
    color.title = "Coalition color";
    color.addEventListener("change", () => {
      coalition.color = color.value;
      this.changed();
    });
    color.addEventListener("click", (e) => e.stopPropagation());
    swatch.appendChild(color);

    const flag = document.createElement("img");
    flag.className = "nation-flag";
    flag.src = flagUrl(coalitionFlag(world, coalition), 21, 14);
    flag.alt = "";
    flag.title = "Edit flag";
    flag.addEventListener("click", (e) => {
      e.stopPropagation();
      this.editFlag(coalition);
    });

    const name = document.createElement("input");
    name.type = "text";
    name.className = "nation-name-input";
    name.value = coalition.name;
    name.title = `${coalition.name} (click to rename)`;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v && v !== coalition.name) {
        coalition.name = v;
        this.onChanged?.();
      } else name.value = coalition.name;
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      e.stopPropagation();
    });
    name.addEventListener("click", (e) => e.stopPropagation());

    // Its realms, on a line under the row
    const line = document.createElement("div");
    line.className = "coalition-members";
    line.innerHTML = members
      .map((i) => `<span><img class="diplo-flag" src="${nationFlagUrl(world, i, 15, 10)}" alt="">${esc(world.nations[i].name)}</span>`)
      .join("");

    const metric = document.createElement("span");
    metric.className = "nation-metric";
    metric.innerHTML = `<span class="nation-territory-count" title="${members.length} realms">${compact(land * CELL_KM2)} km²</span>`;

    const del = document.createElement("button");
    del.className = "nation-delete-btn";
    del.title = "Dissolve coalition";
    del.innerHTML = TRASH;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await this.uiManager.confirm("DISSOLVE COALITION", `Dissolve the ${coalition.name}? Its ${members.length} realms keep their lands and any other coalitions.`);
      if (!ok) return;
      dissolveCoalition(world, coalition.id);
      if (this.selected === coalition.id) this.selected = -1;
      this.hovered = -1;
      this.changed();
      // The dialog lives outside the app, so tell the edit history something changed
      document.getElementById("coalitions-list")?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    item.append(swatch, flag, name, metric, del);
    const entry = document.createElement("div");
    entry.className = "coalition-entry";
    entry.append(item, line);
    entry.addEventListener("mouseenter", () => this.hoverCoalition(coalition.id));
    entry.addEventListener("mouseleave", () => this.hoverCoalition(-1));
    line.addEventListener("click", () => item.click());
    item.addEventListener("click", () => {
      this.selected = this.selected === coalition.id ? -1 : coalition.id;
      if (this.picking === coalition.id && this.selected !== coalition.id) this.stopPicking(false);
      if (this.selected >= 0 && members.length) this.lookAtNation(members[0]);
      this.renderList();
    });
    return entry;
  }

  private details(coalition: Coalition, members: number[], land: number, people: number): HTMLElement {
    const world = this.generator.getWorld();
    const box = document.createElement("div");
    box.className = "culture-details";
    box.addEventListener("click", (e) => e.stopPropagation());
    const cities = world.cities.filter((c) => isMember(world.nations[c.nationIndex], coalition.id)).length;
    box.innerHTML = `
      <div class="culture-facts">
        <span>Realms</span><b>${members.length}</b>
        <span>Area</span><b>${compact(land * CELL_KM2)} km²</b>
        <span>Population</span><b>${compact(people)}</b>
        <span>Settlements</span><b>${cities}</b>
      </div>`;

    box.appendChild(
      this.memberChips(
        members,
        (m) => {
          leaveCoalition(world, m, coalition.id);
          this.changed();
        },
        "Leave the coalition (a coalition of two dissolves)",
      ),
    );

    const picking = this.picking === coalition.id;
    if (picking) box.appendChild(this.pickHint());
    const options = this.realmOptions((i) => isMember(world.nations[i], coalition.id));
    const add = document.createElement("div");
    add.className = "coalition-actions";
    if (options.length)
      add.appendChild(
        createDropdown({
          className: "coalition-dd",
          title: "Bring a realm into the coalition (it keeps its other coalitions)",
          value: "-1",
          options: [{ value: "-1", label: "Add a realm…" }, ...options],
          onChange: (v) => {
            if (joinCoalition(world, Number(v), coalition.id)) this.changed();
          },
        }),
      );
    add.appendChild(this.pickButton(picking, () => this.startPicking(coalition.id)));
    box.appendChild(add);

    const actions = document.createElement("div");
    actions.className = "coalition-actions";
    const flagBtn = document.createElement("button");
    flagBtn.className = "btn-ghost";
    flagBtn.innerHTML = `${coalitionFlagImg(world, coalition)}<span>Edit flag</span>`;
    flagBtn.addEventListener("click", () => this.editFlag(coalition));
    const rename = document.createElement("button");
    rename.className = "btn-ghost";
    rename.textContent = "Suggest name";
    rename.title = "Name the coalition after its realms";
    rename.addEventListener("click", () => {
      const names = [0, 1, 2, 3, 4].map((k) => coalitionName(world, members, k));
      coalition.name = names[(names.indexOf(coalition.name) + 1) % names.length];
      this.changed();
    });
    actions.append(flagBtn, rename);
    box.appendChild(actions);
    return box;
  }

  // Toggles map picking: "Pick on map" to start, "Done" to finish
  private pickButton(active: boolean, start: () => void): HTMLElement {
    const b = document.createElement("button");
    b.className = `btn-ghost coalition-pick ${active ? "active" : ""}`;
    b.textContent = active ? "Done" : "Pick on map";
    b.title = active ? "Stop picking (Esc)" : "Click realms on the map to add or remove them";
    b.addEventListener("click", () => (active ? this.stopPicking() : start()));
    return b;
  }

  private pickHint(): HTMLElement {
    const p = document.createElement("p");
    p.className = "coalition-hint";
    p.textContent = "Click realms on the map to add or remove them. Esc or Done to finish.";
    return p;
  }

  // Flag chips for realms: click one to look at it, × to drop it
  private memberChips(members: number[], remove: (i: number) => void, removeTitle: string): HTMLElement {
    const world = this.generator.getWorld();
    const wrap = document.createElement("div");
    wrap.className = "diplo-vassals";
    for (const m of members) {
      const chip = document.createElement("span");
      chip.className = "diplo-chip coalition-member";
      chip.title = "Show on the map";
      chip.innerHTML = `<img class="diplo-flag" src="${nationFlagUrl(world, m, 15, 10)}" alt="">${esc(world.nations[m].name)}`;
      const x = document.createElement("button");
      x.className = "diplo-x";
      x.textContent = "×";
      x.title = removeTitle;
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hoverNation(-1);
        remove(m);
      });
      chip.appendChild(x);
      chip.addEventListener("click", () => this.lookAtNation(m));
      chip.addEventListener("mouseenter", () => this.hoverNation(m));
      chip.addEventListener("mouseleave", () => this.hoverNation(-1));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  // Founding a coalition: pick its realms, name and color
  private draftForm(): HTMLElement {
    const world = this.generator.getWorld();
    const d = this.draft!;
    if (!d.named) d.name = d.members.length >= 2 ? coalitionName(world, d.members) : "";

    const box = document.createElement("div");
    box.className = "culture-details coalition-draft";
    const row = document.createElement("div");
    row.className = "coalition-actions";
    const color = document.createElement("input");
    color.type = "color";
    color.className = "coalition-color";
    color.value = d.color;
    color.title = "Coalition color";
    color.addEventListener("change", () => {
      d.color = color.value;
      this.canvasManager.scheduleRender();
    });
    const name = document.createElement("input");
    name.className = "coalition-name";
    name.placeholder = "Name (suggested from its realms)";
    name.value = d.name;
    name.addEventListener("input", () => {
      d.name = name.value;
      d.named = name.value.trim() !== "";
    });
    name.addEventListener("keydown", (e) => e.stopPropagation());
    row.append(color, name);
    box.appendChild(row);

    const picking = this.picking === "draft";
    if (picking) box.appendChild(this.pickHint());
    if (d.members.length)
      box.appendChild(
        this.memberChips(
          d.members,
          (m) => {
            d.members = d.members.filter((i) => i !== m);
            this.renderList();
          },
          "Remove",
        ),
      );
    const add = document.createElement("div");
    add.className = "coalition-actions";
    const options = this.realmOptions((i) => d.members.includes(i));
    if (options.length)
      add.appendChild(
        createDropdown({
          className: "coalition-dd",
          title: "Independent realms; those in other coalitions stay in them too",
          value: "-1",
          options: [{ value: "-1", label: d.members.length ? "Add another realm…" : "Pick its first realm…" }, ...options],
          onChange: (v) => {
            d.members.push(Number(v));
            this.renderList();
            this.canvasManager.scheduleRender();
          },
        }),
      );
    add.appendChild(this.pickButton(picking, () => this.startPicking("draft")));
    box.appendChild(add);

    const actions = document.createElement("div");
    actions.className = "coalition-actions";
    const create = document.createElement("button");
    create.className = "btn-ghost coalition-create";
    create.textContent = "Found coalition";
    create.disabled = d.members.length < 2;
    create.title = d.members.length < 2 ? "Pick at least two realms" : "";
    create.addEventListener("click", () => {
      const u = createCoalition(world, d.members, d.name, d.color);
      if (!u) return;
      this.draft = null;
      this.selected = u.id;
      this.stopPicking(false);
      this.changed();
    });
    const cancel = document.createElement("button");
    cancel.className = "btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.draft = null;
      this.stopPicking();
    });
    actions.append(create, cancel);
    box.appendChild(actions);
    return box;
  }
}
