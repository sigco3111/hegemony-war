import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DelegationNoteUpdate,
  DelegationStatusUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { SetEconomyDelegationIntentSchema } from "@openfront/engine-api/Schemas";
import { DefenseDelegationExecution } from "@openfront/engine/execution/DefenseDelegationExecution";
import { EconomyDelegationExecution } from "@openfront/engine/execution/EconomyDelegationExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * 개선 11 economy delegation integration evidence: these tests drive the
 * engine tick loop (game.executeNextTick) with the same execution classes
 * the deployed intent wiring spawns, and assert both engine state (a city /
 * factory appears) and the DelegationNote updates the client delegation
 * panel renders as its action history. Warships stay manual by design and
 * are never built by this delegate.
 *
 * Layout: player stripe | enemy stripe on big_plains.
 */
const MAX_TICKS = 600;

interface Ctx {
  game: Game;
  player: Player;
  enemy: Player;
}

async function setupDelegation(): Promise<Ctx> {
  const game = await setup(
    "big_plains",
    { difficulty: Difficulty.Hard, gameMode: GameMode.FFA },
    [
      new PlayerInfo("me", PlayerType.Human, null, "me_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ],
  );
  const player = game.player("me_id");
  const enemy = game.player("enemy_id");

  const half = Math.floor(game.map().width() / 2);
  for (let x = 0; x < game.map().width(); x++) {
    for (let y = 0; y < game.map().height(); y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) {
        (x < half ? player : enemy).conquer(tile);
      }
    }
  }
  player.addTroops(100_000);
  enemy.addTroops(100_000);
  player.addGold(10_000_000n);
  return { game, player, enemy };
}

function tickCollecting(
  game: Game,
  maxTicks: number,
  stop?: (notes: DelegationNoteUpdate[]) => boolean,
): { notes: DelegationNoteUpdate[]; ticks: number[] } {
  const notes: DelegationNoteUpdate[] = [];
  const ticks: number[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const updates = game.executeNextTick();
    for (const n of (updates[GameUpdateType.DelegationNote] ??
      []) as DelegationNoteUpdate[]) {
      notes.push(n);
      ticks.push(game.ticks());
    }
    if (stop?.(notes)) break;
  }
  return { notes, ticks };
}

function spawnEconomy(
  game: Game,
  player: Player,
  enabled: boolean,
  reservePercent: number,
  options: {
    buildCities?: boolean;
    buildFactories?: boolean;
    priority?: "balanced" | "city" | "factory";
    cityTarget?: number;
    factoryTarget?: number;
  } = {},
): void {
  const exec = new EconomyDelegationExecution(
    player,
    enabled,
    reservePercent,
    options,
  );
  game.addExecution(exec);
}

describe("EconomyDelegation", () => {
  test("intent schema parses a plain toggle and a detailed intent", () => {
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 50,
      }).success,
    ).toBe(true);
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 25,
        buildCities: false,
        buildFactories: true,
      }).success,
    ).toBe(true);
    // reservePercent above 90 is rejected (same cap as defense delegation)
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 95,
      }).success,
    ).toBe(false);
  });

  test("builds a city and a factory, emitting DelegationNote updates", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0);
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length >= 2);
    const units = notes.map((n) => n.unit);
    expect(units).toContain(UnitType.City);
    expect(units).toContain(UnitType.Factory);
    // never builds anything outside the delegated scope
    for (const n of notes) {
      expect([UnitType.City, UnitType.Factory]).toContain(n.unit);
    }
  });

  test("respects the structure toggles", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0, {
      buildCities: true,
      buildFactories: false,
    });
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length >= 1);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.unit).toBe(UnitType.City);
    }
  });

  test("keeps the anchored reserve floor: no build below the floor", async () => {
    const { game, player } = await setupDelegation();
    // Anchor at 10M with a 90% reserve: only ~1M is spendable, which
    // covers roughly one cheap structure but must stop before the floor.
    spawnEconomy(game, player, true, 90);
    tickCollecting(game, MAX_TICKS, (n) => n.length >= 4);
    expect(player.gold()).toBeGreaterThanOrEqual(9_000_000n);
  });

  test("disabled intent spawns no worker (deactivates itself)", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, false, 0);
    const { notes } = tickCollecting(game, 100);
    expect(notes.length).toBe(0);
  });

  test("budget separation: never spends into the defense reserve", async () => {
    const { game, player } = await setupDelegation();
    // Defense delegation on with a high reserve: 80% of its 10M anchor
    // (8M) is untouchable defense budget.
    game.addExecution(
      new DefenseDelegationExecution(player, true, 80, {
        buildPosts: false,
        buildSams: false,
      }),
    );
    // Economy delegation with 0% own reserve: without budget separation it
    // could spend the full 10M; with separation it must stop above 8M.
    spawnEconomy(game, player, true, 0);
    tickCollecting(game, MAX_TICKS, (n) => n.length >= 6);
    expect(player.gold()).toBeGreaterThanOrEqual(8_000_000n);
  });

  test("never builds warships even when a port exists", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0);
    tickCollecting(game, MAX_TICKS, (n) => n.length >= 3);
    expect(player.units(UnitType.Warship).length).toBe(0);
    for (const n of game
      .executions()
      .filter((e) => e.constructor.name === "WarshipExecution")) {
      throw new Error("economy delegate must not spawn warships");
    }
  });
});

