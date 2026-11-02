import { NoiseEngine } from '../../core/NoiseEngine';
import { WorldData } from '../WorldData';
import type { Preset } from '../MapGenerator';
import type { GuideField } from '../ImageGuide';

// Generation options, in real units; DEFAULT_SETTINGS reproduces the generator's baseline
export interface WorldSettings {
    seaLevel: number; // elevation below which the map is water
    mountains: number; // multiplier on the height of land above the sea
    climate: number; // added to every temperature (0..1 scale)
    rainfall: number; // added to every land moisture value (0..1 scale)
    settlements: number; // multiplier on how many towns and villages appear
    nations: number; // number of realms; 0 picks one from the map size
}
export const DEFAULT_SETTINGS: WorldSettings = { seaLevel: 0.45, mountains: 1, climate: 0, rainfall: 0, settlements: 1, nations: 0 };

export interface GeneratorContext {
    world: WorldData;
    noise: NoiseEngine;
    width: number;
    height: number;
    preset: Preset;
    settings?: WorldSettings;
    greatPowers?: number; // realms grown far larger than the rest (0-3)
    guide?: GuideField; // imported picture that decides land and sea
    onProgress?: (pct: number) => void;
}
