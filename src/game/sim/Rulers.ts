import type { Nation, Ruler, WorldData } from "../WorldData";

// Ruling houses and their rulers. Everything lives on the Nation (dynasty,
// ruler, regnal) so it is saved with the world; ages count in simulated years.

const TITLES: Record<string, string> = {
  Sultanate: "Sultan",
  Emirate: "Emir",
  Caliphate: "Caliph",
  Khanate: "Khan",
  Kingdom: "King",
  "High Kingdom": "High King",
  Tsardom: "Tsar",
  Shogunate: "Shogun",
  Empire: "Emperor",
  Dynasty: "Emperor",
  Republic: "Consul",
  "Merchant Republic": "Doge",
  "Serene Republic": "Doge",
  Duchy: "Duke",
  "Grand Duchy": "Grand Duke",
  Principality: "Prince",
  Margraviate: "Margrave",
  Electorate: "Elector",
  Jarldom: "Jarl",
  "Thing-Realm": "Lawspeaker",
  Union: "King",
  Commonwealth: "Grand Hetman",
  Clanhold: "Chieftain",
  Confederation: "High Chieftain",
};

function langOf(world: WorldData, n: Nation) {
  return world.languages[n.cultureId ?? 0] ?? world.languages[0];
}

export function rulerTitle(world: WorldData, n: Nation): string {
  const gov = n.government ?? "Kingdom";
  if (gov === "Empire") {
    const fam = langOf(world, n)?.family.key;
    if (fam === "Desert") return "Padishah";
    if (fam === "Slavic") return "Tsar";
  }
  return TITLES[gov] ?? "King";
}

// Elected heads of state: their "house" is the leading family of the day
function elective(n: Nation) {
  return (n.government ?? "").includes("Republic");
}

const ROMAN: [number, string][] = [
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];
export function roman(v: number): string {
  let out = "";
  if (v >= 40) return String(v);
  for (const [n, s] of ROMAN)
    while (v >= n) {
      out += s;
      v -= n;
    }
  return out;
}

export function rulerName(r: Ruler): string {
  return r.ordinal > 1 ? `${r.name} ${roman(r.ordinal)}` : r.name;
}

// "Sultan Rashid II"
export function rulerStyle(n: Nation): string {
  return n.ruler ? `${n.ruler.title} ${rulerName(n.ruler)}` : "";
}

function newHouse(world: WorldData, n: Nation, rand: () => number): string {
  const lang = langOf(world, n);
  for (let k = 0; k < 4; k++) {
    const h = lang ? lang.houseName(rand) : "Aldmar";
    if (h !== n.dynasty && h !== n.name) return h;
  }
  return lang ? lang.houseName(rand) + "a" : "Aldmar";
}

// A new ruler for n, born `age` years ago. Heirs often take a name the
// realm's earlier rulers bore, which raises its regnal number.
function crown(world: WorldData, n: Nation, year: number, age: number, rand: () => number, lang = langOf(world, n), avoid = ""): Ruler {
  n.regnal ??= {};
  const used = Object.keys(n.regnal);
  let name = used.length && rand() < 0.55 ? used[Math.floor(rand() * used.length)] : lang ? lang.personName(rand) : "Aldric";
  if (name === avoid) name = lang ? lang.personName(rand) : "Aldric"; // brothers rarely share a name
  const ordinal = (n.regnal[name] ?? 0) + 1;
  n.regnal[name] = ordinal;
  return { name, ordinal, born: year - Math.round(age), since: year, title: rulerTitle(world, n) };
}

// Gives every nation without one a house and a ruler already some years on the throne
export function crownRulers(world: WorldData, rand: () => number) {
  const year = world.year;
  for (const n of world.nations) {
    if (n.ruler && n.dynasty) continue;
    n.dynasty ??= newHouse(world, n, rand);
    const age = 22 + rand() * 38;
    n.ruler = crown(world, n, year, age, rand);
    n.ruler.since = year - Math.floor(rand() * Math.min(age - 18, 25));
  }
}

