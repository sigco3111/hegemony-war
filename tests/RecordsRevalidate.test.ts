import { GameMapType, Difficulty, GameMode } from "@openfront/engine-api/game/GameTypes";

// localStorage stub (node env)
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

const { loadRecords } = await import("../src/client/LocalRecords");

const trickBlitzWin = {
  id: "g1",
  endedAt: 1,
  map: GameMapType.World,
  difficulty: Difficulty.Medium,
  gameMode: GameMode.FFA,
  result: "win",
  ticks: 711,
  cheats: false,
  bots: 0,
  nations: 0,
  maxTimerValue: 1,
  disabledUnits: [],
};

const legitSurroundedWin = {
  id: "g2",
  endedAt: 2,
  map: GameMapType.Surrounded,
  difficulty: Difficulty.Hard,
  gameMode: GameMode.FFA,
  result: "win",
  ticks: 631,
  cheats: false,
  bots: 0,
  maxTimerValue: 1,
};

const realBlitzWin = {
  ...trickBlitzWin,
  id: "g3",
  ticks: 5900,
  bots: 400,
  nations: 72,
  maxTimerValue: null,
};

function seed(data: object) {
  store.set("hegemony.records.v1", JSON.stringify({ version: 1, wins: {}, ...data }));
}

describe("scenarioGateV2 one-time migration", () => {
  beforeEach(() => store.clear());

  it("revokes clears with positive evidence of an old-gate grant, keeps achievements", () => {
    seed({
      games: [trickBlitzWin, legitSurroundedWin],
      challenges: ["blitz", "surrounded_breakout", "pacifist"],
    });
    const data = loadRecords();
    // blitz: only a trick win on record (legacy-satisfying, gate-failing) -> revoked.
    // pacifist: no evidence either way -> PRESERVED.
    // surrounded_breakout: achievement-type, never re-examined -> kept.
    expect(data.challenges).toEqual(["surrounded_breakout", "pacifist"]);
    const saved = JSON.parse(store.get("hegemony.records.v1")!);
    expect(saved.games).toHaveLength(2); // history untouched
    expect(saved.migrations.scenarioGateV2).toBe(true);
  });

  it("legitimizes a clear backed by a current-gate win and pins permanent proof", () => {
    seed({ games: [realBlitzWin], challenges: ["blitz"] });
    const data = loadRecords();
    expect(data.challenges).toEqual(["blitz"]);
    expect(data.challengeProofs?.blitz?.id).toBe("g3");
  });

  it("preserves clears with no evidence (record rotated out)", () => {
    seed({ games: [], challenges: ["blitz", "outnumbered"] });
    expect(loadRecords().challenges).toEqual(["blitz", "outnumbered"]);
  });

  it("runs once: later arrivals of trick records revoke nothing", () => {
    seed({ games: [], challenges: ["outnumbered"] });
    loadRecords(); // migration runs, preserves
    // A trick record appears afterwards; migration must not re-run.
    const before = JSON.parse(store.get("hegemony.records.v1")!);
    before.games = [trickBlitzWin];
    store.set("hegemony.records.v1", JSON.stringify(before));
    expect(loadRecords().challenges).toEqual(["outnumbered"]);
  });

  it("proof-backed clears survive 200-game history rotation", () => {
    const rotated = Array.from({ length: 200 }, (_, i) => ({
      ...trickBlitzWin,
      id: `gx${i}`,
    }));
    seed({
      games: rotated,
      challenges: ["blitz"],
      challengeProofs: { blitz: realBlitzWin },
    });
    // The granting record is no longer in games[], but the proof persists.
    expect(loadRecords().challenges).toEqual(["blitz"]);
  });

  it("recomputes grand_hegemon from the kept set", () => {
    seed({ games: [trickBlitzWin], challenges: ["blitz", "grand_hegemon"] });
    const data = loadRecords();
    expect(data.challenges).not.toContain("grand_hegemon");
  });
});
