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
  /**
   * Boat orders: the destination tile. Land attacks: the clicked tile when
   * known (marker position); null falls back to the target's name location.
   */
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

/**
 * Emitted by PlayerActionHandler when an attack click lands while paused.
 * For land attacks dstTile carries the clicked tile (when known) so the map
 * can mark exactly where the player aimed; for boat orders it is the
 * transport destination.
 */
export class QueuePlanOrderEvent {
  constructor(
    public readonly kind: PlanOrderKind,
    public readonly targetID: PlayerID | null,
    public readonly dstTile: TileRef | null,
    public readonly ratioPercent: number,
  ) {}
}

/**
 * 개선 10: a queued order's map marker. `row` is the 1-based row number in
 * the panel list, so the number on the map always matches the number the
 * player sees in the 작전 panel.
 */
export interface WarPlanMarker {
  id: number;
  row: number;
  kind: PlanOrderKind;
  x: number;
  y: number;
}

/**
 * Panel → map layer: the current queued-order markers (empty array clears
 * the overlay). highlightId pulses one badge right after the player located
 * it from the list.
 */
export class WarPlanMarkersEvent {
  constructor(
    public readonly markers: WarPlanMarker[],
    public readonly highlightId: number | null = null,
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

/**
 * Queued orders paired with their 1-based row number in the full list.
 * Row numbers match the panel's row labels, so a marker on the map reads
 * exactly like its list row; finished orders keep the list's numbering
 * stable but get no marker.
 */
export function queuedPlanRows(
  orders: readonly PlanOrder[],
): { order: PlanOrder; row: number }[] {
  const out: { order: PlanOrder; row: number }[] = [];
  orders.forEach((o, i) => {
    if (o.state === "queued") out.push({ order: o, row: i + 1 });
  });
  return out;
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