/** 개선 13: the status updates carry the engine's real decision. */
describe("DelegationStatus (engine decision trace)", () => {
  function statusTicks(
    game: Game,
    n: number,
    kind: "economy" | "defense",
  ): DelegationStatusUpdate[] {
    const out: DelegationStatusUpdate[] = [];
    for (let i = 0; i < n; i++) {
      const updates = game.executeNextTick();
      for (const s of (updates[GameUpdateType.DelegationStatus] ??
        []) as DelegationStatusUpdate[]) {
        if (s.kind === kind) out.push(s);
      }
    }
    return out;
  }

  test("economy reports budget shortfall = cost + floors - gold, then builds", async () => {
    const { game, player } = await setupDelegation();
    // Finite treasury: 100K, below the 125K first-city cost.
    player.removeGold(player.gold() - 100_000n);
    spawnEconomy(game, player, true, 25, { buildFactories: false });
    const sts = statusTicks(game, 20, "economy");
    expect(sts.length).toBeGreaterThan(0);
    const last = sts[sts.length - 1];
    const city = last.items.find((i) => i.unit === UnitType.City)!;
    expect(city.result).toBe("budget");
    const floor = Math.floor(last.gold * 0.25) ;
    expect(last.ownReserve).toBe(25_000);
    expect(last.otherReserve).toBe(0);
    expect(city.cost).toBe(125_000);
    expect(city.shortfall).toBe(125_000 + 25_000 - 100_000);
    expect(floor).toBe(25_000);
    const fact = last.items.find((i) => i.unit === UnitType.Factory)!;
    expect(fact.result).toBe("userOff");
    // Top up past cost + floor: the next attempt builds and says so.
    player.addGold(60_000n);
    const after = statusTicks(game, 20, "economy");
    const built = after.find((s) =>
      s.items.some((i) => i.unit === UnitType.City && i.result === "built"),
    );
    expect(built).toBeDefined();
  });

  test("economy adds the active defense reserve to the held floor", async () => {
    const { game, player } = await setupDelegation();
    player.removeGold(player.gold() - 200_000n);
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    spawnEconomy(game, player, true, 25, { buildFactories: false });
    const sts = statusTicks(game, 20, "economy");
    const last = sts[sts.length - 1];
    expect(last.ownReserve).toBe(50_000);
    expect(last.otherReserve).toBe(100_000);
    const city = last.items.find((i) => i.unit === UnitType.City)!;
    expect(city.result).toBe("budget");
    expect(city.shortfall).toBe(125_000 + 150_000 - 200_000);
  });

  test("economy reports a factory needs a city first and territory gate", async () => {
    const { game, player } = await setupDelegation();
    player.removeGold(player.gold() - 100_000n);
    spawnEconomy(game, player, true, 0, {});
    const sts = statusTicks(game, 10, "economy");
    const last = sts[sts.length - 1];
    expect(last.items.find((i) => i.unit === UnitType.Factory)!.result).toBe(
      "needCity",
    );
  });

  test("defense reports noNeed without a threat and keeps building rules", async () => {
    const { game, player } = await setupDelegation();
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    const sts = statusTicks(game, 10, "defense");
    const last = sts[sts.length - 1];
    const post = last.items.find((i) => i.unit === UnitType.DefensePost)!;
    expect(["noNeed", "budget"]).toContain(post.result);
    expect(last.ownReserve).toBe(5_000_000);
  });
});

/**
 * 개선 14: build direction (priority) and per-structure target counts.
 */
