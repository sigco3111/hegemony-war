import type {
  Difficulty,
  GameMapType,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import {
  CHALLENGES,
  challengesSatisfied,
  GRAND_HEGEMON_ID,
  LEGACY_SCENARIO_CHECKS,
} from "./Challenges";

/**
 * 패권의 시간 — device-local solo records ("기록실").
 *
 * The upstream achievements/records live on the account API; this build has
 * no backend at all, so every solo result is kept here in localStorage.
 * The shape mirrors what the account API served for singleplayer medals
 * (per-map set of difficulties won) plus a bounded per-game history, so the
 * SinglePlayerModal medal UI reads it unchanged in shape. Challenge clears
 * (챌린지) ride along in the same store.
 */

export interface SoloGameRecord {
  // gameID + end tick: unique per game, so a double-fire never double-counts.
  id: string;
  endedAt: number; // epoch ms
  map: GameMapType;
  difficulty: Difficulty;
  gameMode: GameMode;
  result: "win" | "loss";
  // Simulation length; the UI renders it as mm:ss at 100ms/tick.
  ticks: number;
  // Cheat options (infinite gold/troops, instant build) were on: the game
  // still goes into the history, but a win earns no medal and no challenge.
  cheats?: boolean;
  // Scenario facts (시나리오형 챌린지 판정용). Optional — games recorded
  // before these fields existed simply don't satisfy scenario rules that
  // need them.
  bots?: number;
  nations?: number;
  maxTimerValue?: number | null;
  disabledUnits?: string[];
}

interface LocalRecordsData {
  version: 1;
  // Newest first, capped — localStorage is small and the list is a history,
  // not an archive.
  games: SoloGameRecord[];
  // Medal progress: map -> difficulties won (the SinglePlayerModal shape).
  wins: Partial<Record<GameMapType, Difficulty[]>>;
  // Cleared challenge ids (see Challenges.ts).
  challenges?: string[];
  // Permanent grant evidence for cleared challenges: the winning record that
  // earned each one. Not subject to the games cap, so proofs survive history
  // rotation and refreshes. Clears from before this field existed are
  // backfilled by the one-time migration when their record is still around.
  challengeProofs?: Record<string, SoloGameRecord>;
  // One-time data migrations that already ran (never re-run).
  migrations?: { scenarioGateV2?: boolean; scenarioGateV3?: boolean };
}

const STORAGE_KEY = "hegemony.records.v1";
const MAX_GAMES = 200;

export const RECORDS_CHANGED_EVENT = "hegemony-records-changed";

function emptyData(): LocalRecordsData {
  return { version: 1, games: [], wins: {}, challenges: [] };
}

export function loadRecords(): LocalRecordsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyData();
    const parsed = JSON.parse(raw) as LocalRecordsData;
    if (parsed.version !== 1 || !Array.isArray(parsed.games)) {
      return emptyData();
    }
    parsed.wins ??= {};
    parsed.challenges ??= [];
    return migrateScenarioGateV2(parsed);
  } catch {
    return emptyData();
  }
}

/**
 * One-time migration for the v1.1 scenario gate. Before it, hollowed-out
 * configs (0 opponents, 1-minute timer) cleared scenario challenges.
 *
 * For each stored scenario clear without a pinned proof:
 * - a stored win satisfying the CURRENT rule pins it as proof and keeps it;
 * - a stored win satisfying the LEGACY rule but not the current one is
 *   positive evidence of a wrong grant: the clear is revoked;
 * - no evidence either way (record rotated out of the history cap, or the
 *   clear predates record fields): PRESERVED. Absence is not invalidity.
 *
 * Proof-backed and achievement-type clears are never touched here, and the
 * migration runs once, so legitimate clears survive the 200-game history
 * rotation forever. 전적(games)·업적(wins) 데이터는 건드리지 않는다.
 */
