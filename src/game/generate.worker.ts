/// <reference lib="webworker" />
// Runs world generation off the main thread, so the page keeps painting the
// progress bar and stays responsive while a large world is built.
import { MapGenerator, type GenerateRequest } from "./MapGenerator";
import { packWorld } from "./WorldTransfer";

export type WorkerMessage =
  | { type: "progress"; pct: number }
  | { type: "done"; packed: ReturnType<typeof packWorld>["packed"] }
  | { type: "error"; message: string; stack?: string };

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<GenerateRequest>) => {
  const r = e.data;
  try {
    const g = new MapGenerator(r.width, r.height, r.seed);
    g.currentPreset = r.preset;
    g.greatPowers = r.greatPowers;
    g.settings = r.settings;
    g.guide = r.guide;
    g.useWorker = false;
    const world = await g.generate((pct) => post({ type: "progress", pct }));
    const { packed, transfer } = packWorld(world, g.getNoise(), r.seed);
    post({ type: "done", packed }, transfer);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  }
};
