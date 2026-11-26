// App versions. Every world (link, .world file, export) records the version
// that made it, so it regenerates under that version's rules. Anything saved
// before versions existed counts as the first one.
//
// 0.1  the original generator
// 0.2  coalitions, merging realms and independence, more flag emblems, mosques for zawiyas,
//      and realms/provinces no longer follow from the seed alone (each world
//      rolls its own politics seed, which links and files carry)
// 0.3  history brings plague, famine and migrations, wonders, libraries and
//      universities that spread knowledge, and (rarely) conquerors renaming towns

export const APP_VERSION = "0.3";
export const LEGACY_VERSION = "0.1";
export const KNOWN_VERSIONS = ["0.1", "0.2", "0.3"] as const;

// "0.1" -> [0, 1]; unknown parts read as 0
const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);

// <0 when a is older than b, 0 when equal, >0 when newer
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const atLeast = (v: string, min: string) => compareVersions(v, min) >= 0;

// A version read from a file or link; missing or malformed means the oldest
export function normalizeVersion(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  return typeof v === "string" && /^\d+(\.\d+)*$/.test(v) ? v : LEGACY_VERSION;
}

// A warning to show when a world from another version is opened, or null
export function versionWarning(v: string): string | null {
  const c = compareVersions(v, APP_VERSION);
  if (c < 0)
    return `This world was made with version ${v} and is opened with its rules in version ${APP_VERSION}. Older worlds may not behave exactly as before, and some newer features may not work with them.`;
  if (c > 0) return `This world was made with version ${v}, newer than this app (${APP_VERSION}). Parts of it may be missing or broken.`;
  return null;
}
