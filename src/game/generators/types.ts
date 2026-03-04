import { NoiseEngine } from '../../core/NoiseEngine';
import { WorldData } from '../WorldData';
import type { Preset } from '../MapGenerator';

export interface GeneratorContext {
    world: WorldData;
    noise: NoiseEngine;
    width: number;
    height: number;
    preset: Preset;
}
