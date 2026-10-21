import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Gold,
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import {
  attackFrontTiles,
  borderTilesFacing,
  countDefensePostsNearFront,
  DEFENSE_POST_FRONT_BAND,
  DEFENSE_POST_FRONT_DIST_PER_RATIO,
  DEFENSE_POST_FRONT_MIN_DIST,
  DEFENSE_POST_FRONT_RATIO_CAP,
  DEFENSE_POST_RATIO_PER_POST,
  findDefensePostTile,
  PROACTIVE_DEFENSE_POST_MAX_DIST,
  PROACTIVE_DEFENSE_POST_MIN_CITIES,
  PROACTIVE_DEFENSE_POST_MIN_DIST,
  PROACTIVE_DEFENSE_POSTS_PER_CITY,
  UNDER_ATTACK_THREAT_RATIO,
} from "./DefensePostPlacement";

/** Runtime settings for the rear-defense delegation, set by player intent. */
export interface DefenseDelegationSettings {
  enabled: boolean;
  /** Share of the anchor treasury (0-90) the delegate must always keep. */
  reservePercent: number;
  /**
   * Treasury captured when the delegation switched from off to on. The
   * reserve floor is reservePercent of THIS anchor, not of the current
   * balance, so consecutive builds cannot ratchet the floor down. Toggling
   * off and on again re-anchors; changing reservePercent while on keeps the
   * same anchor and just recomputes the floor from it.
   */
  anchorGold: Gold;
}

/** Structures the delegated defender wants under SAM cover (same as nations). */
const SAM_PROTECTED_TYPES: readonly UnitType[] = [
  UnitType.City,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.Port,
];

/** SAM launchers per city the delegate may build (Hard nation ratio). */
const SAM_PER_CITY = 0.25;

/** Share of own troops a hostile neighbor needs before its border is fortified */
const PROACTIVE_HOSTILE_TROOP_RATIO = 0.5;

/** Random tiles tried when looking for a SAM launcher spot */
const SAM_SAMPLE_ATTEMPTS = 150;

/**
 * 개선6: rear-defense delegation. When the player opts in, this builds
 * defensive structures for them using the same placement rules the nation AI
 * uses (DefensePostPlacement). It only ever issues ConstructionExecution for
 * DefensePost and SAMLauncher — never attacks, boats, nukes, or diplomacy —
 * and it never spends gold that would drop the treasury below the reserve
 * floor (reservePercent of the anchor treasury captured at toggle-on).
 */
