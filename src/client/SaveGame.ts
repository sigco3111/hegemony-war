/**
 * 중간 저장 / 이어하기.
 *
 * 엔진은 결정적이라, 판의 시작 정보(gameStartInfo)와 지금까지 확정된 턴
 * (turns, 각 턴의 인텐트)만 있으면 같은 상태를 다시 만들 수 있습니다. 그래서
 * 병력·영토·금고·위임 실행 상태를 따로 직렬화하지 않고, 불러올 때 저장된 턴을
 * 엔진에 다시 먹입니다(LocalServer의 rejoin 경로와 같음).
 *
 * - 슬롯은 하나. IndexedDB에 저장하며 기록실(localStorage)과는 완전히 분리됩니다.
 * - 같은 빌드에서만 이어합니다. 빌드가 다르면 엔진이 달라져 결과가 어긋날 수
 *   있으므로 이어하기를 막고, 삭제는 직접 하게 둡니다.
 * - 판이 끝나면(승패 확정, 내 소멸 후 결과 화면) 저장을 지웁니다.
 * - 기록실, 메달, 백업 파일은 건드리지 않습니다.
 */

import type { StampedIntent, Turn } from "@openfront/engine-api/Schemas";
import type { WireGameStartInfo } from "@openfront/shared/WireSchemas";

export const SAVE_FORMAT = 1;
const DB_NAME = "hegemony-save-v1";
const STORE = "slot";
const KEY = "current";

export interface SavedMatch {
  format: number;
  build: string;
  savedAt: number;
  gameStartInfo: WireGameStartInfo;
  turns: Turn[];
}

export interface SavedMatchSummary {
  savedAt: number;
  ticks: number;
  map: string;
  difficulty: string;
  sameBuild: boolean;
  compatible: boolean;
}

export interface ResumedDelegation {
  defense?: Extract<StampedIntent, { type: "set_defense_delegation" }>;
  economy?: Extract<StampedIntent, { type: "set_economy_delegation" }>;
}

/**
 * 엔진 호환 표식. 정적 배포에서는 gitCommit이 의미 있는 값이 아니므로 직접
 * 관리합니다: 시뮬레이션 결과가 달라지는 엔진 변경을 배포할 때 올립니다.
 * 표식이 다른 저장은 이어하기를 막습니다(어긋난 판을 조용히 이어가지 않기 위해).
 */
export const SAVE_ENGINE_REV = "2026-10-22-a";

function currentBuild(): string {
  return SAVE_ENGINE_REV;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = globalThis.indexedDB?.open(DB_NAME, 1);
      if (req === undefined) return resolve(null);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await openDb();
  if (db === null) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = () => {
        db.close();
        resolve(undefined);
      };
      tx.onabort = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

// ---- session state -------------------------------------------------------

let activeGameID: string | null = null;
let blockedGameID: string | null = null;
let resume: SavedMatch | null = null;
let resumedDelegation: ResumedDelegation | null = null;

export function setActiveGame(gameID: string): void {
  activeGameID = gameID;
}

/** 판이 끝났다: 저장을 지우고 이 판은 다시 저장하지 않는다. */
export function markMatchOver(): void {
  if (activeGameID !== null) blockedGameID = activeGameID;
  void clearSavedMatch();
}

export function isSaveBlocked(gameID: string): boolean {
  return blockedGameID === gameID;
}

// ---- storage -------------------------------------------------------------

export async function writeSavedMatch(m: SavedMatch): Promise<boolean> {
  if (isSaveBlocked(m.gameStartInfo.gameID)) return false;
  const r = await withStore("readwrite", (s) => s.put(m, KEY));
  return r !== undefined;
}

export async function readSavedMatch(): Promise<SavedMatch | null> {
  const v = await withStore<unknown>("readonly", (s) => s.get(KEY));
  if (v === undefined || v === null || typeof v !== "object") return null;
  const m = v as Partial<SavedMatch>;
  if (
    m.format !== SAVE_FORMAT ||
    m.gameStartInfo === undefined ||
    !Array.isArray(m.turns)
  ) {
    return null;
  }
  return m as SavedMatch;
}

export async function clearSavedMatch(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(KEY));
}

export function buildSavedMatch(
  gameStartInfo: WireGameStartInfo,
  turns: Turn[],
): SavedMatch {
  return {
    format: SAVE_FORMAT,
    build: currentBuild(),
    savedAt: Date.now(),
    gameStartInfo,
    turns,
  };
}

export function summarize(m: SavedMatch): SavedMatchSummary {
  const sameBuild = m.build === currentBuild();
  return {
    savedAt: m.savedAt,
    ticks: m.turns.length,
    map: String(m.gameStartInfo.config.gameMap),
    difficulty: String(m.gameStartInfo.config.difficulty),
    sameBuild,
    compatible: sameBuild,
  };
}

// ---- resume hand-off (modal -> LocalServer / panel) ----------------------

export function stageResume(m: SavedMatch): void {
  resume = m;
  resumedDelegation = null;
}

/** LocalServer calls this at start; only matches the staged game. */
export function takeResume(gameID: string): SavedMatch | null {
  if (resume === null || resume.gameStartInfo.gameID !== gameID) return null;
  const m = resume;
  resume = null;
  resumedDelegation = lastDelegationIntents(m.turns);
  return m;
}

export function consumeResumedDelegation(): ResumedDelegation | null {
  const d = resumedDelegation;
  resumedDelegation = null;
  return d;
}

/** The latest delegation settings the player sent, replayed from the turns. */
export function lastDelegationIntents(turns: Turn[]): ResumedDelegation {
  const out: ResumedDelegation = {};
  for (const t of turns) {
    for (const i of t.intents) {
      if (i.type === "set_defense_delegation") out.defense = i;
      else if (i.type === "set_economy_delegation") out.economy = i;
    }
  }
  return out;
}