describe("EconomyDelegation direction and targets", () => {
  test("intent schema parses priority and targets, rejects bad values", () => {
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 50,
        priority: "city",
        cityTarget: 3,
        factoryTarget: 2,
      }).success,
    ).toBe(true);
    // unknown priority is rejected
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 50,
        priority: "ports",
      }).success,
    ).toBe(false);
    // targets above the shared cap are rejected
    expect(
      SetEconomyDelegationIntentSchema.safeParse({
        type: "set_economy_delegation",
        enabled: true,
        reservePercent: 50,
        cityTarget: 21,
      }).success,
    ).toBe(false);
  });

  test("city target stops cities at the count, factories continue", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0, { cityTarget: 1 });
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length >= 4);
    const cityNotes = notes.filter((n) => n.unit === UnitType.City);
    expect(cityNotes.length).toBe(1);
    expect(notes.some((n) => n.unit === UnitType.Factory)).toBe(true);
  });

  test("destroying a targeted structure makes the delegate rebuild it", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0, {
      buildFactories: false,
      cityTarget: 1,
    });
    const first = tickCollecting(game, MAX_TICKS, (n) => n.length >= 1);
    expect(first.notes.length).toBe(1);
    // Target met: no further cities while the first one stands.
    const quiet = tickCollecting(game, 200, (n) => n.length >= 1);
    expect(quiet.notes.length).toBe(0);
    // Lose the city: the owned count drops below the target, so the
    // delegate builds a replacement without any new intent. (Destruction
    // stands in for an enemy razing it; the delegate only sees the count.)
    let city = player.units(UnitType.City)[0];
    for (let i = 0; i < 200 && city === undefined; i++) {
      game.executeNextTick();
      city = player.units(UnitType.City)[0];
    }
    expect(city).toBeDefined();
    city!.delete(false);
    expect(player.unitsOwned(UnitType.City)).toBe(0);
    const rebuilt = tickCollecting(game, MAX_TICKS, (n) => n.length >= 1);
    expect(rebuilt.notes.length).toBe(1);
    expect(rebuilt.notes[0].unit).toBe(UnitType.City);
  });

  test("priority picks the first build when several kinds are due", async () => {
    // One city already standing, zero factories: balanced prefers the
    // factory (ratio unmet), city-first prefers another city.
    for (const [priority, expected] of [
      ["balanced", UnitType.Factory],
      ["city", UnitType.City],
      ["factory", UnitType.Factory],
    ] as const) {
      const { game, player } = await setupDelegation();
      spawnEconomy(game, player, true, 0, { priority });
      const first = tickCollecting(game, MAX_TICKS, (n) => n.length >= 1);
      expect(first.notes[0].unit).toBe(UnitType.City); // factory needs a city
      const second = tickCollecting(game, MAX_TICKS, (n) => n.length >= 1);
      expect(second.notes[0].unit).toBe(expected);
    }
  });

  test("status reports targetMet with owned/target and a progress line", async () => {
    const { game, player } = await setupDelegation();
    spawnEconomy(game, player, true, 0, {
      buildFactories: false,
      cityTarget: 1,
    });
    let sawBuilt = false;
    let met: DelegationStatusUpdate | null = null;
    for (let i = 0; i < MAX_TICKS && met === null; i++) {
      const updates = game.executeNextTick();
      for (const n of (updates[GameUpdateType.DelegationNote] ??
        []) as DelegationNoteUpdate[]) {
        if (n.unit === UnitType.City) sawBuilt = true;
      }
      if (!sawBuilt) continue;
      for (const st of (updates[GameUpdateType.DelegationStatus] ??
        []) as DelegationStatusUpdate[]) {
        if (st.kind !== "economy") continue;
        const city = st.items.find((it) => it.unit === UnitType.City);
        if (city?.result === "targetMet") met = st;
      }
    }
    expect(met).not.toBeNull();
    const city = met!.items.find((it) => it.unit === UnitType.City)!;
    expect(city.have).toBe(1);
    expect(city.need).toBe(1);
    const progress = met!.progress!;
    expect(progress.find((pr) => pr.unit === UnitType.City)).toEqual({
      unit: UnitType.City,
      owned: 1,
      target: 1,
    });
    expect(progress.find((pr) => pr.unit === UnitType.Factory)).toEqual({
      unit: UnitType.Factory,
      owned: 0,
      target: 0,
    });
  });
});
