import {
  Difficulty,
  GameMapType,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import { CHALLENGES, GRAND_HEGEMON_ID } from "./Challenges";
import {
  LocalRecordsData,
  MAX_RECORD_GAMES,
  SoloGameRecord,
} from "./LocalRecords";

/**
 * 패권의 시간 — 기록실 백업/복원.
 *
 * The 기록실 lives only in this browser's localStorage, so a lost profile or
 * a new device loses everything. This module exports the whole store to a
 * JSON file and merges such a file back in.
 *
 * Safety rules (the user keeps real records here):
 * - Import MERGES onto current data. Existing games, medals, challenges and
 *   proofs are never deleted or rewritten; duplicates are skipped by record
 *   id. There is no replace mode.
 * - A malformed file is rejected whole: nothing is imported half-way.
 *   Every record is re-validated and rebuilt field by field, so unknown or
 *   hostile extra fields never reach the store.
 * - Missing proof never invalidates a record: imported clears without
 *   proofs are kept, same as the scenarioGate migration treats them.
 * - Migration flags are OR-ed: an older backup can never make a one-time
 *   migration re-run against merged data.
 */

export const BACKUP_APP = "hegemony-war";
export const BACKUP_KIND = "records-backup";
export const BACKUP_FORMAT = 1;
// Hard ceiling so a hostile or accidental huge file can't wedge the tab.
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
// Sanity bound far above the live store's own 200-game cap.
export const MAX_BACKUP_GAMES = 5000;

export interface RecordsBackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  format: typeof BACKUP_FORMAT;
  exportedAt: number;
  records: LocalRecordsData;
}

export type BackupParseError =
  | "too_large"
  | "not_json"
  | "not_backup"
  | "invalid_records";

export type ParseBackupResult =
  | { ok: true; data: LocalRecordsData; exportedAt: number | null }
  | { ok: false; error: BackupParseError; detail?: string };

export interface ImportPlan {
  // Games the file would add (ids not already stored).
  newGames: number;
  // Games skipped because the same id is already stored.
  duplicateGames: number;
  // (map, difficulty) medal entries the file would add.
  newMedals: number;
  // Challenge clears the file would add (including derived meta challenge).
  newChallenges: number;
  // Games in the history after the merge (existing games are never cut).
  gamesAfterMerge: number;
  // Of the file's new games, how many won't fit the history cap and are
  // left out (the file's oldest first). Never an existing game.
  droppedByCap: number;
}

const VALID_MAPS = new Set<string>(Object.values(GameMapType));
const VALID_DIFFICULTIES = new Set<string>(Object.values(Difficulty));
const VALID_MODES = new Set<string>(Object.values(GameMode));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Rebuilds one game record field by field. Returns null when any required
 * field is missing or malformed; unknown extra fields are dropped, so the
 * store never gains keys this build did not write itself.
 */
export function sanitizeGameRecord(v: unknown): SoloGameRecord | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 200) {
    return null;
  }
  if (!isNonNegativeNumber(v.endedAt)) return null;
  if (typeof v.map !== "string" || !VALID_MAPS.has(v.map)) return null;
  if (typeof v.difficulty !== "string" || !VALID_DIFFICULTIES.has(v.difficulty)) {
    return null;
  }
  if (typeof v.gameMode !== "string" || !VALID_MODES.has(v.gameMode)) {
    return null;
  }
  if (v.result !== "win" && v.result !== "loss") return null;
  if (!isNonNegativeNumber(v.ticks)) return null;

  const rec: SoloGameRecord = {
    id: v.id,
    endedAt: v.endedAt,
    map: v.map as GameMapType,
    difficulty: v.difficulty as Difficulty,
    gameMode: v.gameMode as GameMode,
    result: v.result,
    ticks: v.ticks,
  };
  if (v.cheats !== undefined) {
    if (typeof v.cheats !== "boolean") return null;
    rec.cheats = v.cheats;
  }
  if (v.bots !== undefined) {
    if (!isNonNegativeNumber(v.bots)) return null;
    rec.bots = v.bots;
  }
  if (v.nations !== undefined) {
    if (!isNonNegativeNumber(v.nations)) return null;
    rec.nations = v.nations;
  }
  if (v.maxTimerValue !== undefined) {
    if (v.maxTimerValue !== null && !isNonNegativeNumber(v.maxTimerValue)) {
      return null;
    }
    rec.maxTimerValue = v.maxTimerValue;
  }
  if (v.disabledUnits !== undefined) {
    if (
      !Array.isArray(v.disabledUnits) ||
      v.disabledUnits.some((u) => typeof u !== "string")
    ) {
      return null;
    }
    rec.disabledUnits = [...v.disabledUnits];
  }
  return rec;
}

