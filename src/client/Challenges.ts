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
  nations?: number;
  maxTimerValue?: number | null;
  disabledUnits?: string[];
}

// Starting opposition (bots + AI nations). Scenario rules require real
// opponents so a hollowed-out config (0 bots / 1-minute timer) cannot clear
// them - changing the preset's pinned settings turns it into a normal game.
function opposition(r: ChallengeRecordInfo): number {
  return (r.bots ?? 0) + (r.nations ?? 0);
}

// Timer games must run at least this long to count: a 1-minute timer is a
// wiring trick, not a scenario.
const MIN_SCENARIO_TIMER_MINUTES = 5;

function noShortTimer(r: ChallengeRecordInfo): boolean {
  return (
    r.maxTimerValue == null || r.maxTimerValue >= MIN_SCENARIO_TIMER_MINUTES
  );
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
    // 10 minutes at 100ms/tick = 6000 ticks. A real conquest: no timer win
    // and genuine opposition (the preset starts 400 bots).
    check: (r) =>
      r.map === GameMapType.World &&
      difficultyAtLeast(r.difficulty, Difficulty.Medium) &&
      r.ticks <= 6000 &&
      r.maxTimerValue == null &&
      opposition(r) >= 200,
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
      r.maxTimerValue != null &&
      r.maxTimerValue >= MIN_SCENARIO_TIMER_MINUTES &&
      opposition(r) >= 200,
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
      NUKE_UNITS.every((u) => r.disabledUnits?.includes(u) ?? false) &&
      noShortTimer(r) &&
      opposition(r) >= 100,
    preset: {
      difficulty: Difficulty.Medium,
      disabledUnits: [...NUKE_UNITS],
    },
  },
  {
    id: "outnumbered",
    scenario: true,
    check: (r) =>
      difficultyAtLeast(r.difficulty, Difficulty.Hard) &&
      (r.bots ?? 0) >= 300 &&
      noShortTimer(r),
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

/**
 * Legacy (pre-v1.1) scenario rules, kept ONLY for the one-time migration in
 * LocalRecords: a stored win satisfying the legacy rule but not the current
 * one is positive evidence that a clear was granted by the old, looser gate.
 */
export const LEGACY_SCENARIO_CHECKS: Record<
  string,
  (r: ChallengeRecordInfo) => boolean
> = {
  blitz: (r) =>
    r.map === GameMapType.World &&
    difficultyAtLeast(r.difficulty, Difficulty.Medium) &&
    r.ticks <= 6000,
  hold_the_line: (r) =>
    r.map === GameMapType.Surrounded &&
    difficultyAtLeast(r.difficulty, Difficulty.Hard) &&
    r.maxTimerValue != null,
  pacifist: (r) =>
    difficultyAtLeast(r.difficulty, Difficulty.Medium) &&
    NUKE_UNITS.every((u) => r.disabledUnits?.includes(u) ?? false),
  outnumbered: (r) =>
    difficultyAtLeast(r.difficulty, Difficulty.Hard) && (r.bots ?? 0) >= 300,
};

/** Challenges this winning record satisfies (the meta challenge excluded). */
export function challengesSatisfied(r: ChallengeRecordInfo): string[] {
  const out: string[] = [];
  for (const c of CHALLENGES) {
    if (c.id === GRAND_HEGEMON_ID) continue;
    if (c.check(r)) out.push(c.id);
  }
  return out;
}
