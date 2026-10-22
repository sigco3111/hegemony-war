import { describe, expect, it } from "vitest";
import {
  clampPlanRatio,
  planOrderTroops,
  queuedPlanRows,
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

  it("keeps the clicked tile on land attacks for map markers", () => {
    const q = new WarPlanQueue();
    const land = q.add("attack", "p1", 4242, 50);
    const boat = q.add("boat", null, 777, 25);
    const noTile = q.add("attack", "p2", null, 10);
    expect(land.dstTile).toBe(4242);
    expect(boat.dstTile).toBe(777);
    expect(noTile.dstTile).toBeNull();
  });
});

describe("queuedPlanRows (개선 10 map markers)", () => {
  it("numbers markers by list row so map and panel match", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", 11, 10);
    const b = q.add("attack", "b", 22, 10);
    const c = q.add("boat", null, 33, 10);
    expect(
      queuedPlanRows(q.all()).map(({ order, row }) => [order.id, row]),
    ).toEqual([
      [a.id, 1],
      [b.id, 2],
      [c.id, 3],
    ]);
  });

  it("renumbers after reorder and remove", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", null, 10);
    const b = q.add("attack", "b", null, 10);
    const c = q.add("attack", "c", null, 10);
    q.move(c.id, -1);
    expect(queuedPlanRows(q.all()).map(({ row }) => row)).toEqual([1, 2, 3]);
    expect(
      queuedPlanRows(q.all()).map(({ order }) => order.targetID),
    ).toEqual(["a", "c", "b"]);
    q.remove(a.id);
    expect(
      queuedPlanRows(q.all()).map(({ order, row }) => [order.targetID, row]),
    ).toEqual([
      ["c", 1],
      ["b", 2],
    ]);
    expect(b.id).not.toBe(a.id);
  });

  it("excludes finished orders but keeps their row numbers stable", () => {
    const q = new WarPlanQueue();
    const a = q.add("attack", "a", null, 10);
    const b = q.add("attack", "b", null, 10);
    const c = q.add("attack", "c", null, 10);
    a.state = "sent";
    b.state = "skipped";
    const rows = queuedPlanRows(q.all());
    expect(rows).toHaveLength(1);
    expect(rows[0].order.id).toBe(c.id);
    // Row 3 on the map matches row 3 in the list, not a renumbered 1.
    expect(rows[0].row).toBe(3);
  });
});
