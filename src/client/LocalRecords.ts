import type {
  Difficulty,
  GameMapType,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import {
  CHALLENGES,
  challengesSatisfiedByWin,
  GRAND_HEGEMON_ID,
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
    return parsed;
  } catch {
    return emptyData();
  }
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
    for (const id of challengesSatisfiedByWin(
      record.map,
      record.difficulty,
    )) {
      if (!data.challenges.includes(id)) {
        data.challenges.push(id);
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
