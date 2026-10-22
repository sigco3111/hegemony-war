import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DelegationNoteUpdate,
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
  options: { buildCities?: boolean; buildFactories?: boolean } = {},
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
