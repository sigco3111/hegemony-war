import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { challengesSatisfied, type ChallengeRecordInfo } from "../src/client/Challenges";

// 개선3 무결성: 시나리오형 챌린지는 실제 config(적 수/타이머/난이도/맵)를
// 검증한다. 축소된 config(0봇, 1분 타이머)로 얻은 승리는 인정하지 않는다.

const base: ChallengeRecordInfo = {
  map: GameMapType.World,
  difficulty: Difficulty.Medium,
  ticks: 800,
};

describe("scenario challenge config gate", () => {
  it("blitz: real preset win clears (World/Medium/400 bots, no timer)", () => {
    const r = { ...base, ticks: 5900, bots: 400, nations: 72 };
    expect(challengesSatisfied(r)).toContain("blitz");
  });

  it("blitz: 1-minute timer trick win does not clear", () => {
    const r = { ...base, ticks: 711, bots: 0, nations: 0, maxTimerValue: 1 };
    expect(challengesSatisfied(r)).not.toContain("blitz");
  });

  it("blitz: no timer but no opposition does not clear", () => {
    const r = { ...base, ticks: 3000, bots: 0, nations: 0 };
    expect(challengesSatisfied(r)).not.toContain("blitz");
  });

  it("hold_the_line: real preset win clears (10-min timer, 400 bots)", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.Surrounded,
      difficulty: Difficulty.Hard,
      ticks: 6000,
      bots: 400,
      nations: 72,
      maxTimerValue: 10,
    };
    expect(challengesSatisfied(r)).toContain("hold_the_line");
  });

  it("hold_the_line: 1-minute timer trick does not clear", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.Surrounded,
      difficulty: Difficulty.Hard,
      ticks: 631,
      bots: 0,
      nations: 0,
      maxTimerValue: 1,
    };
    expect(challengesSatisfied(r)).not.toContain("hold_the_line");
  });

  it("hold_the_line: no timer at all does not clear", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.Surrounded,
      difficulty: Difficulty.Hard,
      ticks: 6000,
      bots: 400,
      maxTimerValue: null,
    };
    expect(challengesSatisfied(r)).not.toContain("hold_the_line");
  });

  it("pacifist: real win clears (nukes banned, 400 bots, no timer)", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.World,
      difficulty: Difficulty.Medium,
      ticks: 9000,
      bots: 400,
      disabledUnits: ["Atom Bomb", "Hydrogen Bomb", "MIRV"],
    };
    expect(challengesSatisfied(r)).toContain("pacifist");
  });

  it("pacifist: nukes banned but 1-minute timer trick does not clear", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.World,
      difficulty: Difficulty.Medium,
      ticks: 651,
      bots: 0,
      nations: 0,
      maxTimerValue: 1,
      disabledUnits: ["Atom Bomb", "Hydrogen Bomb", "MIRV"],
    };
    expect(challengesSatisfied(r)).not.toContain("pacifist");
  });

  it("outnumbered: 300 bots Hard clears; short timer blocks it", () => {
    const ok: ChallengeRecordInfo = {
      map: GameMapType.World,
      difficulty: Difficulty.Hard,
      ticks: 20000,
      bots: 300,
    };
    expect(challengesSatisfied(ok)).toContain("outnumbered");
    const trick = { ...ok, maxTimerValue: 1 };
    expect(challengesSatisfied(trick)).not.toContain("outnumbered");
  });

  it("achievement-type challenges are unchanged (map+difficulty win)", () => {
    const r: ChallengeRecordInfo = {
      map: GameMapType.Surrounded,
      difficulty: Difficulty.Hard,
      ticks: 631,
      bots: 0,
      maxTimerValue: 1,
    };
    expect(challengesSatisfied(r)).toContain("surrounded_breakout");
  });
});
