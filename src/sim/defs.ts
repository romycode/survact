// Static game data. Keep balance numbers here, not scattered in systems.

export const Building = {
  None: 0,
  Core: 1,
  Wall: 2,
  Turret: 3,
} as const;
export type Building = (typeof Building)[keyof typeof Building];

export interface BuildingDef {
  name: string;
  cost: number;
  hp: number;
  /** Extra path cost for enemies: how much they "prefer" to go around it. */
  pathCost: number;
}

export const BUILDINGS: Record<Exclude<Building, 0>, BuildingDef> = {
  [Building.Core]: { name: 'Núcleo', cost: 0, hp: 500, pathCost: 0 },
  [Building.Wall]: { name: 'Muro', cost: 5, hp: 120, pathCost: 12 },
  [Building.Turret]: { name: 'Torreta', cost: 25, hp: 80, pathCost: 12 },
};

export const TURRET = {
  range: 3.5, // tiles
  cooldownTicks: 20,
  damage: 12,
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

export function waveSize(wave: number): number {
  return 4 + Math.floor(wave * 2.5);
}
