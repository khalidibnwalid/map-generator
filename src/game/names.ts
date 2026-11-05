// Culture-flavored name generation. Each culture picks a language family and
// derives its own syllable mix, so neighboring towns sound related.

interface Family {
  key: string;
  onsets: string[];
  middles: string[];
  endings: string[];
  townSuffixes: string[];
  nationSuffixes: string[];
  governments: string[];
  given: string[]; // endings of personal names (rulers)
  names?: string[]; // traditional given names, mixed in with generated ones
}

const BASE_FAMILIES: Family[] = [
  {
    key: "Germanic",
    onsets: ["Al", "Bran", "Dor", "Eis", "Falk", "Gr", "Hal", "Kr", "Lin", "Mar", "Ost", "Rot", "St", "Wal", "Wolf", "Ul"],
    middles: ["en", "er", "an", "el", "in", "ur", "ol"],
    endings: ["berg", "burg", "dorf", "feld", "hausen", "heim", "stadt", "wald", "furt", "bach"],
    townSuffixes: ["berg", "burg", "dorf", "furt", "heim", "stadt", "brück", "au"],
    nationSuffixes: ["ia", "land", "mark", "reich"],
    governments: ["Kingdom", "Duchy", "Margraviate", "Empire", "Electorate"],
    given: ["bert", "mund", "ric", "wald", "helm", "fried", "hard", "win", "o"],
  },
  {
    key: "Latin",
    onsets: ["Aur", "Cal", "Cor", "Fl", "Luc", "Mar", "Nov", "Pal", "Ser", "Tar", "Val", "Vir", "Ost", "Ver"],
    middles: ["a", "e", "i", "o", "en", "an", "il"],
    endings: ["ia", "ium", "ona", "ano", "ento", "ara", "esa", "ina"],
    townSuffixes: ["ona", "ano", "ento", "ia", "ella", "ica", "ora"],
    nationSuffixes: ["ia", "ium", "ana"],
    governments: ["Republic", "Principality", "Serene Republic", "Kingdom", "Empire"],
    given: ["us", "ius", "o", "ian", "en", "ar"],
  },
  {
    key: "Slavic",
    onsets: ["Bor", "Dob", "Grod", "Kras", "Lub", "Mir", "Nov", "Pol", "Rad", "Svet", "Vel", "Zem", "Vys", "Chel"],
    middles: ["o", "e", "i", "a", "ov", "ev"],
    endings: ["grad", "ov", "ovo", "sk", "ice", "ava", "in", "ets"],
    townSuffixes: ["grad", "ov", "sk", "ice", "ovo", "in", "ava"],
    nationSuffixes: ["ia", "ovia", "ania"],
    governments: ["Tsardom", "Grand Duchy", "Principality", "Kingdom", "Commonwealth"],
    given: ["slav", "mir", "dan", "gost", "bor", "ko", "ek"],
  },
  {
    key: "Nordic",
    onsets: ["As", "Bj", "Dr", "Fj", "Hr", "Kv", "Ny", "Sk", "Sv", "Tor", "Ulf", "Vik", "Ey", "Gr"],
    middles: ["a", "e", "o", "ar", "en", "il"],
    endings: ["heim", "vik", "fjord", "holm", "by", "stad", "nes", "dal"],
    townSuffixes: ["vik", "by", "holm", "stad", "nes", "dal", "havn"],
    nationSuffixes: ["heim", "land", "rike"],
    governments: ["Jarldom", "Kingdom", "Thing-Realm", "Union"],
    given: ["ulf", "bjorn", "geir", "mund", "stein", "var", "rik"],
  },
  {
    key: "Desert",
    onsets: ["Al", "Bah", "Dar", "Far", "Ham", "Jaz", "Kar", "Mad", "Qas", "Rah", "Sal", "Tal", "Zah", "Sab"],
    middles: ["a", "i", "u", "ar", "im", "un"],
    endings: ["abad", "ar", "ira", "iya", "un", "an", "esh", "ah"],
    townSuffixes: ["abad", "iya", "ar", "ah", "un", "esh"],
    nationSuffixes: ["ia", "istan", "ar"],
    governments: ["Sultanate", "Emirate", "Caliphate", "Khanate"],
    given: ["im", "id", "ir", "an", "ad", "ib", "un"],
    names: ["Rashid", "Idris", "Qasim", "Harun", "Yusuf", "Tariq", "Salim", "Karim", "Hamid", "Faisal", "Nasir", "Malik", "Zayd", "Jamal", "Mahmud", "Sulayman"],
  },
  {
    key: "Celtic",
    onsets: ["Ab", "Bal", "Caer", "Dun", "Glen", "Inver", "Kil", "Lis", "Mor", "Pen", "Tre", "Ard", "Bryn"],
    middles: ["a", "e", "i", "o", "an", "wy"],
    endings: ["more", "dun", "glas", "wen", "ross", "lin", "ach", "rin"],
    townSuffixes: ["more", "dun", "ross", "wen", "lin", "ach"],
    nationSuffixes: ["ia", "land", "wy"],
    governments: ["High Kingdom", "Clanhold", "Kingdom", "Confederation"],
    given: ["an", "ach", "wyn", "ric", "dan", "oc", "ed"],
  },
  {
    key: "Eastern",
    onsets: ["Han", "Jin", "Kai", "Lan", "Ming", "Shan", "Tai", "Wu", "Xia", "Yun", "Zhao", "Kyo", "Ryu"],
    middles: ["", "a", "o", "u"],
    endings: ["an", "ou", "ing", "zhou", "shan", "ao", "jin", "to"],
    townSuffixes: ["zhou", "an", "jin", "shan", "ning", "to"],
    nationSuffixes: ["", "an", "guo"],
    governments: ["Empire", "Shogunate", "Kingdom", "Dynasty"],
    given: ["", "o", "ei", "shi", "ro", "ji", "ren"],
  },
];

