import { TileRef } from "@openfront/engine-api/game/GameMap";
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import {
  SendAllianceExtensionIntentEvent,
  SendAllianceRequestIntentEvent,
  SendAttackIntentEvent,
  SendBoatAttackIntentEvent,
  SendBreakAllianceIntentEvent,
  SendDeleteUnitIntentEvent,
  SendDonateGoldIntentEvent,
  SendDonateTroopsIntentEvent,
  SendEmbargoIntentEvent,
  SendEmojiIntentEvent,
  SendSpawnIntentEvent,
  SendTargetPlayerIntentEvent,
} from "../../Transport";
import { UIState } from "../../UIState";
import { PlayerView } from "../../view";
import { GameView } from "../../view";
import { clampPlanRatio, QueuePlanOrderEvent } from "../../WarPlan";

export class PlayerActionHandler {
  constructor(
    private eventBus: EventBus,
    private uiState: UIState,
    private game?: GameView,
  ) {}

  /**
   * 개선 7: while a solo game is paused the LocalServer drops every intent,
   * so manual attack clicks become plan orders instead of disappearing.
   */
  private shouldQueuePlan(): boolean {
    if (!this.game) return false;
    if (!this.uiState.paused) return false;
    if (this.game.config().gameConfig().gameType !== GameType.Singleplayer) {
      return false;
    }
    if (this.game.config().isReplay()) return false;
    if (this.game.inSpawnPhase()) return false;
    return true;
  }

  private planRatioPercent(): number {
    return clampPlanRatio(this.uiState.attackRatio * 100);
  }

  handleAttack(
    player: PlayerView,
    targetId: string | null,
    tile: TileRef | null = null,
  ) {
    if (this.shouldQueuePlan()) {
      // 개선 10: keep the clicked tile so the plan map can mark the exact aim.
      this.eventBus.emit(
        new QueuePlanOrderEvent("attack", targetId, tile, this.planRatioPercent()),
      );
      return;
    }
    this.eventBus.emit(
      new SendAttackIntentEvent(
        targetId,
        this.uiState.attackRatio * player.troops(),
      ),
    );
  }

  handleBoatAttack(player: PlayerView, targetTile: TileRef) {
    if (this.shouldQueuePlan()) {
      this.eventBus.emit(
        new QueuePlanOrderEvent("boat", null, targetTile, this.planRatioPercent()),
      );
      return;
    }
    this.eventBus.emit(
      new SendBoatAttackIntentEvent(
        targetTile,
        this.uiState.attackRatio * player.troops(),
      ),
    );
  }

  async findBestTransportShipSpawn(
    player: PlayerView,
    tile: TileRef,
  ): Promise<TileRef | false> {
    return await player.bestTransportShipSpawn(tile);
  }

  handleSpawn(tile: TileRef) {
    this.eventBus.emit(new SendSpawnIntentEvent(tile));
  }

  handleAllianceRequest(player: PlayerView, recipient: PlayerView) {
    this.eventBus.emit(new SendAllianceRequestIntentEvent(player, recipient));
  }

  handleExtendAlliance(recipient: PlayerView) {
    this.eventBus.emit(new SendAllianceExtensionIntentEvent(recipient));
  }

  handleBreakAlliance(player: PlayerView, recipient: PlayerView) {
    this.eventBus.emit(new SendBreakAllianceIntentEvent(player, recipient));
  }

  handleTargetPlayer(targetId: string | null) {
    if (!targetId) return;

    this.eventBus.emit(new SendTargetPlayerIntentEvent(targetId));
  }

  handleDonateGold(recipient: PlayerView) {
    this.eventBus.emit(new SendDonateGoldIntentEvent(recipient, null));
  }

  handleDonateTroops(recipient: PlayerView, troops?: number) {
    const amount = troops ?? null;
    if (amount !== null && amount <= 0) {
      return;
    }
    this.eventBus.emit(new SendDonateTroopsIntentEvent(recipient, amount));
  }

  handleEmbargo(recipient: PlayerView, action: "start" | "stop") {
    this.eventBus.emit(new SendEmbargoIntentEvent(recipient, action));
  }

  handleEmoji(targetPlayer: PlayerView | "AllPlayers", emojiIndex: number) {
    this.eventBus.emit(new SendEmojiIntentEvent(targetPlayer, emojiIndex));
  }

  handleDeleteUnit(unitId: number) {
    this.eventBus.emit(new SendDeleteUnitIntentEvent(unitId));
  }
}
