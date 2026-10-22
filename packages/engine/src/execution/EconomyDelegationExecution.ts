import {
  zInt,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Gold } from "@openfront/engine-api/game/GameTypes";
import { Execution, Game, Player } from "../game/Game";
import { DefenseDelegationExecution } from "./DefenseDelegationExecution";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  EconomyDelegationBehavior,
  EconomyDelegationSettings,
} from "./nation/EconomyDelegationBehavior";

/** Minimum ticks between two delegated builds (5s at 10 ticks/s). */
const BUILD_GAP_TICKS = 50;

/**
 * 개선 11: the player's economy delegation worker (cities and factories
 * only — warships and every other facility stay manual). Spawned by the
 * set_economy_delegation intent through ExecutionManager. A new intent
 * spawns a new instance which replaces any existing one for the same
 * player, so the latest settings always win. Disabled instances deactivate
 * themselves, so a delegation that is off leaves no worker behind.
 *
 * Budget separation: each attempt computes the active defense delegation's
 * reserve floor and keeps it untouched on top of this delegation's own
 * anchored floor, so the two delegates can never drain each other's budget.
 *
 * NOTE: executions added from inside another execution's init() are dropped
 * by GameImpl (unInitExecs is overwritten after the init pass), which is why
 * this is a single self-replacing execution rather than a control execution
 * spawning a separate worker.
 */
export class EconomyDelegationExecution implements Execution {
  private active = true;
  private lastBuildTick = -BUILD_GAP_TICKS;
  private behavior: EconomyDelegationBehavior | null = null;
  private random: PseudoRandom | null = null;
  /**
   * Treasury at the off→on transition; the reserve floor is computed from
   * this fixed anchor. Serialized as a decimal string (snapshots are JSON).
   */
  private anchorGold: bigint = 0n;

  private buildCities: boolean;
  private buildFactories: boolean;

  constructor(
    public player: Player,
    private enabled: boolean,
    private reservePercent: number,
    options: {
      buildCities?: boolean;
      buildFactories?: boolean;
    } = {},
  ) {
    this.buildCities = options.buildCities ?? true;
    this.buildFactories = options.buildFactories ?? true;
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
        e instanceof EconomyDelegationExecution &&
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
    this.random = new PseudoRandom(simpleHash(this.player.id()) + 7);
    this.behavior = new EconomyDelegationBehavior(this.random, mg, this.player);
    this.mgRef = mg;
  }

  private deactivate(): void {
    this.active = false;
  }

  /**
   * Reserve floor of the player's active defense delegation (0 when defense
   * delegation is off). The economy delegate never spends into this budget.
   */
  private defenseFloor(mg: Game): Gold {
    for (const e of mg.executions()) {
      if (
        e instanceof DefenseDelegationExecution &&
        e.player === this.player &&
        e.isActive()
      ) {
        return e.reserveFloor();
      }
    }
    return 0n;
  }

  tick(ticks: number): void {
    if (!this.player.isAlive()) {
      this.active = false;
      return;
    }
    if (ticks - this.lastBuildTick < BUILD_GAP_TICKS) return;
    const settings: EconomyDelegationSettings = {
      enabled: this.enabled,
      reservePercent: this.reservePercent,
      anchorGold: this.anchorGold,
      buildCities: this.buildCities,
      buildFactories: this.buildFactories,
      defenseFloor: this.behavior ? this.defenseFloorRef() : 0n,
    };
    if (this.behavior?.tryBuild(settings)) {
      this.lastBuildTick = ticks;
    }
  }

  /** Set by init so tick can reach the game for the defense-floor lookup. */
  private mgRef: Game | null = null;
  private defenseFloorRef(): Gold {
    return this.mgRef === null ? 0n : this.defenseFloor(this.mgRef);
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return EconomyDelegationExecutionSnapshot.write({
      player: w.player(this.player),
      enabled: this.enabled,
      reservePercent: this.reservePercent,
      anchorGold: this.anchorGold.toString(),
      lastBuildTick: this.lastBuildTick,
      random: w.random(this.random!),
      buildCities: this.buildCities,
      buildFactories: this.buildFactories,
    });
  }

  restoreSnapshot(s: EconomyDelegationState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.enabled = s.enabled;
    this.reservePercent = s.reservePercent;
    this.anchorGold = BigInt(s.anchorGold ?? "0");
    this.lastBuildTick = s.lastBuildTick;
    this.buildCities = s.buildCities ?? true;
    this.buildFactories = s.buildFactories ?? true;
    this.random = r.random(s.random);
    this.behavior = new EconomyDelegationBehavior(
      this.random,
      r.game,
      this.player,
    );
    this.mgRef = r.game;
    this.active = this.enabled && this.player.isAlive();
  }
}

const EconomyDelegationStateSchema = z.object({
  player: zPlayerRef(),
  enabled: z.boolean(),
  reservePercent: zInt(),
  // Decimal string; optional so pre-anchor snapshots still restore.
  anchorGold: z.string().optional(),
  lastBuildTick: zInt(),
  random: zRandom(),
  buildCities: z.boolean().optional(),
  buildFactories: z.boolean().optional(),
});
type EconomyDelegationState = z.infer<typeof EconomyDelegationStateSchema>;

export const EconomyDelegationExecutionSnapshot = execSnapshotType({
  name: "EconomyDelegation",
  version: 1,
  schema: EconomyDelegationStateSchema,
  cls: () => EconomyDelegationExecution,
});
