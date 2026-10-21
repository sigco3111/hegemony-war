import { GameType } from "@openfront/engine-api/game/GameTypes";
import { PlayerID } from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  PauseGameIntentEvent,
  SendAttackIntentEvent,
  SendBoatAttackIntentEvent,
} from "../../Transport";
import { UIState } from "../../UIState";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";
import {
  PlanOrder,
  PLAN_RATIO_STEP,
  QueuePlanOrderEvent,
  ToggleWarPlanPanelEvent,
  WarPlanChangedEvent,
  WarPlanQueue,
} from "../../WarPlan";

/**
 * 개선 7: 일시정지 작전 계획 — the pause operation plan panel.
 *
 * While paused, attack clicks queue orders here (target + troop ratio)
 * instead of being dropped by the paused LocalServer. The panel edits the
 * queue (ratio, order, cancel) and, once the game resumes, dispatches the
 * remaining orders top-down, one per tick, recomputing troops from the live
 * count so an earlier order never double-spends the troops of a later one.
 * Orders that no longer make sense (target destroyed, now allied, no
 * troops, no usable shoreline) are skipped with the reason shown in place.
 */
@customElement("war-plan-panel")
export class WarPlanPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public uiState: UIState;

  @state() private show = false;
  @state() private executing = false;
  @state() private paused = false;
  /** Bumped to re-render on queue mutations. */
  @state() private version = 0;

  private queue = new WarPlanQueue();
  /** displayName cache so rows survive their target's destruction. */
  private nameCache = new Map<PlayerID, string>();
  private boatDispatchInFlight = false;
  private lastEmittedCount = -1;
  private lastEmittedExecuting = false;

  createRenderRoot() {
    return this;
  }

  init() {
    // Session isolation: a new game always starts with an empty plan, even
    // though this element is a singleton reused across games.
    this.queue = new WarPlanQueue();
    this.nameCache = new Map();
    this.executing = false;
    this.paused = false;
    this.show = false;
    this.boatDispatchInFlight = false;

    this.eventBus.on(QueuePlanOrderEvent, (e) => {
      this.queue.add(e.kind, e.targetID, e.dstTile, e.ratioPercent);
      this.version++;
    });
    this.eventBus.on(ToggleWarPlanPanelEvent, (e) => {
      this.show = e.isVisible ?? !this.show;
    });
    this.eventBus.on(PauseGameIntentEvent, (e) => {
      this.paused = e.paused;
      // Resume runs the plan no matter which control released the pause.
      if (!e.paused && this.queue.nextQueued() !== undefined) {
        this.executing = true;
      }
      this.version++;
    });
  }

  getTickIntervalMs() {
    return 200;
  }

  private isSolo(): boolean {
    return (
      this.game?.config().gameConfig().gameType === GameType.Singleplayer &&
      !this.game.config().isReplay()
    );
  }

  tick() {
    if (this.game === undefined || this.game === null) return;
    if (!this.isSolo()) return;
    this.emitChanged();
    if (!this.executing || this.paused) return;
    if (this.game.inSpawnPhase()) return;
    const me = this.game.myPlayer();
    if (me === null || me === undefined || !me.isAlive()) {
      // No commander, no plan: leave rows as they are for the death screen.
      this.executing = false;
      this.version++;
      return;
    }
    const order = this.queue.nextQueued();
    if (order === undefined) {
      this.executing = false;
      this.version++;
      return;
    }
    void this.dispatch(me, order);
  }

  private emitChanged(): void {
    const count = this.queue.queuedCount();
    if (count !== this.lastEmittedCount || this.executing !== this.lastEmittedExecuting) {
      this.lastEmittedCount = count;
      this.lastEmittedExecuting = this.executing;
      this.eventBus.emit(new WarPlanChangedEvent(count, this.executing));
    }
  }

  /**
   * Validates one order against the live game and sends it. The engine
   * repeats every check (friendly targets are rejected, troops are capped at
   * what the owner holds), so a client-side race can never misfire — it only
   * decides which skip reason the player sees.
   */
  private async dispatch(me: PlayerView, order: PlanOrder): Promise<void> {
    if (this.boatDispatchInFlight) return;

    let target: PlayerView | null = null;
    if (order.targetID !== null) {
      try {
        target = this.game.player(order.targetID);
      } catch {
        target = null;
      }
      if (target === null || target === undefined || !target.isAlive()) {
        this.skip(order, "target_gone");
        return;
      }
      if (me.isFriendly(target)) {
        this.skip(order, "ally");
        return;
      }
      this.nameCache.set(target.id(), target.displayName());
    }

    const troops = Math.floor((order.ratioPercent / 100) * me.troops());
    if (troops < 1) {
      this.skip(order, "troops");
      return;
    }

    if (order.kind === "boat") {
      this.boatDispatchInFlight = true;
      try {
        const spawn =
          order.dstTile === null
            ? false
            : await me.bestTransportShipSpawn(order.dstTile);
        if (spawn === false) {
          this.skip(order, "no_boat");
          return;
        }
        this.eventBus.emit(new SendBoatAttackIntentEvent(spawn, troops));
      } finally {
        this.boatDispatchInFlight = false;
      }
    } else {
      this.eventBus.emit(new SendAttackIntentEvent(order.targetID, troops));
    }
    order.state = "sent";
    order.sentTroops = troops;
    this.version++;
  }

  private skip(order: PlanOrder, reason: string): void {
    order.state = "skipped";
    order.skipReason = reason;
    this.version++;
  }

  private targetName(order: PlanOrder): string {
    if (order.targetID === null) return translateText("war_plan.neutral_target");
    try {
      const pv = this.game.player(order.targetID);
      const name = pv.displayName();
      this.nameCache.set(order.targetID, name);
      return name;
    } catch {
      return (
        this.nameCache.get(order.targetID) ??
        translateText("war_plan.neutral_target")
      );
    }
  }

  private estimateTroops(order: PlanOrder): number {
    const me = this.game.myPlayer();
    if (me === null || me === undefined) return 0;
    return Math.floor((order.ratioPercent / 100) * me.troops());
  }

  private renderOrder(order: PlanOrder, index: number): TemplateResult {
    const isQueued = order.state === "queued";
    const orders = this.queue.all();
    const ratioPct = order.ratioPercent;
    return html`
      <div
        class="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg ${isQueued
          ? "bg-white/5"
          : order.state === "sent"
            ? "bg-emerald-900/30"
            : "bg-red-900/20"}"
      >
        <span class="text-white/40 tabular-nums shrink-0 w-5 text-center"
          >${index + 1}</span
        >
        <span class="shrink-0" title=${translateText(`war_plan.kind_${order.kind}`)}
          >${order.kind === "boat" ? "🚢" : "⚔️"}</span
        >
        <span class="text-white/85 truncate">${this.targetName(order)}</span>
        ${isQueued
          ? html`
              <span class="flex items-center gap-0.5 shrink-0 ml-auto">
                <button
                  class="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white/80 cursor-pointer leading-none"
                  title="-${PLAN_RATIO_STEP}%"
                  @click=${() => {
                    this.queue.setRatio(order.id, ratioPct - PLAN_RATIO_STEP);
                    this.version++;
                  }}
                >
                  −
                </button>
                <span class="text-sky-300 tabular-nums w-9 text-center"
                  >${ratioPct}%</span
                >
                <button
                  class="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white/80 cursor-pointer leading-none"
                  title="+${PLAN_RATIO_STEP}%"
                  @click=${() => {
                    this.queue.setRatio(order.id, ratioPct + PLAN_RATIO_STEP);
                    this.version++;
                  }}
                >
                  +
                </button>
              </span>
              <span class="text-white/45 tabular-nums shrink-0 hidden sm:inline"
                >${translateText("war_plan.est_troops", {
                  troops: renderTroops(this.estimateTroops(order)),
                })}</span
              >
              <span class="flex items-center gap-0.5 shrink-0">
                <button
                  class="w-5 h-5 rounded bg-slate-700 text-white/80 leading-none ${index ===
                  0
                    ? "opacity-30 cursor-default"
                    : "hover:bg-slate-600 cursor-pointer"}"
                  title=${translateText("war_plan.move_up")}
                  ?disabled=${index === 0}
                  @click=${() => {
                    this.queue.move(order.id, -1);
                    this.version++;
                  }}
                >
                  ↑
                </button>
                <button
                  class="w-5 h-5 rounded bg-slate-700 text-white/80 leading-none ${index ===
                  orders.length - 1
                    ? "opacity-30 cursor-default"
                    : "hover:bg-slate-600 cursor-pointer"}"
                  title=${translateText("war_plan.move_down")}
                  ?disabled=${index === orders.length - 1}
                  @click=${() => {
                    this.queue.move(order.id, 1);
                    this.version++;
                  }}
                >
                  ↓
                </button>
                <button
                  class="w-5 h-5 rounded bg-slate-700 hover:bg-red-700 text-white/80 cursor-pointer leading-none"
                  title=${translateText("war_plan.remove")}
                  @click=${() => {
                    this.queue.remove(order.id);
                    this.version++;
                  }}
                >
                  ✕
                </button>
              </span>
            `
          : html`
              <span
                class="ml-auto shrink-0 tabular-nums ${order.state === "sent"
                  ? "text-emerald-300"
                  : "text-red-300/90"}"
              >
                ${order.state === "sent"
                  ? translateText("war_plan.state_sent", {
                      troops: renderTroops(order.sentTroops ?? 0),
                    })
                  : `${translateText("war_plan.state_skipped")}: ${translateText(
                      `war_plan.skip_${order.skipReason}`,
                    )}`}
              </span>
            `}
      </div>
    `;
  }

  render() {
    if (!this.show || !this.isSolo()) return nothing;
    const me = this.game.myPlayer();
    if (me === null || me === undefined || !me.isAlive()) return nothing;

    const orders = this.queue.all();
    const queued = this.queue.queuedCount();
    const finished = this.queue.finishedCount();
    const sliderPct = Math.round((this.uiState?.attackRatio ?? 0) * 100);

    return html`
      <div
        class="fixed inset-0 z-2000 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3"
        @click=${() => (this.show = false)}
      >
        <div
          class="w-full max-w-md max-h-[86vh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div
            class="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-slate-900/95 border-b border-white/10"
          >
            <span class="text-sm font-bold text-white uppercase tracking-wider"
              >${translateText("war_plan.title")}</span
            >
            <button
              class="text-white/50 hover:text-white text-lg leading-none px-2 cursor-pointer"
              @click=${() => (this.show = false)}
            >
              ✕
            </button>
          </div>
          <div class="flex flex-col gap-4 p-4">
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("war_plan.heading")}
              </h3>
              <p class="text-xs text-white/60 leading-relaxed">
                ${translateText("war_plan.desc")}
              </p>
              <p class="text-xs text-white/45 mt-1">
                ${translateText("war_plan.ratio_hint", { pct: sliderPct })}
              </p>
            </section>
            ${this.executing
              ? html`<p class="text-xs text-emerald-300/90 tabular-nums">
                  ${translateText("war_plan.executing", {
                    done: finished,
                    total: orders.length,
                  })}
                </p>`
              : nothing}
            <section>
              ${orders.length === 0
                ? html`<div class="text-white/40 text-sm py-2">
                    ${translateText("war_plan.empty")}
                  </div>`
                : html`<div class="flex flex-col gap-1">
                    ${orders.map((o, i) => this.renderOrder(o, i))}
                  </div>`}
            </section>
            ${orders.length > 0
              ? html`<div class="flex gap-2">
                  ${finished > 0
                    ? html`<button
                        class="flex-1 rounded-lg px-3 py-2 text-xs font-bold bg-slate-700 hover:bg-slate-600 text-white/80 transition-colors cursor-pointer"
                        @click=${() => {
                          this.queue.clearFinished();
                          this.version++;
                        }}
                      >
                        ${translateText("war_plan.clear_finished")}
                      </button>`
                    : nothing}
                  <button
                    class="flex-1 rounded-lg px-3 py-2 text-xs font-bold bg-red-800/80 hover:bg-red-700 text-white/90 transition-colors cursor-pointer"
                    @click=${() => {
                      this.queue.clear();
                      this.executing = false;
                      this.version++;
                    }}
                  >
                    ${translateText("war_plan.clear_all")}
                  </button>
                </div>`
              : nothing}
            ${queued > 0 && !this.paused && !this.executing
              ? html`<p class="text-xs text-amber-300/80">
                  ${translateText("war_plan.waiting_resume")}
                </p>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}
