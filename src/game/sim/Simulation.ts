import type { City, WorldData } from "../WorldData";
import type { NoiseEngine } from "../../core/NoiseEngine";
import {
  appendNation,
  makeVassal,
  relation,
  releaseVassal,
  relocateCapital,
  removeNation,
  setRelation,
} from "../politics";
import { colorForNewNation, partitionNation, refreshTerritorialWaters } from "../generators";
import { EconomySim, type EconEventKind } from "./economySim";
import { HistoryRecorder } from "./History";
import { crownRulers, foundHouse, installCadet, reignYear, rulerStyle, succeed, usurp } from "./Rulers";

export interface SimEvent {
  year: number;
  text: string;
  kind: "war" | "peace" | "conquest" | "civil" | "vassal" | "independence" | "fall" | "annex" | "battle" | "ruler" | EconEventKind;
  x: number;
  y: number;
}

// A large army advance: where it broke through (x, y) and how far it got
export interface Battle {
  year: number;
  x: number;
  y: number;
  winner: string;
  loser: string;
  size: number; // cells taken
}

// This year's offensive arrows, world cells (x1 may lie past the wrap)
export interface Offensive {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

// Contact frontier of a war, as polylines in world cells (x unwrapped)
export interface FrontLine {
  a: number;
  b: number;
  chains: Float32Array[];
}

interface War {
  a: number;
  b: number;
  start: number;
  aLand0: number; // land each side held when the war began
  bLand0: number;
  mom: number; // momentum: >0 favors a, <0 favors b
  ends: number; // year after which a negotiated peace becomes likely
}

const GOV_FACTOR: Record<string, number> = {
  Empire: 1.2,
  Sultanate: 1.1,
  Caliphate: 1.15,
  Kingdom: 1.0,
  "High Kingdom": 1.05,
  Tsardom: 1.05,
  Shogunate: 1.05,
  Republic: 0.95,
  "Merchant Republic": 1.05,
  Duchy: 0.85,
  Principality: 0.85,
};

// Min-heap of (priority, cell) used by army thrusts
class Heap {
  private p: number[] = [];
  private c: number[] = [];
  get size() {
    return this.p.length;
  }
  push(pr: number, cell: number) {
    const p = this.p;
    const c = this.c;
    let i = p.length;
    p.push(pr);
    c.push(cell);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pr) break;
      p[i] = p[up];
      c[i] = c[up];
      i = up;
    }
    p[i] = pr;
    c[i] = cell;
  }
  pop(): number {
    const p = this.p;
    const c = this.c;
    const top = c[0];
    const lp = p.pop()!;
    const lc = c.pop()!;
    const n = p.length;
    if (n) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && p[m + 1] < p[m]) m++;
        if (p[m] >= lp) break;
        p[i] = p[m];
        c[i] = c[m];
        i = m;
      }
      p[i] = lp;
      c[i] = lc;
    }
    return top;
  }
}

// Yearly history on flat typed arrays. Wars are offensives: the side with
// the upper hand thrusts along the cheapest ground toward the enemy capital
// (mountains, rivers and fortresses slow it). Occupied land is held until
// peace, when whole provinces change hands by how much of them is occupied.
// Civil wars break culturally mixed realms apart; vassals rebel or get
// absorbed; empty land is settled; nations without land fall.
export class Simulation {
  public year = 0;
  public events: SimEvent[] = [];
  public history: HistoryRecorder;
  public battles: Battle[] = []; // oldest first
  public offensives: Offensive[] = []; // advances of the latest year
  private frontCache: { year: number; lines: FrontLine[] } | null = null;
  private prongs: { seed: number; dx: number; dy: number; n: number }[] = []; // filled by thrust()
  private lastBattleLog = -99;
  public changedCities = new Set<number>(); // city ids whose owner changed since last read
  // Rows touched since the UI last read them, and whether provinces changed
  public dirty = { y0: Infinity, y1: -1, provinces: false };
  public econ = new EconomySim(); // settlement growth, ruin, founding and trade (economySim.ts)
  private po: Int16Array = new Int16Array(0); // province -> owning nation
  private calmUntil = new Map<string, number>(); // nation name -> year a new civil war may start
  private world: WorldData;
  private noise: NoiseEngine;
  private wars = new Map<number, War>();
  private W: number;
  private H: number;
  private land: Uint8Array;
  private defense: Float32Array;
  private culture: Int16Array;
  private people: Float32Array;
  private owner: Int16Array;
  private prov: Int32Array;
  private stamp: Int32Array;
  private stampId = 0;
  private cityAt = new Map<number, City>(); // cell -> city
  private needsSync = true;
  private byProv: { start: Int32Array; cells: Int32Array } | null = null; // land cells grouped by province

  // Ownership of every cell (land and sea), kept in step with the grid
  get ownerArray(): Int16Array {
    return this.owner;
  }

  // The user changed the map: re-read it before the next year
  public markEdited() {
    this.needsSync = true;
  }

