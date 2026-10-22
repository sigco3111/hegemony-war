import {
  zInt,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { DefensePriority } from "@openfront/engine-api/game/DefenseDelegation";
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  DefenseDelegationBehavior,
  DefenseDelegationSettings,
} from "./nation/DefenseDelegationBehavior";

/** Minimum ticks between two delegated builds (5s at 10 ticks/s). */
const BUILD_GAP_TICKS = 50;

/**
 * 개선6: the player's rear-defense delegation worker. Spawned by the
 * set_defense_delegation intent through ExecutionManager. A new intent spawns
 * a new instance which replaces any existing one for the same player, so the
 * latest settings always win. Disabled instances deactivate themselves, so a
 * delegation that is off leaves no worker behind. Only ever builds defensive
 * structures — attacks and diplomacy stay manual.
 *
 * NOTE: executions added from inside another execution's init() are dropped
 * by GameImpl (unInitExecs is overwritten after the init pass), which is why
 * this is a single self-replacing execution rather than a control execution
 * spawning a separate worker.
 */
export class DefenseDelegationExecution implements Execution {
  private active = true;
  private lastBuildTick = -BUILD_GAP_TICKS;
  private behavior: DefenseDelegationBehavior | null = null;
  private random: PseudoRandom | null = null;
  /**
   * Treasury at the off→on transition; the reserve floor is computed from
   * this fixed anchor. Serialized as a decimal string (snapshots are JSON).
   */
  private anchorGold: bigint = 0n;

  /**
   * 개선 9 detailed settings. The intent carries them all optional; the
   * execution normalizes them so the behavior always sees a full object.
   * `zoneTile` is the protected-zone center (null = delegate anywhere).
   */
  private buildPosts: boolean;
  private buildSams: boolean;
  private priority: DefensePriority;
  private zoneTile: TileRef | null;

  constructor(
    public player: Player,
    private enabled: boolean,
    private reservePercent: number,
    options: {
      buildPosts?: boolean;
      buildSams?: boolean;
      priority?: DefensePriority;
      zoneTile?: TileRef | null;
    } = {},
  ) {
    this.buildPosts = options.buildPosts ?? true;
    this.buildSams = options.buildSams ?? true;
    this.priority = options.priority ?? "reactive";
    this.zoneTile = options.zoneTile ?? null;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(mg: Game, ticks: number): void {
    // Latest intent wins: retire any older delegation for this player. A
    // settings change while ON (a new enabled execution replacing an enabled
    // one) inherits the anchor so the reserve basis does not reset; only an
    // off→on transition re-anchors to the current treasury.
    let inherited: bigint | null = null;
    for (const e of mg.executions()) {
      if (
        e instanceof DefenseDelegationExecution &&
        e !== this &&
        e.player === this.player
      ) {
        if (e.enabled && this.enabled) inherited = e.anchorGold;
        e.deactivate();
      }
    }
    if (!this.enabled) {
      // A disable intent leaves no worker behind.
      this.active = false;
      return;
    }
    this.anchorGold = inherited ?? this.player.gold();
    this.random = new PseudoRandom(simpleHash(this.player.id()));
    this.behavior = new DefenseDelegationBehavior(this.random, mg, this.player);
  }

  private deactivate(): void {
    this.active = false;
  }

  /**
   * 개선 11: the gold floor this delegation always keeps (reservePercent of
   * the anchor). Exposed so the economy delegation can stay out of the
   * defense budget (budget separation).
   */
  reserveFloor(): bigint {
    return (this.anchorGold * BigInt(this.reservePercent)) / 100n;
  }

  tick(ticks: number): void {
    if (!this.player.isAlive()) {
      this.active = false;
      return;
    }
    if (ticks - this.lastBuildTick < BUILD_GAP_TICKS) return;
    const settings: DefenseDelegationSettings = {
      enabled: this.enabled,
      reservePercent: this.reservePercent,
      anchorGold: this.anchorGold,
      buildPosts: this.buildPosts,
      buildSams: this.buildSams,
      priority: this.priority,
      zoneTile: this.zoneTile,
    };
    if (this.behavior?.tryBuild(settings)) {
      this.lastBuildTick = ticks;
    }
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DefenseDelegationExecutionSnapshot.write({
      player: w.player(this.player),
      enabled: this.enabled,
      reservePercent: this.reservePercent,
      anchorGold: this.anchorGold.toString(),
      lastBuildTick: this.lastBuildTick,
      random: w.random(this.random!),
      buildPosts: this.buildPosts,
      buildSams: this.buildSams,
      priority: this.priority,
      zoneTile: this.zoneTile === null ? null : this.zoneTile,
    });
  }

  restoreSnapshot(s: DefenseDelegationState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.enabled = s.enabled;
    this.reservePercent = s.reservePercent;
    this.anchorGold = BigInt(s.anchorGold ?? "0");
    this.lastBuildTick = s.lastBuildTick;
    this.buildPosts = s.buildPosts ?? true;
    this.buildSams = s.buildSams ?? true;
    this.priority = s.priority ?? "reactive";
    this.zoneTile = s.zoneTile ?? null;
    this.random = r.random(s.random);
    this.behavior = new DefenseDelegationBehavior(
      this.random,
      r.game,
      this.player,
    );
    this.active = this.enabled && this.player.isAlive();
  }
}

const DefenseDelegationStateSchema = z.object({
  player: zPlayerRef(),
  enabled: z.boolean(),
  reservePercent: zInt(),
  // Decimal string; optional so pre-anchor snapshots still restore.
  anchorGold: z.string().optional(),
  lastBuildTick: zInt(),
  random: zRandom(),
  // 개선 9 detailed settings; optional so pre-detail snapshots restore with
  // the original behavior (everything on, reactive first, no zone).
  buildPosts: z.boolean().optional(),
  buildSams: z.boolean().optional(),
  priority: z.enum(["reactive", "proactive", "sam"]).optional(),
  zoneTile: zInt().nullable().optional(),
});
type DefenseDelegationState = z.infer<typeof DefenseDelegationStateSchema>;

export const DefenseDelegationExecutionSnapshot = execSnapshotType({
  name: "DefenseDelegation",
  version: 1,
  schema: DefenseDelegationStateSchema,
  cls: () => DefenseDelegationExecution,
});
