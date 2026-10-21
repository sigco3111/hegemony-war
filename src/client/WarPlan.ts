import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerID } from "@openfront/engine-api/game/GameTypes";

/**
 * 개선 7: 일시정지 작전 계획 (pause operation plan).
 *
 * While a singleplayer game is paused, attack clicks are queued here instead
 * of being dropped by the paused LocalServer. Orders keep the troop ratio
 * they were planned with; on resume the panel dispatches them top-down, one
 * per tick, always against the live troop count. The queue is session-only
 * (component state, never persisted) so nothing leaks across games.
 */

export type PlanOrderKind = "attack" | "boat";
export type PlanOrderState = "queued" | "sent" | "skipped";

export interface PlanOrder {
  id: number;
  kind: PlanOrderKind;
  /** null = unclaimed (neutral) land; land attacks only. */
  targetID: PlayerID | null;
  /** Boat orders only: the destination tile clicked. */
  dstTile: TileRef | null;
  /** Percent (1-100) of the live troop count, applied at execution time. */
  ratioPercent: number;
  state: PlanOrderState;
  /** Skip reason key suffix (war_plan.skip_*) when state === "skipped". */
  skipReason: string | null;
  /** Troops actually dispatched when state === "sent". */
  sentTroops: number | null;
}

export const PLAN_RATIO_MIN = 1;
export const PLAN_RATIO_MAX = 100;
export const PLAN_RATIO_STEP = 5;

/** Emitted by PlayerActionHandler when an attack click lands while paused. */
export class QueuePlanOrderEvent {
  constructor(
    public readonly kind: PlanOrderKind,
    public readonly targetID: PlayerID | null,
    public readonly dstTile: TileRef | null,
    public readonly ratioPercent: number,
  ) {}
}

/** Toggles the war plan overlay (작전). Mirrors ToggleDelegationPanelEvent. */
export class ToggleWarPlanPanelEvent {
  constructor(public readonly isVisible?: boolean) {}
}

/** Panel → sidebar badge: how many orders are still waiting to run. */
export class WarPlanChangedEvent {
  constructor(
    public readonly queuedCount: number,
    public readonly executing: boolean,
  ) {}
}

export function clampPlanRatio(pct: number): number {
  if (!Number.isFinite(pct)) return PLAN_RATIO_MAX;
  return Math.min(PLAN_RATIO_MAX, Math.max(PLAN_RATIO_MIN, Math.round(pct)));
}

/** Troops an order will request: ratio of the live count, floored. */
export function planOrderTroops(ratioPercent: number, troops: number): number {
  if (!Number.isFinite(troops) || troops <= 0) return 0;
  return Math.floor((clampPlanRatio(ratioPercent) / 100) * troops);
}

export class WarPlanQueue {
  private orders: PlanOrder[] = [];
  private nextId = 1;

  add(
    kind: PlanOrderKind,
    targetID: PlayerID | null,
    dstTile: TileRef | null,
    ratioPercent: number,
  ): PlanOrder {
    const order: PlanOrder = {
      id: this.nextId++,
      kind,
      targetID,
      dstTile,
      ratioPercent: clampPlanRatio(ratioPercent),
      state: "queued",
      skipReason: null,
      sentTroops: null,
    };
    // Same target twice is meaningful (successive waves), so duplicates are
    // kept as independent entries in click order.
    this.orders.push(order);
    return order;
  }

  remove(id: number): boolean {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== id);
    return this.orders.length !== before;
  }

  /** delta -1 = up (earlier), +1 = down (later). Edges are no-ops. */
  move(id: number, delta: -1 | 1): boolean {
    const idx = this.orders.findIndex((o) => o.id === id);
    const swap = idx + delta;
    if (idx < 0 || swap < 0 || swap >= this.orders.length) return false;
    [this.orders[idx], this.orders[swap]] = [
      this.orders[swap],
      this.orders[idx],
    ];
    return true;
  }

  setRatio(id: number, pct: number): boolean {
    const order = this.orders.find((o) => o.id === id);
    if (order === undefined) return false;
    order.ratioPercent = clampPlanRatio(pct);
    return true;
  }

  clear(): void {
    this.orders = [];
  }

  /** Drop sent/skipped rows, keep anything still waiting. */
  clearFinished(): void {
    this.orders = this.orders.filter((o) => o.state === "queued");
  }

  nextQueued(): PlanOrder | undefined {
    return this.orders.find((o) => o.state === "queued");
  }

  queuedCount(): number {
    return this.orders.filter((o) => o.state === "queued").length;
  }

  finishedCount(): number {
    return this.orders.filter((o) => o.state !== "queued").length;
  }

  all(): readonly PlanOrder[] {
    return this.orders;
  }
}
