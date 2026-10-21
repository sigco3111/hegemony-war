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

  it("never spends below the reserve floor anchored at switch-on", async () => {
    const { game, player, enemy } = await setupDelegation();
    // Gold exactly equal to the post cost: anchored 50% reserve means the
    // floor is cost/2 and building would leave 0 below it, so hold.
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    player.addGold(cost - player.gold());
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));

    const { notes } = tickCollecting(game, 120);
    expect(notes).toHaveLength(0);
    expect(player.units(UnitType.DefensePost)).toHaveLength(0);
  });

  it("anchor is fixed at switch-on: consecutive builds stop at the original floor, not a ratcheting one", async () => {
    const { game, player, enemy } = await setupDelegation();
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    // Anchor at 4x cost, 50% reserve → floor 2x cost. With a current-balance
    // percentage the floor would ratchet down (4c→3c→2.5c→…) allowing ~2 more
    // builds; with the anchor, spending must stop at 2 builds (8c→6c→4c… no:
    // 4c anchor, floor 2c: build1 leaves 3c ≥ 2c ok; build2 would leave 2c-c…
    // build1: 4c-c=3c ≥ 2c ok; build2: 3c-c=2c ≥ 2c ok; build3: 2c-c=c < 2c stop).
    player.addGold(4n * cost - player.gold());
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    // Keep the threat alive so the delegate keeps wanting posts.
    for (let i = 0; i < MAX_TICKS; i++) {
      if (i % 40 === 0) {
        game.addExecution(new AttackExecution(40_000, enemy, player.id()));
      }
      game.executeNextTick();
    }
    expect(player.gold()).toBeGreaterThanOrEqual(2n * cost);
  });

  it("holds when manual spending dropped the balance below the floor, resumes after income", async () => {
    const { game, player, enemy } = await setupDelegation();
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    player.addGold(4n * cost - player.gold()); // anchor 4c, floor 2c
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    // Simulate a big manual spend (e.g. the player launched something).
    player.removeGold(3n * cost); // balance now 1c < floor 2c
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));
    expect(tickCollecting(game, 100).notes).toHaveLength(0);

    // Income lifts the balance above floor + cost: building resumes.
    player.addGold(3n * cost); // balance 4c
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length > 0);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("re-anchors on off→on but keeps the anchor across a percent change while on", async () => {
    const { game, player, enemy } = await setupDelegation();
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    player.addGold(10n * cost - player.gold());
    game.addExecution(new DefenseDelegationExecution(player, true, 50));

    // Percent change while on: new execution replaces the old one but must
    // keep the 10c anchor → 90% reserve floor is 9c, so with balance 10c a
    // 1c build holds (10c-c=9c ≥ 9c ok, barely). Then drop balance below.
    game.addExecution(new DefenseDelegationExecution(player, true, 90));
    player.removeGold(cost); // balance 9c: 9c-c=8c < 9c floor → hold
    game.addExecution(new AttackExecution(50_000, enemy, player.id()));
    expect(tickCollecting(game, 100).notes).toHaveLength(0);

    // Off→on re-anchors to the current 9c: 90% floor is now 8.1c, so
    // 9c-c=8c < 8.1c still holds; use 10% instead → floor 0.9c, builds.
    game.addExecution(new DefenseDelegationExecution(player, false, 90));
    game.executeNextTick();
    game.addExecution(new DefenseDelegationExecution(player, true, 10));
    const { notes } = tickCollecting(game, MAX_TICKS, (n) => n.length > 0);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("respects the anchored floor as construction costs rise", async () => {
    const { game, player, enemy } = await setupDelegation();
    const cost = game.unitInfo(UnitType.DefensePost).cost(game, player);
    // Anchor 4c with 50% floor 2c. After two builds the balance is 2c; even
    // if a later quote came back cheaper the delegate must not dip under 2c.
    player.addGold(4n * cost - player.gold());
    game.addExecution(new DefenseDelegationExecution(player, true, 50));
    let minGold = player.gold();
    for (let i = 0; i < MAX_TICKS; i++) {
      if (i % 40 === 0) {
        game.addExecution(new AttackExecution(40_000, enemy, player.id()));
      }
      game.executeNextTick();
      if (player.gold() < minGold) minGold = player.gold();
    }
    expect(minGold).toBeGreaterThanOrEqual(2n * cost);
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
