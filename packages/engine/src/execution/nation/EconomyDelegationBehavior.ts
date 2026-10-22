import {
  ECONOMY_MIN_TILES_FOR_CITY,
  ECONOMY_SAMPLE_ATTEMPTS,
  FACTORY_CITY_BONUS_DIST,
  FACTORY_RATIO_PER_CITY_DEN,
  FACTORY_RATIO_PER_CITY_NUM,
} from "@openfront/engine-api/game/EconomyDelegation";
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Gold, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DelegationStatusItem,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { randTerritoryTileArray } from "./NationUtils";

/** Runtime settings for the economy delegation, set by player intent. */
export interface EconomyDelegationSettings {
  enabled: boolean;
  /** Share of the anchor treasury (0-90) the delegate must always keep. */
  reservePercent: number;
  /** May the delegate build cities? */
  buildCities: boolean;
  /** May the delegate build factories? */
  buildFactories: boolean;
  /**
   * Treasury captured when the delegation switched from off to on. The
   * reserve floor is reservePercent of THIS anchor, not of the current
   * balance, so consecutive builds cannot ratchet the floor down. Toggling
   * off and on again re-anchors; changing reservePercent while on keeps the
   * same anchor and just recomputes the floor from it.
   */
  anchorGold: Gold;
  /**
   * 개선 11 budget separation: the reserve floor of the player's active
   * defense delegation (0 when defense delegation is off). The economy
   * delegate keeps BOTH floors untouched, so its spending can never eat the
   * defense budget. Computed by the execution each attempt, not by intent.
   */
  defenseFloor: Gold;
}

/**
 * 개선 11: economy delegation. When the player opts in, this builds cities
 * and factories for them. It only ever issues ConstructionExecution for
 * City and Factory — never warships, ports, weapons, attacks, or diplomacy
 * — and it never spends gold that would drop the treasury below the sum of
 * its own anchored reserve floor and the defense delegation's floor.
 */
