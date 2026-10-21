import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Attack, Game, Player } from "../../game/Game";

/**
 * 개선6: defense-post placement shared by the nation AI
 * (NationStructureBehavior) and the player-facing rear-defense delegation
 * (DefenseDelegationBehavior). Extracted verbatim from
 * NationStructureBehavior so both place posts with the exact same rules.
 */

/**
 * Incoming attack troop count as a fraction of own troops below which
 * no defensive structures are built.
 */
export const UNDER_ATTACK_THREAT_RATIO = 0.35;

/**
 * One additional defense post is allowed per this fraction of the
 * incoming-to-own-troop ratio (e.g. 0.4 → 1 post at 0–40%, 2 at 40–80%, …).
 */
export const DEFENSE_POST_RATIO_PER_POST = 0.4;

/** Closest a reactive defense post goes to the attack front, in post ranges; stronger attacks push it further back */
export const DEFENSE_POST_FRONT_MIN_DIST = 2 / 3;
export const DEFENSE_POST_FRONT_DIST_PER_RATIO = 1 / 3;
export const DEFENSE_POST_FRONT_RATIO_CAP = 2;
/** Depth of the band a reactive defense post may go in, in post ranges */
export const DEFENSE_POST_FRONT_BAND = 1 / 2;

/** Distance band from a threatening neighbor's border for a defense post built before it attacks, in post ranges */
export const PROACTIVE_DEFENSE_POST_MIN_DIST = 1 / 2;
export const PROACTIVE_DEFENSE_POST_MAX_DIST = 1;
/** Cities owned before borders that aren't under attack yet get fortified */
export const PROACTIVE_DEFENSE_POST_MIN_CITIES = 2;
/** Defense posts owned per city above which borders that aren't under attack stop being fortified */
export const PROACTIVE_DEFENSE_POSTS_PER_CITY = 0.5;

/** Random tiles tried when looking for a defense post spot */
const DEFENSE_POST_SAMPLE_ATTEMPTS = 150;

// Reusable neighbor buffer for hot loops; the simulation is single-threaded.
const NEIGHBOR_SCRATCH: TileRef[] = [0, 0, 0, 0];

/** Player's border tiles adjacent to land owned by any of `players`. */
export function borderTilesFacing(
  game: Game,
  player: Player,
  players: ReadonlySet<Player>,
): TileRef[] {
  const frontTiles: TileRef[] = [];
  if (players.size === 0) return frontTiles;
  // Set.forEach + a reused neighbor buffer: border sets are huge, and
  // for..of over a Set allocates an iterator-result object per element.
  // "Any neighbor is one of them" is order-insensitive.
  const nbuf = NEIGHBOR_SCRATCH;
  player.borderTiles().forEach((borderTile) => {
    const n = game.neighbors4(borderTile, nbuf);
    for (let i = 0; i < n; i++) {
      const owner = game.owner(nbuf[i]);
      if (players.has(owner as Player)) {
        frontTiles.push(borderTile);
        return;
      }
    }
  });
  return frontTiles;
}

/**
 * Returns the player's border tiles adjacent to a land attacker's territory,
 * plus the landing frontier of boat attacks from players not attacking by
 * land.
 */
export function attackFrontTiles(
  game: Game,
  player: Player,
  attacks: Attack[],
): TileRef[] {
  const landAttackers = new Set<Player>();
  for (const a of attacks) {
    if (a.sourceTile() === null) landAttackers.add(a.attacker());
  }

  const frontTiles = borderTilesFacing(game, player, landAttackers);

  // A land attacker's beachheads are already in its adjacency front above.
  for (const a of attacks) {
    if (a.sourceTile() === null || landAttackers.has(a.attacker())) continue;
    a.borderTiles().forEach((t) => {
      if (game.owner(t) === player) frontTiles.push(t);
    });
  }
  return frontTiles;
}

/**
 * Counts defense posts within `range` of any front tile.
 * `cap` short-circuits the scan once that many are found.
 */
export function countDefensePostsNearFront(
  game: Game,
  player: Player,
  frontTiles: TileRef[],
  range: number,
  cap?: number,
): number {
  if (frontTiles.length === 0) return 0;

  const rangeSquared = range ** 2;

  let count = 0;
  for (const dp of player.units(UnitType.DefensePost)) {
    for (const frontTile of frontTiles) {
      if (game.euclideanDistSquared(dp.tile(), frontTile) <= rangeSquared) {
        count++;
        if (cap !== undefined && count >= cap) return count;
        break;
      }
    }
  }
  return count;
}

/**
 * Finds an own tile where a defense post can be built at a distance in
 * [minDist, maxDist] from the nearest front tile, sampled around the front.
 * Front tiles and candidates near existing defense posts are skipped, since
 * overlapping posts don't stack; a fully covered front yields null.
 */
export function findDefensePostTile(
  game: Game,
  player: Player,
  random: PseudoRandom,
  frontTiles: TileRef[],
  minDist: number,
  maxDist: number,
): TileRef | null {
  if (frontTiles.length === 0) return null;

  const spreadRangeSquared = (game.config().defensePostRange() * 1.5) ** 2;
  const existingDPTiles = player
    .units(UnitType.DefensePost)
    .map((u) => u.tile());
  const nearExistingPost = (t: TileRef) =>
    existingDPTiles.some(
      (dp) => game.euclideanDistSquared(t, dp) < spreadRangeSquared,
    );

  const anchors = frontTiles.filter((ft) => !nearExistingPost(ft));
  if (anchors.length === 0) return null;

  const minSquared = minDist ** 2;
  const maxSquared = maxDist ** 2;
  const searchRadius = Math.ceil(maxDist);
  for (let attempt = 0; attempt < DEFENSE_POST_SAMPLE_ATTEMPTS; attempt++) {
    const anchor = random.randElement(anchors);
    const ax = game.x(anchor);
    const ay = game.y(anchor);
    const x = random.nextInt(ax - searchRadius, ax + searchRadius + 1);
    const y = random.nextInt(ay - searchRadius, ay + searchRadius + 1);
    if (!game.isValidCoord(x, y)) continue;
    const t = game.ref(x, y);
    if (game.owner(t) !== player) continue;
    if (nearExistingPost(t)) continue;
    let nearestSquared = Infinity;
    for (const ft of frontTiles) {
      nearestSquared = Math.min(
        nearestSquared,
        game.euclideanDistSquared(t, ft),
      );
      if (nearestSquared < minSquared) break;
    }
    if (nearestSquared < minSquared || nearestSquared > maxSquared) continue;
    if (!player.canBuild(UnitType.DefensePost, t)) continue;
    return t;
  }
  return null;
}
