import {
  zInt,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
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

  constructor(
    public player: Player,
    private enabled: boolean,
    private reservePercent: number,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(mg: Game, ticks: number): void {
    // Latest intent wins: retire any older delegation for this player.
    for (const e of mg.executions()) {
      if (
        e instanceof DefenseDelegationExecution &&
        e !== this &&
        e.player === this.player
      ) {
        e.deactivate();
      }
    }
    if (!this.enabled) {
      // A disable intent leaves no worker behind.
      this.active = false;
      return;
    }
    this.random = new PseudoRandom(simpleHash(this.player.id()));
    this.behavior = new DefenseDelegationBehavior(this.random, mg, this.player);
  }

  private deactivate(): void {
    this.active = false;
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
      lastBuildTick: this.lastBuildTick,
      random: w.random(this.random!),
    });
  }

  restoreSnapshot(s: DefenseDelegationState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.enabled = s.enabled;
    this.reservePercent = s.reservePercent;
    this.lastBuildTick = s.lastBuildTick;
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
  lastBuildTick: zInt(),
  random: zRandom(),
});
type DefenseDelegationState = z.infer<typeof DefenseDelegationStateSchema>;

export const DefenseDelegationExecutionSnapshot = execSnapshotType({
  name: "DefenseDelegation",
  version: 1,
  schema: DefenseDelegationStateSchema,
  cls: () => DefenseDelegationExecution,
});
