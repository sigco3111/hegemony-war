import {
  Difficulty,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";

/**
 * 개선 8: 지도 위 외교·위협 표시 (map diplomacy & threat markers).
 *
 * Pure marker computation for DiplomacyMapOverlay. Kept free of DOM/GL so the
 * rules (who gets which marker) are unit-testable without a game session.
 */

/** Toggles the map diplomacy overlay (sidebar button). */
export class ToggleDiplomacyOverlayEvent {
  constructor(public readonly isVisible?: boolean) {}
}

/** Overlay → sidebar status (badge count + active state). */
export class DiplomacyOverlayStatusEvent {
  constructor(
    public readonly visible: boolean,
    public readonly attackerCount: number,
  ) {}
}

export type DiplomacyMarkerKind = "attacker" | "hegemon" | "ally";

export interface DiplomacyMarker {
  kind: DiplomacyMarkerKind;
  /** Nation this marker points at. */
  smallID: number;
  /** World coordinates (the nation's name/capital location). */
  x: number;
  y: number;
  /** Total non-retreating troops this nation is sending at me (attackers). */
  troops: number;
}

export interface MarkerNationInput {
  smallID: number;
  isMe: boolean;
  isAlive: boolean;
  isBot: boolean;
  tilesOwned: number;
  alliedWithMe: boolean;
  nameLocation: { x: number; y: number } | null;
}

export interface AttackLike {
  attackerID: number;
  troops: number;
  retreating: boolean;
}

/**
 * Aggregate incoming attacks by attacker, skipping retreats — the same roll-up
 * the diplomacy board's threat section uses.
 */
export function aggregateIncomingTroops(
  attacks: readonly AttackLike[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const a of attacks) {
    if (a.retreating) continue;
    out.set(a.attackerID, (out.get(a.attackerID) ?? 0) + a.troops);
  }
  return out;
}

/**
 * Mirror of the engine's runawayLeadFactor (NationUtils.ts), same rule the
 * diplomacy board mirrors: which difficulties have a hegemon threshold.
 */
export function runawayLeadFactor(d: Difficulty): number | null {
  switch (d) {
    case Difficulty.Easy:
      return null;
    case Difficulty.Medium:
      return 3;
    case Difficulty.Hard:
      return 2;
    case Difficulty.Impossible:
      return 1.5;
  }
}

/**
 * The runaway leader's smallID, computed exactly like the engine sees it:
 * FFA only, bots excluded, leader must own factor x the runner-up's tiles.
 * Returns null when there is no runaway leader.
 */
export function findRunawayLeaderID(
  nations: readonly MarkerNationInput[],
  mode: GameMode,
  difficulty: Difficulty,
): number | null {
  if (mode !== GameMode.FFA) return null;
  const factor = runawayLeadFactor(difficulty);
  if (factor === null) return null;
  let leader: MarkerNationInput | null = null;
  let runnerUp: MarkerNationInput | null = null;
  for (const n of nations) {
    if (n.isBot || !n.isAlive) continue;
    if (leader === null || n.tilesOwned > leader.tilesOwned) {
      runnerUp = leader;
      leader = n;
    } else if (runnerUp === null || n.tilesOwned > runnerUp.tilesOwned) {
      runnerUp = n;
    }
  }
  if (leader === null || runnerUp === null) return null;
  return leader.tilesOwned >= runnerUp.tilesOwned * factor
    ? leader.smallID
    : null;
}

/**
 * One marker per notable attacker/nation. Precedence: attacker > hegemon >
 * ally — a force shelling me needs the urgent red ring even when it is also
 * the hegemon or (mid-betrayal) still technically allied.
 *
 * Any live invasion counts as an attacker, bot armies included, matching the
 * diplomacy board's threat section; bots never get hegemon/ally markers.
 * Attackers without a name location (tiny or just eliminated) are skipped.
 * The local player never gets a marker.
 */
export function computeDiplomacyMarkers(
  nations: readonly MarkerNationInput[],
  incomingTroops: ReadonlyMap<number, number>,
  mode: GameMode,
  difficulty: Difficulty,
): DiplomacyMarker[] {
  const hegemonID = findRunawayLeaderID(nations, mode, difficulty);
  const markers: DiplomacyMarker[] = [];
  for (const n of nations) {
    if (n.isMe || !n.isAlive) continue;
    if (n.nameLocation === null) continue;
    const troops = incomingTroops.get(n.smallID) ?? 0;
    if (troops > 0) {
      markers.push({
        kind: "attacker",
        smallID: n.smallID,
        x: n.nameLocation.x,
        y: n.nameLocation.y,
        troops,
      });
      continue;
    }
    // Bots only qualify while actively invading (handled above).
    if (n.isBot) continue;
    if (n.smallID === hegemonID) {
      markers.push({
        kind: "hegemon",
        smallID: n.smallID,
        x: n.nameLocation.x,
        y: n.nameLocation.y,
        troops: 0,
      });
    } else if (n.alliedWithMe) {
      markers.push({
        kind: "ally",
        smallID: n.smallID,
        x: n.nameLocation.x,
        y: n.nameLocation.y,
        troops: 0,
      });
    }
  }
  // Stable order for deterministic rendering/tests: attacker, hegemon, ally;
  // strongest first inside each group.
  const rank = (k: DiplomacyMarkerKind) =>
    k === "attacker" ? 0 : k === "hegemon" ? 1 : 2;
  markers.sort((a, b) => rank(a.kind) - rank(b.kind) || b.troops - a.troops);
  return markers;
}
