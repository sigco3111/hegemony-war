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

/**
 * 개선 14: which structure the economy delegate builds first when several
 * are due. "balanced" keeps the original behavior (factories until the
 * 3-per-4-cities ratio is met, cities otherwise); "city" and "factory"
 * always try that kind first and fall back to the other when it is capped
 * or blocked.
 */
export const ECONOMY_PRIORITIES = ["balanced", "city", "factory"] as const;
export type EconomyPriority = (typeof ECONOMY_PRIORITIES)[number];

/**
 * Upper bound for the per-structure build targets the player can set
 * (개선 14). 0 means unlimited: the delegate keeps building that kind as
 * long as the other rules allow. Once a positive target is reached the
 * delegate stops building that kind; when destruction drops the owned
 * count below the target it resumes automatically.
 */
export const ECONOMY_MAX_TARGET = 20;
