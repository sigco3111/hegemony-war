import {
  Difficulty,
  GameMapType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";

/**
 * 패권의 시간 — goal/reward 챌린지.
 *
 * Improvement 3 from the design brainstorm: on top of the existing maps and
 * difficulties, fixed 목표 with a reward. Two tiers:
 *
 * 1. 업적형 — win on a map at a minimum difficulty (the original seven).
 * 2. 시나리오형 — a differentiated rule on top of a win: a time limit, a
 *    hold-the-line timer game, banned nukes, or a heavily outnumbered start.
 *    These carry a `preset` the 기록실's 도전 button applies to the solo
 *    modal, so a challenge is also a one-tap scenario board.
 *
 * A challenge clears on a solo win whose record satisfies `check`; the
 * cleared set lives in the device-local 기록실 (LocalRecords), so it works
 * with no backend. Cheat options (infinite gold/troops, instant build)
 * never clear a challenge — same bar as the win medals.
 */

const DIFFICULTY_ORDER: Difficulty[] = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

export function difficultyAtLeast(
  have: Difficulty,
  need: Difficulty,
): boolean {
  return DIFFICULTY_ORDER.indexOf(have) >= DIFFICULTY_ORDER.indexOf(need);
}

// The finished-game facts a challenge rule may look at. A structural subset
// of LocalRecords' SoloGameRecord (kept separate to avoid an import cycle).
export interface ChallengeRecordInfo {
  map: GameMapType;
  difficulty: Difficulty;
  ticks: number;
  bots?: number;
  maxTimerValue?: number | null;
  disabledUnits?: string[];
}

// One-tap scenario setup, applied to the solo modal by the 도전 button.
export interface ChallengePreset {
  map?: GameMapType;
  difficulty?: Difficulty;
  bots?: number;
  maxTimer?: boolean;
  maxTimerValue?: number;
  disabledUnits?: UnitType[];
}

export interface Challenge {
  id: string;
  // True for 시나리오형 (rule beyond map+difficulty) — the UI tags these.
  scenario?: boolean;
  preset?: ChallengePreset;
  check: (r: ChallengeRecordInfo) => boolean;
}

// The meta challenge: clears when every other challenge is cleared.
export const GRAND_HEGEMON_ID = "grand_hegemon";

function mapWin(map: GameMapType, minDifficulty: Difficulty) {
  return (r: ChallengeRecordInfo) =>
    r.map === map && difficultyAtLeast(r.difficulty, minDifficulty);
}

const NUKE_UNITS: UnitType[] = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
];

export const CHALLENGES: Challenge[] = [
  // -- 업적형 --
  { id: "korea_spirit", check: mapWin(GameMapType.Korea, Difficulty.Easy) },
  {
    id: "yellowsea_lord",
    check: mapWin(GameMapType.YellowSea, Difficulty.Medium),
  },
  {
    id: "eastasia_hegemon",
    check: mapWin(GameMapType.EastAsia, Difficulty.Hard),
  },
  {
    id: "surrounded_breakout",
    check: mapWin(GameMapType.Surrounded, Difficulty.Medium),
  },
  {
    id: "baikal_survivor",
    check: mapWin(GameMapType.BaikalNukeWars, Difficulty.Easy),
  },
  {
    id: "impossible_conquest",
    check: (r) => difficultyAtLeast(r.difficulty, Difficulty.Impossible),
  },
  // -- 시나리오형 --
  {
    id: "blitz",
    scenario: true,
    // 10 minutes at 100ms/tick = 6000 ticks.
    check: (r) =>
      r.map === GameMapType.World &&
      difficultyAtLeast(r.difficulty, Difficulty.Medium) &&
      r.ticks <= 6000,
    preset: {
      map: GameMapType.World,
      difficulty: Difficulty.Medium,
      bots: 400,
    },
  },
  {
    id: "hold_the_line",
    scenario: true,
    check: (r) =>
      r.map === GameMapType.Surrounded &&
      difficultyAtLeast(r.difficulty, Difficulty.Hard) &&
      r.maxTimerValue != null,
    preset: {
      map: GameMapType.Surrounded,
      difficulty: Difficulty.Hard,
      bots: 400,
      maxTimer: true,
      maxTimerValue: 10,
    },
  },
  {
    id: "pacifist",
    scenario: true,
    check: (r) =>
      difficultyAtLeast(r.difficulty, Difficulty.Medium) &&
      NUKE_UNITS.every((u) => r.disabledUnits?.includes(u) ?? false),
    preset: {
      difficulty: Difficulty.Medium,
      disabledUnits: [...NUKE_UNITS],
    },
  },
  {
    id: "outnumbered",
    scenario: true,
    check: (r) =>
      difficultyAtLeast(r.difficulty, Difficulty.Hard) && (r.bots ?? 0) >= 300,
    preset: {
      difficulty: Difficulty.Hard,
      bots: 300,
    },
  },
  // -- 메타 --
  {
    id: GRAND_HEGEMON_ID,
    check: () => false, // evaluated against the cleared set after recording
  },
];

/** Challenges this winning record satisfies (the meta challenge excluded). */
export function challengesSatisfied(r: ChallengeRecordInfo): string[] {
  const out: string[] = [];
  for (const c of CHALLENGES) {
    if (c.id === GRAND_HEGEMON_ID) continue;
    if (c.check(r)) out.push(c.id);
  }
  return out;
}
