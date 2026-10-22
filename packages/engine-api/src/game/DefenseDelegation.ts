/**
 * 개선 9: shared rules for the rear-defense delegation's detailed settings.
 * The engine (placement) and the client (zone marker) both use these so the
 * circle drawn on the map and the zone the delegate actually enforces never
 * drift apart.
 */

/** Which delegated build kind is attempted first when several are needed. */
export const DEFENSE_PRIORITIES = ["reactive", "proactive", "sam"] as const;
export type DefensePriority = (typeof DEFENSE_PRIORITIES)[number];

/**
 * Radius (in tiles) of the delegation's protected zone: 8% of the map's
 * smaller dimension, clamped to [40, 100] so it stays meaningful on small
 * maps and focused on large ones.
 */
export function delegationZoneRadius(
  mapWidth: number,
  mapHeight: number,
): number {
  const minDim = Math.min(mapWidth, mapHeight);
  return Math.max(40, Math.min(100, Math.round(minDim * 0.08)));
}
