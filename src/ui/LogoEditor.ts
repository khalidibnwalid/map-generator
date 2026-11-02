import type { WorldData } from "../game/WorldData";
import { syncSliders } from "./components/Slider";
import { FLAG_BADGES, FLAG_CHARGES, contrastCharge, type FlagSpec } from "../game/flags";
import { emblemSpec, logoFromFile, renderEmblem } from "../game/emblem";

const CHARGE_NAMES: Record<string, string> = {
  "crescent-star": "Crescent & star",
  crescent: "Crescent",
  star: "Star",
  star8: "Eight-point star",
  sun: "Sun",
  disc: "Disc",
  ring: "Ring",
  "stars-row": "Three stars",
  "stars-ring": "Ring of stars",
  lozenge: "Lozenge",
  swords: "Crossed swords",
  mountain: "Mountain",
  crown: "Crown",
  wheel: "Wheel",
};

const SIGILS = FLAG_CHARGES.filter((c) => c !== "none");

// Modal logo designer for a culture, like the flag editor: pick a sigil, colors
// and badge, or upload a picture. Edits a copy; Save writes it to the culture.
export class LogoEditor {
  private root: HTMLDivElement;
  private world!: WorldData;
  private idx = -1;
  private spec!: FlagSpec;
  private image: string | undefined;
  private onSave: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "modal-overlay flag-modal";
    this.root.style.display = "none";
    this.root.innerHTML = /* html */ `
      <div class="modal-content flag-editor logo-editor">
        <div class="fe-head">
          <span class="modal-title" id="le-title">Logo</span>
          <button class="icon-btn" id="le-close" title="Close">✕</button>
        </div>
        <div class="fe-preview"><canvas id="le-canvas" width="240" height="240" class="le-canvas"></canvas></div>
        <div class="field-label">Sigil</div>
        <div class="fe-grid" id="le-charges"></div>
        <div class="fe-colors">
          <label><span>Field</span><input type="color" id="le-field" /></label>
          <label><span>Sigil</span><input type="color" id="le-charge-color" /></label>
          <label class="fe-grow"><span>Size</span><input type="range" id="le-scale" min="0.6" max="1.6" step="0.05" /></label>
        </div>
        <div class="fe-row">
          <div class="fe-seg" id="le-badge"></div>
          <label class="fe-inline"><span>Badge</span><input type="color" id="le-badge-color" /></label>
        </div>
        <div class="fe-row">
          <button class="btn-cancel" id="le-upload">Upload image</button>
          <button class="btn-cancel" id="le-remove-image" style="display:none">Remove image</button>
          <input type="file" id="le-file" accept="image/*" hidden />
        </div>
        <div class="modal-actions fe-actions">
          <button class="btn-cancel" id="le-random" title="Draw a different emblem">Randomize</button>
          <button class="btn-cancel" id="le-reset" title="Back to the generated emblem">Reset</button>
          <span class="fe-spacer"></span>
          <button class="btn-cancel" id="le-cancel">Cancel</button>
          <button class="btn-ok" id="le-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(this.root);

    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    $("le-close").addEventListener("click", () => this.close());
    $("le-cancel").addEventListener("click", () => this.close());
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display !== "none") this.close();
    });
    $("le-save").addEventListener("click", () => {
      const c = this.world.cultures[this.idx];
      if (c) {
        c.logoSpec = { ...this.spec, colors: [...this.spec.colors] };
        c.logo = this.image;
        delete c.logoSeed;
        this.world.culturesEdited = true;
      }
      this.close();
      this.onSave?.();
    });
    $("le-random").addEventListener("click", () => {
      const c = this.world.cultures[this.idx];
      this.image = undefined;
      this.spec = emblemSpec({ ...c, logoSpec: undefined, logoSeed: 1 + Math.floor(Math.random() * 1e6) }, this.family());
      this.refresh();
    });
    $("le-reset").addEventListener("click", () => {
      const c = this.world.cultures[this.idx];
      this.image = undefined;
      this.spec = emblemSpec({ ...c, logoSpec: undefined, logoSeed: undefined }, this.family());
      this.refresh();
    });
    $("le-upload").addEventListener("click", () => $<HTMLInputElement>("le-file").click());
    $<HTMLInputElement>("le-file").addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        this.image = await logoFromFile(file);
        this.refresh(false);
      } catch {
        // an unreadable file leaves the design as it was
      }
    });
    $("le-remove-image").addEventListener("click", () => {
      this.image = undefined;
      this.refresh(false);
    });
    // Editing the design replaces an uploaded picture
    const design = (apply: () => void) => {
      this.image = undefined;
      apply();
      this.refresh(false);
    };
    $<HTMLInputElement>("le-field").addEventListener("input", (e) => {
      const v = (e.target as HTMLInputElement).value;
      design(() => (this.spec.colors = [v, v, v]));
    });
    $<HTMLInputElement>("le-charge-color").addEventListener("input", (e) => design(() => (this.spec.chargeColor = (e.target as HTMLInputElement).value)));
    $<HTMLInputElement>("le-badge-color").addEventListener("input", (e) => design(() => (this.spec.badgeColor = (e.target as HTMLInputElement).value)));
    $<HTMLInputElement>("le-scale").addEventListener("input", (e) => design(() => (this.spec.chargeScale = Number((e.target as HTMLInputElement).value))));
  }

  private family() {
    return this.world.languages[this.idx]?.family.key ?? "Latin";
  }

  public open(world: WorldData, idx: number, onSave: () => void) {
    const culture = world.cultures[idx];
    if (!culture) return;
    this.world = world;
    this.idx = idx;
    this.onSave = onSave;
    const spec = emblemSpec(culture, world.languages[idx]?.family.key ?? "Latin");
    this.spec = { ...spec, colors: [...spec.colors] };
    this.image = culture.logo;
    this.root.querySelector("#le-title")!.textContent = `Logo of ${culture.name}`;
    this.root.style.display = "flex";
    this.refresh();
  }

  private close() {
    this.root.style.display = "none";
  }

  private refresh(galleries = true) {
    const sp = this.spec;
    const canvas = this.root.querySelector<HTMLCanvasElement>("#le-canvas")!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.image) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.beginPath();
        ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2 - 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      };
      img.src = this.image;
    } else ctx.drawImage(renderEmblem(sp, canvas.width), 0, 0);

    const setVal = (sel: string, v: string) => {
      const el = this.root.querySelector<HTMLInputElement>(sel);
      if (el && el.value !== v) el.value = v;
    };
    setVal("#le-field", sp.colors[0]);
    setVal("#le-charge-color", sp.chargeColor);
    setVal("#le-badge-color", sp.badgeColor ?? "#f3efe2");
    setVal("#le-scale", String(sp.chargeScale));
    syncSliders(this.root);
    this.root.querySelector<HTMLElement>("#le-remove-image")!.style.display = this.image ? "" : "none";

    const seg = this.root.querySelector<HTMLDivElement>("#le-badge")!;
    seg.innerHTML = "";
    for (const b of FLAG_BADGES) {
      const btn = document.createElement("button");
      btn.className = `fe-seg-btn ${(sp.badge ?? "none") === b ? "active" : ""}`;
      btn.textContent = b === "none" ? "No badge" : b === "disc" ? "Roundel" : "Shield";
      btn.addEventListener("click", () => {
        this.image = undefined;
        sp.badge = b;
        if (b !== "none" && !sp.badgeColor) sp.badgeColor = "#f3efe2";
        sp.chargeColor = contrastCharge(sp, sp.chargeColor);
        this.refresh();
      });
      seg.appendChild(btn);
    }

    if (!galleries) {
      this.markActive();
      return;
    }
    const host = this.root.querySelector<HTMLDivElement>("#le-charges")!;
    host.innerHTML = "";
    for (const k of SIGILS) {
      const b = document.createElement("button");
      b.className = "fe-thumb";
      b.dataset.key = k;
      b.title = CHARGE_NAMES[k] ?? k;
      b.appendChild(renderEmblem({ ...sp, charge: k, chargeScale: 1.1 }, 52));
      b.addEventListener("click", () => {
        this.image = undefined;
        sp.charge = k;
        this.refresh();
      });
      host.appendChild(b);
    }
    this.markActive();
  }

  private markActive() {
    this.root.querySelectorAll<HTMLElement>("#le-charges .fe-thumb").forEach((b) => b.classList.toggle("active", b.dataset.key === this.spec.charge && !this.image));
  }
}
