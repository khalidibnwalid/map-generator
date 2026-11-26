import type { City, WorldData } from "../WorldData";
import { atLeast } from "../version";

// The life of the world beyond wars, in 0.3+ histories:
//  - plague breaks out in a great city and travels the roads, emptying towns;
//    famine strikes a realm after failed harvests. Both weaken the realms
//    they touch for a few years.
//  - peoples migrate: a band of one culture moves across the land for
//    decades, settling as it goes (the land it crosses takes its culture,
//    the old people often staying beside it)
//  - rich, peaceful realms raise wonders, and their towns found libraries
//    and universities; these gather knowledge, which spreads to neighbors
//    and strengthens armies
//  - very rarely, a town held for generations by a realm of another people
//    is renamed in its rulers' tongue
// Wonders, libraries and universities are landmarks; knowledge and former
// names live on nations and cities, so world snapshots (undo, branches)
// carry them. Marks and migrations are kept here and checkpointed.

export type MarkKind = "plague" | "famine" | "migration";

// Something to draw on the map for a while (see WarRenderer.drawWorldMarks)
export interface WorldMark {
  kind: MarkKind;
  year: number; // when it happened (a migration: when it ended or now)
  x: number; // cells
  y: number;
  r: number; // reach, cells
  name: string;
  path?: { x: number; y: number }[]; // a migration's route, x unwrapped
  color?: string;
  active?: boolean; // a migration still under way
}

interface Migration {
  culture: number;
  name: string; // the people
  path: { x: number; y: number }[];
  dir: number; // heading, radians
  speed: number; // cells a year
  years: number; // years left
  r: number;
  from: string; // where it set out (for the chronicle)
}

export interface LifeCheckpoint {
  marks: WorldMark[];
  migrations: Migration[];
  weak: [string, number][];
}

type Log = (kind: "plague" | "famine" | "migration" | "wonder" | "learning" | "rename", text: string, x: number, y: number) => void;

export interface LifeContext {
  world: WorldData;
  year: number;
  rand: () => number;
  log: Log;
  land: Uint8Array; // per cell
  owner: Int16Array; // per cell, the simulation's
  culture: Int16Array; // per cell, the simulation's copy
  border: Int32Array; // shared border cells, n × n (upper triangle)
  atWar: (nation: number) => boolean;
  heldSince: (c: City) => number; // year it last changed hands (-99: never)
  strike: (c: City, pop: number) => void; // sets a settlement's population
}

const PLAGUES = ["the Grey Death", "the Sweating Sickness", "the Red Cough", "the Blue Fever", "the Weeping Pox", "the Black Flux", "the Marsh Fever", "the Pale Plague", "the Shaking Ague"];
const WONDERS: { name: (city: string, realm: string) => string; port?: boolean }[] = [
  { name: (c) => `Colossus of ${c}`, port: true },
  { name: (c) => `Great Lighthouse of ${c}`, port: true },
  { name: (c) => `Hanging Gardens of ${c}` },
  { name: (c) => `Grand Temple of ${c}` },
  { name: (c) => `Observatory of ${c}` },
  { name: (c) => `Golden Dome of ${c}` },
  { name: (_c, r) => `Great Wall of ${r}` },
  { name: (c) => `Palace of a Thousand Rooms, ${c}` },
  { name: (c) => `Tomb of the Kings, ${c}` },
];

export const lifeApplies = (world: WorldData) => atLeast(world.version, "0.3");

const MAX_WONDERS_PER_REALM = 3;
const MARK_YEARS = 12; // how long a calamity stays on the map

export class WorldLife {
  public marks: WorldMark[] = [];
  public culturesChanged = false; // the culture map changed (the UI repaints, then clears it)
  private migrations: Migration[] = [];
  private weak = new Map<string, number>(); // realm name -> year it recovers

  public checkpoint(): LifeCheckpoint {
    return { marks: this.marks.map((m) => ({ ...m })), migrations: this.migrations.map((m) => ({ ...m, path: m.path.slice() })), weak: [...this.weak] };
  }
  public rollback(cp: LifeCheckpoint) {
    this.marks = cp.marks.map((m) => ({ ...m }));
    this.migrations = cp.migrations.map((m) => ({ ...m, path: m.path.slice() }));
    this.weak = new Map(cp.weak);
  }

