import { NoiseEngine } from '../../core/NoiseEngine';
import { WorldData } from '../WorldData';
import type { Preset } from '../MapGenerator';
import type { GuideField } from '../ImageGuide';

export interface GeneratorContext {
    world: WorldData;
    noise: NoiseEngine;
    width: number;
    height: number;
    preset: Preset;
    greatPowers?: number; // realms grown far larger than the rest (0-3)
    guide?: GuideField; // imported picture that decides land and sea
    onProgress?: (pct: number) => void;
}
