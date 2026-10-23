import {
  ANALYSIS_SIZE,
  analyzeImage,
  guidePlacement,
  sampleGuide,
  shapeCoast,
  type GuideAnalysis,
  type GuideKind,
  type ImportMode,
  type TerrainGuide,
} from "../game/ImageGuide";
import { NoiseEngine } from "../core/NoiseEngine";
import { syncSliders } from "./components/Slider";

const MODES: { value: ImportMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Picks the reading that fits the picture." },
  { value: "silhouette", label: "Filled", hint: "Painted shapes are land. Holes in them become lakes." },
  { value: "outline", label: "Outline", hint: "Closed lines enclose land. A ring drawn inside an island is a lake." },
  { value: "colors", label: "Colors", hint: "Blue is sea. Greens, tans, browns and white become lowlands, deserts, hills and peaks." },
  { value: "heightmap", label: "Height", hint: "Brighter is higher. Sea level decides the coast." },
];

const KIND_LABEL: Record<GuideKind, string> = {
  silhouette: "filled shapes",
  outline: "an outline sketch",
  colors: "a colored map",
  heightmap: "a heightmap",
};

const switchRow = (id: string, label: string, hint = "") => /* html */ `
  <label class="switch-row">
    <span class="switch-text">${label}${hint ? `<small>${hint}</small>` : ""}</span>
    <input type="checkbox" id="${id}" />
    <span class="switch"></span>
  </label>`;

const seg = (key: string, options: { value: string; label: string }[]) =>
  `<div class="picker segmented pd-seg" data-key="${key}">${options
    .map((o) => `<button type="button" class="pick" data-value="${o.value}"><span class="pick-label">${o.label}</span></button>`)
    .join("")}</div>`;

const mix = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k] - v) * t);

// Guide painted in plain map colors, as it will sit on a W x H world. With
// the world's seed the coast gets the same detail and islands as the
// generated world; `stale` drops a paint overtaken by a newer one.
export async function paintGuide(
  canvas: HTMLCanvasElement,
  guide: TerrainGuide,
  world?: { seed: number; noise: NoiseEngine },
  stale?: () => boolean,
) {
  const W = canvas.width;
  const H = canvas.height;
  const f = sampleGuide(guide, W, H, world ? world.seed : null);
  const coast = world ? await shapeCoast(f, W, H, world.noise) : null;
  if (stale?.()) return;
  const res = W / 800;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    let c: number[];
    if (coast ? coast[i] >= 0 : f.land[i] >= 0.5) {
      const r = f.relief && f.land[i] >= 0.5 ? f.relief[i] : 0.25;
      c = r < 0.5 ? mix([104, 148, 78], [186, 165, 104], r / 0.5) : mix([186, 165, 104], [236, 232, 222], (r - 0.5) / 0.5);
      if (f.moisture && r < 0.5) c = mix(c, [200, 180, 120], Math.max(0, 0.4 - f.moisture[i]) * 1.5);
    } else {
      const shore = coast ? Math.max(0, 1 + coast[i] / (14 * res)) : Math.min(1, f.land[i] * 2.2);
      c = mix([22, 52, 82], [64, 122, 160], f.depth ? shore + (f.depth[i] - shore) * f.inside[i] : shore);
    }
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
}

// Turns a picture into a terrain guide, with a live preview of the coastline
// it will produce on the current world size.
export class ImportDialog {
  public onApply: ((guide: TerrainGuide, name: string) => void) | null = null;

