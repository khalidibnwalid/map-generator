import type { WorldData } from "../game/WorldData";
import { syncSliders } from "./components/Slider";
import {
  CHARGE_NAMES,
  FLAG_BADGES,
  FLAG_CHARGES,
  FLAG_LAYOUTS,
  contrastCharge,
  defaultFlagFor,
  flagOf,
  normalizeCharge,
  randomFlagFor,
  renderFlag,
  type ChargePos,
  type FlagSpec,
} from "../game/flags";

const LAYOUT_NAMES: Record<string, string> = {
  plain: "Plain",
  hbi: "Bicolor",
  htri: "Tricolor",
  fess: "Fess",
  vbi: "Vertical bicolor",
  vtri: "Vertical tricolor",
  pale: "Pale",
  diag: "Per bend",
  bend: "Bend",
  "hoist-tri": "Hoist triangle",
  chevron: "Chevron",
  stripes: "Stripes",
  border: "Bordure",
  quartered: "Quartered",
  canton: "Canton",
  "hoist-band": "Hoist band",
  serrated: "Serrated",
  rays: "Sunburst",
  waves: "Waves",
  "tribar-hoist": "Hoist bar",
};

const POSITIONS: { value: ChargePos; label: string }[] = [
  { value: "center", label: "Center" },
  { value: "hoist", label: "Hoist" },
  { value: "canton", label: "Canton" },
];

// Whose flag is being edited: a nation's, or anything else that carries one (coalitions)
export interface FlagTarget {
  title: string;
  spec: FlagSpec;
  canton?: FlagSpec | null; // the overlord's flag, drawn in the canton
  random: () => FlagSpec;
  reset: () => FlagSpec; // the generated flag
  save: (spec: FlagSpec) => void;
}