function migrateScenarioGateV2(data: LocalRecordsData): LocalRecordsData {
  if (data.migrations?.scenarioGateV3 === true) return data;
  data.migrations = { ...data.migrations, scenarioGateV2: true, scenarioGateV3: true };
  data.challengeProofs ??= {};

  const wins = data.games.filter(
    (g) => g.result === "win" && g.cheats !== true,
  );
  const kept: string[] = [];
  for (const id of data.challenges ?? []) {
    if (id === GRAND_HEGEMON_ID) continue; // derived; recomputed below
    const def = CHALLENGES.find((c) => c.id === id);
    if (def === undefined) continue; // retired challenge
    if (data.challengeProofs[id] !== undefined) {
      kept.push(id); // verified at grant time; permanent
      continue;
    }
    if (def.scenario !== true) {
      kept.push(id); // 업적형: the rule never changed
      continue;
    }
    const validRecord = wins.find((g) => def.check(g));
    if (validRecord !== undefined) {
      data.challengeProofs[id] = validRecord; // legitimize + pin proof
      kept.push(id);
      continue;
    }
    const legacyCheck = LEGACY_SCENARIO_CHECKS[id];
    const wrongGrant =
      legacyCheck !== undefined
        ? wins.find((g) => legacyCheck(g) && !def.check(g))
        : undefined;
    if (wrongGrant !== undefined) continue; // proven old-gate grant: revoke
    kept.push(id); // no evidence: preserve
  }
  // Evidence-based restore: a clear deleted without a surviving trace
  // (the brief revalidate build kept no backup) returns only when a
  // stored win satisfies the CURRENT gate. Absent evidence grants nothing.
  for (const def of CHALLENGES) {
    if (def.id === GRAND_HEGEMON_ID || kept.includes(def.id)) continue;
    const validRecord = wins.find((g) => def.check(g));
    if (validRecord !== undefined) {
      data.challengeProofs[def.id] = validRecord;
      kept.push(def.id);
    }
  }
  const allOthersCleared = CHALLENGES.every(
    (c) => c.id === GRAND_HEGEMON_ID || kept.includes(c.id),
  );
  if (allOthersCleared) kept.push(GRAND_HEGEMON_ID);
  data.challenges = kept;
  saveRecords(data);
  return data;
}

function saveRecords(data: LocalRecordsData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("LocalRecords: save failed", e);
  }
}

/**
 * Records the finished solo game. Returns the challenges this game cleared
 * for the first time, so the end-of-game modal can celebrate them.
 */
export function recordSoloGameEnd(record: SoloGameRecord): string[] {
  const data = loadRecords();
  if (data.games.some((g) => g.id === record.id)) return [];
  data.games.unshift(record);
  if (data.games.length > MAX_GAMES) data.games.length = MAX_GAMES;
  const newlyCleared: string[] = [];
  if (record.result === "win" && record.cheats !== true) {
    const won = (data.wins[record.map] ??= []);
    if (!won.includes(record.difficulty)) won.push(record.difficulty);
    data.challenges ??= [];
    for (const id of challengesSatisfied(record)) {
      if (!data.challenges.includes(id)) {
        data.challenges.push(id);
        // Pin permanent grant evidence (survives history rotation).
        (data.challengeProofs ??= {})[id] = record;
        newlyCleared.push(id);
      }
    }
    // The meta challenge: every other challenge cleared.
    if (
      !data.challenges.includes(GRAND_HEGEMON_ID) &&
      CHALLENGES.every(
        (c) => c.id === GRAND_HEGEMON_ID || data.challenges!.includes(c.id),
      )
    ) {
      data.challenges.push(GRAND_HEGEMON_ID);
      (data.challengeProofs ??= {})[GRAND_HEGEMON_ID] = record;
      newlyCleared.push(GRAND_HEGEMON_ID);
    }
  }
  saveRecords(data);
  document.dispatchEvent(new CustomEvent(RECORDS_CHANGED_EVENT));
  return newlyCleared;
}

/** The medal map in the exact shape SinglePlayerModal already renders. */
export function localMapWins(): Map<GameMapType, Set<Difficulty>> {
  const data = loadRecords();
  const map = new Map<GameMapType, Set<Difficulty>>();
  for (const [mapName, difficulties] of Object.entries(data.wins)) {
    map.set(mapName as GameMapType, new Set(difficulties));
  }
  return map;
}

/** Ids of every challenge cleared so far. */
export function clearedChallenges(): Set<string> {
  return new Set(loadRecords().challenges ?? []);
}

export interface RecordsSummary {
  totalGames: number;
  totalWins: number;
  winRate: number; // 0..1, 0 when no games
  mapsWon: number; // maps with at least one win
  challengesCleared: number;
  challengesTotal: number;
}

export function recordsSummary(): RecordsSummary {
  const data = loadRecords();
  const totalWins = data.games.filter((g) => g.result === "win").length;
  return {
    totalGames: data.games.length,
    totalWins,
    winRate: data.games.length === 0 ? 0 : totalWins / data.games.length,
    mapsWon: Object.keys(data.wins).length,
    challengesCleared: (data.challenges ?? []).length,
    challengesTotal: CHALLENGES.length,
  };
}

/** Ticks at Config.msPerTick() === 100 → whole seconds of simulation time. */
export function ticksToSeconds(ticks: number): number {
  return Math.round(ticks / 10);
}

export function formatRecordDuration(ticks: number): string {
  const seconds = ticksToSeconds(ticks);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
