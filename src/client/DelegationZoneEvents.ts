import { TileRef } from "@openfront/engine-api/game/GameMap";
import { GameEvent } from "@openfront/shared/EventBus";

/**
 * 개선 9: delegation protected-zone pick flow.
 *
 * The delegation panel cannot see raw map clicks (they belong to
 * ClientGameRunner), so picking a zone is a two-step handshake:
 * panel emits PickMode(true) and hides itself; the runner turns the next
 * map click into a Picked event instead of an attack; the panel stores the
 * tile, re-opens, and broadcasts Changed so the zone layer draws the ring.
 */

/** Panel → runner: the next map click picks the delegation's zone center. */
export class DelegationZonePickModeEvent implements GameEvent {
  constructor(public readonly active: boolean) {}
}

/** Runner → panel: the player clicked this tile while in pick mode. */
export class DelegationZonePickedEvent implements GameEvent {
  constructor(public readonly tile: TileRef) {}
}

/**
 * Panel → zone layer: draw the protected-zone ring at this tile with this
 * radius (in tiles), or clear it when tile is null.
 */
export class DelegationZoneChangedEvent implements GameEvent {
  constructor(
    public readonly tile: TileRef | null,
    public readonly radius: number,
  ) {}
}
