import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
  Tick,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { findRunawayLeader } from "@openfront/engine/execution/nation/NationUtils";
import { AllianceRequest, Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * 개선4 (AI 외교 심화) containment behavior: when a runaway leader dominates,
 * nations rally a coalition (accept + send cross-border alliance requests)
 * and abandon alliances with the hegemon. Each test pins the trigger
 * condition (leader tiles/troops) and asserts the behavior change.
 *
 * Stripe layout like NationRunawayLeader: helper | leader | nation | runnerUp.
 */
async function setupContainment(
  widths: [number, number, number, number] = [10, 140, 20, 30],
  difficulty: Difficulty = Difficulty.Impossible,
) {
  const game = await setup("big_plains", { difficulty, gameMode: GameMode.FFA }, [
    new PlayerInfo("helper", PlayerType.Human, null, "helper_id"),
    new PlayerInfo("leader", PlayerType.Human, null, "leader_id"),
    new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    new PlayerInfo("runnerUp", PlayerType.Human, null, "runner_up_id"),
  ]);
  const [helper, leader, nation, runnerUp] = [
    "helper_id",
    "leader_id",
    "nation_id",
    "runner_up_id",
  ].map((id) => game.player(id));

  for (let x = 0; x < game.map().width(); x++) {
    let stripe = 0;
    let edge = widths[0];
    while (x >= edge && stripe < widths.length - 1) edge += widths[++stripe];
    for (let y = 0; y < game.map().height(); y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) {
        [helper, leader, nation, runnerUp][stripe].conquer(tile);
      }
    }
  }

  // Leader clearly out-guns everyone (containment needs >2x troops).
  leader.addTroops(100_000);
  nation.addTroops(10_000);
  runnerUp.addTroops(5_000);
  helper.addTroops(5_000);

  const random = new PseudoRandom(42);
  const emojiBehavior = new NationEmojiBehavior(random, game, nation);
  const allianceBehavior = new NationAllianceBehavior(
    random,
    game,
    nation,
    emojiBehavior,
  );

  return { game, helper, leader, nation, runnerUp, random, allianceBehavior };
}

function mockRequest(game: Game, requestor: Player, recipient: Player) {
  const request = {
    requestor: () => requestor,
    recipient: () => recipient,
    createdAt: () =>
      (game.config().numSpawnPhaseTurns() + 2) as unknown as Tick,
    accept: vi.fn(),
    reject: vi.fn(),
  } as unknown as AllianceRequest;
  vi.spyOn(recipient, "incomingAllianceRequests").mockReturnValue([request]);
  return request;
}

describe("containment acceptance (trigger: runaway leader out-guns both)", () => {
  it("accepts a coalition partner it would otherwise reject", async () => {
    const { game, leader, nation, runnerUp, allianceBehavior } =
      await setupContainment();
    expect(findRunawayLeader(game)).toBe(leader); // trigger pinned

    // runnerUp is far weaker than the nation: normal logic rejects.
    const request = mockRequest(game, runnerUp, nation);
    allianceBehavior.handleAllianceRequests();
    expect(request.accept).toHaveBeenCalled();
    expect(request.reject).not.toHaveBeenCalled();
  });

  it("rejects the same weak requestor when no leader runs away", async () => {
    // Narrow leader stripe: no runaway leader.
    const { game, nation, runnerUp, random, allianceBehavior } =
      await setupContainment([50, 50, 60, 40]);
    // Tiles grant base troops, so out-power the requestor decisively:
    // otherwise the normal similarly-strong rule would accept it anyway.
    nation.addTroops(100_000);
    expect(findRunawayLeader(game)).toBeNull(); // trigger absent

    // Deterministic neutral decisions (no earlygame luck, strict thresholds).
    vi.spyOn(random, "nextInt").mockReturnValue(50);

    const request = mockRequest(game, runnerUp, nation);
    allianceBehavior.handleAllianceRequests();
    expect(request.reject).toHaveBeenCalled();
    expect(request.accept).not.toHaveBeenCalled();
  });
});

describe("containment betrayal (trigger: allied with the runaway leader)", () => {
  async function allyWithLeader(ctx: {
    game: Game;
    leader: Player;
    nation: Player;
  }) {
    ctx.game.addExecution(
      new AllianceRequestExecution(ctx.nation, ctx.leader.id()),
    );
    ctx.game.executeNextTick();
    ctx.game.addExecution(
      new AllianceRequestExecution(ctx.leader, ctx.nation.id()),
    );
    ctx.game.executeNextTick();
    expect(ctx.nation.isAlliedWith(ctx.leader)).toBe(true);
  }

  it("breaks the alliance with the dominant leader", async () => {
    const ctx = await setupContainment();
    await allyWithLeader(ctx);
    expect(findRunawayLeader(ctx.game)).toBe(ctx.leader); // trigger pinned

    ctx.allianceBehavior.maybeContainmentDiplomacy();

    expect(ctx.nation.isAlliedWith(ctx.leader)).toBe(false);
  });

  it("keeps the alliance when the ally is not running away", async () => {
    const ctx = await setupContainment([50, 50, 60, 40]); // no runaway
    await allyWithLeader(ctx);
    expect(findRunawayLeader(ctx.game)).toBeNull(); // trigger absent

    ctx.allianceBehavior.maybeContainmentDiplomacy();

    expect(ctx.nation.isAlliedWith(ctx.leader)).toBe(true);
  });
});

describe("coalition outreach (trigger: out-gunned by the leader)", () => {
  it("sends alliance requests beyond its borders", async () => {
    const { game, helper, leader, nation, random, allianceBehavior } =
      await setupContainment();
    expect(findRunawayLeader(game)).toBe(leader);
    // helper does not border the nation (the leader stripe lies between):
    // the old code only ever requested alliances with bordering enemies.
    expect(nation.sharesBorderWith(helper)).toBe(false);

    vi.spyOn(random, "chance").mockReturnValue(true); // skip the 1/20 gate
    const added: unknown[] = [];
    vi.spyOn(game, "addExecution").mockImplementation((e) => {
      added.push(e);
    });

    allianceBehavior.maybeContainmentDiplomacy();

    const requests = added.filter(
      (e): e is AllianceRequestExecution =>
        e instanceof AllianceRequestExecution,
    );
    // helper + runnerUp both qualify; the helper request is cross-border.
    expect(requests.length).toBe(2);
  });

  it("sends nothing when no leader runs away", async () => {
    const { game, random, allianceBehavior } = await setupContainment([
      50, 50, 60, 40,
    ]);
    expect(findRunawayLeader(game)).toBeNull();

    vi.spyOn(random, "chance").mockReturnValue(true);
    const added: unknown[] = [];
    vi.spyOn(game, "addExecution").mockImplementation((e) => {
      added.push(e);
    });

    allianceBehavior.maybeContainmentDiplomacy();

    expect(added).toHaveLength(0);
  });
});
