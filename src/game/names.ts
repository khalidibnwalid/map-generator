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

const FAMILIES: Family[] = [
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

export class Language {
  public family: Family;
  private onsets: string[];
  private rand: () => number;

  constructor(rand: () => number, familyIndex?: number) {
    this.rand = rand;
    this.family =
      FAMILIES[familyIndex ?? Math.floor(rand() * FAMILIES.length) % FAMILIES.length];
    // Each culture uses a random subset so sister cultures still differ
    this.onsets = this.family.onsets.filter(() => rand() < 0.65);
    if (this.onsets.length < 4) this.onsets = this.family.onsets.slice();
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
    const forms = ["ic", "ian", "ish", "ese", "an"];
    return this.cap(base + this.pick(forms));
  }

  public government(size: number, coastal: boolean): string {
    if (coastal && this.rand() < 0.25) return "Merchant Republic";
    if (size > 0.75 && this.rand() < 0.6) return "Empire";
    if (size < 0.2 && this.rand() < 0.5) return this.rand() < 0.5 ? "Duchy" : "Principality";
    return this.pick(this.family.governments);
  }
}

export const familyCount = FAMILIES.length;

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