export class DefenseDelegationBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  /**
   * One build attempt. Returns the construction it started, or null when
   * nothing was needed, affordable, or placeable. Reactive defense posts
   * first, then proactive border posts, then SAM cover.
   */
  tryBuild(settings: DefenseDelegationSettings): UnitType | null {
    if (!settings.enabled || !this.player.isAlive()) return null;
    return (
      this.tryReactiveDefensePost(settings) ??
      this.tryProactiveDefensePost(settings) ??
      this.trySamLauncher(settings)
    );
  }

  private cost(type: UnitType): Gold {
    return this.game.unitInfo(type).cost(this.game, this.player);
  }

  /**
   * True when building `type` keeps at least reservePercent of the ANCHOR
   * treasury. When attacks or manual spending already dropped the balance
   * below the floor, the delegate holds until income lifts it back.
   */
  private withinBudget(
    settings: DefenseDelegationSettings,
    type: UnitType,
  ): boolean {
    const gold = this.player.gold();
    const cost = this.cost(type);
    const reserve =
      (settings.anchorGold * BigInt(settings.reservePercent)) / 100n;
    return gold - cost >= reserve;
  }

  private build(
    settings: DefenseDelegationSettings,
    type: UnitType,
    tile: TileRef,
  ): UnitType {
    this.game.addExecution(new ConstructionExecution(this.player, type, tile));
    this.game.addUpdate({
      type: GameUpdateType.DelegationNote,
      unit: type,
      tile,
      cost: Number(this.cost(type)),
    });
    return type;
  }

  /**
   * A defense post behind an active attack front, same rule as the nation
   * AI's Hard/Impossible reactive placement but without the difficulty gate:
   * the delegation is an assist and helps on every difficulty.
   */
  private tryReactiveDefensePost(
    settings: DefenseDelegationSettings,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.DefensePost)) return null;
    if (!this.withinBudget(settings, UnitType.DefensePost)) return null;

    const player = this.player;
    const attacks = player.incomingAttacks();
    if (attacks.length === 0) return null;
    const ourTroops = player.troops();
    if (ourTroops <= 0) return null;
    const incomingTroops = attacks.reduce((sum, a) => sum + a.troops(), 0);
    const ratio = incomingTroops / ourTroops;
    if (ratio < UNDER_ATTACK_THREAT_RATIO) return null;

    const allowed = Math.ceil(ratio / DEFENSE_POST_RATIO_PER_POST);
    const range = config.defensePostRange();
    const scaledRatio = Math.min(ratio, DEFENSE_POST_FRONT_RATIO_CAP);
    const minDist =
      range *
      (DEFENSE_POST_FRONT_MIN_DIST +
        DEFENSE_POST_FRONT_DIST_PER_RATIO * scaledRatio);
    const maxDist = minDist + range * DEFENSE_POST_FRONT_BAND;

    const frontTiles = attackFrontTiles(this.game, player, attacks);
    if (
      countDefensePostsNearFront(
        this.game,
        player,
        frontTiles,
        maxDist,
        allowed,
      ) >= allowed
    ) {
      return null;
    }
    const tile = findDefensePostTile(
      this.game,
      player,
      this.random,
      frontTiles,
      minDist,
      maxDist,
    );
    if (tile === null) return null;
    return this.build(settings, UnitType.DefensePost, tile);
  }

  /**
   * A defense post covering the border with a hostile (recently attacking)
   * neighbor at least half our strength, before it attacks again. Same rule
   * as the nation AI's proactive placement, without the difficulty gate.
   */
  private tryProactiveDefensePost(
    settings: DefenseDelegationSettings,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.DefensePost)) return null;
    if (!this.withinBudget(settings, UnitType.DefensePost)) return null;

    const player = this.player;
    const cityCount = player.units(UnitType.City).length;
    if (cityCount < PROACTIVE_DEFENSE_POST_MIN_CITIES) return null;
    if (
      player.units(UnitType.DefensePost).length >=
      cityCount * PROACTIVE_DEFENSE_POSTS_PER_CITY
    ) {
      return null;
    }

    const minTroops = player.troops() * PROACTIVE_HOSTILE_TROOP_RATIO;
    const threats = new Set<Player>();
    for (const neighbor of player.nearby()) {
      if (!neighbor.isPlayer() || neighbor.type() === PlayerType.Bot) continue;
      if (player.isFriendly(neighbor)) continue;
      if (
        player.relation(neighbor) === Relation.Hostile &&
        neighbor.troops() >= minTroops
      ) {
        threats.add(neighbor);
      }
    }
    if (threats.size === 0) return null;

    const range = config.defensePostRange();
    const frontTiles = borderTilesFacing(this.game, player, threats);
    if (
      countDefensePostsNearFront(
        this.game,
        player,
        frontTiles,
        range * 1.5,
        threats.size,
      ) >= threats.size
    ) {
      return null;
    }
    const tile = findDefensePostTile(
      this.game,
      player,
      this.random,
      frontTiles,
      range * PROACTIVE_DEFENSE_POST_MIN_DIST,
      range * PROACTIVE_DEFENSE_POST_MAX_DIST,
    );
    if (tile === null) return null;
    return this.build(settings, UnitType.DefensePost, tile);
  }

  /**
   * A SAM launcher covering protected structures (city/factory/silo/port),
   * only when nukes are a live threat in this game. SAMs under construction
   * count as covering so the delegate doesn't pile launchers on one spot.
   */
  private trySamLauncher(
    settings: DefenseDelegationSettings,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.SAMLauncher)) return null;
    const nukesLive = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
    ].some((t) => !config.isUnitDisabled(t));
    if (!nukesLive) return null;
    if (!this.withinBudget(settings, UnitType.SAMLauncher)) return null;

    const player = this.player;
    const structures = player
      .units()
      .filter((u) => SAM_PROTECTED_TYPES.includes(u.type()));
    if (structures.length === 0) return null;

    const cityCount = player.units(UnitType.City).length;
    const cap = Math.max(1, Math.ceil(Math.max(cityCount, 1) * SAM_PER_CITY));
    const sams = player.units(UnitType.SAMLauncher);
    if (sams.length >= cap) return null;

    const range = config.samRange(1);
    const rangeSquared = range ** 2;
    const uncovered = structures.filter(
      (s) =>
        !sams.some(
          (sam) =>
            this.game.euclideanDistSquared(sam.tile(), s.tile()) <=
            rangeSquared,
        ),
    );
    if (uncovered.length === 0) return null;

    // Sample around the uncovered structures; keep the tile that puts the
    // most still-uncovered structures in range.
    let bestTile: TileRef | null = null;
    let bestCover = 0;
    for (let attempt = 0; attempt < SAM_SAMPLE_ATTEMPTS; attempt++) {
      const anchor = this.random.randElement(uncovered);
      const ax = this.game.x(anchor.tile());
      const ay = this.game.y(anchor.tile());
      const r = Math.ceil(range);
      const x = this.random.nextInt(ax - r, ax + r + 1);
      const y = this.random.nextInt(ay - r, ay + r + 1);
      if (!this.game.isValidCoord(x, y)) continue;
      const t = this.game.ref(x, y);
      if (this.game.owner(t) !== player) continue;
      if (!player.canBuild(UnitType.SAMLauncher, t)) continue;
      let cover = 0;
      for (const s of uncovered) {
        if (this.game.euclideanDistSquared(t, s.tile()) <= rangeSquared) {
          cover++;
        }
      }
      if (cover > bestCover) {
        bestCover = cover;
        bestTile = t;
      }
    }
    if (bestTile === null) return null;
    return this.build(settings, UnitType.SAMLauncher, bestTile);
  }
}
