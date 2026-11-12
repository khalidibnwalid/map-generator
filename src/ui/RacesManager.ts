import type { Culture, Race, WorldData } from "../game/WorldData";
import { FAMILY_KEYS, Language, familyIndexOf, familyLabel, hslHex, randomRaceName } from "../game/names";
import { seededRand } from "../game/sim/Rulers";
import { createDropdown } from "./components/Dropdown";
import { emblemUrl } from "../game/emblem";
import { PeopleManager, esc } from "./PeopleManager";

// The Races tab: peoples (Arabian, Hungarian...) as a layer of their own. A race
// has a name, a color, a language family and territory painted on the map;
// cultures belong to a race and speak its language. List, brush and map
// interaction are shared with the Cultures tab (PeopleManager).
export class RacesManager extends PeopleManager<Race> {
  protected readonly kind = "races";
  protected readonly noun = "race";
  protected readonly field = "raceIndex";
  protected readonly field2 = "race2Index";

  protected items(world: WorldData) {
    return world.races;
  }

  // A generated emblem in the race's color (races have no logo of their own)
  protected emblem(idx: number, size: number) {
    const world = this.generator.getWorld();
    const race = world.races[idx];
    if (!race) return null;
    const stand: Culture = { id: race.id, name: race.name, color: race.color, centerX: 0, centerY: 0 };
    return emblemUrl(stand, race.family, size, world.version);
  }

  protected detailRows(box: HTMLElement, idx: number) {
    const world = this.generator.getWorld();
    const race = world.races[idx];
    const lang = document.createElement("div");
    lang.className = "culture-race";
    lang.innerHTML = `<span title="Every culture of the race speaks it">Language</span>`;
    lang.appendChild(
      createDropdown({
        options: FAMILY_KEYS.map((k) => ({ value: k, label: familyLabel(k) })),
        value: race.family,
        onChange: (v) => {
          this.setFamily(idx, v);
          this.metaChanged();
          this.renderList();
        },
      }),
    );
    box.appendChild(lang);
    const cultures = world.cultures.filter((c) => c.raceId === idx);
    const p = document.createElement("p");
    p.className = "muted culture-spans";
    p.innerHTML = cultures.length
      ? `Cultures: ${cultures
          .slice(0, 6)
          .map((c) => esc(c.name))
          .join(" · ")}${cultures.length > 6 ? ` and ${cultures.length - 6} more` : ""}`
      : "No culture belongs to this race yet (set it in the Cultures tab).";
    box.appendChild(p);
  }

  protected detailActions(actions: HTMLElement, idx: number) {
    const world = this.generator.getWorld();
    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = "Rename places";
    b.title = "Give the towns and realms on this race's land new names in its language";
    b.addEventListener("click", async () => {
      const race = world.races[idx];
      const ok = await this.uiManager.confirm("RENAME PLACES", `Give the towns and realms of ${race.name} new names (${familyLabel(race.family)})?`);
      if (ok && this.generator.getWorld() === world) this.renamePlaces(idx);
    });
    actions.appendChild(b);
  }

  private languageFor(id: number, family: string) {
    const world = this.generator.getWorld();
    return new Language(seededRand(world.seed ^ (id * 7919) ^ (familyIndexOf(family) * 104729)), familyIndexOf(family));
  }

  // Every culture of the race now speaks the new family
  private setFamily(idx: number, family: string) {
    const world = this.generator.getWorld();
    world.races[idx].family = family;
    for (const c of world.cultures) if (c.raceId === idx) world.languages[c.id] = this.languageFor(c.id, family);
  }

  // Towns and realms on the race's land get names from its language
  private renamePlaces(idx: number) {
    const world = this.generator.getWorld();
    const lang = this.languageFor(1000 + idx, world.races[idx].family);
    for (const city of world.cities) {
      if ((world.getCell(city.x, city.y)?.raceIndex ?? -1) === idx) city.name = lang.townName();
    }
    const taken = new Set(world.nations.map((n) => n.name));
    for (const nation of world.nations) {
      if ((world.getCell(nation.capitalX, nation.capitalY)?.raceIndex ?? -1) !== idx) continue;
      let name = lang.nationName();
      for (let k = 0; k < 12 && taken.has(name); k++) name = lang.nationName();
      taken.add(name);
      nation.name = name;
      nation.flag = undefined;
    }
    this.metaChanged();
    this.canvasManager.scheduleRender();
  }

  protected create(world: WorldData) {
    const id = world.races.length;
    // A family no race speaks yet, when there is one
    const used = new Set(world.races.map((r) => r.family));
    const free = FAMILY_KEYS.filter((k) => !used.has(k));
    const pool = free.length ? free : FAMILY_KEYS;
    const family = pool[Math.floor(Math.random() * pool.length)];
    world.races.push({ id, name: randomRaceName(Math.random, familyIndexOf(family)), color: hslHex((id * 83 + 12) % 360, 0.55, 0.55), family });
    return id;
  }

  // Cultures of the deleted race join the race that now holds most of their land
  private moved = new Set<number>(); // cultures whose race is being deleted

  protected beforeRemove(world: WorldData, id: number) {
    this.moved = new Set(world.cultures.filter((c) => c.raceId === id).map((c) => c.id));
    const tally = new Map<number, Map<number, number>>();
    for (const col of world.grid)
      for (const cell of col) {
        const c = cell.cultureIndex ?? -1;
        if (c < 0 || world.cultures[c]?.raceId !== id || cell.raceIndex === undefined) continue;
        const m = tally.get(c) ?? new Map<number, number>();
        m.set(cell.raceIndex, (m.get(cell.raceIndex) ?? 0) + 1);
        tally.set(c, m);
      }
    for (const culture of world.cultures) {
      if (culture.raceId !== id) continue;
      const m = tally.get(culture.id);
      culture.raceId = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : id === 0 ? 1 : 0;
    }
  }

  protected afterRemove(world: WorldData, _id: number, shift: (v: number) => number) {
    // Only the cultures that changed race take up a new language
    for (const culture of world.cultures) {
      culture.raceId = shift(culture.raceId ?? 0);
      if (this.moved.has(culture.id)) world.languages[culture.id] = this.languageFor(culture.id, world.races[culture.raceId]?.family ?? FAMILY_KEYS[0]);
    }
    this.moved.clear();
  }
}
