// The last world worked on, kept in IndexedDB so a closed tab or a crash
// does not lose an evening of editing. One slot: the .world file itself
// (seed + edits + recorded history), plus enough to describe it in the
// "continue where you left off" prompt.

const DB = "map-generator";
const STORE = "autosave";
const KEY = "last";

export interface AutosaveEntry {
  blob: Blob;
  savedAt: number;
  seed: number;
  title: string; // e.g. "Medium Continents · 57 realms · year 120"
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Autosave transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function readAutosave(): Promise<AutosaveEntry | null> {
  try {
    const v = await run<AutosaveEntry | undefined>("readonly", (s) => s.get(KEY) as IDBRequest<AutosaveEntry | undefined>);
    return v && v.blob instanceof Blob ? v : null;
  } catch {
    return null; // private windows and blocked storage: no autosave, no fuss
  }
}

export async function writeAutosave(entry: AutosaveEntry): Promise<void> {
  await run("readwrite", (s) => s.put(entry, KEY));
}

export async function clearAutosave(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    /* nothing stored */
  }
}

export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
