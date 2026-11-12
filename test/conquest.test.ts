import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";
import { conquestMask } from "../src/game/sim/conquest";

test("conquest mask: land taken in battle and still occupied, not liberated or settled land", () => {
  // Realms C = 0, B = 1, A = 2; provinces 0, 1 and 2 belong to C, B and A
  const C = 0;
  const B = 1;
  const A = 2;
  const cells = [
    { owner: A, prov: 0, gainedBy: A, land: 1, want: 255 }, // A took from B what B had taken from C (A and C never at war)
    { owner: B, prov: 0, gainedBy: B, land: 1, want: 255 }, // B occupies C's land
    { owner: A, prov: 1, gainedBy: A, land: 1, want: 255 }, // A occupies B's land
    { owner: C, prov: 0, gainedBy: C, land: 1, want: 0 }, // C retook its own land: a liberation
    { owner: B, prov: 0, gainedBy: -1, land: 1, want: 0 }, // held by B but never won in battle
    { owner: A, prov: 0, gainedBy: A, land: 0, want: 0 }, // sea
    { owner: A, prov: 2, gainedBy: A, land: 1, want: 0 }, // a province ceded to A at the peace is A's own
    { owner: B, prov: 1, gainedBy: A, land: 1, want: 0 }, // returned to B at the peace
    { owner: C, prov: 1, gainedBy: A, land: 1, want: 0 }, // taken by A, then held by C without a battle
  ];
  const m = conquestMask({
    land: cells.map((c) => c.land),
    owner: cells.map((c) => c.owner),
    prov: cells.map((c) => c.prov),
    provOwner: [C, B, A],
    gainedBy: cells.map((c) => c.gainedBy),
  });
  expect([...m]).toEqual(cells.map((c) => c.want));
});

test("conquest shading follows the wars of a simulated world and leaves the simulation untouched", async () => {
  const run = async (look: boolean) => {
    const g = new MapGenerator(400, 225, 8080);
    g.currentPreset = "Earthlike";
    g.pin("0.1"); // a fixed world (newer versions draw their realms from a random seed)
    const world = await g.generate();
    const sim = new Simulation(world, g.getNoise());
    let shaded = 0;
    let checked = false;
    let before = -1; // shaded cells last year, when it ended at peace
    for (let i = 0; i < 40; i++) {
      sim.step();
      if (!look) continue;
      const mask = sim.conquestMask();
      expect(sim.conquestMask()).toBe(mask); // cached until the next year
      sim.warFronts();
      let n = 0;
      for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue;
        n++;
        const c = world.grid[k % world.width][Math.floor(k / world.width)];
        const o = c.nationIndex ?? -1;
        const po = world.provinces[c.provinceIndex ?? -1]?.nationIndex ?? -1;
        // Occupied: held by someone other than its province's owner
        expect(c.isWater).toBe(false);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(po).toBeGreaterThanOrEqual(0);
        expect(po).not.toBe(o);
        checked = true;
      }
      shaded += n;
      // Without wars nothing new is taken: the shading can only shrink
      if (before >= 0) expect(n).toBeLessThanOrEqual(before);
      before = sim.warPairs.length ? -1 : n;
    }
    // What the simulation decided (nation colors are left out: new realms draw theirs unseeded)
    const state = { owner: Array.from(sim.ownerArray), provinces: world.provinces.map((p) => p.nationIndex), events: sim.events.map((e) => e.text), battles: sim.battles };
    return { state, shaded, checked };
  };
  const plain = await run(false);
  const looked = await run(true);
  expect(looked.checked).toBe(true); // some land was taken in these 40 years
  expect(looked.state).toEqual(plain.state);
}, 300_000);
