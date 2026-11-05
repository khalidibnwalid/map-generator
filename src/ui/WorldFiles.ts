import type { CanvasManager } from "../core/CanvasManager";
import type { MapGenerator } from "../game/MapGenerator";
import { loadWorld, saveWorld } from "../game/WorldFile";
import { recipeFromHash, recipeToHash, type WorldRecipe } from "../game/WorldLink";
import type { SavedSim } from "../game/sim/Simulation";
import { autoNations, OPTIONS, refreshPickers } from "./components/MainApp";
import { installSliders } from "./components/Slider";
import { background, toast } from "./components/Toast";
import { downloadBlob } from "./AtlasRender";
import type { UIManager } from "./UIManager";

// The File tab and the address bar: saving and opening .world files, world
// links, data and SVG exports, and keeping the World tab's controls in step
// with the world on screen.

export interface WorldFilesHost {
  generator: MapGenerator;
  canvasManager: CanvasManager;
  uiManager: UIManager;
  simSave(): SavedSim | undefined; // recorded history to save with the world
  edited(): boolean; // the world differs from what its seed generates
  title(): string; // a short description, for exported files
  syncNationsRange(w: number, h: number, count?: number): void;
  setGuideName(name: string): void;
  syncGuideCard(): void;
  worldOpened(): void; // a file was opened: refresh everything
}

export class WorldFiles {
  private host: WorldFilesHost;

  constructor(host: WorldFilesHost) {
    this.host = host;
    const g = host.generator;
    const openInput = document.getElementById("open-world-input") as HTMLInputElement | null;
    document.getElementById("save-world")?.addEventListener("click", () => background(this.save(), "Saving the world"));
    document.getElementById("open-world")?.addEventListener("click", () => openInput?.click());
    openInput?.addEventListener("change", () => {
      const file = openInput.files?.[0];
      openInput.value = "";
      if (file) background(this.open(file, file.name), "Opening the world");
    });
    document.getElementById("share-link")?.addEventListener("click", () => background(this.shareLink(), "Sharing the link"));
    document.getElementById("tab-file")?.addEventListener("click", () => this.syncLink());
    window.addEventListener("hashchange", () => this.openLink());

    // Exports load their code on first use
    const busy = (btn: HTMLElement, work: () => Promise<void>, what: string) => {
      if (g.isGenerating || btn.classList.contains("loading")) return;
      btn.classList.add("loading");
      background(work().finally(() => btn.classList.remove("loading")), what);
    };
    const dataBtn = document.getElementById("export-data");
    dataBtn?.addEventListener("click", () => busy(dataBtn, () => import("./DataExport").then((m) => m.downloadGameExport(g)), "Exporting world data"));
    const svgBtn = document.getElementById("export-svg");
    svgBtn?.addEventListener("click", () => busy(svgBtn, () => import("./DataExport").then((m) => m.downloadSvg(g, host.title())), "Exporting the SVG"));
  }

  private async save() {
    const blob = await saveWorld(this.host.generator, this.host.simSave());
    downloadBlob(blob, `world-${this.host.generator.currentSeed}.world`);
  }

  // Opens a .world file (File > Open, or the autosave)
  public async open(file: Blob, name: string) {
    const { generator: g, canvasManager: cm, uiManager: ui } = this.host;
    if (g.isGenerating) return;
    ui.showLoadingModal();
    try {
      await loadWorld(file, g, (pct) => ui.updateLoadingModal(pct));
      const W = g.getWidth();
      const H = g.getHeight();
      cm.scale = window.innerHeight / H;
      cm.offsetX = (window.innerWidth - W * cm.scale) / 2;
      cm.offsetY = 0;
      this.syncControls();
      this.host.setGuideName(name.replace(/\.world$/i, ""));
      this.host.syncGuideCard();
      this.host.worldOpened();
    } catch (err) {
      console.error(err);
      await ui.confirm("OPEN WORLD", `Could not open this file: ${(err as Error).message}`);
    } finally {
      ui.hideLoadingModal();
    }
  }

  // World tab controls show the generator's seed, landmass, size and options
  public syncControls(W = this.host.generator.getWidth(), H = this.host.generator.getHeight()) {
    const g = this.host.generator;
    const set = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = v;
    };
    set("seed", String(g.currentSeed));
    installSliders();
    set("preset", g.currentPreset);
    set("size", `${W}x${H}`);
    set("great-powers", String(g.greatPowers));
    for (const o of OPTIONS) if (o.kind !== "count") set(`opt-${o.key}`, String(Math.round(g.settings[o.key] * 100)));
    this.host.syncNationsRange(W, H, g.settings.nations || autoNations(W, H));
    refreshPickers();
  }

  // --- World links ---

  private recipe(): WorldRecipe {
    const g = this.host.generator;
    return { seed: g.currentSeed, preset: g.currentPreset, width: g.getWidth(), height: g.getHeight(), greatPowers: g.greatPowers, settings: { ...g.settings } };
  }

  // The address bar always links to the world on screen (worlds shaped from
  // an image can't be linked: the picture isn't in the URL)
  public syncLink() {
    const hash = this.host.generator.guide ? "" : recipeToHash(this.recipe());
    if (location.hash !== hash) history.replaceState(null, "", hash ? hash : location.pathname + location.search);
    const btn = document.getElementById("share-link") as HTMLButtonElement | null;
    const info = document.getElementById("share-link-info");
    if (btn) btn.disabled = !hash;
    if (info)
      info.textContent = !hash
        ? "Worlds shaped from an image can't be linked; save a .world file"
        : this.host.edited()
          ? "Seed and options only: your edits travel in .world files"
          : "Anyone with the link gets this exact world";
  }

  private async shareLink() {
    if (this.host.generator.guide) return;
    const url = location.origin + location.pathname + recipeToHash(this.recipe());
    // Phones get the system share sheet; elsewhere the link is copied
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: "A generated world", url });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(url, { ms: 10000 }); // no clipboard access: show it to copy by hand
    }
  }

  // A world link pasted into the address bar of an open tab
  private openLink() {
    const g = this.host.generator;
    const r = recipeFromHash(location.hash);
    if (!r || g.isGenerating || recipeToHash(r) === recipeToHash(this.recipe())) return;
    g.guide = null;
    this.host.syncGuideCard();
    g.currentSeed = r.seed;
    g.currentPreset = r.preset;
    g.greatPowers = r.greatPowers;
    g.settings = r.settings;
    // The Generate button reads the controls, so set them and press it
    this.syncControls(r.width, r.height);
    (document.getElementById("generate") as HTMLButtonElement | null)?.click();
  }
}