// Seeded generator for crowning outside the simulation (keeps generation streams intact)
export function seededRand(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Succession = { text: string; houseChanged: boolean; elected?: boolean };

// The ruler of n leaves the throne (`cause` completes "Sultan X of Y ..."), and a successor is crowned
export function succeed(world: WorldData, n: Nation, year: number, rand: () => number, cause?: string): Succession {
  const old = n.ruler;
  if (!old) {
    crownRulers(world, rand);
    return { text: "", houseChanged: false };
  }
  const oldStyle = `${old.title} ${rulerName(old)}`;
  const oldHouse = n.dynasty ?? "";
  const oldAge = year - old.born;
  const head = `${oldStyle} of the House of ${oldHouse} ${cause ?? `dies in ${n.name}`}`;
  if (elective(n)) {
    const changed = rand() < 0.6;
    if (changed) n.dynasty = newHouse(world, n, rand);
    const r = (n.ruler = crown(world, n, year, 40 + rand() * 25, rand));
    return {
      text: `${head}; the councils elect ${rulerName(r)}${changed ? ` of the House of ${n.dynasty}` : ` of the same house`}`,
      houseChanged: false,
      elected: true, // routine for republics: kept out of the yearly chronicle
    };
  }
  const roll = rand();
  if (roll < 0.1) {
    n.dynasty = newHouse(world, n, rand);
    const r = (n.ruler = crown(world, n, year, 25 + rand() * 25, rand));
    return { text: `${head} without an heir; ${rulerName(r)} of the House of ${n.dynasty} takes the throne`, houseChanged: true };
  }
  const kin = roll < 0.75 ? "son" : roll < 0.88 ? "brother" : roll < 0.95 ? "grandson" : "nephew";
  const age =
    kin === "son"
      ? Math.max(3, Math.min(oldAge - 18, 14 + rand() * 30))
      : kin === "brother"
        ? Math.max(16, oldAge - 2 - rand() * 12)
        : Math.max(4, Math.min(oldAge - 36, 12 + rand() * 20));
  const r = (n.ruler = crown(world, n, year, age, rand, undefined, kin === "brother" ? old.name : ""));
  const young = year - r.born < 16 ? ", a child," : "";
  return { text: `${head}; his ${kin} ${rulerName(r)}${young} succeeds`, houseChanged: false };
}

// One year of reigns. `notable(i)` decides which successions reach the chronicle.
export function reignYear(
  world: WorldData,
  year: number,
  rand: () => number,
  notable: (i: number) => boolean,
  log: (i: number, text: string) => void,
) {
  for (let i = 0; i < world.nations.length; i++) {
    const n = world.nations[i];
    if (!n.ruler || !n.dynasty) {
      crownRulers(world, rand);
      continue;
    }
    n.ruler.title = rulerTitle(world, n); // the government may have been edited
    const age = year - n.ruler.born;
    const p = age < 30 ? 0.006 : 0.006 + (age - 30) * 0.0035;
    if (rand() >= p) continue;
    const s = succeed(world, n, year, rand);
    if (s.text && !s.elected && (notable(i) || s.houseChanged)) log(i, s.text);
  }
}

// A rebel or general seizes the throne and founds a new house
export function usurp(world: WorldData, n: Nation, year: number, rand: () => number): string {
  const old = n.ruler ? `${n.ruler.title} ${rulerName(n.ruler)}` : "the old ruler";
  n.dynasty = newHouse(world, n, rand);
  const r = (n.ruler = crown(world, n, year, 30 + rand() * 20, rand));
  return `${rulerName(r)} deposes ${old} of ${n.name} and founds the House of ${n.dynasty}`;
}

// A conqueror places a scion of its own house on a vassal's throne
export function installCadet(world: WorldData, vassal: Nation, overlord: Nation, year: number, rand: () => number): string {
  if (!overlord.dynasty) return "";
  vassal.dynasty = overlord.dynasty;
  const r = (vassal.ruler = crown(world, vassal, year, 18 + rand() * 20, rand, langOf(world, overlord)));
  return `${overlord.name} places ${rulerName(r)}, a scion of the House of ${overlord.dynasty}, on the throne of ${vassal.name}`;
}

// A new realm's first ruler
export function foundHouse(world: WorldData, n: Nation, year: number, rand: () => number) {
  n.dynasty = newHouse(world, n, rand);
  n.regnal = {};
  n.ruler = crown(world, n, year, 28 + rand() * 25, rand);
}
