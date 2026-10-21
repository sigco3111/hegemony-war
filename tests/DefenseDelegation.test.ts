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
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { DefenseDelegationExecution } from "@openfront/engine/execution/DefenseDelegationExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * 개선6 rear-defense delegation integration evidence: these tests drive the
 * engine tick loop (game.executeNextTick) with the same execution classes the
 * deployed intent wiring spawns, and assert both engine state (a defense
 * post / SAM appears) and the DelegationNote updates the client delegation
 * panel renders as its action history.
 *
 * Layout: player stripe | enemy stripe on big_plains.
 */
const MAX_TICKS = 400;

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

describe("DefenseDelegation (engine tick loop, deployed wiring)", () => {
  it("builds a reactive defense post behind an active attack front and emits a DelegationNote", async () => {
    const { game, player, enemy } = await setupDelegation();
    game.addExecution(new DefenseDelegationExecution(player, true, 0));
    // 50k vs the fixture's 125k defenders: ratio 0.4 >= 0.35 triggers.
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));

    // Keep ticking past the note: construction itself takes ticks.
    const { notes } = tickCollecting(game, MAX_TICKS);

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].unit).toBe(UnitType.DefensePost);
    expect(notes[0].cost).toBeGreaterThan(0);
    expect(player.units(UnitType.DefensePost).length).toBeGreaterThan(0);
  });

  it("paces builds: no second delegated build within the 50-tick gap", async () => {
    const { game, player, enemy } = await setupDelegation();
    game.addExecution(new DefenseDelegationExecution(player, true, 0));

    // Keep the threat alive so the delegate keeps wanting posts; every
    // consecutive pair of builds must still respect the 50-tick gap.
    const notes: DelegationNoteUpdate[] = [];
    const ticks: number[] = [];
    for (let i = 0; i < MAX_TICKS; i++) {
      if (i % 40 === 0) {
        game.addExecution(new AttackExecution(40_000, enemy, player.id()));
      }
      const updates = game.executeNextTick();
      for (const n of (updates[GameUpdateType.DelegationNote] ??
        []) as DelegationNoteUpdate[]) {
        notes.push(n);
        ticks.push(game.ticks());
      }
    }
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(50);
    }
  });

  it("never spends below the configured reserve share of the treasury", async () => {
    const { game, player, enemy } = await setupDelegation();
    // Gold exactly equal to the post cost: with a 50% reserve, building
    // would leave 0 < 50% of the treasury, so the delegate must hold.
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    player.addGold(cost - player.gold());
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));

    const { notes } = tickCollecting(game, 120);
    expect(notes).toHaveLength(0);
    expect(player.units(UnitType.DefensePost)).toHaveLength(0);
  });

  it("stays idle while disabled, and the control intent creates and updates the worker", async () => {
    const { game, player, enemy } = await setupDelegation();
    // Disabled control creates no worker and builds nothing.
    game.addExecution(new DefenseDelegationExecution(player, false, 0));
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));
    expect(tickCollecting(game, 120).notes).toHaveLength(0);

    // Enabling later reuses/creates the worker and starts building.
    game.addExecution(new DefenseDelegationExecution(player, true, 0));
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length > 0);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("builds nothing without threats", async () => {
    const { game, player } = await setupDelegation();
    game.addExecution(new DefenseDelegationExecution(player, true, 0));
    const { notes } = tickCollecting(game, 150);
    expect(notes).toHaveLength(0);
  });

  it("covers unprotected structures with one SAM launcher per city cap", async () => {
    const { game, player } = await setupDelegation();
    // Two cities, no SAM cover, nukes live in this game's config.
    const half = Math.floor(game.map().width() / 2);
    player.buildUnit(UnitType.City, game.ref(half - 20, 100), {});
    player.buildUnit(UnitType.City, game.ref(half - 40, 100), {});
    game.addExecution(new DefenseDelegationExecution(player, true, 0));

    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length > 0);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].unit).toBe(UnitType.SAMLauncher);

    // Cap is ceil(2 cities * 0.25) = 1: no second SAM afterwards.
    const more = tickCollecting(game, MAX_TICKS);
    const sams = more.notes.filter((n) => n.unit === UnitType.SAMLauncher);
    expect(sams).toHaveLength(0);
  });
});
