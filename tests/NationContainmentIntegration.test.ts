import {
  Difficulty,
  GameMode,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AllianceRequestReplyUpdate,
  BrokeAllianceUpdate,
  DiplomacyNoteUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * 개선4 integration evidence: unlike NationContainment.test.ts (which drives
 * NationAllianceBehavior directly), these tests let the engine's own
 * NationExecution - the same class ExecutionManager spawns in deployed
 * games - run the per-tick loop via game.executeNextTick(). They assert
 * both engine state (alliances formed/broken) and the exact GameUpdates
 * (AllianceRequestReply accepted / BrokeAlliance) that the client's war
 * chronicle renders.
 *
 * Stripe layout: helper | nationA | leader | nationB | runnerUp.
 * The two nations never share a border (the leader stripe lies between),
 * so any alliance between them must come from the new cross-border
 * coalition outreach, not the old bordering-only logic.
 */
const WIDTHS: [number, number, number, number, number] = [10, 20, 130, 20, 20];
const MAX_TICKS = 1500;

interface Ctx {
  game: Game;
  helper: Player;
  nationA: Player;
  leader: Player;
  nationB: Player;
  runnerUp: Player;
}

async function setupIntegration(
  widths: [number, number, number, number, number] = WIDTHS,
  leaderTroops = 200_000,
): Promise<Ctx> {
  const game = await setup(
    "big_plains",
    { difficulty: Difficulty.Impossible, gameMode: GameMode.FFA },
    [
      new PlayerInfo("helper", PlayerType.Human, null, "helper_id"),
      new PlayerInfo("nationA", PlayerType.Nation, null, "nation_a_id"),
      new PlayerInfo("leader", PlayerType.Human, null, "leader_id"),
      new PlayerInfo("nationB", PlayerType.Nation, null, "nation_b_id"),
      new PlayerInfo("runnerUp", PlayerType.Human, null, "runner_up_id"),
    ],
  );
  const [helper, nationA, leader, nationB, runnerUp] = [
    "helper_id",
    "nation_a_id",
    "leader_id",
    "nation_b_id",
    "runner_up_id",
  ].map((id) => game.player(id));

  const owners = [helper, nationA, leader, nationB, runnerUp];
  for (let x = 0; x < game.map().width(); x++) {
    let stripe = 0;
    let edge = widths[0];
    while (x >= edge && stripe < widths.length - 1) edge += widths[++stripe];
    for (let y = 0; y < game.map().height(); y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) owners[stripe].conquer(tile);
    }
  }

  leader.addTroops(leaderTroops);
  nationA.addTroops(10_000);
  nationB.addTroops(10_000);
  helper.addTroops(5_000);
  runnerUp.addTroops(5_000);

  // The exact wiring ExecutionManager uses for real nations.
  game.addExecution(new NationExecution("game_id", new Nation(undefined, nationA.info())));
  game.addExecution(new NationExecution("game_id", new Nation(undefined, nationB.info())));

  return { game, helper, nationA, leader, nationB, runnerUp };
}

interface TickLog {
  acceptedReplies: AllianceRequestReplyUpdate[];
  brokeAlliances: BrokeAllianceUpdate[];
  diplomacyNotes: DiplomacyNoteUpdate[];
}

function tickUntil(game: Game, stop: () => boolean): TickLog {
  const log: TickLog = {
    acceptedReplies: [],
    brokeAlliances: [],
    diplomacyNotes: [],
  };
  for (let i = 0; i < MAX_TICKS && !stop(); i++) {
    const updates = game.executeNextTick();
    for (const r of (updates[GameUpdateType.AllianceRequestReply] ??
      []) as AllianceRequestReplyUpdate[]) {
      if (r.accepted) log.acceptedReplies.push(r);
    }
    for (const b of (updates[GameUpdateType.BrokeAlliance] ??
      []) as BrokeAllianceUpdate[]) {
      log.brokeAlliances.push(b);
    }
    for (const n of (updates[GameUpdateType.DiplomacyNote] ??
      []) as DiplomacyNoteUpdate[]) {
      log.diplomacyNotes.push(n);
    }
  }
  return log;
}

function involvesBoth(update: {
  request: { requestorID: number; recipientID: number };
}, a: Player, b: Player): boolean {
  const ids = [update.request.requestorID, update.request.recipientID];
  return ids.includes(a.smallID()) && ids.includes(b.smallID());
}

describe("containment integration (engine tick loop, deployed wiring)", () => {
  it("nations form a cross-border coalition against a runaway leader", async () => {
    const { game, nationA, leader, nationB } = await setupIntegration();
    expect(nationA.sharesBorderWith(nationB)).toBe(false); // leader between

    const log = tickUntil(game, () => nationA.isAlliedWith(nationB));

    // Engine state: the coalition actually formed.
    expect(nationA.isAlliedWith(nationB)).toBe(true);
    // Chronicle feed: an accepted AllianceRequestReply between the two
    // nations was emitted - the update WarDashboard renders as "동맹".
    expect(
      log.acceptedReplies.some((r) => involvesBoth(r, nationA, nationB)),
    ).toBe(true);
    // Nobody allied with the hegemon in the process.
    expect(nationA.isAlliedWith(leader)).toBe(false);
    expect(nationB.isAlliedWith(leader)).toBe(false);

    // 개선5 chronicle feed: the acceptor emitted a factual containment note
    // naming the runaway leader as the threat.
    const nationIDs = [nationA.smallID(), nationB.smallID()];
    expect(
      log.diplomacyNotes.some(
        (n) =>
          n.reason === "accept_containment" &&
          nationIDs.includes(n.actorID) &&
          nationIDs.includes(n.targetID) &&
          n.threatID === leader.smallID(),
      ),
    ).toBe(true);
  });

  it("a nation allied with the runaway leader breaks it (betrayal)", async () => {
    const { game, nationA, leader } = await setupIntegration();
    // Forge the nation-leader alliance through real executions.
    game.addExecution(new AllianceRequestExecution(nationA, leader.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(leader, nationA.id()));
    game.executeNextTick();
    expect(nationA.isAlliedWith(leader)).toBe(true);

    const log = tickUntil(game, () => !nationA.isAlliedWith(leader));

    expect(nationA.isAlliedWith(leader)).toBe(false);
    // Chronicle feed: BrokeAlliance with the nation as traitor.
    expect(
      log.brokeAlliances.some(
        (b) =>
          b.traitorID === nationA.smallID() &&
          b.betrayedID === leader.smallID(),
      ),
    ).toBe(true);
    // 개선5 chronicle feed: a hegemon-break note names both the leader as
    // target and as the contained threat.
    expect(
      log.diplomacyNotes.some(
        (n) =>
          n.reason === "break_hegemon" &&
          n.actorID === nationA.smallID() &&
          n.targetID === leader.smallID() &&
          n.threatID === leader.smallID(),
      ),
    ).toBe(true);
  });

  it("sends no cross-border coalition when no leader runs away", async () => {
    // Equal stripes: no runaway leader possible.
    const { game, nationA, nationB } = await setupIntegration(
      [40, 40, 40, 40, 40],
      10_000,
    );
    expect(nationA.sharesBorderWith(nationB)).toBe(false);

    const log = tickUntil(game, () => nationA.isAlliedWith(nationB));

    expect(nationA.isAlliedWith(nationB)).toBe(false);
    expect(
      log.acceptedReplies.some((r) => involvesBoth(r, nationA, nationB)),
    ).toBe(false);
    // No runaway leader: no containment notes either.
    expect(
      log.diplomacyNotes.some((n) => n.reason === "accept_containment"),
    ).toBe(false);
  });
});
