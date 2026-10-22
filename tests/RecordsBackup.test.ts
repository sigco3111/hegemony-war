import {
  Difficulty,
  GameMapType,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import { CHALLENGES, GRAND_HEGEMON_ID } from "../src/client/Challenges";
import {
  LocalRecordsData,
  MAX_RECORD_GAMES,
  SoloGameRecord,
} from "../src/client/LocalRecords";
import {
  MAX_BACKUP_BYTES,
  medalCount,
  mergeRecords,
  parseBackup,
  planImport,
  sanitizeGameRecord,
  serializeBackup,
} from "../src/client/RecordsBackup";

function game(over: Partial<SoloGameRecord> = {}): SoloGameRecord {
  return {
    id: "g1",
    endedAt: 1000,
    map: GameMapType.World,
    difficulty: Difficulty.Medium,
    gameMode: GameMode.FFA,
    result: "win",
    ticks: 700,
    ...over,
  };
}

function store(over: Partial<LocalRecordsData> = {}): LocalRecordsData {
  return {
    version: 1,
    games: [],
    wins: {},
    challenges: [],
    challengeProofs: {},
    migrations: { scenarioGateV2: true, scenarioGateV3: true },
    ...over,
  };
}

describe("backup round-trip", () => {
  it("serializes and parses back the same store", () => {
    const data = store({
      games: [game(), game({ id: "g2", endedAt: 2000, result: "loss" })],
      wins: { [GameMapType.World]: [Difficulty.Medium] },
      challenges: ["korea_spirit"],
      challengeProofs: { korea_spirit: game() },
    });
    const parsed = parseBackup(serializeBackup(data));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data).toEqual(data);
      expect(typeof parsed.exportedAt).toBe("number");
    }
  });

  it("keeps optional record fields through the round-trip", () => {
    const rec = game({
      cheats: false,
      bots: 400,
      nations: 72,
      maxTimerValue: null,
      disabledUnits: ["AtomBomb"],
    });
    const parsed = parseBackup(serializeBackup(store({ games: [rec] })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.games[0]).toEqual(rec);
  });
});