/** Validates and rebuilds the records payload of a parsed backup object. */
function sanitizeRecordsData(
  v: unknown,
): { ok: true; data: LocalRecordsData } | { ok: false; detail: string } {
  if (!isPlainObject(v)) return { ok: false, detail: "records" };
  if (v.version !== 1) return { ok: false, detail: "version" };
  if (!Array.isArray(v.games)) return { ok: false, detail: "games" };
  if (v.games.length > MAX_BACKUP_GAMES) return { ok: false, detail: "games" };

  const games: SoloGameRecord[] = [];
  for (let i = 0; i < v.games.length; i++) {
    const rec = sanitizeGameRecord(v.games[i]);
    if (rec === null) return { ok: false, detail: `games[${i}]` };
    games.push(rec);
  }

  const wins: LocalRecordsData["wins"] = {};
  if (v.wins !== undefined) {
    if (!isPlainObject(v.wins)) return { ok: false, detail: "wins" };
    for (const [mapName, difficulties] of Object.entries(v.wins)) {
      if (!VALID_MAPS.has(mapName)) {
        return { ok: false, detail: `wins.${mapName}` };
      }
      if (!Array.isArray(difficulties)) {
        return { ok: false, detail: `wins.${mapName}` };
      }
      const list: Difficulty[] = [];
      for (const d of difficulties) {
        if (typeof d !== "string" || !VALID_DIFFICULTIES.has(d)) {
          return { ok: false, detail: `wins.${mapName}` };
        }
        if (!list.includes(d as Difficulty)) list.push(d as Difficulty);
      }
      if (list.length > 0) wins[mapName as GameMapType] = list;
    }
  }

  // Unknown challenge ids are kept: a backup from a newer build must not
  // lose clears this build does not know. They are inert in the UI.
  let challenges: string[] = [];
  if (v.challenges !== undefined) {
    if (
      !Array.isArray(v.challenges) ||
      v.challenges.some((c) => typeof c !== "string")
    ) {
      return { ok: false, detail: "challenges" };
    }
    challenges = [...new Set(v.challenges as string[])];
  }

  const proofs: Record<string, SoloGameRecord> = {};
  if (v.challengeProofs !== undefined) {
    if (!isPlainObject(v.challengeProofs)) {
      return { ok: false, detail: "challengeProofs" };
    }
    for (const [id, proof] of Object.entries(v.challengeProofs)) {
      const rec = sanitizeGameRecord(proof);
      if (rec === null) return { ok: false, detail: `challengeProofs.${id}` };
      proofs[id] = rec;
    }
  }

  const migrations: LocalRecordsData["migrations"] = {};
  if (v.migrations !== undefined) {
    if (!isPlainObject(v.migrations)) return { ok: false, detail: "migrations" };
    if (v.migrations.scenarioGateV2 === true) migrations.scenarioGateV2 = true;
    if (v.migrations.scenarioGateV3 === true) migrations.scenarioGateV3 = true;
  }

  return {
    ok: true,
    data: { version: 1, games, wins, challenges, challengeProofs: proofs, migrations },
  };
}

/** Builds the backup envelope around the current store. */
export function buildBackup(data: LocalRecordsData): RecordsBackupFile {
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    format: BACKUP_FORMAT,
    exportedAt: Date.now(),
    records: data,
  };
}

export function serializeBackup(data: LocalRecordsData): string {
  return JSON.stringify(buildBackup(data), null, 2);
}

/**
 * Parses and validates backup file text. The whole file is rejected on the
 * first malformed record — a partial import would be worse than none.
 */
export function parseBackup(text: string): ParseBackupResult {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not_json" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "not_backup" };
  if (
    parsed.app !== BACKUP_APP ||
    parsed.kind !== BACKUP_KIND ||
    parsed.format !== BACKUP_FORMAT
  ) {
    return { ok: false, error: "not_backup" };
  }
  const result = sanitizeRecordsData(parsed.records);
  if (!result.ok) {
    return { ok: false, error: "invalid_records", detail: result.detail };
  }
  const exportedAt =
    typeof parsed.exportedAt === "number" && Number.isFinite(parsed.exportedAt)
      ? parsed.exportedAt
      : null;
  return { ok: true, data: result.data, exportedAt };
}

