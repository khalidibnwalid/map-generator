import { CELL_KM2, type WorldData } from "../game/WorldData";
import { nationFlagUrl } from "../game/flags";
import {
  compact,
  downloadBlob,
  escapeHtml,
  fileSlug,
  frameExtent,
  nationsExtent,
  scopeNations,
  worldExtent,
  type AtlasHost,
} from "./AtlasRender";
import { loadPosterFonts, paintBackground, paintDecorations, posterLayout, posterView, type PosterSpec } from "./PosterDecor";

type Scope = "world" | "nations";
type Format = "png" | "jpeg";

const SIZES = [
  { value: 2048, label: "2K" },
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
];

const DECOR = [
  { key: "title", label: "Title cartouche" },
  { key: "compass", label: "Compass rose" },
  { key: "scaleBar", label: "Scale bar", hint: "kilometers" },
  { key: "legend", label: "Legend", hint: "realms, or the thematic key" },
  { key: "frame", label: "Border & frame", hint: "styled after the map theme" },
  { key: "flags", label: "Row of flags" },
] as const;
type DecorKey = (typeof DECOR)[number]["key"];

const switchRow = (id: string, label: string, checked: boolean, hint = "") => /* html */ `
  <label class="switch-row">
    <span class="switch-text">${label}${hint ? `<small>${hint}</small>` : ""}</span>
    <input type="checkbox" id="${id}" ${checked ? "checked" : ""} />
    <span class="switch"></span>
  </label>`;

const seg = (key: string, options: { value: string | number; label: string }[]) =>
  `<div class="picker segmented pd-seg" data-key="${key}">${options
    .map((o) => `<button type="button" class="pick" data-value="${o.value}"><span class="pick-label">${o.label}</span></button>`)
    .join("")}</div>`;

// Export dialog: scope, size, format and decorations, with a live preview
// rendered through the same pipeline as the final image.
export class PosterDialog {
  private host: AtlasHost;
  private root: HTMLDivElement;
  private world: WorldData | null = null;
  private scope: Scope = "world";
  private picked = new Set<number>();
  private vassals = true;
  private size = 4096;
  private format: Format = "png";
  private decor: Record<DecorKey, boolean> = { title: true, compass: true, scaleBar: true, legend: true, frame: true, flags: false };
  private previewTimer = 0;
  private previewRunning = false;
  private previewPending = false;
  private exporting = false;
  private cancelRequested = false;

