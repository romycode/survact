// Static game data. Keep balance numbers here, not scattered in systems.

export const Building = {
  None: 0,
  Core: 1,
  Wall: 2,
  Turret: 3,
  Belt: 4,
  Miner: 5,
  Furnace: 6,
} as const;
export type Building = (typeof Building)[keyof typeof Building];
export type Placeable = Exclude<Building, 0 | 1>;

export const Item = {
  None: 0,
  Iron: 1,
  Plate: 2,
} as const;
export type Item = (typeof Item)[keyof typeof Item];
export type Resource = Exclude<Item, 0>;

export const ITEM_NAMES: Record<Resource, string> = {
  [Item.Iron]: 'Hierro',
  [Item.Plate]: 'Placa',
};

export type Cost = Partial<Record<Resource, number>>;
export type Inventory = Record<Resource, number>;

export interface BuildingDef {
  name: string;
  cost: Cost;
  hp: number;
  /** Solid buildings block enemies (they attack them). Non-solid are walked over. */
  solid: boolean;
  /** Extra path cost for enemies: how much they "prefer" to go around it. */
  pathCost: number;
  /** Has a facing direction (output side). */
  directed: boolean;
}

export const BUILDINGS: Record<Exclude<Building, 0>, BuildingDef> = {
  [Building.Core]: { name: 'Núcleo', cost: {}, hp: 500, solid: true, pathCost: 0, directed: false },
  [Building.Wall]: { name: 'Muro', cost: { [Item.Iron]: 4 }, hp: 120, solid: true, pathCost: 12, directed: false },
  [Building.Turret]: { name: 'Torreta', cost: { [Item.Plate]: 10 }, hp: 80, solid: true, pathCost: 12, directed: false },
  [Building.Belt]: { name: 'Cinta', cost: { [Item.Iron]: 1 }, hp: 20, solid: false, pathCost: 0, directed: true },
  [Building.Miner]: { name: 'Minero', cost: { [Item.Iron]: 10 }, hp: 60, solid: true, pathCost: 12, directed: true },
  [Building.Furnace]: { name: 'Horno', cost: { [Item.Iron]: 12 }, hp: 80, solid: true, pathCost: 12, directed: true },
};

// Directions: 0=E 1=S 2=W 3=N
export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Y = [0, 1, 0, -1] as const;

export const BELT = {
  ticksPerTile: 30, // 2 tiles/s, 1 item per tile
};

export const MINER = {
  ticksPerItem: 60,
};

export const FURNACE = {
  ticksPerPlate: 90,
  maxInput: 10,
  maxOutput: 5,
};

export const TURRET = {
  range: 3.5, // tiles
  cooldownTicks: 20,
  damage: 12,
  shotsPerItem: { [Item.Iron]: 4, [Item.Plate]: 10 } as Record<Resource, number>,
  maxAmmo: 40,
};

export const ENEMY = {
  speed: 1.6, // tiles/second
  hp: 30,
  hpGrowthPerWave: 0.18,
  attackDamage: 8,
  attackCooldownTicks: 30,
};

export const ECONOMY = {
  start: { [Item.Iron]: 60, [Item.Plate]: 30 } as Inventory,
  /** Fraction of the cost returned when removing a building. */
  refund: 1,
};

export const MAP = {
  /** You can only build within this many tiles (Chebyshev) of an existing building. */
  buildReach: 6,
  /** Enemies spawn this far beyond your furthest building. */
  spawnMargin: 10,
  /** Extra tiles around base+spawns where enemies can path (lake detours). */
  flowPadding: 8,
  coreClearRadius: 4,
};

export const WAVES = {
  /** Time to set up before the first wave. */
  firstDelaySec: 60,
  /** Countdown after a wave finishes spawning. Waves can overlap if you're slow. */
  intervalSec: 40,
};

export function waveSize(wave: number): number {
  return 4 + Math.floor(wave * 2.5);
}

export function spawnPointCount(wave: number): number {
  return wave < 4 ? 1 : wave < 8 ? 2 : 3;
}

export function costEntries(c: Cost): [Resource, number][] {
  return Object.entries(c).map(([k, v]) => [Number(k) as Resource, v as number]);
}
