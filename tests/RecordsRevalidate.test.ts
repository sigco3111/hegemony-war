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

describe("revalidateChallenges on load", () => {
  beforeEach(() => store.clear());

  it("revokes scenario clears whose records fail the current gate, keeps achievements", () => {
    store.set(
      "hegemony.records.v1",
      JSON.stringify({
        version: 1,
        games: [trickBlitzWin, legitSurroundedWin],
        wins: {},
        challenges: ["blitz", "surrounded_breakout", "pacifist"],
      }),
    );
    const data = loadRecords();
    // blitz: only a trick win on record -> revoked.
    // pacifist: no satisfying record at all -> revoked.
    // surrounded_breakout: achievement-type, record stands -> kept.
    expect(data.challenges).toEqual(["surrounded_breakout"]);
    // Persisted, not just in memory.
    const saved = JSON.parse(store.get("hegemony.records.v1")!);
    expect(saved.challenges).toEqual(["surrounded_breakout"]);
    // Games history untouched.
    expect(saved.games).toHaveLength(2);
  });

  it("keeps a scenario clear backed by a real-config win", () => {
    store.set(
      "hegemony.records.v1",
      JSON.stringify({
        version: 1,
        games: [realBlitzWin],
        wins: {},
        challenges: ["blitz"],
      }),
    );
    expect(loadRecords().challenges).toEqual(["blitz"]);
  });

  it("recomputes grand_hegemon from the kept set", () => {
    store.set(
      "hegemony.records.v1",
      JSON.stringify({
        version: 1,
        games: [trickBlitzWin],
        wins: {},
        challenges: ["blitz", "grand_hegemon"],
      }),
    );
    const data = loadRecords();
    expect(data.challenges).not.toContain("grand_hegemon");
  });
});
