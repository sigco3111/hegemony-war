import { describe, expect, it } from "vitest";
import {
  lastDelegationIntents,
  stageResume,
  takeResume,
  consumeResumedDelegation,
  summarize,
  SAVE_FORMAT,
  SAVE_ENGINE_REV,
  type SavedMatch,
} from "../src/client/SaveGame";

const intent = (o: object) => o as never;

function match(turns: unknown[]): SavedMatch {
  return {
    format: SAVE_FORMAT,
    build: SAVE_ENGINE_REV,
    savedAt: 1,
    gameStartInfo: {
      gameID: "g1",
      config: { gameMap: "World", difficulty: "Medium" },
    } as never,
    turns: turns as never,
  };
}

describe("SaveGame resume", () => {
  it("latest delegation intents win and keep all settings", () => {
    const r = lastDelegationIntents([
      { turnNumber: 0, intents: [] },
      {
        turnNumber: 1,
        intents: [
          intent({ type: "set_economy_delegation", enabled: true, reservePercent: 30, cityTarget: 5 }),
          intent({ type: "set_defense_delegation", enabled: true, reservePercent: 50 }),
        ],
      },
      {
        turnNumber: 2,
        intents: [
          intent({ type: "set_economy_delegation", enabled: false, reservePercent: 30, cityTarget: 5, factoryTarget: 2 }),
        ],
      },
    ] as never);
    expect(r.economy?.enabled).toBe(false);
    expect(r.economy?.cityTarget).toBe(5);
    expect(r.economy?.factoryTarget).toBe(2);
    expect(r.defense?.enabled).toBe(true);
  });

  it("only the staged game is taken, once", () => {
    stageResume(match([{ turnNumber: 0, intents: [] }]));
    expect(takeResume("other")).toBeNull();
    const m = takeResume("g1");
    expect(m?.turns.length).toBe(1);
    expect(takeResume("g1")).toBeNull();
    expect(consumeResumedDelegation()).not.toBeNull();
    expect(consumeResumedDelegation()).toBeNull();
  });

  it("a different engine revision is not resumable", () => {
    const m = match([]);
    expect(summarize(m).compatible).toBe(true);
    expect(summarize({ ...m, build: "old" }).compatible).toBe(false);
  });
});

import { lastDelegationIntents as lastDeleg } from "../src/client/SaveGame";
describe("pending intents survive a save", () => {
  it("lets a paused stop override earlier on-state", () => {
    const on = { type: "set_defense_delegation", enabled: true } as any;
    const off = { type: "set_defense_delegation", enabled: false } as any;
    const r = lastDeleg([{ turnNumber: 0, intents: [on] } as any], [off]);
    expect(r.defense?.enabled).toBe(false);
  });
});