describe("parseBackup rejection", () => {
  it("rejects non-JSON", () => {
    expect(parseBackup("not json {{{").ok).toBe(false);
    expect(parseBackup("").ok).toBe(false);
  });

  it("rejects oversized text", () => {
    const big = " ".repeat(MAX_BACKUP_BYTES + 1);
    const r = parseBackup(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_large");
  });

  it("rejects a foreign JSON document", () => {
    for (const doc of [{}, { app: "other" }, { app: "hegemony-war" }, []]) {
      const r = parseBackup(JSON.stringify(doc));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("not_backup");
    }
  });

  it("rejects a record with an unknown map", () => {
    const data = store({ games: [game({ map: "Atlantis" as GameMapType })] });
    const r = parseBackup(serializeBackup(data));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_records");
  });

  it("rejects a record with missing or mistyped required fields", () => {
    const bad = [
      { ...game(), id: "" },
      { ...game(), endedAt: "yesterday" },
      { ...game(), result: "draw" },
      { ...game(), ticks: -5 },
      { ...game(), difficulty: "Nightmare" },
      { ...game(), cheats: "yes" },
      { ...game(), disabledUnits: [42] },
    ];
    for (const b of bad) {
      const r = parseBackup(serializeBackup(store({ games: [b as never] })));
      expect(r.ok).toBe(false);
    }
  });

  it("rejects malformed wins and proofs", () => {
    const badWins = store({
      wins: { ["Atlantis" as GameMapType]: ["Easy"] as never },
    });
    expect(parseBackup(serializeBackup(badWins)).ok).toBe(false);
    const badProof = store({
      challengeProofs: { korea_spirit: { nope: 1 } as never },
    });
    expect(parseBackup(serializeBackup(badProof)).ok).toBe(false);
  });

  it("strips unknown extra fields instead of storing them", () => {
    const dirty = {
      ...game(),
      admin: true,
      "__proto__": { polluted: true },
    };
    const parsed = parseBackup(serializeBackup(store({ games: [dirty as never] })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const rec = parsed.data.games[0] as unknown as Record<string, unknown>;
      expect(rec.admin).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(rec, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("keeps unknown challenge ids (backup from a newer build)", () => {
    const data = store({ challenges: ["future_challenge_x"] });
    const parsed = parseBackup(serializeBackup(data));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.challenges).toEqual(["future_challenge_x"]);
    }
  });
});

describe("sanitizeGameRecord", () => {
  it("accepts a minimal record and fills nothing", () => {
    const rec = sanitizeGameRecord(game());
    expect(rec).toEqual(game());
    expect(rec).not.toHaveProperty("cheats");
  });
});

describe("mergeRecords", () => {
  it("unions games by id, newest first, and never removes current games", () => {
    const current = store({ games: [game({ id: "a", endedAt: 100 })] });
    const imported = store({
      games: [
        game({ id: "a", endedAt: 100 }), // duplicate
        game({ id: "b", endedAt: 300 }),
        game({ id: "c", endedAt: 200 }),
      ],
    });
    const merged = mergeRecords(current, imported);
    expect(merged.games.map((g) => g.id)).toEqual(["b", "c", "a"]);
  });

  it("pins existing games: a full history drops only the file's overflow", () => {
    const current = store({
      games: Array.from({ length: MAX_RECORD_GAMES }, (_, i) =>
        game({ id: `cur${i}`, endedAt: 10_000 + i }),
      ),
    });
    const imported = store({
      games: [
        game({ id: "new-newer", endedAt: 20_000 }), // newer than all current
        game({ id: "new-older", endedAt: 5_000 }),
      ],
      wins: { [GameMapType.Europe]: [Difficulty.Easy] },
      challenges: ["korea_spirit"],
      challengeProofs: { korea_spirit: game({ id: "proof-game" }) },
    });
    const merged = mergeRecords(current, imported);
    // Every existing game survives — even though the imported one is newer.
    expect(merged.games).toHaveLength(MAX_RECORD_GAMES);
    expect(merged.games.some((g) => g.id === "cur0")).toBe(true);
    expect(merged.games.some((g) => g.id === "cur199")).toBe(true);
    expect(merged.games.some((g) => g.id === "new-newer")).toBe(false);
    // Medals, challenges and proofs are not capped: all still merge.
    expect(merged.wins[GameMapType.Europe]).toEqual([Difficulty.Easy]);
    expect(merged.challenges).toContain("korea_spirit");
    expect(merged.challengeProofs?.korea_spirit.id).toBe("proof-game");
  });

  it("fills free history slots with the file's newest games first", () => {
    const current = store({
      games: Array.from({ length: MAX_RECORD_GAMES - 2 }, (_, i) =>
        game({ id: `cur${i}`, endedAt: 10_000 + i }),
      ),
    });
    const imported = store({
      games: [
        game({ id: "imp-old", endedAt: 1_000 }),
        game({ id: "imp-new", endedAt: 30_000 }),
        game({ id: "imp-mid", endedAt: 20_000 }),
      ],
    });
    const merged = mergeRecords(current, imported);
    expect(merged.games).toHaveLength(MAX_RECORD_GAMES);
    expect(merged.games.some((g) => g.id === "imp-new")).toBe(true);
    expect(merged.games.some((g) => g.id === "imp-mid")).toBe(true);
    expect(merged.games.some((g) => g.id === "imp-old")).toBe(false);
  });

  it("unions medals and challenges, preferring current proofs", () => {
    const currentProof = game({ id: "mine" });
    const importedProof = game({ id: "theirs" });
    const current = store({
      wins: { [GameMapType.World]: [Difficulty.Medium] },
      challenges: ["korea_spirit"],
      challengeProofs: { korea_spirit: currentProof },
    });
    const imported = store({
      wins: {
        [GameMapType.World]: [Difficulty.Medium, Difficulty.Hard],
        [GameMapType.Europe]: [Difficulty.Easy],
      },
      challenges: ["korea_spirit", "yellowsea_lord"],
      challengeProofs: {
        korea_spirit: importedProof,
        yellowsea_lord: importedProof,
      },
    });
    const merged = mergeRecords(current, imported);
    expect(merged.wins[GameMapType.World]).toEqual([
      Difficulty.Medium,
      Difficulty.Hard,
    ]);
    expect(merged.wins[GameMapType.Europe]).toEqual([Difficulty.Easy]);
    expect(merged.challenges).toEqual(["korea_spirit", "yellowsea_lord"]);
    expect(merged.challengeProofs?.korea_spirit.id).toBe("mine");
    expect(merged.challengeProofs?.yellowsea_lord.id).toBe("theirs");
  });

  it("grants the meta challenge when the union completes the set", () => {
    const ids = CHALLENGES.map((c) => c.id).filter(
      (id) => id !== GRAND_HEGEMON_ID,
    );
    const half = Math.ceil(ids.length / 2);
    const current = store({ challenges: ids.slice(0, half) });
    const imported = store({ challenges: ids.slice(half) });
    const merged = mergeRecords(current, imported);
    expect(merged.challenges).toContain(GRAND_HEGEMON_ID);
  });

  it("ORs migration flags so an old backup cannot re-run a migration", () => {
    const current = store({
      migrations: { scenarioGateV2: true, scenarioGateV3: true },
    });
    const imported = store({ migrations: {} });
    const merged = mergeRecords(current, imported);
    expect(merged.migrations?.scenarioGateV3).toBe(true);
  });

  it("importing into an empty store keeps imported data intact", () => {
    const imported = store({
      games: [game()],
      wins: { [GameMapType.World]: [Difficulty.Medium] },
      challenges: ["korea_spirit"],
      migrations: { scenarioGateV2: true, scenarioGateV3: true },
    });
    const merged = mergeRecords(store(), imported);
    expect(merged.games).toHaveLength(1);
    expect(medalCount(merged)).toBe(1);
    expect(merged.challenges).toEqual(["korea_spirit"]);
  });
});

describe("planImport", () => {
  it("counts new and duplicate entries for the preview", () => {
    const current = store({
      games: [game({ id: "a" })],
      wins: { [GameMapType.World]: [Difficulty.Medium] },
      challenges: ["korea_spirit"],
    });
    const imported = store({
      games: [game({ id: "a" }), game({ id: "b" })],
      wins: { [GameMapType.World]: [Difficulty.Medium, Difficulty.Hard] },
      challenges: ["korea_spirit", "yellowsea_lord"],
    });
    const plan = planImport(current, imported);
    expect(plan.newGames).toBe(1);
    expect(plan.duplicateGames).toBe(1);
    expect(plan.newMedals).toBe(1);
    expect(plan.newChallenges).toBe(1);
    expect(plan.gamesAfterMerge).toBe(2);
    expect(plan.droppedByCap).toBe(0);
  });

  it("reports imported-only overflow when the history is full", () => {
    const current = store({
      games: Array.from({ length: MAX_RECORD_GAMES - 3 }, (_, i) =>
        game({ id: `cur${i}`, endedAt: 10_000 + i }),
      ),
    });
    const imported = store({
      games: Array.from({ length: 10 }, (_, i) =>
        game({ id: `imp${i}`, endedAt: 20_000 + i }),
      ),
    });
    const plan = planImport(current, imported);
    expect(plan.newGames).toBe(3);
    expect(plan.droppedByCap).toBe(7);
    expect(plan.gamesAfterMerge).toBe(MAX_RECORD_GAMES);
  });

  it("reports an all-duplicate import as a no-op", () => {
    const current = store({ games: [game({ id: "a" })] });
    const imported = store({ games: [game({ id: "a" })] });
    const plan = planImport(current, imported);
    expect(plan.newGames).toBe(0);
    expect(plan.newMedals).toBe(0);
    expect(plan.newChallenges).toBe(0);
  });
});