  // Marks saved with a world file come back (migrations restart as marks only)
  public restoreMarks(marks: WorldMark[] | undefined) {
    this.marks = (marks ?? []).map((m) => ({ ...m, active: false }));
  }

  // How strong a realm's armies are against what they would be: weakened
  // by plague or famine, raised by knowledge and wonders
  public strengthFactor(world: WorldData, nation: number, wonders: number, year: number): number {
    const n = world.nations[nation];
    if (!n) return 1;
    let f = 1;
    if ((this.weak.get(n.name) ?? 0) > year) f *= 0.75;
    f *= 1 + Math.min(0.35, (n.knowledge ?? 0) / 250);
    f *= 1 + 0.04 * Math.min(MAX_WONDERS_PER_REALM, wonders);
    return f;
  }

  // One year. Returns whether settlements or the map changed.
  public step(ctx: LifeContext): boolean {
    const { world, year } = ctx;
    let changed = false;
    // Old marks fade off the map
    this.marks = this.marks.filter((m) => m.active || year - m.year <= MARK_YEARS);
    if (year > 15 && ctx.rand() < 1 / 70) changed = this.plague(ctx) || changed;
    if (year > 10 && ctx.rand() < 1 / 55) changed = this.famine(ctx) || changed;
    if (this.migrations.length < 2 && ctx.rand() < 1 / 90) this.startMigration(ctx);
    changed = this.migrate(ctx) || changed;
    changed = this.build(ctx) || changed;
    this.learn(ctx);
    this.rename(ctx);
    for (const [k, until] of this.weak) if (until <= year) this.weak.delete(k);
    if (this.culturesChanged) world.culturesEdited = true;
    return changed;
  }

