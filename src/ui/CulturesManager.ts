import type { Culture, WorldData } from "../game/WorldData";
import { FAMILY_KEYS, Language, familyIndexOf, familyLabel, hslHex } from "../game/names";
import { cityNameFor } from "../game/generators";
import { seededRand } from "../game/sim/Rulers";
import { createDropdown } from "./components/Dropdown";
import { emblemUrl } from "../game/emblem";
import { LogoEditor } from "./LogoEditor";
import { PeopleManager } from "./PeopleManager";

// The Cultures tab: peoples with a name, color, logo and race (whose language
// family they speak), and territory painted on the map. List, brush and map
// interaction are shared with the Races tab (PeopleManager).
export class CulturesManager extends PeopleManager<Culture> {
  protected readonly kind = "cultures";
  protected readonly noun = "culture";
  protected readonly field = "cultureIndex";
  protected readonly field2 = "culture2Index";
  private logoEditor: LogoEditor | null = null; // built on first use

  protected items(world: WorldData) {
    return world.cultures;
  }

  protected emblem(idx: number, size: number) {
    const world = this.generator.getWorld();
    const culture = world.cultures[idx];
    return culture ? emblemUrl(culture, world.languages[idx]?.family.key ?? "Latin", size, world.version) : null;
  }

  protected editEmblem(idx: number) {
    this.logoEditor ??= new LogoEditor();
    this.logoEditor.open(this.generator.getWorld(), idx, () => {
      this.renderList();
      this.onChanged?.(true);
    });
  }

  protected detailRows(box: HTMLElement, idx: number) {
    const world = this.generator.getWorld();
    const culture = world.cultures[idx];
    const family = world.languages[idx]?.family.key ?? FAMILY_KEYS[0];
    const race = document.createElement("div");
    race.className = "culture-race";
    race.innerHTML = `<span title="A culture speaks its race's language">Race</span>`;
    race.appendChild(
      createDropdown({
        options: world.races.map((r) => ({ value: String(r.id), label: r.name, color: r.color, hint: familyLabel(r.family) })),
        value: String(culture.raceId ?? 0),
        onChange: (v) => {
          this.setRace(idx, Number(v));
          this.metaChanged();
          this.renderList();
        },
      }),
    );
    const lang = document.createElement("div");
    lang.className = "culture-race";
    lang.innerHTML = `<span>Language</span><span title="Change the race to change the language" style="text-transform:none;letter-spacing:0;color:var(--text)">${familyLabel(family)}</span>`;
    box.append(race, lang);
  }

  protected detailActions(actions: HTMLElement, idx: number) {
    const world = this.generator.getWorld();
    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = "Rename places";
    b.title = "Give this culture's towns and realms new names in its language";
    b.addEventListener("click", async () => {
      const culture = world.cultures[idx];
      const family = world.languages[idx]?.family.key ?? FAMILY_KEYS[0];
      const ok = await this.uiManager.confirm("RENAME PLACES", `Give the towns and realms of ${culture.name} new names (${familyLabel(family)})?`);
      if (ok && this.generator.getWorld() === world) this.renamePlaces(idx);
    });
    actions.appendChild(b);
  }

  // A culture speaks its race's language family
  private setRace(idx: number, raceId: number) {
    const world = this.generator.getWorld();
    const key = world.races[raceId]?.family ?? world.languages[idx].family.key;
    world.cultures[idx].raceId = raceId;
    world.languages[idx] = new Language(seededRand(world.seed ^ (idx * 7919) ^ (familyIndexOf(key) * 104729)), familyIndexOf(key));
  }

  // Towns and realms of this culture get names from its (possibly new) language
  private renamePlaces(idx: number) {
    const world = this.generator.getWorld();
    const lang = world.languages[idx];
    if (!lang) return;
    for (const city of world.cities) {
      if ((world.getCell(city.x, city.y)?.cultureIndex ?? -1) === idx) city.name = cityNameFor(world, city.x, city.y, Math.random);
    }
    const taken = new Set(world.nations.map((n) => n.name));
    for (const nation of world.nations) {
      if (nation.cultureId !== idx) continue;
      let name = lang.nationName();
      for (let k = 0; k < 12 && taken.has(name); k++) name = lang.nationName();
      taken.add(name);
      nation.name = name;
      nation.flag = undefined; // regenerated for the new name and race
    }
    this.metaChanged();
    this.canvasManager.scheduleRender();
  }

  protected create(world: WorldData) {
    const id = world.cultures.length;
    const race = world.races[Math.floor(Math.random() * world.races.length)];
    const family = race?.family ?? FAMILY_KEYS[0];
    const lang = new Language(seededRand(world.seed ^ (id * 7919) ^ Date.now()), familyIndexOf(family));
    world.languages.push(lang);
    world.cultures.push({
      id,
      name: lang.cultureName(),
      color: hslHex((id * 137.508 + 20) % 360, 0.5, 0.58),
      centerX: world.width / 2,
      centerY: world.height / 2,
      raceId: race?.id,
    });
    return id;
  }

  protected beforeRemove(world: WorldData, id: number) {
    for (const nation of world.nations) {
      if (nation.cultureId === id) nation.cultureId = world.getCell(nation.capitalX, nation.capitalY)?.cultureIndex ?? (id === 0 ? 1 : 0);
    }
  }

  protected afterRemove(world: WorldData, id: number, shift: (v: number) => number) {
    world.languages.splice(id, 1);
    for (const nation of world.nations) if (nation.cultureId !== undefined) nation.cultureId = shift(nation.cultureId);
  }
}
