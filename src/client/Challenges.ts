import {
  Difficulty,
  GameMapType,
} from "@openfront/engine-api/game/GameTypes";

/**
 * 패권의 시간 — goal/reward 챌린지.
 *
 * Improvement 3 from the design brainstorm: on top of the existing maps and
 * difficulties, fixed 목표(목표) with a reward. A challenge clears on a solo
 * win that satisfies its map + minimum difficulty; the cleared set lives in
 * the device-local 기록실 (LocalRecords), so it works with no backend.
 * Cheat options (infinite gold/troops, instant build) never clear a
 * challenge — same bar as the win medals.
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

export interface Challenge {
  id: string;
  // The map the win must happen on; undefined = any map.
  map?: GameMapType;
  minDifficulty: Difficulty;
}

// The meta challenge: clears when every other challenge is cleared.
export const GRAND_HEGEMON_ID = "grand_hegemon";

export const CHALLENGES: Challenge[] = [
  {
    id: "korea_spirit",
    map: GameMapType.Korea,
    minDifficulty: Difficulty.Easy,
  },
  {
    id: "yellowsea_lord",
    map: GameMapType.YellowSea,
    minDifficulty: Difficulty.Medium,
  },
  {
    id: "eastasia_hegemon",
    map: GameMapType.EastAsia,
    minDifficulty: Difficulty.Hard,
  },
  {
    id: "surrounded_breakout",
    map: GameMapType.Surrounded,
    minDifficulty: Difficulty.Medium,
  },
  {
    id: "baikal_survivor",
    map: GameMapType.BaikalNukeWars,
    minDifficulty: Difficulty.Easy,
  },
  {
    id: "impossible_conquest",
    minDifficulty: Difficulty.Impossible,
  },
  {
    id: GRAND_HEGEMON_ID,
    minDifficulty: Difficulty.Easy,
  },
];

/**
 * Challenges a win on `map` at `difficulty` satisfies. The meta challenge is
 * excluded here — it is evaluated against the cleared set after recording.
 */
export function challengesSatisfiedByWin(
  map: GameMapType,
  difficulty: Difficulty,
): string[] {
  const out: string[] = [];
  for (const c of CHALLENGES) {
    if (c.id === GRAND_HEGEMON_ID) continue;
    if (c.map !== undefined && c.map !== map) continue;
    if (!difficultyAtLeast(difficulty, c.minDifficulty)) continue;
    out.push(c.id);
  }
  return out;
}