  private root: HTMLDivElement;
  private pixels: ImageData | null = null;
  private source: HTMLCanvasElement | null = null;
  private name = "";
  private mode: ImportMode = "auto";
  private invert = false;
  private gaps = 0.012;
  private seaLevel = -1;
  private roughness = 0.4;
  private islands = 0.3;
  private zoom = 1;
  private world = { seed: 0, noise: new NoiseEngine(0) };
  private paintTimer = 0;
  private paintId = 0;
  private fit: TerrainGuide["fit"] = "contain";
  private overlay = false;
  private result: GuideAnalysis | null = null;
  private worldW = 800;
  private worldH = 450;
  private timer = 0;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "modal-overlay import-modal";
    this.root.style.display = "none";
    this.root.innerHTML = /* html */ `
      <div class="modal-content poster-dialog import-dialog">
        <div class="pd-head">
          <span class="modal-title">Shape from image</span>
          <button class="icon-btn" id="im-close" title="Close">✕</button>
        </div>
        <div class="pd-body">
          <div class="pd-options">
            <button type="button" class="file-card im-choose" id="im-choose">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>
              <span><strong id="im-name">Choose image</strong><small>PNG, JPG, WebP or SVG. You can also paste or drop one.</small></span>
            </button>
            <input type="file" id="im-file" accept="image/*" style="display:none" />
            <div class="field">
              <div class="field-label">Read as <span class="pd-dims" id="im-detected"></span></div>
              ${seg("mode", MODES)}
              <small class="pd-hint" id="im-mode-hint"></small>
            </div>
            <div class="field" id="im-gaps-field">
              <div class="field-label">Close gaps <span class="pd-dims" id="im-gaps-val"></span></div>
              <input type="range" id="im-gaps" min="0" max="0.04" step="0.002" />
              <small class="pd-hint">Bridges breaks in hand-drawn coastlines. Too high fuses nearby shapes.</small>
            </div>
            <div class="field" id="im-sea-field">
              <div class="field-label">Sea level <span class="pd-dims" id="im-sea-val"></span></div>
              <input type="range" id="im-sea" min="0" max="0.95" step="0.01" />
            </div>
            <div class="field">
              <div class="field-label">Coast detail <span class="pd-dims" id="im-rough-val"></span></div>
              <input type="range" id="im-rough" min="0" max="1" step="0.05" />
              <small class="pd-hint">Fractal bays and capes added to the drawn coast.</small>
            </div>
            <div class="field">
              <div class="field-label">Islands <span class="pd-dims" id="im-isl-val"></span></div>
              <input type="range" id="im-isl" min="0" max="1" step="0.05" />
              <small class="pd-hint">Island chains carry peninsulas out to sea, stepping stones cross the straits, and islets line the shore.</small>
            </div>
            <div class="field">
              <div class="field-label">Zoom <span class="pd-dims" id="im-zoom-val"></span></div>
              <input type="range" id="im-zoom" min="0.3" max="2.5" step="0.05" />
              <small class="pd-hint">How large the picture sits on the world. Past 100% its edges are cut off.</small>
            </div>
            <div class="field">
              <div class="field-label">Placement</div>
              ${seg("fit", [
                { value: "contain", label: "Fit, ocean around" },
                { value: "stretch", label: "Stretch to fill" },
              ])}
            </div>
            <div class="group">
              ${switchRow("im-invert", "Swap land and sea", "for pictures where the sea is drawn")}
              ${switchRow("im-overlay", "Show the picture", "over the preview")}
            </div>
          </div>
          <div class="pd-preview-col">
            <div class="pd-preview im-drop" id="im-preview">
              <canvas id="im-canvas" width="2" height="2"></canvas>
              <div class="pd-preview-msg" id="im-msg"></div>
            </div>
            <div class="pd-progress"><span id="im-stats"></span></div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" id="im-cancel">Cancel</button>
          <button class="btn-primary pd-export" id="im-apply">Create world</button>
        </div>
      </div>`;
    document.body.appendChild(this.root);

    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    const fileInput = $<HTMLInputElement>("im-file");
    $("im-close").addEventListener("click", () => this.close());
    $("im-cancel").addEventListener("click", () => this.close());
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) this.close();
    });
    $("im-choose").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) this.load(file, file.name);
    });
    window.addEventListener("paste", (e) => {
      if (!this.isOpen()) return;
      const item = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      this.load(file, "Pasted image");
    });
    const drop = $("im-preview");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("over");
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) this.load(file, file.name);
    });

    this.root.querySelectorAll<HTMLElement>(".pd-seg").forEach((el) =>
      el.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>(".pick");
        if (!b) return;
        if (el.dataset.key === "mode") {
          this.mode = b.dataset.value as ImportMode;
          this.schedule();
        } else {
          this.fit = b.dataset.value as TerrainGuide["fit"];
          this.paint();
        }
        this.sync();
      }),
    );
    $<HTMLInputElement>("im-gaps").addEventListener("input", (e) => {
      this.gaps = Number((e.target as HTMLInputElement).value);
      this.sync();
      this.schedule();
    });
    $<HTMLInputElement>("im-sea").addEventListener("input", (e) => {
      this.seaLevel = Number((e.target as HTMLInputElement).value);
      this.sync();
      this.schedule();
    });
    $<HTMLInputElement>("im-rough").addEventListener("input", (e) => {
      this.roughness = Number((e.target as HTMLInputElement).value);
      this.sync();
      this.schedulePaint();
    });
    $<HTMLInputElement>("im-isl").addEventListener("input", (e) => {
      this.islands = Number((e.target as HTMLInputElement).value);
      this.sync();
      this.schedulePaint();
    });
    $<HTMLInputElement>("im-zoom").addEventListener("input", (e) => {
      this.zoom = Number((e.target as HTMLInputElement).value);
      this.sync();
      this.schedulePaint();
    });
    $<HTMLInputElement>("im-invert").addEventListener("change", (e) => {
      this.invert = (e.target as HTMLInputElement).checked;
      this.schedule();
    });
    $<HTMLInputElement>("im-overlay").addEventListener("change", (e) => {
      this.overlay = (e.target as HTMLInputElement).checked;
      this.paint();
    });
    $("im-apply").addEventListener("click", () => {
      const guide = this.guide();
      if (!guide) return;
      this.close();
      this.onApply?.(guide, this.name);
    });
    window.addEventListener("resize", () => {
      if (this.isOpen()) this.paint();
    });
  }

  public isOpen() {
    return this.root.style.display !== "none";
  }

  // World size and seed shape the preview; `file` starts with that picture
  public open(worldW: number, worldH: number, seed: number, file?: File) {
    this.worldW = worldW;
    this.worldH = worldH;
    if (seed !== this.world.seed) this.world = { seed, noise: new NoiseEngine(seed) };
    this.root.style.display = "flex";
    this.sync();
    if (file) this.load(file, file.name);
    else this.paint();
  }

  private close() {
    this.root.style.display = "none";
    clearTimeout(this.timer);
    clearTimeout(this.paintTimer);
  }

  private guide(): TerrainGuide | null {
    if (!this.result) return null;
    const { w, h, land, relief, depth, moisture } = this.result;
    return { w, h, land, relief, depth, moisture, fit: this.fit, roughness: this.roughness, islands: this.islands, zoom: this.zoom };
  }

  private async load(file: Blob, name: string) {
    const msg = this.root.querySelector<HTMLElement>("#im-msg")!;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // SVGs without a size report 0
      const iw = img.naturalWidth || ANALYSIS_SIZE;
      const ih = img.naturalHeight || ANALYSIS_SIZE;
      const k = Math.min(1, ANALYSIS_SIZE / Math.max(iw, ih));
      const c = document.createElement("canvas");
      c.width = Math.max(8, Math.round(iw * k));
      c.height = Math.max(8, Math.round(ih * k));
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      this.pixels = ctx.getImageData(0, 0, c.width, c.height);
      this.source = c;
      this.name = name;
      this.seaLevel = -1;
      this.result = null;
      this.sync();
      this.schedule(0);
    } catch {
      msg.textContent = "That file could not be read as an image.";
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private schedule(delay = 140) {
    clearTimeout(this.timer);
    if (!this.pixels) return;
    this.root.querySelector("#im-preview")!.classList.add("loading");
    this.timer = window.setTimeout(() => {
      if (!this.pixels) return;
      this.result = analyzeImage(this.pixels, {
        mode: this.mode,
        invert: this.invert,
        gaps: this.gaps,
        seaLevel: this.seaLevel,
      });
      this.root.querySelector("#im-preview")!.classList.remove("loading");
      this.sync();
      this.paint();
    }, delay);
  }

  private sync() {
    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    this.root.querySelectorAll<HTMLElement>(".pd-seg").forEach((el) => {
      const v = el.dataset.key === "mode" ? this.mode : this.fit;
      el.querySelectorAll<HTMLElement>(".pick").forEach((b) => b.classList.toggle("active", b.dataset.value === v));
    });
    const r = this.result;
    const kind = r?.kind ?? (this.mode === "auto" ? null : this.mode);
    $("im-name").textContent = this.name || "Choose image";
    $("im-detected").textContent = this.mode === "auto" && r ? `· looks like ${KIND_LABEL[r.kind]}` : "";
    $("im-mode-hint").textContent = MODES.find((m) => m.value === (this.mode === "auto" && kind ? kind : this.mode))!.hint;
    $("im-gaps-field").style.display = kind === "outline" ? "" : "none";
    $("im-sea-field").style.display = kind === "heightmap" ? "" : "none";
    const sea = this.seaLevel >= 0 ? this.seaLevel : (r?.seaLevel ?? 0.3);
    $<HTMLInputElement>("im-gaps").value = String(this.gaps);
    $<HTMLInputElement>("im-sea").value = String(Math.max(0, sea));
    $<HTMLInputElement>("im-rough").value = String(this.roughness);
    $<HTMLInputElement>("im-isl").value = String(this.islands);
    $<HTMLInputElement>("im-zoom").value = String(this.zoom);
    $("im-isl-val").textContent = `${Math.round(this.islands * 100)}%`;
    $("im-zoom-val").textContent = `${Math.round(this.zoom * 100)}%`;
    $("im-gaps-val").textContent = `${(this.gaps * 100).toFixed(1)}%`;
    $("im-sea-val").textContent = `${Math.round(Math.max(0, sea) * 100)}%${this.seaLevel < 0 ? " · auto" : ""}`;
    $("im-rough-val").textContent = `${Math.round(this.roughness * 100)}%`;
    $<HTMLButtonElement>("im-apply").disabled = !r || r.landShare <= 0;
    $("im-stats").innerHTML = r
      ? r.landShare > 0
        ? `${Math.round(r.landShare * 100)}% land · ${r.landmasses} ${r.landmasses === 1 ? "landmass" : "landmasses"}${r.relief ? " · relief from the picture" : ""}${r.moisture ? " · climate hints" : ""}`
        : "No land found. Try another reading, or swap land and sea."
      : this.pixels
        ? "Reading the picture…"
        : "";
    syncSliders(this.root);
  }

  private schedulePaint() {
    clearTimeout(this.paintTimer);
    this.paintTimer = window.setTimeout(() => this.paint(), 90);
  }

  private async paint() {
    const id = ++this.paintId;
    const box = this.root.querySelector<HTMLElement>("#im-preview")!;
    const canvas = this.root.querySelector<HTMLCanvasElement>("#im-canvas")!;
    const msg = this.root.querySelector<HTMLElement>("#im-msg")!;
    const guide = this.guide();
    msg.innerHTML = guide ? "" : this.pixels ? "" : `Drop a picture here, paste one, or choose a file.<br /><small>A rough sketch is enough: a filled blob, a coastline outline, a colored map or a heightmap.</small>`;
    canvas.style.visibility = guide ? "visible" : "hidden";
    if (!guide) return;
    const maxW = Math.max(200, box.clientWidth - 28);
    const maxH = Math.max(120, box.clientHeight - 28);
    const k = Math.min(maxW / this.worldW, maxH / this.worldH);
    // Drawn off screen: resizing the visible canvas would blank it meanwhile
    const off = document.createElement("canvas");
    off.width = Math.round(this.worldW * k);
    off.height = Math.round(this.worldH * k);
    await paintGuide(off, guide, this.world, () => id !== this.paintId);
    if (id !== this.paintId) return;
    canvas.width = off.width;
    canvas.height = off.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(off, 0, 0);
    if (this.overlay && this.source) {
      const p = guidePlacement(guide, canvas.width, canvas.height);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this.source, p.ox, p.oy, guide.w * p.sx, guide.h * p.sy);
      ctx.globalAlpha = 1;
    }
  }
}
