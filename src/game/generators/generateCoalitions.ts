import type { GeneratorContext } from "./types";
import { mulberry } from "../names";
import { atLeast, APP_VERSION } from "../version";
import { coalitionName, createCoalition, defaultCoalitionFlag } from "../coalitions";

// Coalitions among the generated realms (0.2+): independent neighbors (by land
// or across their waters) on good terms, preferring kin by culture or language.
// Some grow to three or four members; rarely a realm belongs to two.
// Draws from its own stream off the politics seed, so the world's noise stream
// (later stages, the history simulation) is untouched and links rebuild the
// same coalitions.
export async function generateCoalitions(ctx: GeneratorContext): Promise<void> {
  const { world } = ctx;
  if (!atLeast(ctx.version ?? APP_VERSION, "0.2")) return;
  const n = world.nations.length;
  if (n < 3) return;
  const rand = mulberry((world.politicsSeed ^ 0x6c0a1e57) >>> 0);

  // Realms touching each other: shared land borders or adjoining waters
  const contact = new Set<number>();
  const W = world.width;
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    const right = world.grid[(x + 1) % W];
    for (let y = 0; y < world.height; y++) {
      const a = col[y].nationIndex ?? -1;
      if (a < 0 || a >= n) continue;
      for (const b of [right[y].nationIndex ?? -1, y + 1 < world.height ? (col[y + 1].nationIndex ?? -1) : -1])
        if (b >= 0 && b < n && b !== a) contact.add(a < b ? a * n + b : b * n + a);
    }
  }
  const touches = (a: number, b: number) => contact.has(a < b ? a * n + b : b * n + a);
  const free = (i: number) => world.nations[i].overlord === undefined;
  const rel = (a: number, b: number) => world.relations[a]?.[b] ?? "Neutral";
  const friendly = (a: number, b: number) => rel(a, b) === "Alliance" || rel(a, b) === "Friendly";
  const family = (i: number) => world.languages[world.nations[i].cultureId ?? -1]?.family.key;
  const kinship = (a: number, b: number) => {
    const ca = world.nations[a].cultureId;
    if (ca !== undefined && ca === world.nations[b].cultureId) return 1.5;
    return family(a) && family(a) === family(b) ? 0.7 : 0;
  };
  const score = (a: number, b: number) => (rel(a, b) === "Alliance" ? 2 : 1) + kinship(a, b) + rand() * 0.8;

  // How many: none or one for small worlds, about one per 8-12 realms otherwise
  const target = n < 8 ? (rand() < 0.45 ? 1 : 0) : rand() < 0.1 ? 0 : Math.max(1, Math.round(n / (8 + rand() * 4)));
  if (!target) return;

  const pairs: { a: number; b: number; s: number }[] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) if (free(a) && free(b) && touches(a, b) && friendly(a, b)) pairs.push({ a, b, s: score(a, b) });
  pairs.sort((p, q) => q.s - p.s);

  const memberships = new Array<number>(n).fill(0);
  let overlaps = 0;
  // A realm already in a coalition joins another only rarely
  const mayJoin = (i: number) => memberships[i] === 0 || (memberships[i] === 1 && overlaps < 1 && rand() < 0.12);
  const groups: number[][] = [];
  for (const { a, b } of pairs) {
    if (groups.length >= target) break;
    if (groups.some((g) => g.includes(a) && g.includes(b))) continue;
    if (!mayJoin(a) || !mayJoin(b)) continue;
    const group = [a, b];
    // Grow with realms friendly to every member and touching one of them
    while (group.length < 4 && rand() < 0.45) {
      let best = -1;
      let bestScore = -Infinity;
      for (let c = 0; c < n; c++) {
        if (group.includes(c) || !free(c) || memberships[c] > (overlaps < 1 ? 1 : 0)) continue;
        if (!group.every((m) => friendly(m, c)) || !group.some((m) => touches(m, c))) continue;
        const s = group.reduce((t, m) => t + kinship(m, c), 0) / group.length + rand() * 0.8 - memberships[c] * 1.5;
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (best < 0) break;
      group.push(best);
    }
    for (const m of group) if (memberships[m]++ === 1) overlaps++;
    groups.push(group);
  }

  for (const group of groups) {
    const c = createCoalition(world, group);
    if (!c) continue;
    c.name = coalitionName(world, group, Math.floor(rand() * 5));
    c.flag = defaultCoalitionFlag(world, c);
  }
}