// Peoples that are never rolled by world generation (so existing seeds keep
// their cultures); they can be chosen when editing a culture
const EXTRA_FAMILIES: Family[] = [
  {
    key: "Magyar",
    onsets: ["Bak", "Deb", "Esz", "Gyul", "Kal", "Mis", "Sze", "Tat", "Vesz", "Zal", "Nyir", "Hod", "Bek", "Sar"],
    middles: ["a", "e", "o", "i"],
    endings: ["vár", "háza", "falva", "tó", "hely", "kő"],
    townSuffixes: ["vár", "háza", "falva", "tó", "hely", "egyháza"],
    nationSuffixes: ["ország", "föld", "a"],
    governments: ["Kingdom", "Principality", "Grand Principality", "Banate", "Voivodeship"],
    given: ["án", "ló", "os", "ás", "mér", "ek"],
    names: ["István", "László", "Béla", "Géza", "Árpád", "Kálmán", "Ferenc", "Mátyás", "Zoltán", "Gyula", "Andor", "Levente"],
  },
  {
    key: "Persian",
    onsets: ["Far", "Gol", "Ham", "Isf", "Kash", "Mash", "Nish", "Shir", "Tab", "Yaz", "Zan", "Bam", "Ker", "Rez"],
    middles: ["a", "i", "u", "ab", "an"],
    endings: ["abad", "shahr", "stan", "jan", "dasht", "kuh", "rud", "pur"],
    townSuffixes: ["abad", "shahr", "pur", "jan", "dasht", "kuh", "rud"],
    nationSuffixes: ["stan", "shahr", "an", "istan"],
    governments: ["Shahdom", "Empire", "Satrapy", "Kingdom", "Emirate"],
    given: ["shid", "dad", "zad", "vash", "bod", "an"],
    names: ["Dariush", "Cyrus", "Kaveh", "Bahram", "Rostam", "Arash", "Farhad", "Shapur", "Khosrow", "Mehrdad", "Babak", "Kourosh"],
  },
  {
    key: "Indian",
    onsets: ["Am", "Bha", "Chan", "Dev", "Gan", "Jai", "Kan", "Lak", "Mah", "Nag", "Pra", "Raj", "Sur", "Var", "Uj"],
    middles: ["a", "i", "u", "an", "ar"],
    endings: ["pur", "nagar", "abad", "garh", "ganj", "vati", "pali", "giri"],
    townSuffixes: ["pur", "nagar", "garh", "ganj", "vati", "pura", "giri"],
    nationSuffixes: ["a", "vartha", "desh", "pradesh"],
    governments: ["Raj", "Kingdom", "Mahajanapada", "Sultanate", "Empire"],
    given: ["endra", "deva", "raj", "an", "esh", "ik", "ant"],
    names: ["Arjun", "Rohan", "Vikram", "Aditya", "Karan", "Sanjay", "Rahul", "Ashok", "Chandra", "Harsha", "Bharat", "Ravi"],
  },
  {
    key: "African",
    onsets: ["Ab", "Bam", "Dak", "Gao", "Kum", "Lag", "Mal", "Nia", "Oyo", "Seg", "Tim", "Zan", "Ife", "Kan", "Wag"],
    middles: ["a", "o", "u", "an", "em"],
    endings: ["ba", "gu", "ko", "ana", "uru", "ndi", "ala", "wa"],
    townSuffixes: ["ba", "gu", "ko", "ana", "ndi", "ala", "wa"],
    nationSuffixes: ["land", "ia", "ana", "gu"],
    governments: ["Kingdom", "Empire", "Confederacy", "Chiefdom", "Sultanate"],
    given: ["u", "a", "ko", "ndo", "mba", "ye", "ba"],
    names: ["Kofi", "Kwame", "Amadou", "Sundiata", "Mansa", "Oba", "Chike", "Tendai", "Jabari", "Sekou", "Idris", "Zuberi"],
  },
  {
    key: "Steppe",
    onsets: ["Alt", "Bat", "Chin", "Dag", "Gur", "Khan", "Mog", "Orh", "Sar", "Tem", "Ulu", "Yes", "Bor", "Kul"],
    middles: ["a", "u", "o", "ag", "ur"],
    endings: ["gai", "tai", "bator", "khan", "ur", "orum", "gol", "sar"],
    townSuffixes: ["gol", "tai", "orum", "sar", "gai", "ur"],
    nationSuffixes: ["khanate", "ia", "stan", "gol"],
    governments: ["Khanate", "Horde", "Kaganate", "Ulus", "Confederation"],
    given: ["khan", "tai", "bek", "gei", "dai", "mur"],
    names: ["Temur", "Batu", "Subutai", "Kublai", "Jochi", "Berke", "Mongke", "Ogedei", "Tolui", "Arslan", "Toghrul", "Jebe"],
  },
];

