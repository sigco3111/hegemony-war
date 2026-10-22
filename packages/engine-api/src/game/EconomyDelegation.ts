/**
 * 개선 11: shared rules for the economy delegation (cities and factories).
 * The engine (placement) and the client (panel copy) both use these so the
 * behavior the player reads about is the behavior that runs.
 */

/**
 * Target factories per city for the economy delegate (same 0.75 ratio the
 * nation AI uses, expressed as factories*4 < cities*3 to stay in integers).
 */
export const FACTORY_RATIO_PER_CITY_NUM = 3;
export const FACTORY_RATIO_PER_CITY_DEN = 4;

/** Minimum owned tiles before the delegate considers a first city. */
export const ECONOMY_MIN_TILES_FOR_CITY = 150;

/** Random territory tiles sampled per placement attempt. */
export const ECONOMY_SAMPLE_ATTEMPTS = 25;

/** A factory scores a bonus when a city is within this Manhattan distance. */
export const FACTORY_CITY_BONUS_DIST = 40;
