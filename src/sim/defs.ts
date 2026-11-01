// Static game data. Keep balance numbers here, not scattered in systems.

export const Building = {
  None: 0,
  Core: 1,
  Wall: 2,
  Turret: 3,
  Belt: 4,
  Miner: 5,
} as const;
export type Building = (typeof Building)[keyof typeof Building];
export type Placeable = Exclude<Building, 0 | 1>;

export interface BuildingDef {
  name: string;
  cost: number;
  hp: number;
  /** Solid buildings block enemies (they attack them). Non-solid are walked over. */
  solid: boolean;
  /** Extra path cost for enemies: how much they "prefer" to go around it. */
  pathCost: number;
  /** Has a facing direction (output side). */
  directed: boolean;
}

export const BUILDINGS: Record<Exclude<Building, 0>, BuildingDef> = {
  [Building.Core]: { name: 'Núcleo', cost: 0, hp: 500, solid: true, pathCost: 0, directed: false },
  [Building.Wall]: { name: 'Muro', cost: 5, hp: 120, solid: true, pathCost: 12, directed: false },
  [Building.Turret]: { name: 'Torreta', cost: 25, hp: 80, solid: true, pathCost: 12, directed: false },
  [Building.Belt]: { name: 'Cinta', cost: 1, hp: 20, solid: false, pathCost: 0, directed: true },
  [Building.Miner]: { name: 'Minero', cost: 15, hp: 60, solid: true, pathCost: 12, directed: true },
};

// Directions: 0=E 1=S 2=W 3=N (sim space)
export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Y = [0, 1, 0, -1] as const;

export const Item = {
  None: 0,
  Ore: 1,
} as const;
export type Item = (typeof Item)[keyof typeof Item];

export const BELT = {
  ticksPerTile: 30, // 2 tiles/s, 1 item per tile
};

export const MINER = {
  ticksPerItem: 60,
};

export const TURRET = {
  range: 3.5, // tiles
  cooldownTicks: 20,
  damage: 12,
  shotsPerItem: 4,
  maxAmmo: 40,
};

export const ENEMY = {
  speed: 1.6, // tiles/second
  hp: 30,
  hpGrowthPerWave: 0.18,
  attackDamage: 8,
  attackCooldownTicks: 30,
  bounty: 3,
};

export const ECONOMY = {
  startMoney: 120,
  waveClearBonus: 30,
};

export const MAP = {
  oreClusters: 4,
};

export function waveSize(wave: number): number {
  return 4 + Math.floor(wave * 2.5);
}
