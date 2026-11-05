import { EditHistory, type RestoreResult } from "../game/EditHistory";
import type { WorldData } from "../game/WorldData";
import { readAutosave, writeAutosave, timeAgo, type AutosaveEntry } from "./Autosave";
import { background, toast } from "./components/Toast";

// Undo/redo and autosave around the editors. The interface tells it when the
// world is replaced or history moves it on; everything else (which editor
// changed what) is found by comparing the world after each interaction.

export interface EditSessionHost {
  world(): WorldData;
  // Generating, replaying, exporting or simulating: no edits to record
  busy(): boolean;
  // A map-canvas interaction can change the world right now (an editor is active)
  canvasEdits(): boolean;
  // Re-uploads textures and refreshes panels after an undo or redo
  afterRestore(r: RestoreResult): void;
  // The current world as a .world file, and what to call it
  snapshot(): Promise<Blob>;
  describe(): { seed: number; title: string };
  // Opens a .world file the way File > Open does
  open(blob: Blob, name: string): Promise<void>;
}

const COMMIT_DELAY = 300; // ms after the last interaction
const AUTOSAVE_DELAY = 2500;

export class EditSession {
  private host: EditSessionHost;
  private history: EditHistory;
  private commitTimer = 0;
  private saveTimer = 0;
  private saving = false;
  // The world is worth keeping: edited, simulated, opened or deliberately generated
  private worthSaving = false;
  private undoBtn: HTMLButtonElement | null;
  private redoBtn: HTMLButtonElement | null;
  private previous: AutosaveEntry | null = null;

  constructor(host: EditSessionHost) {
    this.host = host;
    this.history = new EditHistory(host.world());
    this.history.onChange = () => {
      this.syncButtons();
      this.worthSaving = true;
      this.scheduleAutosave();
    };
    this.undoBtn = document.getElementById("undo") as HTMLButtonElement | null;
    this.redoBtn = document.getElementById("redo") as HTMLButtonElement | null;
    this.undoBtn?.addEventListener("click", () => this.undo());
    this.redoBtn?.addEventListener("click", () => this.redo());
    this.listen();
    this.syncButtons();
  }

  // --- Lifecycle hooks called by the interface ---

  // A new world: generated, opened or restored. `keep` = the user chose it,
  // so it is autosaved (the random world shown on first load is not, so it
  // never overwrites the session the user may want back)
  public worldReplaced(keep: boolean) {
    clearTimeout(this.commitTimer);
    this.history.reset(this.host.world());
    this.syncButtons();
    if (keep) {
      this.worthSaving = true;
      this.scheduleAutosave();
    }
  }

  // History stepped, skipped or fought a battle. Recorded steps no longer
  // describe the map, so they are dropped; the new state is kept.
  public historyMoved() {
    clearTimeout(this.commitTimer);
    this.history.reset();
    this.syncButtons();
    this.worthSaving = true;
    this.scheduleAutosave();
  }

  // --- Undo / redo ---

  public undo() {
    if (this.host.busy()) return;
    clearTimeout(this.commitTimer);
    const r = this.history.undo();
    if (!r) return;
    this.host.afterRestore(r);
    toast(`Undid ${r.label}`, { action: this.history.canRedo ? { label: "Redo", run: () => this.redo() } : undefined });
  }

  public redo() {
    if (this.host.busy()) return;
    clearTimeout(this.commitTimer);
    const r = this.history.redo();
    if (!r) return;
    this.host.afterRestore(r);
    toast(`Redid ${r.label}`);
  }

  private syncButtons() {
    const set = (b: HTMLButtonElement | null, on: boolean, verb: string, label?: string) => {
      if (!b) return;
      b.disabled = !on;
      b.title = on && label ? `${verb} ${label}` : verb;
    };
    set(this.undoBtn, this.history.canUndo, "Undo", this.history.undoLabel);
    set(this.redoBtn, this.history.canRedo, "Redo", this.history.redoLabel);
  }

  private scheduleCommit() {
    clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      if (this.host.busy()) return;
      this.history.commit();
    }, COMMIT_DELAY);
  }

  private listen() {
    const app = document.getElementById("app") ?? document.body;
    const canvas = document.getElementById("mapCanvas");
    const relevant = (e: Event) => e.target !== canvas || this.host.canvasEdits();
    // Take a baseline before anything can change, then look for a change
    // once the interaction settles
    const start = (e: Event) => {
      if (!this.host.busy() && relevant(e)) this.history.ensureBaseline();
    };
    const settle = (e: Event) => {
      if (relevant(e)) this.scheduleCommit();
    };
    for (const t of ["pointerdown", "keydown", "focusin"]) app.addEventListener(t, start, true);
    for (const t of ["pointerup", "click", "change", "keyup"]) app.addEventListener(t, settle, true);
    // Dialogs (flag and logo editors, confirmations) live outside #app
    for (const t of ["pointerup", "click", "change"]) document.addEventListener(t, (e) => !app.contains(e.target as Node) && settle(e), true);

    window.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // Text fields keep their own undo
      if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio", "range", "button"].includes((t as HTMLInputElement).type))))
        return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        this.redo();
      }
    });

    // Write the pending autosave before the tab goes away
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.saveTimer) this.autosaveNow();
    });
  }

  // --- Autosave ---

  private scheduleAutosave() {
    if (!this.worthSaving) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.autosaveNow(), AUTOSAVE_DELAY);
  }

  private autosaveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.saving) {
      this.scheduleAutosave();
      return;
    }
    if (this.host.busy()) {
      // Try again once generation or a running simulation settles
      this.scheduleAutosave();
      return;
    }
    this.saving = true;
    const meta = this.host.describe();
    const work = this.host
      .snapshot()
      .then((blob) => writeAutosave({ blob, savedAt: Date.now(), seed: meta.seed, title: meta.title }))
      .finally(() => (this.saving = false));
    // Storage can be full or blocked; say so once, quietly
    work.catch((e: unknown) => {
      console.warn("Autosave failed:", e);
      if (!this.warnedSave) toast("Autosave is unavailable in this browser", { error: true });
      this.warnedSave = true;
    });
  }
  private warnedSave = false;

  // Offers the last session back, if there is one. Call before anything is autosaved.
  public async offerRestore() {
    this.previous = await readAutosave();
    const prev = this.previous;
    const btn = document.getElementById("restore-autosave");
    const sub = document.getElementById("restore-autosave-info");
    if (!prev) return;
    if (btn) btn.style.display = "";
    if (sub) sub.textContent = `${prev.title}, saved ${timeAgo(prev.savedAt)}`;
    btn?.addEventListener("click", () => background(this.restorePrevious(), "Restoring the last session"));
    toast(`Continue your last world? ${prev.title}, ${timeAgo(prev.savedAt)}`, {
      action: { label: "Restore", run: () => background(this.restorePrevious(), "Restoring the last session") },
      ms: 12000,
    });
  }

  private async restorePrevious() {
    const prev = this.previous;
    if (!prev || this.host.busy()) return;
    await this.host.open(prev.blob, `Autosave ${prev.seed}`);
    toast("Last session restored");
  }
}
