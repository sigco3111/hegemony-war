import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Gold,
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DelegationResult,
  DelegationStatusItem,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { delegationZoneRadius } from "@openfront/engine-api/game/DefenseDelegation";
import { DefensePriority } from "@openfront/engine-api/game/DefenseDelegation";
import {
  attackFrontTiles,
  borderTilesFacing,
  countDefensePostsNearFront,
  DefenseZone,
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
  /** 개선 9: may the delegate build defense posts? */
  buildPosts: boolean;
  /** 개선 9: may the delegate build SAM launchers? */
  buildSams: boolean;
  /** 개선 9: which build kind is attempted first when several are needed. */
  priority: DefensePriority;
  /**
   * 개선 9: protected-zone center. When set, every delegated build must land
   * within the shared zone radius of this tile; null lets the delegate build
   * anywhere.
   */
  zoneTile: TileRef | null;
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
   * Resolves the protected zone for this attempt, or null for an invalid /
   * unset zone tile. The radius comes from the shared rule the client uses
   * to draw the zone circle, so what the player sees is what is enforced.
   */
  private zone(settings: DefenseDelegationSettings): DefenseZone | null {
    if (settings.zoneTile === null) return null;
    const x = this.game.x(settings.zoneTile);
    const y = this.game.y(settings.zoneTile);
    if (!this.game.isValidCoord(x, y)) return null;
    return {
      center: settings.zoneTile,
      radius: delegationZoneRadius(
        this.game.map().width(),
        this.game.map().height(),
      ),
    };
  }

  /**
   * One build attempt. Returns the construction it started, or null when
   * nothing was needed, affordable, or placeable. The player's priority
   * picks which kind is tried first; the rest follow in the default order
   * (reactive posts, proactive posts, SAM cover). Structure kinds the
   * player switched off are skipped entirely.
   */
  tryBuild(settings: DefenseDelegationSettings): UnitType | null {
    this.trace = new Map();
    if (!settings.enabled || !this.player.isAlive()) return null;
    const zone = this.zone(settings);
    const reactive = () => this.tryReactiveDefensePost(settings, zone);
    const proactive = () => this.tryProactiveDefensePost(settings, zone);
    const sam = () => this.trySamLauncher(settings, zone);
    const attempts: Record<DefensePriority, () => UnitType | null> = {
      reactive,
      proactive,
      sam,
    };
    const order: DefensePriority[] =
      settings.priority === "proactive"
        ? ["proactive", "reactive", "sam"]
        : settings.priority === "sam"
          ? ["sam", "reactive", "proactive"]
          : ["reactive", "proactive", "sam"];
    for (const kind of order) {
      if (kind === "sam" ? !settings.buildSams : !settings.buildPosts) {
        this.note(
          kind === "sam" ? UnitType.SAMLauncher : UnitType.DefensePost,
          "userOff",
        );
        continue;
      }
      const built = attempts[kind]();
      if (built !== null) return built;
    }
    return null;
  }

  /**
   * Decision trace of the last tryBuild, one entry per structure kind. Posts
   * have two routes (reactive, proactive); the more informative outcome wins
   * (built > budget > noSpot > noNeed > off).
   */
  private trace = new Map<UnitType, DelegationResult>();
  private static readonly RANK: Record<DelegationResult, number> = {
    built: 7,
    budget: 6,
    noSpot: 5,
    noNeed: 4,
    ruleOff: 3,
    needTiles: 2,
    needCity: 2,
    userOff: 1,
  };
  private note(unit: UnitType, result: DelegationResult): void {
    const prev = this.trace.get(unit);
    if (
      prev === undefined ||
      DefenseDelegationBehavior.RANK[result] >
        DefenseDelegationBehavior.RANK[prev]
    ) {
      this.trace.set(unit, result);
    }
  }

  /** Items for the status update; shortfall uses the settings' floor. */
  lastItems(reserve: Gold): DelegationStatusItem[] {
    const out: DelegationStatusItem[] = [];
    for (const [unit, result] of this.trace) {
      const off = result === "userOff" || result === "ruleOff";
      const cost = off ? 0 : Number(this.cost(unit));
      const short =
        result === "budget"
          ? Number(this.cost(unit) + reserve - this.player.gold())
          : 0;
      out.push({ unit, result, cost, shortfall: short, have: 0, need: 0 });
    }
    return out;
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
    zone: DefenseZone | null,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.DefensePost)) {
      this.note(UnitType.DefensePost, "ruleOff");
      return null;
    }

    const player = this.player;
    const attacks = player.incomingAttacks();
    const ourTroops = player.troops();
    if (attacks.length === 0 || ourTroops <= 0) {
      this.note(UnitType.DefensePost, "noNeed");
      return null;
    }
    const incomingTroops = attacks.reduce((sum, a) => sum + a.troops(), 0);
    const ratio = incomingTroops / ourTroops;
    if (ratio < UNDER_ATTACK_THREAT_RATIO) {
      this.note(UnitType.DefensePost, "noNeed");
      return null;
    }

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
        zone ?? undefined,
      ) >= allowed
    ) {
      this.note(UnitType.DefensePost, "noNeed");
      return null;
    }
    if (!this.withinBudget(settings, UnitType.DefensePost)) {
      this.note(UnitType.DefensePost, "budget");
      return null;
    }
    const tile = findDefensePostTile(
      this.game,
      player,
      this.random,
      frontTiles,
      minDist,
      maxDist,
      zone ?? undefined,
    );
    if (tile === null) {
      this.note(UnitType.DefensePost, "noSpot");
      return null;
    }
    this.note(UnitType.DefensePost, "built");
    return this.build(settings, UnitType.DefensePost, tile);
  }

  /**
   * A defense post covering the border with a hostile (recently attacking)
   * neighbor at least half our strength, before it attacks again. Same rule
   * as the nation AI's proactive placement, without the difficulty gate.
   */
  private tryProactiveDefensePost(
    settings: DefenseDelegationSettings,
    zone: DefenseZone | null,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.DefensePost)) {
      this.note(UnitType.DefensePost, "ruleOff");
      return null;
    }

    const player = this.player;
    const cityCount = player.units(UnitType.City).length;
    if (
      cityCount < PROACTIVE_DEFENSE_POST_MIN_CITIES ||
      player.units(UnitType.DefensePost).length >=
        cityCount * PROACTIVE_DEFENSE_POSTS_PER_CITY
    ) {
      this.note(UnitType.DefensePost, "noNeed");
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
    if (threats.size === 0) {
      this.note(UnitType.DefensePost, "noNeed");
      return null;
    }

    const range = config.defensePostRange();
    const frontTiles = borderTilesFacing(this.game, player, threats);
    if (
      countDefensePostsNearFront(
        this.game,
        player,
        frontTiles,
        range * 1.5,
        threats.size,
        zone ?? undefined,
      ) >= threats.size
    ) {
      this.note(UnitType.DefensePost, "noNeed");
      return null;
    }
    if (!this.withinBudget(settings, UnitType.DefensePost)) {
      this.note(UnitType.DefensePost, "budget");
      return null;
    }
    const tile = findDefensePostTile(
      this.game,
      player,
      this.random,
      frontTiles,
      range * PROACTIVE_DEFENSE_POST_MIN_DIST,
      range * PROACTIVE_DEFENSE_POST_MAX_DIST,
      zone ?? undefined,
    );
    if (tile === null) {
      this.note(UnitType.DefensePost, "noSpot");
      return null;
    }
    this.note(UnitType.DefensePost, "built");
    return this.build(settings, UnitType.DefensePost, tile);
  }

  /**
   * A SAM launcher covering protected structures (city/factory/silo/port),
   * only when nukes are a live threat in this game. SAMs under construction
   * count as covering so the delegate doesn't pile launchers on one spot.
   */
  private trySamLauncher(
    settings: DefenseDelegationSettings,
    zone: DefenseZone | null,
  ): UnitType | null {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.SAMLauncher)) {
      this.note(UnitType.SAMLauncher, "ruleOff");
      return null;
    }
    const nukesLive = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
    ].some((t) => !config.isUnitDisabled(t));
    if (!nukesLive) {
      this.note(UnitType.SAMLauncher, "noNeed");
      return null;
    }

    const player = this.player;
    const zoneSquared = zone === null ? 0 : zone.radius ** 2;
    const structures = player
      .units()
      .filter((u) => SAM_PROTECTED_TYPES.includes(u.type()))
      .filter(
        (u) =>
          zone === null ||
          this.game.euclideanDistSquared(u.tile(), zone.center) <=
            zoneSquared,
      );
    if (structures.length === 0) {
      this.note(UnitType.SAMLauncher, "noNeed");
      return null;
    }

    const cityCount = player.units(UnitType.City).length;
    const cap = Math.max(1, Math.ceil(Math.max(cityCount, 1) * SAM_PER_CITY));
    const sams = player.units(UnitType.SAMLauncher);
    if (sams.length >= cap) {
      this.note(UnitType.SAMLauncher, "noNeed");
      return null;
    }

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
    if (uncovered.length === 0) {
      this.note(UnitType.SAMLauncher, "noNeed");
      return null;
    }
    if (!this.withinBudget(settings, UnitType.SAMLauncher)) {
      this.note(UnitType.SAMLauncher, "budget");
      return null;
    }

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
      if (
        zone !== null &&
        this.game.euclideanDistSquared(t, zone.center) > zoneSquared
      ) {
        continue;
      }
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
    if (bestTile === null) {
      this.note(UnitType.SAMLauncher, "noSpot");
      return null;
    }
    this.note(UnitType.SAMLauncher, "built");
    return this.build(settings, UnitType.SAMLauncher, bestTile);
  }
}
