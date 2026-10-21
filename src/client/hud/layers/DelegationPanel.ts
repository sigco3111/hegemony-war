import { GameType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DelegationNoteUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { formatRecordDuration } from "../../LocalRecords";
import { SetDefenseDelegationEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/** Toggles the rear-defense delegation overlay (위임). */
export class ToggleDelegationPanelEvent {
  constructor(public readonly isVisible?: boolean) {}
}

interface DelegationAction {
  tick: number;
  unit: UnitType;
  cost: number;
}

const RESERVE_OPTIONS = [25, 50, 75];
const MAX_HISTORY = 50;

/**
 * 개선6: rear-defense delegation panel. Lets the player hand rear defense
 * (defense posts and SAM launchers only — attacks and diplomacy stay manual)
 * to the AI, cap how much of the treasury it may touch, and see everything
 * it built. The engine side confirms each build with a DelegationNote
 * update, which is what fills the action history here.
 */
@customElement("delegation-panel")
export class DelegationPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private show = false;
  @state() private enabled = false;
  @state() private reservePercent = 50;
  @state() private actions: DelegationAction[] = [];
  @state() private totalSpent = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ToggleDelegationPanelEvent, (e) => {
      this.show = e.isVisible ?? !this.show;
    });
  }

  getTickIntervalMs() {
    return 200;
  }

  private isSolo(): boolean {
    return (
      this.game?.config().gameConfig().gameType === GameType.Singleplayer
    );
  }

  tick() {
    if (this.game === undefined || this.game === null) return;
    if (!this.isSolo()) return;
    if (this.game.inSpawnPhase()) return;
    const updates = this.game.updatesSinceLastTick();
    if (updates === null) return;
    const notes = (updates[GameUpdateType.DelegationNote] ??
      []) as DelegationNoteUpdate[];
    if (notes.length === 0) return;
    const t = this.game.ticks();
    const fresh: DelegationAction[] = notes.map((n) => ({
      tick: t,
      unit: n.unit,
      cost: n.cost,
    }));
    for (const f of fresh) this.totalSpent += f.cost;
    this.actions = [...fresh, ...this.actions].slice(0, MAX_HISTORY);
  }

  private setEnabled(on: boolean): void {
    this.enabled = on;
    this.eventBus.emit(new SetDefenseDelegationEvent(on, this.reservePercent));
  }

  private setReserve(pct: number): void {
    this.reservePercent = pct;
    // A reserve change while running applies immediately.
    if (this.enabled) {
      this.eventBus.emit(new SetDefenseDelegationEvent(true, pct));
    }
  }

  private actionLabel(unit: UnitType): string {
    return unit === UnitType.SAMLauncher
      ? translateText("delegation_panel.built_sam")
      : translateText("delegation_panel.built_post");
  }

  private renderHistory(): TemplateResult {
    return html`
      <section>
        <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
          ${translateText("delegation_panel.history")}
        </h3>
        <div class="flex items-center justify-between text-xs mb-2">
          <span class="text-white/60"
            >${translateText("delegation_panel.spent")}</span
          >
          <span class="text-amber-300 tabular-nums"
            >${this.totalSpent.toLocaleString()}</span
          >
        </div>
        ${this.actions.length === 0
          ? html`<div class="text-white/40 text-sm py-2">
              ${translateText("delegation_panel.history_empty")}
            </div>`
          : html`<div class="flex flex-col gap-1">
              ${this.actions.map(
                (a) => html`
                  <div
                    class="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-white/5"
                  >
                    <span class="text-white/40 tabular-nums shrink-0"
                      >${formatRecordDuration(a.tick)}</span
                    >
                    <span class="text-white/85 truncate"
                      >${this.actionLabel(a.unit)}</span
                    >
                    <span class="ml-auto text-amber-300/90 tabular-nums"
                      >-${a.cost.toLocaleString()}</span
                    >
                  </div>
                `,
              )}
            </div>`}
      </section>
    `;
  }

  render() {
    if (!this.show || !this.isSolo()) return nothing;
    const me = this.game.myPlayer();
    if (me === null || me === undefined || !me.isAlive()) return nothing;

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
              >${translateText("delegation_panel.title")}</span
            >
            <button
              class="text-white/50 hover:text-white text-lg leading-none px-2 cursor-pointer"
              @click=${() => (this.show = false)}
            >
              ✕
            </button>
          </div>
          <div class="flex flex-col gap-5 p-4">
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.heading")}
              </h3>
              <p class="text-xs text-white/60 mb-3 leading-relaxed">
                ${translateText("delegation_panel.desc")}
              </p>
              <button
                class="w-full rounded-lg px-3 py-2 text-sm font-bold transition-colors cursor-pointer ${this
                  .enabled
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                  : "bg-slate-700 hover:bg-slate-600 text-white/80"}"
                @click=${() => this.setEnabled(!this.enabled)}
              >
                ${this.enabled
                  ? translateText("delegation_panel.on")
                  : translateText("delegation_panel.off")}
              </button>
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.reserve")}
              </h3>
              <div class="flex gap-2 mb-2">
                ${RESERVE_OPTIONS.map(
                  (pct) => html`
                    <button
                      class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                        .reservePercent === pct
                        ? "bg-sky-600 text-white"
                        : "bg-slate-700 text-white/70 hover:bg-slate-600"}"
                      @click=${() => this.setReserve(pct)}
                    >
                      ${pct}%
                    </button>
                  `,
                )}
              </div>
              <p class="text-xs text-white/50">
                ${translateText("delegation_panel.reserve_hint", {
                  pct: this.reservePercent,
                })}
              </p>
            </section>
            ${this.renderHistory()}
          </div>
        </div>
      </div>
    `;
  }
}
