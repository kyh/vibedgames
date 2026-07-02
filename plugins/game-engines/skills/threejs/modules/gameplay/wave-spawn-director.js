import { clamp } from "../math/scalar-utils.js";
import { DEFAULT_PRNG } from "../math/random-utils.js";

const DEFAULT_UNLOCK_RULES = [{ waveNumber: 1, type: "DEFAULT" }];

const DEFAULT_TYPE_WEIGHTS = {
  DEFAULT: 1,
};

const resolveWeight = (value, waveNumber) =>
  typeof value === "function" ? value(waveNumber) : value;

export class WaveSpawnDirector {
  constructor({
    baseWaveSize = 3,
    growthPerWave = 1.5,
    maxWaveSize = 500,
    unlockRules = DEFAULT_UNLOCK_RULES,
    typeWeights = DEFAULT_TYPE_WEIGHTS,
    maxSpawnsPerStep = 100,
    startWaveNumber = 1,
    waveAutoStart = true,
    prng = DEFAULT_PRNG,
  }) {
    this.baseWaveSize = baseWaveSize;
    this.growthPerWave = growthPerWave;
    this.maxWaveSize = maxWaveSize;
    this.unlockRules = [...unlockRules].sort((a, b) => a.waveNumber - b.waveNumber);
    this.typeWeights = { ...typeWeights };
    this.maxSpawnsPerStep = maxSpawnsPerStep;
    this.startWaveNumber = startWaveNumber;
    this.waveAutoStart = waveAutoStart;
    this.prng = prng;
    this.activeUnits = 0;

    this.reset(this.startWaveNumber);
    if (this.waveAutoStart) this.startWave(this.startWaveNumber);
  }

  reset(startWaveNumber = this.startWaveNumber) {
    this.waveNumber = startWaveNumber;
    this.inProgress = false;
    this.unitsToSpawn = 0;
    this.unitsSpawned = 0;
    this.lastSpawnedType = null;
    this.activeUnits = 0;
  }

  startWave(waveNumber = this.waveNumber) {
    this.waveNumber = waveNumber;
    this.unitsToSpawn = this.getWaveSize(waveNumber);
    this.unitsSpawned = 0;
    this.lastSpawnedType = null;
    this.inProgress = true;

    return {
      waveNumber: this.waveNumber,
      unitsToSpawn: this.unitsToSpawn,
      availableTypes: this.getAvailableTypes(this.waveNumber),
    };
  }

  step({ activeUnits = this.activeUnits } = {}) {
    this.activeUnits = activeUnits;

    this.completeIfDone(activeUnits);
    if (!this.inProgress && this.waveAutoStart) this.startWave(this.waveNumber);

    return {
      spawns: this.planSpawns(),
    };
  }

  setActiveUnits(activeUnits) {
    this.activeUnits = activeUnits;
  }

  getWaveSize(waveNumber = this.waveNumber) {
    const raw = this.baseWaveSize + (waveNumber - 1) * this.growthPerWave;
    return clamp(Math.floor(raw), 1, this.maxWaveSize);
  }

  getAvailableTypes(waveNumber = this.waveNumber) {
    return this.unlockRules
      .filter((rule) => waveNumber >= rule.waveNumber)
      .map((rule) => rule.type);
  }

  selectType(waveNumber = this.waveNumber) {
    const available = this.getAvailableTypes(waveNumber);
    const entries = [];
    let total = 0;

    for (const type of available) {
      const weight = resolveWeight(this.typeWeights[type] ?? 0, waveNumber);
      if (weight <= 0) continue;
      entries.push({ type, weight });
      total += weight;
    }

    // Before any rule unlocks (or all weights are zero), fall back to the earliest rule's type.
    if (entries.length === 0) return available[0] ?? this.unlockRules[0]?.type;

    let pick = this.prng.random() * total;
    for (const entry of entries) {
      pick -= entry.weight;
      if (pick <= 0) return entry.type;
    }
    return entries[entries.length - 1].type;
  }

  planSpawns() {
    if (!this.inProgress || this.unitsSpawned >= this.unitsToSpawn) return [];

    const spawns = [];
    let guard = this.maxSpawnsPerStep;

    while (this.unitsSpawned < this.unitsToSpawn && guard > 0) {
      const type = this.selectType(this.waveNumber);
      const spawn = {
        type,
        waveNumber: this.waveNumber,
        spawnIndex: this.unitsSpawned,
        spawnCount: this.unitsToSpawn,
      };

      this.unitsSpawned += 1;
      this.lastSpawnedType = type;
      spawns.push(spawn);
      guard -= 1;
    }

    return spawns;
  }

  completeIfDone(activeUnits) {
    if (!this.inProgress || this.unitsSpawned < this.unitsToSpawn || activeUnits > 0) return null;

    const completedWaveNumber = this.waveNumber;
    this.inProgress = false;
    this.waveNumber += 1;

    return {
      completedWaveNumber,
      nextWaveNumber: this.waveNumber,
    };
  }

  snapshot() {
    return {
      waveNumber: this.waveNumber,
      inProgress: this.inProgress,
      unitsToSpawn: this.unitsToSpawn,
      unitsSpawned: this.unitsSpawned,
      pending: this.inProgress ? Math.max(0, this.unitsToSpawn - this.unitsSpawned) : 0,
      activeUnits: this.activeUnits,
      lastSpawnedType: this.lastSpawnedType,
    };
  }
}
