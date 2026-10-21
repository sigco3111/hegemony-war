import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { findRunawayLeader } from "@openfront/engine/execution/nation/NationUtils";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * 개선4 opportunistic betrayal (the branch added by this fork, distinct from
 * upstream's juiciest-ally betrayal and from 개선4's containment betrayal in
 * maybeContainmentDiplomacy): an ally being dogpiled - incoming attack
 * troops exceed the ally's own troops - is a meal, not a friend. Hard and
 * Impossible only, and only when the nation itself is stronger.
 *
 * Block layout on big_plains: the ally touches the nation (west), dogA
 * (east) and dogB (south), so both attackers can send real land attacks.
 * juiciestAlly is null and the bordering lists hold three entries, so the
 * upstream betrayal branches cannot fire - only the opportunistic branch
 * can return true.
 */
interface Ctx {
  game: Game;
  nation: Player;
  ally: Player;
  dogA: Player;
  dogB: Player;
  behavior: NationAllianceBehavior;
}

async function setupDogpile(
  difficulty: Difficulty,
  nationTroops = 50_000,
): Promise<Ctx> {
  const game = await setup("big_plains", {
    difficulty,
    gameMode: GameMode.FFA,
  });
  const [nation, ally, dogA, dogB] = [
    new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    new PlayerInfo("ally", PlayerType.Human, null, "ally_id"),
    new PlayerInfo("dogA", PlayerType.Human, null, "dog_a_id"),
    new PlayerInfo("dogB", PlayerType.Human, null, "dog_b_id"),
  ].map((info) => game.addPlayer(info));

  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 40; y++) {
      const tile = game.ref(x, y);
      if (!game.map().isLand(tile)) continue;
      if (x < 10) nation.conquer(tile);
      else if (x < 20) {
        if (y >= 10 && y < 30) ally.conquer(tile);
        else if (y >= 30) dogB.conquer(tile);
      } else dogA.conquer(tile);
    }
  }
  // Tiles grant base troops every tick (~+25k by the time the dogpile
  // lands), so the ally reads ~55k and the nation ~75k at the call.
  nation.addTroops(nationTroops);
  ally.addTroops(30_000);
  dogA.addTroops(100_000);
  dogB.addTroops(100_000);

  // Forge the nation-ally alliance through real executions.
  game.addExecution(new AllianceRequestExecution(nation, ally.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(ally, nation.id()));
  game.executeNextTick();
  if (!nation.isAlliedWith(ally)) throw new Error("alliance setup failed");

  const random = new PseudoRandom(42);
  const behavior = new NationAllianceBehavior(
    random,
    game,
    nation,
    new NationEmojiBehavior(random, game, nation),
  );
  return { game, nation, ally, dogA, dogB, behavior };
}

function dogpile(ctx: Ctx, troopsEach: number) {
  ctx.game.addExecution(new AttackExecution(troopsEach, ctx.dogA, ctx.ally.id()));
  ctx.game.addExecution(new AttackExecution(troopsEach, ctx.dogB, ctx.ally.id()));
  ctx.game.executeNextTick();
}

// Only the opportunistic branch can answer true with these arguments.
function callMaybeBetray(ctx: Ctx): boolean {
  return ctx.behavior.maybeBetray(
    ctx.ally,
    null, // juiciestAlly: disables the upstream juiciest-ally branch
    [ctx.ally], // borderingFriends
    [ctx.dogA, ctx.dogB], // borderingEnemies: 3 total borders, not 1
  );
}

describe("opportunistic betrayal (trigger: ally dogpiled, nation stronger)", () => {
  it("betrays the dogpiled ally on Hard", async () => {
    const ctx = await setupDogpile(Difficulty.Hard);
    expect(findRunawayLeader(ctx.game)).toBeNull(); // no containment trigger
    dogpile(ctx, 40_000); // 80k incoming > ~55k ally troops

    expect(callMaybeBetray(ctx)).toBe(true);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(false); // actually broken
  });

  it("betrays the dogpiled ally on Impossible", async () => {
    const ctx = await setupDogpile(Difficulty.Impossible);
    expect(findRunawayLeader(ctx.game)).toBeNull();
    dogpile(ctx, 40_000);

    expect(callMaybeBetray(ctx)).toBe(true);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(false);
  });

  it("keeps the alliance when the dogpile is weaker than the ally", async () => {
    const ctx = await setupDogpile(Difficulty.Hard);
    dogpile(ctx, 5_000); // 10k incoming < ~55k ally troops

    expect(callMaybeBetray(ctx)).toBe(false);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(true);
  });

  it("keeps the alliance when the nation itself is weaker", async () => {
    const ctx = await setupDogpile(Difficulty.Hard, 10_000); // nation ~35k < ally ~55k
    dogpile(ctx, 40_000);

    expect(callMaybeBetray(ctx)).toBe(false);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(true);
  });

  it("does not organize on Easy even under a full dogpile", async () => {
    const ctx = await setupDogpile(Difficulty.Easy);
    dogpile(ctx, 40_000);

    expect(callMaybeBetray(ctx)).toBe(false);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(true);
  });

  it("does not organize on Medium even under a full dogpile", async () => {
    const ctx = await setupDogpile(Difficulty.Medium);
    dogpile(ctx, 40_000);

    expect(callMaybeBetray(ctx)).toBe(false);
    expect(ctx.nation.isAlliedWith(ctx.ally)).toBe(true);
  });
});
