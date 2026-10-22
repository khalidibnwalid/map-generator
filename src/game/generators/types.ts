import { NoiseEngine } from '../../core/NoiseEngine';
import { WorldData } from '../WorldData';
import type { Preset } from '../MapGenerator';

export interface GeneratorContext {
    world: WorldData;
    noise: NoiseEngine;
    width: number;
    height: number;
    preset: Preset;
    greatPowers?: number; // realms grown far larger than the rest (0-3)
    onProgress?: (pct: number) => void;
}