export class EconomyDelegationBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  /**
   * One build attempt. Returns the construction it started, or null when
   * nothing was needed, affordable, or placeable. A factory is preferred
   * while the nation-AI 0.75 factories-per-city ratio is unmet; otherwise a
   * city. Structure kinds the player switched off are skipped entirely.
   */
  tryBuild(settings: EconomyDelegationSettings): UnitType | null {
    this.items = [];
    if (!settings.enabled || !this.player.isAlive()) return null;
    const config = this.game.config();
    const cities = this.player.unitsOwned(UnitType.City);
    const factories = this.player.unitsOwned(UnitType.Factory);
    const tiles = this.player.numTilesOwned();
    const factoryDue =
      settings.buildFactories &&
      !config.isUnitDisabled(UnitType.Factory) &&
      cities > 0 &&
      factories * FACTORY_RATIO_PER_CITY_DEN <
        cities * FACTORY_RATIO_PER_CITY_NUM;
    const cityDue =
      settings.buildCities &&
      !config.isUnitDisabled(UnitType.City) &&
      tiles >= ECONOMY_MIN_TILES_FOR_CITY;
    // Static reasons a kind is not even attempted (decision trace).
    const factoryStatic: DelegationStatusItem | null = !settings.buildFactories
      ? this.item(UnitType.Factory, "userOff")
      : config.isUnitDisabled(UnitType.Factory)
        ? this.item(UnitType.Factory, "ruleOff")
        : cities === 0
          ? this.item(UnitType.Factory, "needCity")
          : null;
    const cityStatic: DelegationStatusItem | null = !settings.buildCities
      ? this.item(UnitType.City, "userOff")
      : config.isUnitDisabled(UnitType.City)
        ? this.item(UnitType.City, "ruleOff")
        : tiles < ECONOMY_MIN_TILES_FOR_CITY
          ? {
              ...this.item(UnitType.City, "needTiles"),
              have: tiles,
              need: ECONOMY_MIN_TILES_FOR_CITY,
            }
          : null;
    if (factoryDue) {
      const built = this.tryPlace(settings, UnitType.Factory);
      if (built !== null) return built;
    }
    if (cityDue) {
      const built = this.tryPlace(settings, UnitType.City);
      if (built !== null) return built;
    }
    // Nothing else due: still grow factories when the player enabled them.
    if (
      settings.buildFactories &&
      !factoryDue &&
      cities > 0 &&
      !config.isUnitDisabled(UnitType.Factory)
    ) {
      const built = this.tryPlace(settings, UnitType.Factory);
      if (built !== null) return built;
    }
    if (factoryStatic !== null) this.items.push(factoryStatic);
    if (cityStatic !== null) this.items.push(cityStatic);
    return null;
  }

  /** Trace of the last tryBuild: one entry per structure kind considered. */
  private items: DelegationStatusItem[] = [];
  lastItems(): DelegationStatusItem[] {
    return this.items;
  }

  private item(
    unit: UnitType,
    result: DelegationStatusItem["result"],
    shortfall = 0,
  ): DelegationStatusItem {
    let cost = 0;
    if (result !== "userOff" && result !== "ruleOff") {
      cost = Number(this.cost(unit));
    }
    return { unit, result, cost, shortfall, have: 0, need: 0 };
  }

  private cost(type: UnitType): Gold {
    return this.game.unitInfo(type).cost(this.game, this.player);
  }

  /**
   * True when building `type` keeps BOTH reserve floors intact: this
   * delegation's own anchored floor plus the defense delegation's floor
   * (budget separation). When attacks or manual spending already dropped
   * the balance below the combined floor, the delegate holds until income
   * lifts it back.
   */
  private withinBudget(
    settings: EconomyDelegationSettings,
    type: UnitType,
  ): boolean {
    const gold = this.player.gold();
    const cost = this.cost(type);
    const ownReserve =
      (settings.anchorGold * BigInt(settings.reservePercent)) / 100n;
    return gold - cost >= ownReserve + settings.defenseFloor;
  }

  /**
   * Samples random owned tiles and picks the best valid spot. Cities score
   * by distance from existing cities (spread coverage); factories score by
   * distance from existing factories plus a bonus for a nearby city. Falls
   * back to any buildable sampled tile when every score ties at 0.
   */
  private tryPlace(
    settings: EconomyDelegationSettings,
    type: UnitType,
  ): UnitType | null {
    if (!this.withinBudget(settings, type)) {
      const floor =
        (settings.anchorGold * BigInt(settings.reservePercent)) / 100n +
        settings.defenseFloor;
      const short = this.cost(type) + floor - this.player.gold();
      this.items.push(this.item(type, "budget", Number(short)));
      return null;
    }
    const samples = randTerritoryTileArray(
      this.random,
      this.game,
      this.player,
      ECONOMY_SAMPLE_ATTEMPTS,
    );
    let bestTile: TileRef | null = null;
    let bestValue = 0;
    for (const tile of samples) {
      if (!this.player.canBuild(type, tile)) continue;
      const value = this.score(type, tile);
      if (bestTile === null || value > bestValue) {
        bestTile = tile;
        bestValue = value;
      }
    }
    if (bestTile === null) {
      this.items.push(this.item(type, "noSpot"));
      return null;
    }
    this.items.push(this.item(type, "built"));
    this.game.addExecution(
      new ConstructionExecution(this.player, type, bestTile),
    );
    this.game.addUpdate({
      type: GameUpdateType.DelegationNote,
      unit: type,
      tile: bestTile,
      cost: Number(this.cost(type)),
    });
    return type;
  }

  /** Higher is better; 0 for a merely valid tile. Capped spacing score. */
  private score(type: UnitType, tile: TileRef): number {
    const same = this.player.units(type);
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    let minDist = 60;
    for (const u of same) {
      const d =
        Math.abs(this.game.x(u.tile()) - x) + Math.abs(this.game.y(u.tile()) - y);
      if (d < minDist) minDist = d;
    }
    let value = minDist;
    if (type === UnitType.Factory) {
      for (const c of this.player.units(UnitType.City)) {
        const d =
          Math.abs(this.game.x(c.tile()) - x) +
          Math.abs(this.game.y(c.tile()) - y);
        if (d <= FACTORY_CITY_BONUS_DIST) {
          value += 20;
          break;
        }
      }
    }
    return value;
  }
}