/**
 * Merges an imported store onto the current one. Current data always wins
 * on conflict: existing games stay, existing proofs stay, and nothing the
 * user already has is ever removed — an import can only ADD.
 *
 * The history cap is enforced against the file, not against existing
 * records: when the current history already fills MAX_RECORD_GAMES slots,
 * only the file's own new games are left out (its oldest first), never an
 * existing game. Medals, challenges and clear proofs are not capped at all
 * and always merge fully.
 */
export function mergeRecords(
  current: LocalRecordsData,
  imported: LocalRecordsData,
): LocalRecordsData {
  const seen = new Set(current.games.map((g) => g.id));
  const additions = imported.games
    .filter((g) => !seen.has(g.id))
    .sort((a, b) => b.endedAt - a.endedAt);
  const slots = Math.max(0, MAX_RECORD_GAMES - current.games.length);
  const accepted = additions.slice(0, slots);
  const games = [...current.games, ...accepted].sort(
    (a, b) => b.endedAt - a.endedAt,
  );

  const wins: LocalRecordsData["wins"] = {};
  for (const source of [current.wins, imported.wins]) {
    for (const [mapName, difficulties] of Object.entries(source ?? {})) {
      const key = mapName as GameMapType;
      const list = (wins[key] ??= []);
      for (const d of difficulties) {
        if (!list.includes(d)) list.push(d);
      }
    }
  }

  const challenges = [
    ...new Set([...(current.challenges ?? []), ...(imported.challenges ?? [])]),
  ];

  const challengeProofs: Record<string, SoloGameRecord> = {
    ...(imported.challengeProofs ?? {}),
    // Current proofs overwrite imported ones on key collision.
    ...(current.challengeProofs ?? {}),
  };

  // The meta challenge is derived: if the union completes the set, grant it.
  if (
    !challenges.includes(GRAND_HEGEMON_ID) &&
    CHALLENGES.every(
      (c) => c.id === GRAND_HEGEMON_ID || challenges.includes(c.id),
    )
  ) {
    challenges.push(GRAND_HEGEMON_ID);
  }

  return {
    version: 1,
    games,
    wins,
    challenges,
    challengeProofs,
    // One-time migrations never re-run because of an older backup.
    migrations: {
      scenarioGateV2:
        current.migrations?.scenarioGateV2 === true ||
        imported.migrations?.scenarioGateV2 === true ||
        undefined,
      scenarioGateV3:
        current.migrations?.scenarioGateV3 === true ||
        imported.migrations?.scenarioGateV3 === true ||
        undefined,
    },
  };
}

/** What a given backup would change if imported now (for the preview). */
export function planImport(
  current: LocalRecordsData,
  imported: LocalRecordsData,
): ImportPlan {
  const seen = new Set(current.games.map((g) => g.id));
  const newGamesAll = imported.games.filter((g) => !seen.has(g.id)).length;
  const duplicateGames = imported.games.length - newGamesAll;
  // Only the file's own games are ever left out by the cap; existing
  // history is pinned, so droppedByCap is always imported-only overflow.
  const slots = Math.max(0, MAX_RECORD_GAMES - current.games.length);
  const newGames = Math.min(newGamesAll, slots);

  let newMedals = 0;
  for (const [mapName, difficulties] of Object.entries(imported.wins ?? {})) {
    const have = new Set(current.wins?.[mapName as GameMapType] ?? []);
    for (const d of difficulties) {
      if (!have.has(d)) newMedals++;
    }
  }

  const merged = mergeRecords(current, imported);
  const before = new Set(current.challenges ?? []);
  const newChallenges = merged.challenges!.filter(
    (id) => !before.has(id),
  ).length;

  return {
    newGames,
    duplicateGames,
    newMedals,
    newChallenges,
    gamesAfterMerge: current.games.length + newGames,
    droppedByCap: newGamesAll - newGames,
  };
}

/** Total medal (map, difficulty) entries in a store, for summaries. */
export function medalCount(data: LocalRecordsData): number {
  return Object.values(data.wins ?? {}).reduce((n, list) => n + list.length, 0);
}

function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `hegemony-records-${now.getFullYear()}${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
  );
}

/** Triggers a browser download of the current store as a backup file. */
export function downloadBackup(data: LocalRecordsData): string {
  const fileName = backupFileName(new Date());
  const blob = new Blob([serializeBackup(data)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}
