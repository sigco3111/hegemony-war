import {
  Difficulty,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import {
  aggregateIncomingTroops,
  computeDiplomacyMarkers,
  findRunawayLeaderID,
  MarkerNationInput,
} from "../src/client/DiplomacyMarkers";

function nation(partial: Partial<MarkerNationInput>): MarkerNationInput {
  return {
    smallID: 1,
    isMe: false,
    isAlive: true,
    isBot: false,
    tilesOwned: 100,
    alliedWithMe: false,
    nameLocation: { x: 10, y: 20 },
    ...partial,
  };
}

describe("aggregateIncomingTroops", () => {
  it("sums per attacker and skips retreating attacks", () => {
    const m = aggregateIncomingTroops([
      { attackerID: 7, troops: 100, retreating: false },
      { attackerID: 7, troops: 50, retreating: false },
      { attackerID: 8, troops: 999, retreating: true },
      { attackerID: 9, troops: 10, retreating: false },
    ]);
    expect(m.get(7)).toBe(150);
    expect(m.has(8)).toBe(false);
    expect(m.get(9)).toBe(10);
  });
});

describe("findRunawayLeaderID", () => {
  const nations = [
    nation({ smallID: 1, isMe: true, tilesOwned: 100 }),
    nation({ smallID: 2, tilesOwned: 1000 }),
    nation({ smallID: 3, tilesOwned: 400 }),
    nation({ smallID: 4, tilesOwned: 5000, isBot: true }),
  ];

  it("flags the leader past the difficulty factor (hard = 2x)", () => {
    expect(findRunawayLeaderID(nations, GameMode.FFA, Difficulty.Hard)).toBe(2);
  });

  it("returns null below the factor (medium = 3x)", () => {
    expect(findRunawayLeaderID(nations, GameMode.FFA, Difficulty.Medium)).toBe(
      null,
    );
  });

  it("never triggers on easy or in team games, and ignores bots", () => {
    expect(findRunawayLeaderID(nations, GameMode.FFA, Difficulty.Easy)).toBe(
      null,
    );
    expect(findRunawayLeaderID(nations, GameMode.Team, Difficulty.Hard)).toBe(
      null,
    );
    const botLead = [
      nation({ smallID: 1, isMe: true, tilesOwned: 100 }),
      nation({ smallID: 2, tilesOwned: 100 }),
      nation({ smallID: 4, tilesOwned: 9999, isBot: true }),
    ];
    expect(findRunawayLeaderID(botLead, GameMode.FFA, Difficulty.Hard)).toBe(
      null,
    );
  });
});

describe("computeDiplomacyMarkers", () => {
  it("marks allies, attackers, and the hegemon with attacker precedence", () => {
    const nations = [
      nation({ smallID: 1, isMe: true, tilesOwned: 100 }),
      nation({ smallID: 2, alliedWithMe: true }),
      nation({ smallID: 3 }),
      nation({ smallID: 4, tilesOwned: 3000 }), // hegemon on hard
      nation({ smallID: 5, alliedWithMe: true, tilesOwned: 200 }), // ally+attacker
    ];
    const incoming = new Map([
      [3, 500],
      [5, 100],
    ]);
    const markers = computeDiplomacyMarkers(
      nations,
      incoming,
      GameMode.FFA,
      Difficulty.Hard,
    );
    const byId = new Map(markers.map((m) => [m.smallID, m]));
    expect(byId.get(2)?.kind).toBe("ally");
    expect(byId.get(3)?.kind).toBe("attacker");
    expect(byId.get(3)?.troops).toBe(500);
    expect(byId.get(4)?.kind).toBe("hegemon");
    // attacker wins over ally for nation 5
    expect(byId.get(5)?.kind).toBe("attacker");
    expect(byId.has(1)).toBe(false);
    // ordering: attackers first, strongest first
    expect(markers.map((m) => m.smallID)).toEqual([3, 5, 4, 2]);
  });

  it("skips dead nations, bots, me, and nations without a name location", () => {
    const nations = [
      nation({ smallID: 1, isMe: true, alliedWithMe: false }),
      nation({ smallID: 2, alliedWithMe: true, isAlive: false }),
      nation({ smallID: 3, alliedWithMe: true, isBot: true }),
      nation({ smallID: 4, alliedWithMe: true, nameLocation: null }),
      nation({ smallID: 5, alliedWithMe: true }),
    ];
    const markers = computeDiplomacyMarkers(
      nations,
      new Map(),
      GameMode.FFA,
      Difficulty.Hard,
    );
    expect(markers.map((m) => m.smallID)).toEqual([5]);
  });
});