  constructor(host: AtlasHost) {
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "modal-overlay poster-modal";
    this.root.style.display = "none";
    this.root.innerHTML = /* html */ `
      <div class="modal-content poster-dialog">
        <div class="pd-head">
          <span class="modal-title">Export poster</span>
          <button class="icon-btn" id="pd-close" title="Close">✕</button>
        </div>
        <div class="pd-body">
          <div class="pd-options">
            <div class="field">
              <div class="field-label">Scope</div>
              ${seg("scope", [
                { value: "world", label: "Whole world" },
                { value: "nations", label: "Selected nations" },
              ])}
            </div>
            <div class="pd-nations" id="pd-nations">
              <input type="search" id="pd-filter" placeholder="Filter nations…" />
              <div class="pd-nation-list" id="pd-nation-list"></div>
              <div class="pd-nation-tools">
                <button type="button" class="btn-ghost pd-mini" id="pd-all">All</button>
                <button type="button" class="btn-ghost pd-mini" id="pd-none">None</button>
                <span class="pd-count" id="pd-count"></span>
              </div>
              ${switchRow("pd-vassals", "Include vassals", true)}
            </div>
            <div class="field">
              <div class="field-label">Size <span class="pd-dims" id="pd-dims"></span></div>
              ${seg("size", SIZES)}
            </div>
            <div class="field">
              <div class="field-label">Format</div>
              ${seg("format", [
                { value: "png", label: "PNG" },
                { value: "jpeg", label: "JPEG" },
              ])}
              <small class="pd-hint">JPEG keeps large posters to a few megabytes.</small>
            </div>
            <div class="group">
              <div class="group-title">Decorations</div>
              ${DECOR.map((d) => switchRow(`pd-${d.key}`, d.label, this.decor[d.key], "hint" in d ? d.hint : "")).join("")}
              <div class="pd-title-fields" id="pd-title-fields">
                <input type="text" id="pd-title-text" placeholder="Title" />
                <input type="text" id="pd-subtitle-text" placeholder="Subtitle" />
              </div>
            </div>
          </div>
          <div class="pd-preview-col">
            <div class="pd-preview" id="pd-preview">
              <canvas id="pd-canvas" width="2" height="2"></canvas>
              <div class="pd-preview-msg" id="pd-preview-msg"></div>
            </div>
            <div class="pd-progress" id="pd-progress">
              <div class="loader-progress-bar"><div class="loader-progress-fill" id="pd-progress-fill"></div></div>
              <span id="pd-progress-label"></span>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" id="pd-cancel">Close</button>
          <button class="btn-primary pd-export" id="pd-export">Export</button>
        </div>
      </div>`;
    document.body.appendChild(this.root);

    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    $("pd-close").addEventListener("click", () => this.close());
    $("pd-cancel").addEventListener("click", () => {
      if (this.exporting) this.cancelRequested = true;
      else this.close();
    });
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root && !this.exporting) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display !== "none" && !this.exporting) this.close();
    });

    this.root.querySelectorAll<HTMLElement>(".pd-seg").forEach((el) =>
      el.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>(".pick");
        if (!b) return;
        const v = b.dataset.value!;
        const key = el.dataset.key;
        if (key === "scope") this.scope = v as Scope;
        else if (key === "size") this.size = Number(v);
        else if (key === "format") this.format = v as Format;
        this.sync();
        if (key !== "format") this.schedulePreview();
      }),
    );
    $("pd-filter").addEventListener("input", () => this.renderNationList());
    $("pd-nation-list").addEventListener("change", (e) => {
      const cb = e.target as HTMLInputElement;
      const idx = Number(cb.dataset.idx);
      if (cb.checked) this.picked.add(idx);
      else this.picked.delete(idx);
      this.sync();
      this.schedulePreview();
    });
    $("pd-all").addEventListener("click", () => {
      this.visibleNations().forEach((i) => this.picked.add(i));
      this.renderNationList();
      this.sync();
      this.schedulePreview();
    });
    $("pd-none").addEventListener("click", () => {
      this.picked.clear();
      this.renderNationList();
      this.sync();
      this.schedulePreview();
    });
    $<HTMLInputElement>("pd-vassals").addEventListener("change", (e) => {
      this.vassals = (e.target as HTMLInputElement).checked;
      this.sync();
      this.schedulePreview();
    });
    for (const d of DECOR)
      $<HTMLInputElement>(`pd-${d.key}`).addEventListener("change", (e) => {
        this.decor[d.key] = (e.target as HTMLInputElement).checked;
        this.sync();
        this.schedulePreview();
      });
    for (const id of ["pd-title-text", "pd-subtitle-text"]) $(id).addEventListener("input", () => this.schedulePreview());
    $("pd-export").addEventListener("click", () => this.export());
    window.addEventListener("resize", () => {
      if (this.root.style.display !== "none") this.schedulePreview();
    });
  }

  // `selected` seeds the nation scope with the nation picked in the table
  public open(selected = -1) {
    const world = this.host.getWorld();
    if (world !== this.world) {
      this.world = world;
      this.picked.clear();
      (this.root.querySelector("#pd-title-text") as HTMLInputElement).value = "";
      (this.root.querySelector("#pd-subtitle-text") as HTMLInputElement).value = "";
    }
    for (const i of [...this.picked]) if (!world.nations[i]) this.picked.delete(i);
    if (!this.picked.size && world.nations[selected]) this.picked.add(selected);
    (this.root.querySelector("#pd-filter") as HTMLInputElement).value = "";
    this.root.style.display = "flex";
    this.setProgress(null);
    this.renderNationList();
    this.sync();
    this.schedulePreview(0);
  }

  private close() {
    this.root.style.display = "none";
    clearTimeout(this.previewTimer);
  }

  private visibleNations(): number[] {
    const world = this.host.getWorld();
    const q = (this.root.querySelector("#pd-filter") as HTMLInputElement).value.trim().toLowerCase();
    return world.nations
      .map((n, i) => ({ n, i }))
      .filter((e) => !q || e.n.name.toLowerCase().includes(q))
      .sort((a, b) => a.n.name.localeCompare(b.n.name))
      .map((e) => e.i);
  }

  private renderNationList() {
    const world = this.host.getWorld();
    const area = this.host.landArea();
    const list = this.root.querySelector<HTMLDivElement>("#pd-nation-list")!;
    const rows = this.visibleNations();
    list.innerHTML = rows.length
      ? rows
          .map((i) => {
            const n = world.nations[i];
            const vassal = n.overlord !== undefined ? ` <small>vassal of ${escapeHtml(world.nations[n.overlord]?.name ?? "")}</small>` : "";
            return `<label class="pd-nation">
              <input type="checkbox" data-idx="${i}" ${this.picked.has(i) ? "checked" : ""} />
              <img class="diplo-flag" src="${nationFlagUrl(world, i, 18, 12)}" alt="" />
              <span class="pd-nation-name">${escapeHtml(n.name)}${vassal}</span>
              <span class="pd-nation-area">${compact((area[i] || 0) * CELL_KM2)} km²</span>
            </label>`;
          })
          .join("")
      : `<p class="muted pd-empty">No nation matches.</p>`;
  }

  // Reflects state in the controls
  private sync() {
    const $ = <E extends HTMLElement>(id: string) => this.root.querySelector<E>(`#${id}`)!;
    const mark = (key: string, value: string) =>
      this.root
        .querySelectorAll<HTMLElement>(`.pd-seg[data-key="${key}"] .pick`)
        .forEach((b) => b.classList.toggle("active", b.dataset.value === value));
    mark("scope", this.scope);
    mark("size", String(this.size));
    mark("format", this.format);
    $("pd-nations").style.display = this.scope === "nations" ? "flex" : "none";
    $("pd-title-fields").style.display = this.decor.title ? "grid" : "none";
    const world = this.host.getWorld();
    const keep = scopeNations(world, this.picked, this.vassals);
    $("pd-count").textContent = `${this.picked.size} picked${keep.size > this.picked.size ? ` · ${keep.size - this.picked.size} vassal${keep.size - this.picked.size === 1 ? "" : "s"}` : ""}`;
    const spec = this.spec(this.size);
    $("pd-dims").textContent = spec ? (() => {
      const L = posterLayout(spec);
      return `· ${L.W.toLocaleString()} × ${L.H.toLocaleString()} px`;
    })() : "";
    const t = $<HTMLInputElement>("pd-title-text");
    const s = $<HTMLInputElement>("pd-subtitle-text");
    const d = this.defaults();
    t.placeholder = d.title;
    s.placeholder = d.subtitle || "Subtitle";
    $<HTMLButtonElement>("pd-export").disabled = !spec || this.exporting;
    $("pd-export").textContent = `Export ${this.format === "png" ? "PNG" : "JPEG"}`;
  }

  private defaults(): { title: string; subtitle: string } {
    const world = this.host.getWorld();
    const year = this.host.simYear();
    const yearText = year > 0 ? `Year ${year}` : "";
    if (this.scope === "world" || !this.picked.size) {
      return { title: "The Known World", subtitle: [`${world.nations.length} realms`, yearText].filter(Boolean).join(" · ") };
    }
    const names = [...this.picked].map((i) => world.nations[i]).filter(Boolean);
    if (names.length === 1) {
      const n = names[0];
      const i = world.nations.indexOf(n);
      const capital = world.cities.find((c) => c.nationIndex === i && c.isCapital);
      const area = `${compact((this.host.landArea()[i] || 0) * CELL_KM2)} km²`;
      return {
        title: n.government ? `The ${n.government} of ${n.name}` : n.name,
        subtitle: [capital ? `Capital ${capital.name}` : "", area, yearText].filter(Boolean).join(" · "),
      };
    }
    const list = names.map((n) => n.name).sort();
    const title = list.length === 2 ? `${list[0]} & ${list[1]}` : list.length === 3 ? `${list[0]}, ${list[1]} & ${list[2]}` : `${list[0]}, ${list[1]} & ${list.length - 2} more`;
    return { title, subtitle: [`${list.length} realms`, yearText].filter(Boolean).join(" · ") };
  }

  private spec(longEdge: number): PosterSpec | null {
    const world = this.host.getWorld();
    const area = this.host.landArea();
    let keep: Set<number> | null = null;
    let extent;
    if (this.scope === "nations") {
      keep = scopeNations(world, this.picked, this.vassals);
      const e = keep.size ? nationsExtent(world, keep) : null;
      if (!e) return null;
      extent = frameExtent(world, e, 0.08, 0.7, 2.2, 24);
    } else extent = worldExtent(world);
    const byArea = (keep ? [...keep] : world.nations.map((_, i) => i))
      .filter((i) => (area[i] || 0) > 0)
      .sort((a, b) => (area[b] || 0) - (area[a] || 0));
    const d = this.defaults();
    const t = (this.root.querySelector("#pd-title-text") as HTMLInputElement).value.trim();
    const s = (this.root.querySelector("#pd-subtitle-text") as HTMLInputElement).value.trim();
    const year = this.host.simYear();
    return {
      extent,
      longEdge,
      keep,
      legendNations: byArea,
      title: this.decor.title ? t || d.title : null,
      subtitle: s || d.subtitle,
      compass: this.decor.compass,
      scaleBar: this.decor.scaleBar,
      legend: this.decor.legend,
      frame: this.decor.frame,
      flags: this.decor.flags,
      theme: this.host.mapTheme(),
      thematic: this.host.thematicMode(),
      imprint: `Seed ${world.seed} · ${world.width} × ${world.height} cells of 5 km${year > 0 ? ` · Year ${year}` : ""}`,
    };
  }

  private async paint(
    spec: PosterSpec,
    waitForCities: boolean,
    onProgress?: (f: number, label: string) => void,
    canceled?: () => boolean,
  ): Promise<HTMLCanvasElement> {
    await loadPosterFonts();
    const L = posterLayout(spec);
    const canvas = document.createElement("canvas");
    canvas.width = L.W;
    canvas.height = L.H;
    const ctx = canvas.getContext("2d")!;
    paintBackground(ctx, L, spec);
    await this.host.renderMapTo(ctx, { ...posterView(L, spec), waitForCities, onProgress, canceled });
    paintDecorations(ctx, L, spec, this.host.getWorld(), this.host.landArea());
    return canvas;
  }

  private schedulePreview(delay = 250) {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.runPreview(), delay);
  }

  // Same pipeline at a small size: the layout is resolution independent
  private async runPreview() {
    if (this.exporting || this.root.style.display === "none") return;
    if (this.previewRunning) {
      this.previewPending = true;
      return;
    }
    const box = this.root.querySelector<HTMLDivElement>("#pd-preview")!;
    const view = this.root.querySelector<HTMLCanvasElement>("#pd-canvas")!;
    const msg = this.root.querySelector<HTMLDivElement>("#pd-preview-msg")!;
    const probe = this.spec(1000);
    if (!probe) {
      view.style.visibility = "hidden";
      msg.textContent = "Pick at least one nation with land.";
      return;
    }
    const L0 = posterLayout(probe);
    const bw = Math.max(80, box.clientWidth - 28);
    const bh = Math.max(80, box.clientHeight - 28);
    const fit = Math.min(bw / L0.W, bh / L0.H);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const spec = { ...probe, longEdge: Math.round(Math.max(L0.W, L0.H) * fit * dpr) };
    this.previewRunning = true;
    msg.textContent = "";
    box.classList.add("loading");
    try {
      const img = await this.paint(spec, false);
      if (!this.previewPending) {
        view.width = img.width;
        view.height = img.height;
        view.style.width = `${img.width / dpr}px`;
        view.style.height = `${img.height / dpr}px`;
        view.getContext("2d")!.drawImage(img, 0, 0);
        view.style.visibility = "visible";
      }
    } catch (err) {
      console.error(err);
      msg.textContent = "Preview failed.";
    } finally {
      box.classList.remove("loading");
      this.previewRunning = false;
      if (this.previewPending) {
        this.previewPending = false;
        this.runPreview();
      }
    }
  }

  private setProgress(f: number | null, label = "") {
    const bar = this.root.querySelector<HTMLDivElement>("#pd-progress")!;
    bar.classList.toggle("active", f !== null);
    this.root.querySelector<HTMLDivElement>("#pd-progress-fill")!.style.width = `${Math.round((f ?? 0) * 100)}%`;
    this.root.querySelector<HTMLSpanElement>("#pd-progress-label")!.textContent = label;
  }

  private async export() {
    const spec = this.spec(this.size);
    if (!spec || this.exporting) return;
    this.exporting = true;
    this.cancelRequested = false;
    this.root.classList.add("busy");
    const cancelBtn = this.root.querySelector<HTMLButtonElement>("#pd-cancel")!;
    cancelBtn.textContent = "Cancel";
    this.sync();
    this.setProgress(0, "Preparing");
    // Let a running preview finish first; renders share the GPU canvas
    while (this.previewRunning) await new Promise((r) => setTimeout(r, 50));
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = await this.paint(spec, true, (f, label) => this.setProgress(f, label), () => this.cancelRequested);
      if (this.cancelRequested) {
        this.setProgress(null, "Canceled");
        return;
      }
      this.setProgress(0.92, "Encoding image");
      const mime = this.format === "png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>((r) => canvas!.toBlob(r, mime, 0.92));
      if (!blob) throw new Error("The browser could not encode an image this large. Try a smaller size or JPEG.");
      const label = SIZES.find((s) => s.value === this.size)?.label ?? `${this.size}`;
      downloadBlob(blob, `${fileSlug(spec.title ?? "world-map")}-${label.toLowerCase()}.${this.format === "png" ? "png" : "jpg"}`);
      this.setProgress(1, `Saved · ${(blob.size / 1048576).toFixed(1)} MB`);
    } catch (err) {
      console.error(err);
      this.setProgress(null, (err as Error).message || "Export failed");
    } finally {
      if (canvas) canvas.width = canvas.height = 0; // free the pixels now
      this.exporting = false;
      this.root.classList.remove("busy");
      cancelBtn.textContent = "Close";
      this.sync();
    }
  }
}