const FAMILIES: Family[] = [...BASE_FAMILIES, ...EXTRA_FAMILIES];

// How the editor describes each naming style: by the endings its places carry
const FAMILY_LABELS: Record<string, string> = {
  Germanic: "-burg, -dorf",
  Latin: "-ona, -ium",
  Slavic: "-grad, -ov",
  Nordic: "-vik, -fjord",
  Desert: "-abad, -iya",
  Celtic: "-dun, -glas",
  Eastern: "-zhou, -jin",
  Magyar: "-vár, -háza",
  Persian: "-shahr, -stan",
  Indian: "-pur, -nagar",
  African: "-ndi, -ala",
  Steppe: "-bator, -gol",
};
export const familyLabel = (key: string) => FAMILY_LABELS[key] ?? key;

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An invented name for a people, in the sound of a family: "Tavorai", "Skelmen"
const PEOPLE_ENDINGS = ["ai", "en", "ori", "ith", "oi", "ek", "un", "ar", "ene", "ul", "ish", "ath"];
export function randomRaceName(rand: () => number, familyIndex: number): string {
  const lang = new Language(rand, familyIndex);
  return lang.word() + PEOPLE_ENDINGS[Math.floor(rand() * PEOPLE_ENDINGS.length)];
}
export const FAMILY_KEYS = FAMILIES.map((f) => f.key);
export const familyIndexOf = (key: string) => Math.max(0, FAMILY_KEYS.indexOf(key));

export class Language {
  public family: Family;
  private onsets: string[];
  private rand: () => number;