  // --- Plague: from a great city along the roads ---
  private plague(ctx: LifeContext): boolean {
    const { world, rand, year } = ctx;
    const big = world.cities.filter((c) => c.size >= 1 && c.nationIndex >= 0);
    if (!big.length) return false;
    let total = 0;
    for (const c of big) total += c.population;
    let pick = rand() * total;
    let origin = big[0];
    for (const c of big) {
      pick -= c.population;
      if (pick <= 0) {
        origin = c;
        break;
      }
    }
    const name = PLAGUES[Math.floor(rand() * PLAGUES.length)];
    // Along roads and sea routes, a few towns deep
    const links = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      if (a < 0 || b < 0) return;
      (links.get(a) ?? links.set(a, []).get(a)!).push(b);
      (links.get(b) ?? links.set(b, []).get(b)!).push(a);
    };
    for (const r of world.worldRoads) link(r.a, r.b);
    for (const r of world.seaRoutes) link(r.a, r.b);
    const reach = 2 + Math.floor(rand() * 4);
    const depth = new Map<number, number>([[origin.id, 0]]);
    const queue = [origin.id];
    for (let h = 0; h < queue.length && depth.size < 40; h++) {
      const id = queue[h];
      const d = depth.get(id)!;
      if (d >= reach) continue;
      for (const j of links.get(id) ?? []) {
        if (depth.has(j) || rand() < 0.25) continue; // some towns close their gates in time
        depth.set(j, d + 1);
        queue.push(j);
      }
    }
    const realms = new Set<string>();
    let dead = 0;
    let far = 0;
    const W = world.width;
    for (const [id, d] of depth) {
      const c = world.cities[id];
      if (!c) continue;
      const loss = Math.max(0.04, (0.14 + 0.26 * rand()) * (1 - d * 0.15));
      dead += c.population * loss;
      ctx.strike(c, Math.max(50, Math.round(c.population * (1 - loss))));
      const n = world.nations[c.nationIndex];
      if (n) realms.add(n.name);
      let dx = Math.abs(c.x - origin.x);
      if (dx > W / 2) dx = W - dx;
      far = Math.max(far, Math.hypot(dx, c.y - origin.y));
    }
    for (const r of realms) this.weak.set(r, Math.max(this.weak.get(r) ?? 0, year + 5 + Math.floor(rand() * 5)));
    const towns = depth.size - 1;
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    ctx.log(
      "plague",
      `${title} breaks out in ${origin.name}${towns ? ` and spreads to ${towns} town${towns === 1 ? "" : "s"}` : ""}; some ${roundSouls(dead)} perish`,
      origin.x,
      origin.y,
    );
    this.marks.push({ kind: "plague", year, x: origin.x, y: origin.y, r: Math.max(4, far), name: title });
    return true;
  }

  // --- Famine: failed harvests across a realm ---
  private famine(ctx: LifeContext): boolean {
    const { world, rand, year } = ctx;
    const n = world.nations.length;
    if (!n) return false;
    const landOf = new Float64Array(n);
    const N = ctx.owner.length;
    for (let i = 0; i < N; i++) if (ctx.land[i] && ctx.owner[i] >= 0 && ctx.owner[i] < n) landOf[ctx.owner[i]]++;
    let total = 0;
    for (let i = 0; i < n; i++) if (landOf[i] >= 150) total += landOf[i];
    if (!total) return false;
    let pick = rand() * total;
    let realm = -1;
    for (let i = 0; i < n; i++) {
      if (landOf[i] < 150) continue;
      pick -= landOf[i];
      if (pick <= 0) {
        realm = i;
        break;
      }
    }
    if (realm < 0) return false;
    const R = world.nations[realm];
    let dead = 0;
    for (const c of world.cities) {
      if (c.nationIndex !== realm) continue;
      const loss = 0.04 + 0.1 * rand();
      dead += c.population * loss;
      ctx.strike(c, Math.max(50, Math.round(c.population * (1 - loss))));
    }
    this.weak.set(R.name, Math.max(this.weak.get(R.name) ?? 0, year + 3 + Math.floor(rand() * 3)));
    const why = ["after years of drought", "after failed harvests", "as blight ruins the fields", "after a bitter winter"][Math.floor(rand() * 4)];
    ctx.log("famine", `Famine in ${R.name} ${why}; some ${roundSouls(dead)} perish`, R.capitalX, R.capitalY);
    this.marks.push({ kind: "famine", year, x: R.capitalX, y: R.capitalY, r: Math.max(6, Math.sqrt(landOf[realm]) * 0.6), name: `Famine in ${R.name}` });
    return true;
  }

  // --- Migrations ---
  private startMigration(ctx: LifeContext) {
    const { world, rand } = ctx;
    const W = world.width;
    const H = world.height;
    for (let tries = 0; tries < 40; tries++) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * H);
      const i = y * W + x;
      const cu = ctx.culture[i];
      if (!ctx.land[i] || cu < 0 || !world.cultures[cu]) continue;
      // Heads for land of another people, away from its own
      const dir = rand() * Math.PI * 2;
      const rs = W / 800;
      const people = world.cultures[cu].name;
      const from = world.provinces[world.grid[x][y].provinceIndex ?? -1]?.name ?? "its homeland";
      this.migrations.push({ culture: cu, name: people, path: [{ x: x + 0.5, y: y + 0.5 }], dir, speed: (0.8 + rand() * 0.9) * Math.max(0.6, rs), years: 18 + Math.floor(rand() * 25), r: Math.max(2, Math.round((2.5 + rand() * 2.5) * rs)), from });
      ctx.log("migration", `The ${people} leave ${from} in search of new land`, x + 0.5, y + 0.5);
      return;
    }
  }

  private migrate(ctx: LifeContext): boolean {
    const { world, rand, year } = ctx;
    const W = world.width;
    const H = world.height;
    let changed = false;
    const done: Migration[] = [];
    for (const m of this.migrations) {
      const head = m.path[m.path.length - 1];
      // The next step: ahead if it is land, else the nearest turn that is
      let moved = false;
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
        const d = m.dir + turn + (rand() - 0.5) * 0.3;
        const nx = head.x + Math.cos(d) * m.speed;
        const ny = head.y + Math.sin(d) * m.speed;
        const cy = Math.floor(ny);
        if (cy < 1 || cy >= H - 1) continue;
        const ci = cy * W + ((((Math.floor(nx) % W) + W) % W));
        if (!ctx.land[ci]) continue;
        m.dir = d;
        m.path.push({ x: nx, y: ny });
        moved = true;
        break;
      }
      // Settling around the band: its culture takes the land, the old people often stay beside it
      const at = m.path[m.path.length - 1];
      for (let dy = -m.r; dy <= m.r; dy++)
        for (let dx = -m.r; dx <= m.r; dx++) {
          if (dx * dx + dy * dy > m.r * m.r) continue;
          const y = Math.floor(at.y) + dy;
          if (y < 0 || y >= H) continue;
          const x = (((Math.floor(at.x) + dx) % W) + W) % W;
          const i = y * W + x;
          if (!ctx.land[i] || ctx.culture[i] === m.culture || rand() > 0.5) continue;
          const cell = world.grid[x][y];
          const old = cell.cultureIndex ?? -1;
          cell.cultureIndex = m.culture;
          cell.culture2Index = old >= 0 && rand() < 0.6 ? old : -1;
          ctx.culture[i] = m.culture;
          this.culturesChanged = true;
        }
      m.years--;
      if (!moved || m.years <= 0) done.push(m);
    }
    for (const m of done) {
      this.migrations.splice(this.migrations.indexOf(m), 1);
      const end = m.path[m.path.length - 1];
      const cell = world.grid[(((Math.floor(end.x) % W) + W) % W)][Math.max(0, Math.min(H - 1, Math.floor(end.y)))];
      const where = world.provinces[cell.provinceIndex ?? -1]?.name ?? world.nations[cell.nationIndex ?? -1]?.name ?? "new lands";
      ctx.log("migration", `The ${m.name} settle in ${where}, far from ${m.from}`, end.x, end.y);
      changed = true;
    }
    // Marks: every migration under way, and those ended lately
    this.marks = this.marks.filter((k) => !(k.kind === "migration" && k.active));
    for (const m of [...this.migrations, ...done]) {
      const end = m.path[m.path.length - 1];
      this.marks.push({
        kind: "migration",
        year,
        x: end.x,
        y: end.y,
        r: m.r,
        name: `The ${m.name}`,
        path: m.path.slice(),
        color: world.cultures[m.culture]?.color,
        active: this.migrations.includes(m),
      });
    }
    return changed;
  }

  // --- Wonders, libraries and universities ---
  private build(ctx: LifeContext): boolean {
    const { world, rand, year } = ctx;
    const n = world.nations.length;
    if (!n) return false;
    const W = world.width;
    const ownerAt = (x: number, y: number) => {
      const yy = Math.max(0, Math.min(world.height - 1, Math.floor(y)));
      return ctx.owner[yy * W + ((((Math.floor(x) % W) + W) % W))];
    };
    // What each realm already has
    const wonders = new Int32Array(n);
    const lastWonder = new Int32Array(n).fill(-1e9);
    const learned = new Set<string>(); // "x,y" of cities with a seat of learning
    for (const p of world.pois) {
      if (p.kind === "wonder") {
        const o = ownerAt(p.x, p.y);
        if (o >= 0 && o < n) {
          wonders[o]++;
          lastWonder[o] = Math.max(lastWonder[o], p.year ?? -1e9);
        }
      } else if (p.kind === "university" || p.kind === "library") learned.add(p.name);
    }
    let built = false;
    // A wonder: a large realm at peace, now and then
    const land = new Float64Array(n);
    for (let i = 0; i < ctx.owner.length; i++) if (ctx.land[i] && ctx.owner[i] >= 0 && ctx.owner[i] < n) land[ctx.owner[i]]++;
    let avg = 0;
    let count = 0;
    for (let i = 0; i < n; i++)
      if (land[i] > 0) {
        avg += land[i];
        count++;
      }
    avg = count ? avg / count : 1;
    for (let i = 0; i < n; i++) {
      if (land[i] < avg || ctx.atWar(i) || wonders[i] >= MAX_WONDERS_PER_REALM || year - lastWonder[i] < 60) continue;
      if (rand() >= Math.min(0.012, 0.0025 * (land[i] / avg))) continue;
      const R = world.nations[i];
      const seat = world.cities.find((c) => c.nationIndex === i && c.isCapital) ?? world.cities.filter((c) => c.nationIndex === i).sort((a, b) => b.population - a.population)[0];
      if (!seat) continue;
      const fit = WONDERS.filter((w) => !w.port || seat.isPort);
      const kind = fit[Math.floor(rand() * fit.length)];
      const name = kind.name(seat.name, R.name);
      if (world.pois.some((p) => p.name === name)) continue;
      world.pois.push({ kind: "wonder", x: seat.x + 0.9, y: seat.y - 0.7, angle: 0, name, nationIndex: i, year });
      world.poisEdited = true;
      ctx.log("wonder", `${R.name} raises the ${name}`, seat.x, seat.y);
      built = true;
    }
    // Seats of learning: towns of realms at peace
    for (const c of world.cities) {
      if (c.nationIndex < 0 || c.size < 1 || ctx.atWar(c.nationIndex)) continue;
      const uni = `University of ${c.name}`;
      const lib = `Library of ${c.name}`;
      const big = c.population >= 40000;
      if (big && !learned.has(uni) && rand() < 0.0025) {
        world.pois.push({ kind: "university", x: c.x - 0.9, y: c.y + 0.7, angle: 0, name: uni, nationIndex: c.nationIndex, year });
        world.poisEdited = true;
        learned.add(uni);
        ctx.log("learning", `The ${uni} is founded`, c.x, c.y);
        built = true;
      } else if (!learned.has(lib) && !learned.has(uni) && c.population >= 8000 && rand() < 0.0015) {
        world.pois.push({ kind: "library", x: c.x - 0.9, y: c.y + 0.7, angle: 0, name: lib, nationIndex: c.nationIndex, year });
        world.poisEdited = true;
        learned.add(lib);
        if (c.population >= 25000) ctx.log("learning", `A great library is founded at ${c.name}`, c.x, c.y);
        built = true;
      }
    }
    return built;
  }

  // Knowledge: gathered by a realm's seats of learning, shared over its borders
  private learn(ctx: LifeContext) {
    const { world } = ctx;
    const n = world.nations.length;
    if (!n) return;
    const W = world.width;
    const gain = new Float64Array(n);
    for (const p of world.pois) {
      if (p.kind !== "university" && p.kind !== "library") continue;
      const y = Math.max(0, Math.min(world.height - 1, Math.floor(p.y)));
      const o = ctx.owner[y * W + ((((Math.floor(p.x) % W) + W) % W))];
      if (o >= 0 && o < n) gain[o] += p.kind === "university" ? 0.06 : 0.02;
    }
    const k = world.nations.map((nt) => nt.knowledge ?? 0);
    const next = k.slice();
    for (let a = 0; a < n; a++) {
      next[a] += gain[a];
      // Neighbors learn from those who know more, a little each year
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const shared = ctx.border[a < b ? a * n + b : b * n + a];
        if (shared > 0 && k[b] > k[a]) next[a] += (k[b] - k[a]) * Math.min(0.03, 0.004 + shared / 4000);
      }
    }
    world.nations.forEach((nt, i) => {
      if (next[i] > 0) nt.knowledge = Math.round(next[i] * 1000) / 1000;
    });
  }

  // --- Renaming (very rare): a town long held by rulers of another people ---
  private rename(ctx: LifeContext) {
    const { world, rand, year } = ctx;
    const W = world.width;
    for (const c of world.cities) {
      if (c.formerName || c.size < 1 || c.nationIndex < 0) continue;
      const since = ctx.heldSince(c);
      if (since < 0 || year - since < 40) continue;
      if (rand() >= 0.0005) continue;
      const R = world.nations[c.nationIndex];
      const cell = world.grid[(((Math.floor(c.x) % W) + W) % W)]?.[Math.floor(c.y)];
      const local = cell?.cultureIndex ?? -1;
      const rulers = R.cultureId ?? -1;
      if (rulers < 0 || rulers === local) continue;
      const lang = world.languages[rulers];
      if (!lang) continue;
      const name = lang.townNameWith(rand);
      if (!name || name === c.name || world.cities.some((o) => o.name === name)) continue;
      c.formerName = c.name;
      c.name = name;
      ctx.log("rename", `${c.formerName} is renamed ${name} by its ${R.name} rulers`, c.x, c.y);
    }
  }
}

function roundSouls(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} million`;
  if (n >= 1e4) return `${Math.round(n / 1000).toLocaleString()} thousand`;
  return `${Math.max(100, Math.round(n / 100) * 100).toLocaleString()}`;
}
