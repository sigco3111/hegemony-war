import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  attackRatio: number;
  /** True while the singleplayer sim is paused; kept by GameRenderer. */
  paused?: boolean;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
}
