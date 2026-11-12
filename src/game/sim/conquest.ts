// Recently conquered land, for the History map: land a realm took in battle
// and still holds by occupation. Its holder took it (gainedBy) but does not
// own its province, so retaken home land (a liberation) never counts. It
// doesn't matter whom it was taken from: land B occupied from C and A then
// took from B is A's conquest, even though A was never at war with C.
// The peace treaty settles a war's occupations (well-held provinces pass to
// the victor, whose land it then is; the rest is returned, so its holder no
// longer took it), which ends the shading: it lasts from the battle to the
// peace. Occupations no treaty covers (land of a third realm, or held by the
// loser of a capitulation) stay occupied, and stay shaded, until a later war
// settles them.

export interface ConquestState {
  land: ArrayLike<number>; // 1 for land cells
  owner: ArrayLike<number>; // holder of each cell (-1 none)
  prov: ArrayLike<number>; // province of each cell (-1 none)
  provOwner: ArrayLike<number>; // owning realm of each province
  gainedBy: ArrayLike<number>; // realm that last took each cell in battle (-1 none)
}

// Per cell: 255 for occupied land its holder took in battle, else 0
export function conquestMask(s: ConquestState, out: Uint8Array = new Uint8Array(s.owner.length)): Uint8Array {
  const { land, owner, prov, provOwner, gainedBy } = s;
  const P = provOwner.length;
  for (let i = 0; i < out.length; i++) {
    out[i] = 0;
    if (!land[i]) continue;
    const o = owner[i];
    if (o < 0 || gainedBy[i] !== o) continue;
    const p = prov[i];
    const po = p >= 0 && p < P ? provOwner[p] : -1;
    if (po >= 0 && po !== o) out[i] = 255;
  }
  return out;
}