  constructor(world: WorldData, noise: NoiseEngine) {
    this.world = world;
    this.noise = noise;
    const W = (this.W = world.width);
    const H = (this.H = world.height);
    const N = W * H;
    this.land = new Uint8Array(N);
    this.defense = new Float32Array(N);
    this.culture = new Int16Array(N);
    this.people = new Float32Array(N);
    this.owner = new Int16Array(N);
    this.prov = new Int32Array(N);
    this.stamp = new Int32Array(N);
    this.year = world.year;
    this.history = new HistoryRecorder(N);
    crownRulers(world, this.rand);
    for (let x = 0; x < W; x++) {
      const col = world.grid[x];
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        const c = col[y];
        this.land[i] = world.waterType[i] === 0 ? 1 : 0;
        this.defense[i] = 1 + Math.max(0, c.elevation - 0.6) * 9 + (c.hasRiver ? 1.2 : 0);
        this.culture[i] = c.cultureIndex ?? -1;
        this.people[i] = c.populationDensity * 900;
      }
    }
    for (const p of world.pois) {
      const bonus = p.kind === "castle" ? 4 : p.kind === "fort" ? 3 : p.kind === "watchtower" ? 1.2 : 0;
      if (!bonus) continue;
      const r = p.kind === "watchtower" ? 2 : 3;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const y = Math.floor(p.y) + dy;
          if (y < 0 || y >= H) continue;
          const x = (((Math.floor(p.x) + dx) % W) + W) % W;
          this.defense[y * W + x] += bonus;
        }
    }
  }

  private rand = () => this.noise.random();

  private log(kind: SimEvent["kind"], text: string, x: number, y: number) {
    this.events.unshift({ year: this.year, text, kind, x, y });
    if (this.events.length > 500) this.events.length = 500;
  }

  private nameOf(i: number) {
    return this.world.nations[i]?.name ?? "?";
  }

  private pair(a: number, b: number) {
    return a < b ? a * 4096 + b : b * 4096 + a;
  }

  // Reads ownership/provinces back from the grid (the user may have painted)
  private sync() {
    const w = this.world;
    const W = this.W;
    for (let x = 0; x < W; x++) {
      const col = w.grid[x];
      for (let y = 0; y < this.H; y++) {
        const c = col[y];
        const i = y * W + x;
        this.owner[i] = c.nationIndex ?? -1;
        this.prov[i] = c.provinceIndex ?? -1;
      }
    }
    this.po = Int16Array.from(w.provinces, (p) => p.nationIndex ?? -1);
    this.cityAt.clear();
    for (const c of w.cities) this.cityAt.set(Math.floor(c.y) * W + (((Math.floor(c.x) % W) + W) % W), c);
    this.byProv = null;
  }

  private setOwner(i: number, to: number) {
    const W = this.W;
    this.owner[i] = to;
    const y = (i / W) | 0;
    this.world.grid[i % W][y].nationIndex = to;
    if (y < this.dirty.y0) this.dirty.y0 = y;
    if (y > this.dirty.y1) this.dirty.y1 = y;
    const city = this.cityAt.get(i);
    if (!city || city.nationIndex === to) return;
    const from = city.nationIndex;
    const wasCapital = city.isCapital;
    city.nationIndex = to;
    city.isCapital = false;
    this.changedCities.add(city.id);
    if (wasCapital && from >= 0) {
      this.log("conquest", `${this.nameOf(to)} takes ${city.name}, capital of ${this.nameOf(from)}`, city.x, city.y);
      const fallen = this.world.nations[from];
      if (fallen?.ruler && this.rand() < 0.3) {
        const s = succeed(this.world, fallen, this.year, this.rand, `is slain as ${city.name} falls`);
        if (s.text) this.log("ruler", s.text, city.x, city.y);
      }
      relocateCapital(this.world, from);
    }
  }

  private provOwner(p: number) {
    return p >= 0 && p < this.po.length ? this.po[p] : -1;
  }

  // Per-nation land, people, culture mix and military strength
  private measure() {
    const w = this.world;
    const n = w.nations.length;
    const C = Math.max(1, w.cultures.length + 1);
    const land = new Float64Array(n);
    const pop = new Float64Array(n);
    const cult = new Int32Array(n * C);
    const N = this.W * this.H;
    for (let i = 0; i < N; i++) {
      const o = this.owner[i];
      if (o < 0 || o >= n || !this.land[i]) continue;
      land[o]++;
      pop[o] += this.people[i];
      cult[o * C + this.culture[i] + 1]++;
    }
    const wealth = new Float64Array(n);
    for (const c of w.cities) {
      if (c.nationIndex < 0 || c.nationIndex >= n) continue;
      pop[c.nationIndex] += c.population;
      wealth[c.nationIndex] += c.wealth ?? 0;
    }
    const wars = new Int32Array(n);
    for (const war of this.wars.values()) {
      wars[war.a]++;
      wars[war.b]++;
    }
    const cohesion = new Float64Array(n);
    const mainCulture = new Int32Array(n);
    const strength = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestK = 0;
      for (let k = 0; k < C; k++)
        if (cult[i * C + k] > best) {
          best = cult[i * C + k];
          bestK = k;
        }
      cohesion[i] = land[i] ? best / land[i] : 1;
      mainCulture[i] = bestK - 1;
      const gov = GOV_FACTOR[w.nations[i].government ?? ""] ?? 1;
      strength[i] =
        (Math.sqrt(pop[i] / 800 + land[i] * 2) *
          gov *
          (0.7 + cohesion[i] * 0.4) *
          (1 + Math.min(0.6, wealth[i] / 4000))) /
        (1 + 0.3 * Math.max(0, wars[i] - 1));
    }
    // Vassals lend their overlord a share of their strength
    w.nations.forEach((nt, i) => {
      if (nt.overlord !== undefined && nt.overlord < n) strength[nt.overlord] += strength[i] * 0.4;
    });
    return { land, pop, cult, C, cohesion, mainCulture, strength, wars };
  }

  private startWar(attacker: number, defender: number, land: Float64Array) {
    const a = Math.min(attacker, defender);
    const b = Math.max(attacker, defender);
    setRelation(this.world, attacker, defender, "War");
    this.wars.set(this.pair(a, b), {
      a,
      b,
      start: this.year,
      aLand0: Math.max(1, land[a] ?? 1),
      bLand0: Math.max(1, land[b] ?? 1),
      mom: 0,
      ends: this.year + 4 + Math.floor(this.rand() * 9),
    });
  }

  public step(): boolean {
    const w = this.world;
    const W = this.W;
    const H = this.H;
    const rand = this.rand;
    this.year++;
    if (this.needsSync || this.year % 10 === 0) {
      this.sync();
      this.needsSync = false;
    }
    // The starting borders are the first recorded year
    if (!this.history.length) this.history.record(this.year - 1, this.owner, w.nations);
    w.year = this.year;
    this.offensives = [];
    this.byProv = null;
    let changed = false;
    let m = this.measure();
    const n = w.nations.length;

    // --- Reigns: rulers age and die; only large realms make the chronicle ---
    const ranked = Array.from(m.land).sort((p, q) => q - p);
    const notableLand = Math.min(ranked[Math.min(4, ranked.length - 1)] ?? 0, (ranked[0] ?? 0) * 0.4);
    reignYear(
      w,
      this.year,
      rand,
      (i) => m.land[i] > 0 && m.land[i] >= notableLand,
      (i, text) => this.log("ruler", text, w.nations[i].capitalX, w.nations[i].capitalY),
    );

    // Wars follow the relations matrix (the user may declare or end them)
    for (const [k, war] of this.wars)
      if (war.a >= n || war.b >= n || relation(w, war.a, war.b) !== "War") this.wars.delete(k);
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        if (relation(w, a, b) === "War" && !this.wars.has(this.pair(a, b))) this.startWar(a, b, m.land);

    // --- One pass: borders, war fronts, settlement fronts ---
    const border = new Int32Array(n * n);
    const fronts = new Map<number, { a: number[]; b: number[] }>(); // cells of a facing b, cells of b facing a
    const settle: number[] = []; // [cell, newOwner, provinceFromCell]
    const anyWar = this.wars.size > 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!this.land[i]) continue;
        const o = this.owner[i];
        for (let d = 0; d < 2; d++) {
          const j = d === 0 ? y * W + ((x + 1) % W) : y + 1 < H ? i + W : -1;
          if (j < 0 || !this.land[j]) continue;
          const p = this.owner[j];
          if (p === o) continue;
          if (o < 0 || p < 0) {
            if (o >= 0) settle.push(j, o, i);
            else settle.push(i, p, j);
            continue;
          }
          if (o >= n || p >= n) continue;
          border[o < p ? o * n + p : p * n + o]++;
          if (!anyWar) continue;
          const key = this.pair(o, p);
          const f = fronts.get(key);
          if (f === undefined) {
            if (!this.wars.has(key)) continue;
            fronts.set(key, o < p ? { a: [i], b: [j] } : { a: [j], b: [i] });
          } else if (o < p) {
            f.a.push(i);
            f.b.push(j);
          } else {
            f.a.push(j);
            f.b.push(i);
          }
        }
      }

    // --- Campaigns ---
    let biggest: Battle | null = null;
    let biggestCell = -1;
    for (const [k, war] of this.wars) {
      const f = fronts.get(k);
      const sa = m.strength[war.a];
      const sb = m.strength[war.b];
      if (!f || sa + sb <= 0) continue;
      const pa = Math.max(0.06, Math.min(0.94, sa / (sa + sb) + war.mom * 0.18 + (rand() - 0.5) * 0.3));
      const aWins = rand() < pa;
      war.mom = Math.max(-1, Math.min(1, war.mom * 0.55 + (aWins ? 0.45 : -0.45)));
      const winner = aWins ? war.a : war.b;
      const loser = aWins ? war.b : war.a;
      const edge = Math.abs(pa - 0.5) * 2;
      const loserLand0 = aWins ? war.bLand0 : war.aLand0;
      const budget = Math.round(loserLand0 * (0.025 + 0.09 * edge + 0.05 * rand()) + 6);
      const seeds = aWins ? f.b : f.a; // loser cells on the front
      if (this.thrust(winner, loser, seeds, budget) === 0) continue;
      changed = true;
      // Each prong is an offensive; the largest one is the year's battle on this front
      let best = null;
      for (const p of this.prongs) {
        if (p.n < 3) continue;
        const sx = (p.seed % W) + 0.5;
        const sy = Math.floor(p.seed / W) + 0.5;
        const k2 = 1.7 / p.n;
        this.offensives.push({ x0: sx, y0: sy, x1: sx + p.dx * k2, y1: sy + p.dy * k2, size: p.n });
        if (!best || p.n > best.n) best = p;
      }
      if (best && best.n >= 8) {
        const b: Battle = {
          year: this.year,
          x: (best.seed % W) + 0.5,
          y: Math.floor(best.seed / W) + 0.5,
          winner: this.nameOf(winner),
          loser: this.nameOf(loser),
          size: best.n,
        };
        this.battles.push(b);
        if (!biggest || b.size > biggest.size) {
          biggest = b;
          biggestCell = best.seed;
        }
      }
    }
    // Only the year's largest battle, if large, reaches the chronicle (and not every year)
    if (biggest && biggest.size >= 80 && this.year - this.lastBattleLog >= 4) {
      this.lastBattleLog = this.year;
      this.log("battle", `Battle of ${this.placeName(biggestCell)}: ${biggest.winner} defeats ${biggest.loser}`, biggest.x, biggest.y);
    }
    // Battles are kept as long as the recorded history (timeline and GIF show them)
    const oldest = this.history.frames[0]?.year ?? this.year;
    if (this.battles.length > 6000 || (this.battles.length && this.battles[0].year < oldest))
      this.battles = this.battles.filter((b) => b.year >= oldest).slice(-6000);

    // --- Peace treaties ---
    let dropped = false; // a nation vanished: indices shifted, skip the rest of this year's diplomacy
    if (this.wars.size) {
      m = this.measure();
      const occ = this.occupation();
      for (const [k, war] of [...this.wars]) {
        if (!this.wars.has(k)) continue;
        const aHeld = (occ.get(war.b * 4096 + war.a) ?? 0) / war.aLand0; // share of a's land held by b
        const bHeld = (occ.get(war.a * 4096 + war.b) ?? 0) / war.bLand0;
        const loser = aHeld > bHeld ? war.a : war.b;
        const winner = loser === war.a ? war.b : war.a;
        const held = Math.max(aHeld, bHeld);
        const L = w.nations[loser];
        const lostCapital = !w.cities.some((c) => c.nationIndex === loser && c.isCapital);
        const capitulates = held > 0.6 || (lostCapital && held > 0.3) || m.land[loser] === 0;
        const tired = this.year >= war.ends && rand() < 0.35;
        if (!capitulates && !tired) continue;
        this.wars.delete(k);
        changed = true;
        const pos = { x: L.capitalX, y: L.capitalY };
        if (capitulates) {
          const remaining = m.land[loser] / Math.max(1, loser === war.a ? war.aLand0 : war.bLand0);
          if (remaining < 0.2 || rand() < 0.25) {
            this.log("annex", `${L.name} is conquered by ${this.nameOf(winner)}`, pos.x, pos.y);
            this.cede(winner, loser, 0);
            dropped = true;
            break;
          } else if (this.cede(winner, loser, 0.3) === 0) {
            this.log("annex", `${L.name} is conquered by ${this.nameOf(winner)}`, pos.x, pos.y);
            this.cede(winner, loser, 0);
            dropped = true;
            break;
          } else {
            if (L.overlord === undefined && w.nations[winner].overlord === undefined && rand() < 0.55) {
              makeVassal(w, loser, winner);
              this.log("vassal", `${L.name} capitulates and becomes a vassal of ${this.nameOf(winner)}`, pos.x, pos.y);
              if (rand() < 0.4) {
                const t = installCadet(w, L, w.nations[winner], this.year, rand);
                if (t) this.log("ruler", t, pos.x, pos.y);
              }
            } else {
              setRelation(w, winner, loser, "Rival");
              this.log("peace", `${L.name} capitulates to ${this.nameOf(winner)} and cedes its occupied provinces`, pos.x, pos.y);
            }
          }
        } else {
          // Negotiated peace: well-held provinces change hands, the rest is returned
          this.cede(war.a, war.b, 0.55);
          this.cede(war.b, war.a, 0.55);
          setRelation(w, war.a, war.b, "Rival");
          this.log("peace", `${this.nameOf(war.a)} and ${this.nameOf(war.b)} sign a peace`, pos.x, pos.y);
        }
      }
    }

    if (dropped) return this.finish(true);

    // --- New wars ---
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const len = border[a * n + b];
        if (!len || this.wars.has(this.pair(a, b))) continue;
        const rel = relation(w, a, b);
        if (rel === "Alliance" || rel === "Vassal" || rel === "Overlord") continue;
        if (m.wars[a] > 0 || m.wars[b] > 0) continue;
        if (w.nations[a].overlord !== undefined || w.nations[b].overlord !== undefined) continue;
        const sa = m.strength[a];
        const sb = m.strength[b];
        const ratio = Math.max(sa, sb) / Math.max(1, Math.min(sa, sb));
        const sameFaith = w.nations[a].religionId === w.nations[b].religionId;
        let p = rel === "Rival" ? 0.022 : rel === "Friendly" ? 0.0025 : sameFaith ? 0.005 : 0.009;
        p *= Math.min(2.5, 0.4 + (ratio - 1)) * Math.min(1.5, 0.4 + len / 40);
        if (rand() >= p) continue;
        const attacker = sa >= sb ? a : b;
        const defender = attacker === a ? b : a;
        this.startWar(attacker, defender, m.land);
        m.wars[a]++;
        m.wars[b]++;
        const D = w.nations[defender];
        this.log("war", `${this.nameOf(attacker)} declares war on ${D.name}`, D.capitalX, D.capitalY);
        // Allies answer the call
        for (let ally = 0; ally < n; ally++) {
          if (ally === attacker || ally === defender || m.wars[ally] > 0) continue;
          if (w.nations[ally].overlord !== undefined) continue;
          if (relation(w, ally, defender) === "Alliance" && relation(w, ally, attacker) !== "Alliance" && rand() < 0.6) {
            this.startWar(ally, attacker, m.land);
            m.wars[ally]++;
            this.log("war", `${this.nameOf(ally)} joins the war against ${this.nameOf(attacker)}`, D.capitalX, D.capitalY);
          }
        }
        changed = true;
      }

    // --- Vassals rebel or are absorbed ---
    for (let v = 0; v < w.nations.length; v++) {
      const nt = w.nations[v];
      if (nt.overlord === undefined || v >= m.land.length) continue;
      const o = nt.overlord;
      if (m.strength[v] > m.strength[o] * 0.45 && rand() < 0.04) {
        releaseVassal(w, v);
        this.startWar(v, o, m.land);
        this.log("independence", `${nt.name} rises against its overlord ${this.nameOf(o)}`, nt.capitalX, nt.capitalY);
        changed = true;
      } else if (m.land[v] < m.land[o] * 0.25 && m.mainCulture[v] === m.mainCulture[o] && rand() < 0.012) {
        this.log("annex", `${this.nameOf(o)} absorbs its vassal ${nt.name}`, nt.capitalX, nt.capitalY);
        this.cede(o, v, 0);
        changed = true;
        break; // indices shift once the vassal is gone
      }
    }

    // --- Civil wars ---
    for (let i = 0; i < w.nations.length && i < m.land.length; i++) {
      if (m.land[i] < 120 || (this.calmUntil.get(w.nations[i].name) ?? 0) > this.year) continue;
      const p = 0.009 * Math.pow(1 - m.cohesion[i], 1.5) * Math.min(1.5, m.land[i] / 1000) + (m.wars[i] ? 0.0015 : 0.0003);
      if (rand() >= p) continue;
      this.calmUntil.set(w.nations[i].name, this.year + 25);
      if (this.secede(i, m)) {
        changed = true;
        break; // one civil war a year keeps the chronicle readable
      }
    }

    // --- Settling empty land ---
    for (let s = 0; s < settle.length; s += 3) {
      if (rand() >= 0.25) continue;
      const cell = settle[s];
      if (this.owner[cell] >= 0 || settle[s + 1] >= w.nations.length) continue;
      this.setOwner(cell, settle[s + 1]);
      const pv = this.prov[settle[s + 2]];
      this.prov[cell] = pv;
      this.byProv = null;
      w.grid[cell % W][(cell / W) | 0].provinceIndex = pv;
      this.dirty.provinces = true;
      changed = true;
    }

    if (this.econ.step(w, this.year, rand, (k, t, x, y) => this.log(k, t, x, y))) this.needsSync = true;
    return this.finish(changed);
  }

  private finish(changed: boolean): boolean {
    const w = this.world;
    // --- Fallen nations ---
    if (changed) {
      const land = new Int32Array(w.nations.length);
      const N = this.W * this.H;
      for (let i = 0; i < N; i++) {
        const o = this.owner[i];
        if (o >= 0 && o < land.length && this.land[i]) land[o]++;
      }
      for (let i = w.nations.length - 1; i >= 0; i--) {
        if (land[i] > 0) continue;
        const nt = w.nations[i];
        this.log("fall", `${nt.name} has fallen`, nt.capitalX, nt.capitalY);
        this.dropNation(i);
      }
      refreshTerritorialWaters(w, this.dirty, this.owner);
    }
    if (this.year % 10 === 0) this.pruneProvinces();
    this.history.record(this.year, this.owner, w.nations);
    return changed;
  }

  public get warPairs(): { a: number; b: number }[] {
    return [...this.wars.values()].map((war) => ({ a: war.a, b: war.b }));
  }

  // "Kargrad" for the city nearest a cell, else its province's name
  private placeName(cell: number): string {
    const w = this.world;
    const W = this.W;
    const x = cell % W;
    const y = Math.floor(cell / W);
    let best: City | null = null;
    let bd = 14;
    for (const c of w.cities) {
      let dx = Math.abs(c.x - x);
      if (dx > W / 2) dx = W - dx;
      const d = Math.hypot(dx, c.y - y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best?.name ?? w.provinces[this.prov[cell]]?.name ?? "the frontier";
  }

  // Contact frontiers of active wars, traced into polylines along cell edges.
  // Cached per year; the overlay asks for it every frame.
  public frontLines(): FrontLine[] {
    if (this.frontCache?.year === this.year) return this.frontCache.lines;
    const W = this.W;
    const H = this.H;
    const n = this.world.nations.length;
    const pairs = new Map<number, number[]>(); // war key -> vertex pairs
    for (const war of this.wars.values()) if (war.a < n && war.b < n) pairs.set(this.pair(war.a, war.b), []);
    if (pairs.size) {
      const owner = this.owner;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const o = owner[i];
          if (o < 0 || !this.land[i]) continue;
          const r = y * W + ((x + 1) % W);
          const p = owner[r];
          if (p >= 0 && p !== o && this.land[r]) {
            const e = pairs.get(this.pair(o, p));
            // Vertical edge on the right side of the cell; vertex = vy * W + vx
            if (e) e.push(y * W + ((x + 1) % W), (y + 1) * W + ((x + 1) % W));
          }
          if (y + 1 < H) {
            const d = i + W;
            const q = owner[d];
            if (q >= 0 && q !== o && this.land[d]) {
              const e = pairs.get(this.pair(o, q));
              if (e) e.push((y + 1) * W + x, (y + 1) * W + ((x + 1) % W));
            }
          }
        }
    }
    const lines: FrontLine[] = [];
    for (const [key, edges] of pairs) {
      if (edges.length < 6) continue;
      lines.push({ a: Math.floor(key / 4096), b: key % 4096, chains: traceChains(edges, W) });
    }
    this.frontCache = { year: this.year, lines };
    return lines;
  }

  // Army advance: cheapest-path growth into the loser's land from a few
  // points on the front, biased toward the enemy capital
  private thrust(winner: number, loser: number, front: number[], budget: number): number {
    const w = this.world;
    const W = this.W;
    const H = this.H;
    const L = w.nations[loser];
    const capX = L?.capitalX ?? 0;
    const capY = L?.capitalY ?? 0;
    const prongs = 1 + Math.floor(this.rand() * 3);
    let taken = 0;
    const stampId = ++this.stampId;
    this.prongs = [];
    for (let k = 0; k < prongs && front.length; k++) {
      const seed = front[Math.floor(this.rand() * front.length)];
      if (this.owner[seed] !== loser) continue;
      const heap = new Heap();
      heap.push(0, seed);
      this.stamp[seed] = stampId;
      const cost = new Map<number, number>([[seed, 0]]);
      let quota = Math.ceil(budget / prongs);
      // Summed offset of taken cells from the seed (wrap-aware) for the offensive arrow
      const sx0 = seed % W;
      const sy0 = (seed / W) | 0;
      const prong = { seed, dx: 0, dy: 0, n: 0 };
      this.prongs.push(prong);
      while (heap.size && quota > 0) {
        const c = heap.pop();
        if (this.owner[c] !== loser) continue;
        this.setOwner(c, winner);
        taken++;
        quota--;
        const g = cost.get(c)!;
        const x = c % W;
        const y = (c / W) | 0;
        let ox = x - sx0;
        if (ox > W / 2) ox -= W;
        else if (ox < -W / 2) ox += W;
        prong.dx += ox;
        prong.dy += y - sy0;
        prong.n++;
        for (let d = 0; d < 4; d++) {
          const nx = d === 0 ? (x + 1) % W : d === 1 ? (x - 1 + W) % W : x;
          const ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
          if (ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          if (this.stamp[j] === stampId || this.owner[j] !== loser) continue;
          this.stamp[j] = stampId;
          // Liberating own provinces is easier than taking new ground
          const home = this.provOwner(this.prov[j]) === winner ? 0.4 : 1;
          const gj = g + this.defense[j] * home * (0.6 + this.rand() * 0.8);
          let dx = Math.abs(nx - capX);
          if (dx > W / 2) dx = W - dx;
          cost.set(j, gj);
          heap.push(gj + Math.hypot(dx, ny - capY) * 0.35, j);
        }
      }
    }
    return taken;
  }

  // occupier*4096+owner -> cells of owner's provinces held by occupier
  private occupation(): Map<number, number> {
    const out = new Map<number, number>();
    const N = this.W * this.H;
    for (let i = 0; i < N; i++) {
      if (!this.land[i]) continue;
      const o = this.owner[i];
      if (o < 0) continue;
      const po = this.provOwner(this.prov[i]);
      if (po < 0 || po === o) continue;
      const k = o * 4096 + po;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  }

  // Provinces of `loser` that `winner` holds at least `share` of pass to it
  // whole; the rest of the occupied land returns. share 0 hands over the
  // whole nation, which then disappears.
  private cede(winner: number, loser: number, share: number): number {
    const w = this.world;
    const N = this.W * this.H;
    const total = new Map<number, number>();
    const held = new Map<number, number>();
    const cells: number[] = [];
    const take = (i: number) => {
      const p = this.prov[i];
      cells.push(i);
      total.set(p, (total.get(p) ?? 0) + 1);
      if (this.owner[i] === winner) held.set(p, (held.get(p) ?? 0) + 1);
    };
    if (share === 0) {
      for (let i = 0; i < N; i++)
        if (this.land[i] && (this.provOwner(this.prov[i]) === loser || this.owner[i] === loser)) take(i);
    } else {
      const idx = this.provinceIndex();
      for (let p = 0; p < this.po.length; p++) {
        if (this.po[p] !== loser) continue;
        for (let k = idx.start[p]; k < idx.start[p + 1]; k++) take(idx.cells[k]);
      }
    }
    const gets = (p: number) => share === 0 || (held.get(p) ?? 0) / total.get(p)! >= share;
    let remaining = 0;
    for (const i of cells) {
      const o = this.owner[i];
      if (gets(this.prov[i])) {
        if (o === loser || o === winner) this.setOwner(i, winner);
      } else if (o === winner) this.setOwner(i, loser);
      if (this.owner[i] === loser) remaining++;
    }
    for (const p of total.keys())
      if (p >= 0 && w.provinces[p] && gets(p)) {
        w.provinces[p].nationIndex = winner;
        this.po[p] = winner;
      }
    if (share === 0) {
      for (const c of w.cities)
        if (c.nationIndex === loser) {
          c.nationIndex = winner;
          c.isCapital = false;
          this.changedCities.add(c.id);
        }
      this.dropNation(loser);
    } else relocateCapital(w, loser);
    return remaining;
  }

  // Land cells grouped by province (counting sort), rebuilt when provinces change
  private provinceIndex() {
    if (this.byProv) return this.byProv;
    const P = this.po.length;
    const N = this.W * this.H;
    const start = new Int32Array(P + 1);
    for (let i = 0; i < N; i++) {
      const p = this.prov[i];
      if (this.land[i] && p >= 0 && p < P) start[p + 1]++;
    }
    for (let p = 0; p < P; p++) start[p + 1] += start[p];
    const fill = start.slice(0, P);
    const cells = new Int32Array(start[P]);
    for (let i = 0; i < N; i++) {
      const p = this.prov[i];
      if (this.land[i] && p >= 0 && p < P) cells[fill[p]++] = i;
    }
    return (this.byProv = { start, cells });
  }

  // Removes a nation; provinces it still owns go to whoever holds most of them
  private dropNation(i: number) {
    const w = this.world;
    const N = this.W * this.H;
    const tally = new Map<number, Map<number, number>>();
    for (let c = 0; c < N; c++) {
      const p = this.prov[c];
      if (p < 0 || this.provOwner(p) !== i || !this.land[c]) continue;
      const o = this.owner[c];
      if (o < 0 || o === i) continue;
      let t = tally.get(p);
      if (!t) tally.set(p, (t = new Map()));
      t.set(o, (t.get(o) ?? 0) + 1);
    }
    for (const [p, t] of tally) {
      let best = -1;
      let bestN = 0;
      t.forEach((v, o) => {
        if (v > bestN) {
          bestN = v;
          best = o;
        }
      });
      if (best >= 0) w.provinces[p].nationIndex = best;
    }
    const shifted = new Map<number, War>();
    for (const war of this.wars.values()) {
      if (war.a === i || war.b === i) continue;
      const a = war.a > i ? war.a - 1 : war.a;
      const b = war.b > i ? war.b - 1 : war.b;
      shifted.set(this.pair(a, b), { ...war, a, b });
    }
    this.wars = shifted;
    removeNation(w, i);
    this.dirty.provinces = true;
    this.sync(); // removeNation re-indexed nations and provinces
  }

  // A minority culture (or the far provinces) breaks away as a new nation
  private secede(parent: number, m: ReturnType<Simulation["measure"]>): boolean {
    const w = this.world;
    const W = this.W;
    const H = this.H;
    const N = W * H;
    const rand = this.rand;
    const C = m.C;
    let region: number[] = [];
    let culture = m.mainCulture[parent];

    let minority = -1;
    let minorityN = 0;
    for (let k = 1; k < C; k++) {
      const v = m.cult[parent * C + k];
      if (k - 1 !== m.mainCulture[parent] && v > minorityN) {
        minorityN = v;
        minority = k - 1;
      }
    }
    const capital = w.cities.find((c) => c.nationIndex === parent && c.isCapital);
    const capCell = capital ? Math.floor(capital.y) * W + (((Math.floor(capital.x) % W) + W) % W) : -1;
    const grow = (seed: number, ok: (i: number) => boolean) => {
      const out: number[] = [];
      const id = ++this.stampId;
      this.stamp[seed] = id;
      const stack = [seed];
      while (stack.length) {
        const c = stack.pop()!;
        out.push(c);
        const x = c % W;
        const y = (c / W) | 0;
        const nb = [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? c - W : -1, y < H - 1 ? c + W : -1];
        for (const j of nb)
          if (j >= 0 && this.stamp[j] !== id && ok(j)) {
            this.stamp[j] = id;
            stack.push(j);
          }
      }
      return out;
    };
    if (minority >= 0 && minorityN >= 30 && minorityN >= m.land[parent] * 0.12) {
      const ofMinority = (i: number) => this.land[i] === 1 && this.owner[i] === parent && this.culture[i] === minority;
      const seen = new Uint8Array(N);
      let best: number[] = [];
      for (let i = 0; i < N; i++) {
        if (seen[i] || !ofMinority(i)) continue;
        const comp = grow(i, ofMinority);
        for (const c of comp) seen[c] = 1;
        if (comp.length > best.length) best = comp;
      }
      region = best;
      culture = minority;
    }
    if (region.length < 25) {
      // The provinces farthest from the capital break away instead
      const cx = capital?.x ?? w.nations[parent].capitalX;
      const cy = capital?.y ?? w.nations[parent].capitalY;
      const provs = w.provinces
        .filter((p) => p.nationIndex === parent)
        .map((p) => {
          let dx = Math.abs((p.centroidX ?? cx) - cx);
          if (dx > W / 2) dx = W - dx;
          return { id: p.id, d: Math.hypot(dx, (p.centroidY ?? cy) - cy) };
        })
        .sort((a, b) => b.d - a.d);
      if (provs.length < 4) return false;
      const take = new Set(provs.slice(0, 1 + Math.floor(rand() * Math.min(3, provs.length / 3))).map((e) => e.id));
      region = [];
      for (let i = 0; i < N; i++) if (this.land[i] && this.owner[i] === parent && take.has(this.prov[i])) region.push(i);
    }
    if (region.length < 25 || region.includes(capCell)) return false;

    const regionSet = new Set(region);
    const cities = w.cities.filter((c) => regionSet.has(Math.floor(c.y) * W + (((Math.floor(c.x) % W) + W) % W)));
    const seat = [...cities].sort((a, b) => b.population - a.population)[0];
    const r0 = region[Math.floor(region.length / 2)];
    const lang = w.languages[culture] ?? w.languages[0];
    const parentName = this.nameOf(parent);
    const idx = appendNation(w, {
      id: 0,
      name: lang ? lang.nationName() : `Free ${parentName}`,
      color: "#000000",
      capitalX: seat ? seat.x : (r0 % W) + 0.5,
      capitalY: seat ? seat.y : Math.floor(r0 / W) + 0.5,
      cultureId: culture,
      religionId: w.nations[parent].religionId,
      government: rand() < 0.5 ? "Republic" : lang ? lang.government(0.15, false) : "Kingdom",
    });
    w.nations[idx].color = colorForNewNation(w, [parent]);
    for (const i of region) this.setOwner(i, idx);
    for (const c of cities) {
      c.nationIndex = idx;
      c.isCapital = c === seat;
      this.changedCities.add(c.id);
    }
    partitionNation(w, this.noise, idx);
    this.dirty.provinces = true;
    this.sync();
    const land = new Float64Array(w.nations.length);
    land.set(m.land.subarray(0, Math.min(m.land.length, land.length)));
    land[parent] -= region.length;
    land[idx] = region.length;
    this.startWar(idx, parent, land);
    const NT = w.nations[idx];
    foundHouse(w, NT, this.year, rand);
    this.log("civil", `Civil war in ${parentName}: ${NT.name} breaks away under ${rulerStyle(NT)}`, NT.capitalX, NT.capitalY);
    // The turmoil sometimes topples the old house too
    if (rand() < 0.3) {
      const P = w.nations[parent];
      this.log("ruler", usurp(w, P, this.year, rand), P.capitalX, P.capitalY);
    }
    return true;
  }

  // Provinces left without land are dropped and the rest re-indexed
  private pruneProvinces() {
    const w = this.world;
    const count = new Int32Array(w.provinces.length);
    const N = this.W * this.H;
    for (let i = 0; i < N; i++) if (this.prov[i] >= 0 && this.prov[i] < count.length) count[this.prov[i]]++;
    if (count.every((c) => c > 0)) return;
    const remap = new Map<number, number>();
    const kept = w.provinces.filter((p) => count[p.id] > 0);
    kept.forEach((p, i) => {
      remap.set(p.id, i);
      p.id = i;
    });
    w.provinces = kept;
    const fix = (v: number | undefined) => (v === undefined || v < 0 ? v : (remap.get(v) ?? -1));
    for (let x = 0; x < w.width; x++) for (let y = 0; y < w.height; y++) w.grid[x][y].provinceIndex = fix(w.grid[x][y].provinceIndex);
    for (const c of w.cities) c.provinceIndex = fix(c.provinceIndex);
    this.dirty.provinces = true;
    this.sync();
  }
}

// Joins unit cell edges (pairs of lattice vertices, vertex = vy * W + vx with
// vx wrapped) into polylines, then smooths the stairs away. x is unwrapped
// along each chain so it can run across the date line.
function traceChains(edges: number[], W: number): Float32Array[] {
  const E = edges.length / 2;
  const at = new Map<number, number[]>();
  for (let e = 0; e < E; e++)
    for (let s = 0; s < 2; s++) {
      const v = edges[e * 2 + s];
      const l = at.get(v);
      if (l) l.push(e);
      else at.set(v, [e]);
    }
  const used = new Uint8Array(E);
  const chains: Float32Array[] = [];
  const walk = (start: number) => {
    const pts: number[] = [start % W, Math.floor(start / W)];
    let v = start;
    let px = start % W;
    for (;;) {
      const list = at.get(v)!;
      let next = -1;
      for (const e of list)
        if (!used[e]) {
          next = e;
          break;
        }
      if (next < 0) break;
      used[next] = 1;
      v = edges[next * 2] === v ? edges[next * 2 + 1] : edges[next * 2];
      let nx = v % W;
      while (nx - px > W / 2) nx -= W;
      while (px - nx > W / 2) nx += W;
      pts.push(nx, Math.floor(v / W));
      px = nx;
    }
    if (pts.length < 8) return; // stray bits of frontier
    // Keep every other vertex, then one round of Chaikin corner cutting
    const thin: number[] = [];
    for (let k = 0; k < pts.length; k += 4) thin.push(pts[k], pts[k + 1]);
    if (thin[thin.length - 2] !== pts[pts.length - 2] || thin[thin.length - 1] !== pts[pts.length - 1])
      thin.push(pts[pts.length - 2], pts[pts.length - 1]);
    const out: number[] = [thin[0], thin[1]];
    for (let k = 0; k + 3 < thin.length; k += 2) {
      const x0 = thin[k], y0 = thin[k + 1], x1 = thin[k + 2], y1 = thin[k + 3];
      out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
    }
    out.push(thin[thin.length - 2], thin[thin.length - 1]);
    chains.push(Float32Array.from(out));
  };
  // Open ends first so chains are not split in the middle, then closed loops
  for (const [v, list] of at) if (list.length % 2 === 1) walk(v);
  for (const [v, list] of at) while (list.some((e) => !used[e])) walk(v);
  return chains;
}