// Modal flag designer. Edits a copy; Save hands it to the target.
export class FlagEditor {
  private root: HTMLDivElement;
  private spec!: FlagSpec;
  private target: FlagTarget | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "modal-overlay flag-modal";
    this.root.style.display = "none";
    this.root.innerHTML = /* html */ `
      <div class="modal-content flag-editor">
        <div class="fe-head">
          <span class="modal-title" id="fe-title">Flag</span>
          <button class="icon-btn" id="fe-close" title="Close">✕</button>
        </div>
        <div class="fe-preview"><canvas id="fe-canvas" width="360" height="240"></canvas></div>
        <div class="field-label">Layout</div>
        <div class="fe-grid" id="fe-layouts"></div>
        <div class="fe-colors">
          <label><span>Field</span><input type="color" data-color="0" /></label>
          <label><span>Second</span><input type="color" data-color="1" /></label>
          <label><span>Third</span><input type="color" data-color="2" /></label>
          <label><span class="fe-fim-label"><input type="checkbox" id="fe-fim" title="Thin lines between fields (fimbriation)" />Lines</span><input type="color" id="fe-fim-color" /></label>
        </div>
        <div class="field-label">Emblem</div>
        <div class="fe-grid" id="fe-charges"></div>
        <div class="fe-row">
          <label class="fe-inline"><span>Color</span><input type="color" id="fe-charge-color" /></label>
          <div class="fe-seg" id="fe-pos"></div>
          <label class="fe-inline fe-grow"><span>Size</span><input type="range" id="fe-scale" min="0.6" max="1.6" step="0.05" /></label>
        </div>
        <div class="fe-row">
          <div class="fe-seg" id="fe-badge"></div>
          <label class="fe-inline"><span>Badge</span><input type="color" id="fe-badge-color" /></label>
        </div>
        <div class="modal-actions fe-actions">
          <button class="btn-cancel" id="fe-random" title="Generate a new design">Randomize</button>
          <button class="btn-cancel" id="fe-reset" title="Back to the generated flag">Reset</button>
          <span class="fe-spacer"></span>
          <button class="btn-cancel" id="fe-cancel">Cancel</button>
          <button class="btn-ok" id="fe-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(this.root);

    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    $("fe-close").addEventListener("click", () => this.close());
    $("fe-cancel").addEventListener("click", () => this.close());
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    $("fe-save").addEventListener("click", () => {
      const target = this.target;
      this.close();
      target?.save({ ...this.spec, colors: [...this.spec.colors] });
    });
    $("fe-random").addEventListener("click", () => {
      if (this.target) this.spec = this.target.random();
      this.refresh();
    });
    $("fe-reset").addEventListener("click", () => {
      if (this.target) this.spec = this.target.reset();
      this.refresh();
    });
    this.root.querySelectorAll<HTMLInputElement>("input[data-color]").forEach((inp) =>
      inp.addEventListener("input", () => {
        this.spec.colors[Number(inp.dataset.color)] = inp.value;
        this.refresh(false);
      }),
    );
    $<HTMLInputElement>("fe-fim").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.spec.fimbriation = on ? $<HTMLInputElement>("fe-fim-color").value : null;
      this.refresh(false);
    });
    $<HTMLInputElement>("fe-fim-color").addEventListener("input", (e) => {
      if (this.spec.fimbriation) this.spec.fimbriation = (e.target as HTMLInputElement).value;
      this.refresh(false);
    });
    $<HTMLInputElement>("fe-charge-color").addEventListener("input", (e) => {
      this.spec.chargeColor = (e.target as HTMLInputElement).value;
      this.refresh(false);
    });
    $<HTMLInputElement>("fe-badge-color").addEventListener("input", (e) => {
      this.spec.badgeColor = (e.target as HTMLInputElement).value;
      this.refresh(false);
    });
    $<HTMLInputElement>("fe-scale").addEventListener("input", (e) => {
      this.spec.chargeScale = Number((e.target as HTMLInputElement).value);
      this.refresh(false);
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display !== "none") this.close();
    });
  }

  public open(world: WorldData, idx: number, onSave: () => void) {
    const spec = flagOf(world, idx);
    const n = world.nations[idx];
    if (!spec || !n) return;
    this.edit({
      title: `Flag of ${n.name}`,
      spec,
      canton: n.overlord !== undefined ? flagOf(world, n.overlord) : null,
      random: () => randomFlagFor(world, idx),
      reset: () => defaultFlagFor(world, idx),
      save: (f) => {
        n.flag = f;
        onSave();
      },
    });
  }

  public edit(target: FlagTarget) {
    this.target = target;
    const spec = target.spec;
    this.spec = { ...spec, charge: normalizeCharge(spec.charge), colors: [...spec.colors] };
    this.root.querySelector("#fe-title")!.textContent = target.title;
    this.root.style.display = "flex";
    this.refresh();
  }

  private close() {
    this.root.style.display = "none";
  }

  // Redraws the preview; `galleries` also rebuilds the layout/emblem pickers
  private refresh(galleries = true) {
    const sp = this.spec;
    const overlord = this.target?.canton ?? null;
    const canvas = this.root.querySelector<HTMLCanvasElement>("#fe-canvas")!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(renderFlag(sp, canvas.width, canvas.height, overlord), 0, 0);

    const setVal = (sel: string, v: string) => {
      const el = this.root.querySelector<HTMLInputElement>(sel);
      if (el && el.value !== v) el.value = v;
    };
    sp.colors.forEach((c, i) => setVal(`input[data-color="${i}"]`, c));
    setVal("#fe-charge-color", sp.chargeColor);
    setVal("#fe-badge-color", sp.badgeColor ?? "#f3efe2");
    setVal("#fe-fim-color", sp.fimbriation ?? "#f3efe2");
    setVal("#fe-scale", String(sp.chargeScale));
    syncSliders(this.root);
    this.root.querySelector<HTMLInputElement>("#fe-fim")!.checked = !!sp.fimbriation;

    this.seg("#fe-pos", POSITIONS, sp.chargePos, (v) => {
      sp.chargePos = v;
      sp.chargeColor = contrastCharge(sp, sp.chargeColor);
      this.refresh();
    });
    this.seg(
      "#fe-badge",
      FLAG_BADGES.map((b) => ({ value: b, label: b === "none" ? "No badge" : b === "disc" ? "Roundel" : "Shield" })),
      sp.badge ?? "none",
      (v) => {
        sp.badge = v;
        if (v !== "none" && !sp.badgeColor) sp.badgeColor = "#f3efe2";
        this.refresh();
      },
    );

    if (!galleries) {
      this.markActive();
      return;
    }
    const thumbs = (host: string, keys: readonly string[], names: Record<string, string>, make: (k: string) => FlagSpec, apply: (k: string) => void) => {
      const el = this.root.querySelector<HTMLDivElement>(host)!;
      el.innerHTML = "";
      for (const k of keys) {
        const b = document.createElement("button");
        b.className = "fe-thumb";
        b.dataset.key = k;
        b.title = names[k] ?? k;
        const img = renderFlag(make(k), 72, 48);
        const c = document.createElement("canvas");
        c.width = 72;
        c.height = 48;
        c.getContext("2d")!.drawImage(img, 0, 0);
        b.appendChild(c);
        b.addEventListener("click", () => {
          apply(k);
          this.refresh();
        });
        el.appendChild(b);
      }
    };
    thumbs("#fe-layouts", FLAG_LAYOUTS, LAYOUT_NAMES, (k) => ({ ...sp, layout: k as FlagSpec["layout"], charge: "none", badge: "none", fimbriation: sp.fimbriation }), (k) => {
      sp.layout = k as FlagSpec["layout"];
      sp.chargeColor = contrastCharge(sp, sp.chargeColor);
    });
    thumbs("#fe-charges", FLAG_CHARGES, CHARGE_NAMES, (k) => ({ ...sp, charge: k as FlagSpec["charge"], chargeScale: 1.1 }), (k) => {
      sp.charge = k as FlagSpec["charge"];
    });
    this.markActive();
  }

  private markActive() {
    this.root.querySelectorAll<HTMLElement>("#fe-layouts .fe-thumb").forEach((b) => b.classList.toggle("active", b.dataset.key === this.spec.layout));
    this.root.querySelectorAll<HTMLElement>("#fe-charges .fe-thumb").forEach((b) => b.classList.toggle("active", b.dataset.key === this.spec.charge));
  }

  private seg<V extends string>(sel: string, opts: readonly { value: V; label: string }[], current: V, set: (v: V) => void) {
    const el = this.root.querySelector<HTMLDivElement>(sel)!;
    el.innerHTML = "";
    for (const o of opts) {
      const b = document.createElement("button");
      b.className = `fe-seg-btn ${o.value === current ? "active" : ""}`;
      b.textContent = o.label;
      b.addEventListener("click", () => set(o.value));
      el.appendChild(b);
    }
  }
}