  constructor(rand: () => number, familyIndex?: number) {
    this.rand = rand;
    this.family =
      FAMILIES[familyIndex ?? Math.floor(rand() * BASE_FAMILIES.length) % BASE_FAMILIES.length];
    // Each culture uses a random subset so sister cultures still differ
    this.onsets = this.family.onsets.filter(() => rand() < 0.65);
    if (this.onsets.length < 4) this.onsets = this.family.onsets.slice();
  }

  // What the language drew at creation, so it can be rebuilt elsewhere
  // without drawing again (see WorldTransfer)
  public get spec(): { family: number; onsets: string[] } {
    return { family: FAMILIES.indexOf(this.family), onsets: this.onsets.slice() };
  }
  public static revive(spec: { family: number; onsets: string[] }, rand: () => number): Language {
    const l = Object.create(Language.prototype) as Language;
    l.rand = rand;
    l.family = FAMILIES[spec.family];
    l.onsets = spec.onsets.slice();
    return l;
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rand() * arr.length)];
  }

  private cap(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  public word(): string {
    let w = this.pick(this.onsets);
    if (this.rand() < 0.5) w += this.pick(this.family.middles);
    return this.cap(w);
  }

  public townName(): string {
    const w = this.word();
    return this.cap(w + this.pick(this.family.townSuffixes)).replace(/(.)\1\1/g, "$1$1");
  }

  public nationName(): string {
    return this.cap(this.word() + this.pick(this.family.nationSuffixes));
  }

  // Rulers and houses draw on the caller's random stream, so the language's
  // own stream (towns, nations) is left as world generation expects it
  public personName(rand: () => number): string {
    const f = this.family;
    if (f.names && rand() < 0.6) return f.names[Math.floor(rand() * f.names.length)];
    const on = this.onsets[Math.floor(rand() * this.onsets.length)];
    // Vowel-less onsets ("St", "Kr") need a middle syllable to be pronounceable
    const mid = rand() < 0.3 || !/[aeiouy]/i.test(on) ? f.middles[Math.floor(rand() * f.middles.length)] || "a" : "";
    const end = f.given[Math.floor(rand() * f.given.length)];
    return this.cap((on + mid + end).toLowerCase()).replace(/(.)\1\1/g, "$1$1");
  }

  public houseName(rand: () => number): string {
    const f = this.family;
    const on = this.onsets[Math.floor(rand() * this.onsets.length)];
    const mid = /[aeiouy]/i.test(on) ? "" : f.middles[Math.floor(rand() * f.middles.length)] || "a";
    const tail = rand() < 0.5 ? f.endings[Math.floor(rand() * f.endings.length)] : f.middles[Math.floor(rand() * f.middles.length)];
    return this.cap((on + mid + tail).toLowerCase()).replace(/(.)\1\1/g, "$1$1");
  }

  public cultureName(): string {
    const base = this.word();
    const forms = ["kin", "folk", "born", "clan", "guard"];
    return this.cap(base + this.pick(forms));
  }

  public government(size: number, coastal: boolean): string {
    if (coastal && this.rand() < 0.25) return "Merchant Republic";
    if (size > 0.75 && this.rand() < 0.6) return "Empire";
    if (size < 0.2 && this.rand() < 0.5) return this.rand() < 0.5 ? "Duchy" : "Principality";
    return this.pick(this.family.governments);
  }
}

// World generation only rolls the original families
export const familyCount = BASE_FAMILIES.length;

const RELIGION_ROOTS = ["Sol", "Ast", "Vel", "Mor", "Ith", "Ka", "Ner", "Ys", "Thal", "Or", "Zan", "Eld"];
const RELIGION_FORMS = ["ism", "ianism", "ite Faith", " Covenant", " Way", " Mysteries", " Creed"];

export function religionName(rand: () => number): string {
  const r = RELIGION_ROOTS[Math.floor(rand() * RELIGION_ROOTS.length)];
  const m = ["a", "e", "i", "ar", "on", ""][Math.floor(rand() * 6)];
  const f = RELIGION_FORMS[Math.floor(rand() * RELIGION_FORMS.length)];
  return r + m + f;
}

export function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (c: number) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
