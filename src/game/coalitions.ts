import type { Nation, Coalition, WorldData } from "./WorldData";
import { generateFlag, type FlagSpec } from "./flags";

// Coalitions: independent realms bound together under one name (personal or
// political coalitions). A realm may belong to several at once. Membership lives
// on the nation (Nation.coalitions, a list of coalition ids), so it survives nations
// being removed and re-indexed; pruneCoalitions dissolves coalitions left with fewer
// than two members.

const COALITION_PALETTE = ["#e05a47", "#3f8fd2", "#e3b53a", "#8e5bc9", "#3fae7a", "#d9719f", "#e2873a", "#4bb8c4", "#9c6b3f", "#7a8f2e"];

export function coalitionById(world: WorldData, id: number | undefined): Coalition | undefined {
  return id === undefined ? undefined : world.coalitions.find((u) => u.id === id);
}

export const isMember = (n: Nation | undefined, coalitionId: number) => !!n?.coalitions?.includes(coalitionId);

// Every coalition a nation belongs to, in the order it joined them
export function coalitionsOf(world: WorldData, idx: number): Coalition[] {
  return (world.nations[idx]?.coalitions ?? []).map((id) => coalitionById(world, id)).filter((u): u is Coalition => !!u);
}

export function membersOf(world: WorldData, coalitionId: number): number[] {
  const out: number[] = [];
  world.nations.forEach((n, i) => {
    if (isMember(n, coalitionId)) out.push(i);
  });
  return out;
}

// Only independent realms join coalitions
export function canUnite(world: WorldData, idx: number): boolean {
  const n = world.nations[idx];
  return !!n && n.overlord === undefined;
}

// A name from the members' names; `variant` picks among the styles
export function coalitionName(world: WorldData, members: number[], variant = 0): string {
  const names = members.map((i) => world.nations[i]?.name).filter(Boolean) as string[];
  if (names.length < 2) return names[0] ? `Coalition of ${names[0]}` : "Coalition";
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const pair = `${names[0]}-${names[1]}`;
  const styles = [
    `Coalition of ${list}`,
    `${pair} Pact`,
    `League of ${list}`,
    `Grand Coalition of ${list}`,
    `${pair} Accord`,
  ];
  let h = 0;
  for (const ch of names.join("|")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return styles[(Math.abs(h) + variant) % styles.length];
}

export function freshCoalitionColor(world: WorldData): string {
  const used = new Set(world.coalitions.map((u) => u.color.toLowerCase()));
  return COALITION_PALETTE.find((c) => !used.has(c)) ?? COALITION_PALETTE[world.coalitions.length % COALITION_PALETTE.length];
}

// The flag a coalition is founded with (and Reset in the flag editor); `salt` rerolls it
export function defaultCoalitionFlag(world: WorldData, coalition: Coalition, salt = 0): FlagSpec {
  return generateFlag(`coalition:${coalition.name}`, coalition.color, "Latin", salt, undefined, world.version);
}

export const coalitionFlag = (world: WorldData, coalition: Coalition): FlagSpec => coalition.flag ?? defaultCoalitionFlag(world, coalition);

function setMembership(n: Nation, ids: number[]) {
  if (ids.length) n.coalitions = ids;
  else delete n.coalitions;
}

// A new coalition of a and b, whatever other coalitions they are in
export function formCoalition(world: WorldData, a: number, b: number, name?: string): Coalition | null {
  return a === b ? null : createCoalition(world, [a, b], name);
}

// A new coalition of the given realms. Null unless at least two are independent.
export function createCoalition(world: WorldData, members: number[], name?: string, color?: string): Coalition | null {
  const ok = [...new Set(members)].filter((i) => canUnite(world, i));
  if (ok.length < 2) return null;
  const id = world.coalitions.reduce((m, u) => Math.max(m, u.id + 1), 0);
  const coalition: Coalition = { id, name: name?.trim() || coalitionName(world, ok), color: color ?? freshCoalitionColor(world) };
  coalition.flag = defaultCoalitionFlag(world, coalition);
  world.coalitions.push(coalition);
  for (const i of ok) setMembership(world.nations[i], [...(world.nations[i].coalitions ?? []), id]);
  return coalition;
}

// Adds a realm to a coalition; its other coalitions are kept
export function joinCoalition(world: WorldData, idx: number, coalitionId: number): Coalition | null {
  const coalition = coalitionById(world, coalitionId);
  const n = world.nations[idx];
  if (!coalition || !canUnite(world, idx)) return null;
  if (!isMember(n, coalitionId)) setMembership(n, [...(n.coalitions ?? []), coalitionId]);
  return coalition;
}

// Leaves one coalition (a coalition of two dissolves)
export function leaveCoalition(world: WorldData, idx: number, coalitionId: number) {
  const n = world.nations[idx];
  if (!isMember(n, coalitionId)) return;
  setMembership(n, n.coalitions!.filter((id) => id !== coalitionId));
  pruneCoalitions(world);
}

// Deletes a coalition; its members keep their other coalitions
export function dissolveCoalition(world: WorldData, coalitionId: number) {
  for (const n of world.nations) if (isMember(n, coalitionId)) setMembership(n, n.coalitions!.filter((id) => id !== coalitionId));
  world.coalitions = world.coalitions.filter((u) => u.id !== coalitionId);
}

// Drops memberships of missing coalitions and of realms that became vassals, then
// dissolves coalitions left with fewer than two members
export function pruneCoalitions(world: WorldData) {
  if (!world.coalitions.length && !world.nations.some((n) => n.coalitions)) return;
  const live = new Set(world.coalitions.map((u) => u.id));
  for (const n of world.nations) {
    if (!n.coalitions) continue;
    const ids = n.overlord !== undefined ? [] : [...new Set(n.coalitions)].filter((id) => live.has(id));
    if (ids.length !== n.coalitions.length) setMembership(n, ids);
  }
  const count = new Map<number, number>();
  for (const n of world.nations) for (const id of n.coalitions ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  const dead = new Set(world.coalitions.filter((u) => (count.get(u.id) ?? 0) < 2).map((u) => u.id));
  if (!dead.size) return;
  world.coalitions = world.coalitions.filter((u) => !dead.has(u.id));
  for (const n of world.nations) if (n.coalitions?.some((id) => dead.has(id))) setMembership(n, n.coalitions.filter((id) => !dead.has(id)));
}
