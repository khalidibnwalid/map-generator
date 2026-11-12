import type { WorldData } from "../game/WorldData";
import { flagUrl, nationFlagUrl } from "../game/flags";
import { canUnite, formCoalition, isMember, joinCoalition, leaveCoalition, coalitionFlag, coalitionsOf } from "../game/coalitions";
import { createDropdown, type DropdownOption } from "./components/Dropdown";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// The Coalitions row of a nation's Diplomacy tab: its coalitions (each opens in the
// Coalitions tab, × leaves it) and one picker to join a coalition or found a new one
// with another realm. The full editor is the Coalitions tab (CoalitionsManager).
export function coalitionPanel(world: WorldData, idx: number, changed: () => void, open: (coalitionId: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "diplo-vassals";
  wrap.innerHTML = `<span class="diplo-label">Coalitions</span>`;

  if (!canUnite(world, idx)) {
    const note = document.createElement("span");
    note.className = "coalition-note";
    note.textContent = "Vassals can't join a coalition";
    wrap.appendChild(note);
    return wrap;
  }

  for (const u of coalitionsOf(world, idx)) {
    const chip = document.createElement("span");
    chip.className = "diplo-chip coalition-member";
    chip.title = "Open in the Coalitions tab";
    chip.innerHTML = `<img class="diplo-flag" src="${flagUrl(coalitionFlag(world, u), 15, 10)}" alt="">${esc(u.name)}`;
    chip.style.borderColor = u.color;
    chip.addEventListener("click", () => open(u.id));
    const x = document.createElement("button");
    x.className = "diplo-x";
    x.textContent = "×";
    x.title = "Leave this coalition (a coalition of two dissolves)";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      leaveCoalition(world, idx, u.id);
      changed();
    });
    chip.appendChild(x);
    wrap.appendChild(chip);
  }

  // Coalitions to join, then realms to found a new coalition with
  const options: DropdownOption[] = [
    ...world.coalitions.filter((u) => !isMember(world.nations[idx], u.id)).map((u) => ({ value: `u${u.id}`, label: `Join ${u.name}`, image: flagUrl(coalitionFlag(world, u), 18, 12) })),
    ...world.nations
      .map((n, i) => ({ n, i }))
      .filter((e) => e.i !== idx && canUnite(world, e.i))
      .sort((a, b) => a.n.name.localeCompare(b.n.name))
      .map((e) => ({ value: `n${e.i}`, label: e.n.name, image: nationFlagUrl(world, e.i, 18, 12), hint: "new coalition" })),
  ];
  if (options.length)
    wrap.appendChild(
      createDropdown({
        className: "coalition-dd",
        title: "Join a coalition, or found a new one with another realm",
        value: "",
        options: [{ value: "", label: "Join or found a coalition…" }, ...options],
        onChange: (v) => {
          const id = Number(v.slice(1));
          if (v[0] === "u" ? joinCoalition(world, idx, id) : formCoalition(world, idx, id)) changed();
        },
      }),
    );
  return wrap;
}
