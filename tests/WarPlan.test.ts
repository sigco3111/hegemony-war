import { describe, expect, it } from "vitest";
import {
  clampPlanRatio,
  planOrderTroops,
  WarPlanQueue,
} from "../src/client/WarPlan";

describe("WarPlanQueue", () => {
  it("queues orders in click order, duplicates included", () => {
    const q = new WarPlanQueue();
    q.add("attack", "p1", null, 50);
    q.add("attack", "p1", null, 25);
    q.add("attack", null, null, 100);
    expect(q.all().map((o) => [o.targetID, o.ratioPercent])).toEqual([
      ["p1", 50],
      ["p1", 25],
      [null, 100],
    ]);
    expect(q.queuedCount()).toBe(3);
  });

  it("clamps ratios into 1..100 and rounds", () => {
    expect(clampPlanRatio(0)).toBe(1);
    expect(clampPlanRatio(-20)).toBe(1);
    expect(clampPlanRatio(101)).toBe(100);
    expect(clampPlanRatio(33.6)).toBe(34);
    expect(clampPlanRatio(NaN)).toBe(100);
    const q = new WarPlanQueue();
    const o = q.add("attack", "p1", null, 250);
    expect(o.ratioPercent).toBe(100);
    q.setRatio(o.id, 0);
    expect(o.ratioPercent).toBe(1);
    q.setRatio(o.id, 42);
    expect(o.ratioPercent).toBe(42);
  });

  it("computes troops as a floored share of the live count", () => {
    expect(planOrderTroops(50, 1000)).toBe(500);
    expect(planOrderTroops(33, 100)).toBe(33);
    expect(planOrderTroops(100, 7)).toBe(7);
    expect(planOrderTroops(50, 0)).toBe(0);
    expect(planOrderTroops(50, NaN)).toBe(0);
  });

  it("moves orders up and down, with no-ops at the edges", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", null, 10);
    const b = q.add("attack", "b", null, 10);
    const c = q.add("attack", "c", null, 10);
    expect(q.move(a.id, -1)).toBe(false);
    expect(q.move(b.id, -1)).toBe(true);
    expect(q.all().map((o) => o.targetID)).toEqual(["b", "a", "c"]);
    expect(q.move(c.id, 1)).toBe(false);
    expect(q.move(999, 1)).toBe(false);
    expect(q.all().map((o) => o.targetID)).toEqual(["b", "a", "c"]);
  });

  it("removes and clears orders", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", null, 10);
    q.add("attack", "b", null, 10);
    expect(q.remove(a.id)).toBe(true);
    expect(q.remove(a.id)).toBe(false);
    expect(q.queuedCount()).toBe(1);
    q.clear();
    expect(q.all()).toHaveLength(0);
  });

  it("tracks execution states: nextQueued, sent, skipped, clearFinished", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", null, 50);
    const b = q.add("boat", null, 123, 25);
    const c = q.add("attack", "c", null, 100);
    expect(q.nextQueued()?.id).toBe(a.id);
    a.state = "sent";
    a.sentTroops = 500;
    expect(q.nextQueued()?.id).toBe(b.id);
    b.state = "skipped";
    b.skipReason = "no_boat";
    expect(q.nextQueued()?.id).toBe(c.id);
    expect(q.queuedCount()).toBe(1);
    expect(q.finishedCount()).toBe(2);
    q.clearFinished();
    expect(q.all().map((o) => o.id)).toEqual([c.id]);
  });
});
