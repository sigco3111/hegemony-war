import {
  DEFENSE_PRIORITIES,
  DefensePriority,
  delegationZoneRadius,
} from "@openfront/engine-api/game/DefenseDelegation";
import { GameType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DelegationNoteUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  DelegationZoneChangedEvent,
  DelegationZonePickedEvent,
  DelegationZonePickModeEvent,
} from "../../DelegationZoneEvents";
import { formatRecordDuration } from "../../LocalRecords";
import {
  SetDefenseDelegationEvent,
  SetEconomyDelegationEvent,
} from "../../Transport";
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
  /** 개선 9: which structures the delegate may build. */
  @state() private buildPosts = true;
  @state() private buildSams = true;
  /** 개선 9: which build kind is attempted first. */
  @state() private priority: DefensePriority = "reactive";
  /** 개선 9: protected-zone center tile; null = delegate anywhere. */
  @state() private zoneTile: number | null = null;
  /** 개선 9: waiting for the player to click the zone center on the map. */
  @state() private pickMode = false;
  @state() private actions: DelegationAction[] = [];
  @state() private totalSpent = 0;
  /**
   * Treasury when the delegation was switched on; mirrors the engine anchor.
   * The reserve floor is reservePercent of this fixed amount, so consecutive
   * builds cannot ratchet it down. Reset only on off→on; a reservePercent
   * change while on keeps the anchor.
   */
  @state() private anchorGold: bigint | null = null;
  /** Why the delegate is idle right now; null while disabled. */
  @state() private status: "hold" | "threat" | "watch" | null = null;
  /** Last known defense-post cost (escalates per post owned). */
  private postCost: bigint | null = null;
  private costRefreshTick = -1000;
  private costFetchInFlight = false;

  /** 개선 11: economy delegation (cities + factories) state. */
  @state() private econEnabled = false;
  @state() private econReservePercent = 50;
  @state() private econCities = true;
  @state() private econFactories = true;
  /**
   * Treasury when the economy delegation was switched on; mirrors the
   * engine anchor. Its floor stacks ON TOP of the defense floor, so the
   * two delegations never spend each other's budget.
   */
  @state() private econAnchorGold: bigint | null = null;
  @state() private econStatus: "hold" | "watch" | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ToggleDelegationPanelEvent, (e) => {
      this.show = e.isVisible ?? !this.show;
      // Re-opening the panel cancels a pending zone pick.
      if (this.show && this.pickMode) this.cancelZonePick();
    });
    this.eventBus.on(DelegationZonePickedEvent, (e) => {
      this.pickMode = false;
      this.zoneTile = e.tile;
      this.show = true;
      if (this.enabled) this.emitSettings();
      this.emitZoneChanged();
    });
  }

  /** Sends the full current settings; the latest intent always wins. */
  private emitSettings(): void {
    this.eventBus.emit(
      new SetDefenseDelegationEvent(
        this.enabled,
        this.reservePercent,
        this.buildPosts,
        this.buildSams,
        this.priority,
        this.zoneTile,
      ),
    );
  }

  /** Keeps the map's zone ring in sync with the panel's zone state. */
  private emitZoneChanged(): void {
    if (this.game === undefined || this.game === null) return;
    const radius =
      this.zoneTile === null
        ? 0
        : delegationZoneRadius(this.game.width(), this.game.height());
    this.eventBus.emit(new DelegationZoneChangedEvent(this.zoneTile, radius));
  }

  private startZonePick(): void {
    this.pickMode = true;
    this.show = false;
    this.eventBus.emit(new DelegationZonePickModeEvent(true));
  }

  private cancelZonePick(): void {
    this.pickMode = false;
    this.show = true;
    this.eventBus.emit(new DelegationZonePickModeEvent(false));
  }

  private clearZone(): void {
    this.zoneTile = null;
    if (this.enabled) this.emitSettings();
    this.emitZoneChanged();
  }

  private togglePosts(): void {
    this.buildPosts = !this.buildPosts;
    if (this.enabled) this.emitSettings();
  }

  private toggleSams(): void {
    this.buildSams = !this.buildSams;
    if (this.enabled) this.emitSettings();
  }

  private setPriority(priority: DefensePriority): void {
    this.priority = priority;
    if (this.enabled) this.emitSettings();
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
    const notes = (updates?.[GameUpdateType.DelegationNote] ??
      []) as DelegationNoteUpdate[];
    if (notes.length > 0) {
      const t = this.game.ticks();
      const fresh: DelegationAction[] = notes.map((n) => ({
        tick: t,
        unit: n.unit,
        cost: n.cost,
      }));
      for (const f of fresh) this.totalSpent += f.cost;
      this.actions = [...fresh, ...this.actions].slice(0, MAX_HISTORY);
    }
    void this.refreshStatus();
    this.refreshEconStatus();
  }

  /** Engine mirror: UNDER_ATTACK_THREAT_RATIO in DefensePostPlacement. */
  private static readonly REACTIVE_THREAT_RATIO = 0.35;

  /**
   * Keeps `status` truthful so an empty history is never misread as a
   * broken delegation: "hold" when every build would break the reserve
   * floor, "threat" when an incoming attack crosses the engine's build
   * ratio, "watch" otherwise. Placement itself is engine-side, so a
   * "threat" status can persist while the engine searches for a tile.
   */
  private async refreshStatus(): Promise<void> {
    const me = this.game.myPlayer();
    if (
      !this.enabled ||
      this.anchorGold === null ||
      me === null ||
      me === undefined ||
      !me.isAlive()
    ) {
      if (this.status !== null) this.status = null;
      return;
    }
    const tick = this.game.ticks();
    if (tick - this.costRefreshTick >= 50 && !this.costFetchInFlight) {
      this.costFetchInFlight = true;
      this.costRefreshTick = tick;
      try {
        const list = await me.buildables(undefined, [UnitType.DefensePost]);
        this.postCost =
          list.find((b) => b.type === UnitType.DefensePost)?.cost ?? null;
      } catch {
        // Keep the last known cost.
      } finally {
        this.costFetchInFlight = false;
      }
    }
    const floor = this.reserveFloor();
    const gold = me.gold();
    if (
      floor !== null &&
      this.postCost !== null &&
      gold - this.postCost < floor
    ) {
      this.status = "hold";
      return;
    }
    const incoming = me
      .incomingAttacks()
      .reduce((sum, a) => sum + a.troops, 0);
    const troops = me.troops();
    if (
      troops > 0 &&
      incoming / troops >= DelegationPanel.REACTIVE_THREAT_RATIO
    ) {
      this.status = "threat";
      return;
    }
    this.status = "watch";
  }

  /**
   * 개선 11: keeps the economy section's status truthful — "hold" when the
   * cheapest enabled build would break the combined (own + defense)
   * reserve floor, "watch" otherwise.
   */
  private refreshEconStatus(): void {
    const me = this.game.myPlayer();
    if (
      !this.econEnabled ||
      this.econAnchorGold === null ||
      me === null ||
      me === undefined ||
      !me.isAlive()
    ) {
      if (this.econStatus !== null) this.econStatus = null;
      return;
    }
    const floor = this.econCombinedFloor();
    // Cheapest possible build proxy: the defense-post cost fetch already
    // runs for the defense section; a city/factory costs more, so if even
    // the combined floor exceeds the balance the delegate is holding.
    const gold = me.gold();
    if (floor !== null && gold < floor) {
      this.econStatus = "hold";
      return;
    }
    this.econStatus = "watch";
  }

  private setEnabled(on: boolean): void {
    if (on && !this.enabled) {
      // Off→on: re-anchor the reserve basis to the current treasury.
      this.anchorGold = this.game.myPlayer()?.gold() ?? null;
    }
    if (!on) {
      this.anchorGold = null;
    }
    this.enabled = on;
    this.emitSettings();
  }

  private reserveFloor(): bigint | null {
    if (this.anchorGold === null) return null;
    return (this.anchorGold * BigInt(this.reservePercent)) / 100n;
  }

  private setReserve(pct: number): void {
    this.reservePercent = pct;
    // A reserve change while running applies immediately.
    if (this.enabled) this.emitSettings();
  }

  /** 개선 11: sends the current economy delegation settings. */
  private emitEconSettings(): void {
    this.eventBus.emit(
      new SetEconomyDelegationEvent(
        this.econEnabled,
        this.econReservePercent,
        this.econCities,
        this.econFactories,
      ),
    );
  }

  private setEconEnabled(on: boolean): void {
    if (on && !this.econEnabled) {
      // Off→on: re-anchor the reserve basis to the current treasury.
      this.econAnchorGold = this.game.myPlayer()?.gold() ?? null;
    }
    if (!on) {
      this.econAnchorGold = null;
    }
    this.econEnabled = on;
    this.emitEconSettings();
  }

  private econReserveFloor(): bigint | null {
    if (this.econAnchorGold === null) return null;
    return (
      (this.econAnchorGold * BigInt(this.econReservePercent)) / 100n
    );
  }

  /** Combined floor the economy delegate keeps (own + defense budget). */
  private econCombinedFloor(): bigint | null {
    const own = this.econReserveFloor();
    if (own === null) return null;
    const defense = this.reserveFloor() ?? 0n;
    return own + defense;
  }

  private setEconReserve(pct: number): void {
    this.econReservePercent = pct;
    if (this.econEnabled) this.emitEconSettings();
  }

  private toggleEconCities(): void {
    this.econCities = !this.econCities;
    if (this.econEnabled) this.emitEconSettings();
  }

  private toggleEconFactories(): void {
    this.econFactories = !this.econFactories;
    if (this.econEnabled) this.emitEconSettings();
  }

  private actionLabel(unit: UnitType): string {
    switch (unit) {
      case UnitType.SAMLauncher:
        return translateText("delegation_panel.built_sam");
      case UnitType.City:
        return translateText("delegation_panel.built_city");
      case UnitType.Factory:
        return translateText("delegation_panel.built_factory");
      default:
        return translateText("delegation_panel.built_post");
    }
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
    if (this.pickMode) {
      return html`
        <div
          class="fixed bottom-24 left-1/2 -translate-x-1/2 z-2100 flex items-center gap-3 rounded-xl border border-cyan-300/40 bg-slate-900/95 px-4 py-3 shadow-2xl"
        >
          <span class="text-sm text-cyan-200">
            ${translateText("delegation_panel.zone_pick_banner")}
          </span>
          <button
            class="rounded-lg px-2 py-1 text-xs font-bold bg-slate-700 text-white/80 hover:bg-slate-600 cursor-pointer"
            @click=${() => this.cancelZonePick()}
          >
            ${translateText("delegation_panel.zone_pick_cancel")}
          </button>
        </div>
      `;
    }
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
              ${this.enabled && this.status !== null
                ? html`<p
                    class="mt-2 text-xs ${this.status === "hold"
                      ? "text-amber-300/90"
                      : "text-white/55"}"
                  >
                    ${translateText(`delegation_panel.status_${this.status}`)}
                  </p>`
                : nothing}
            </section>
            ${this.enabled && !this.buildPosts && !this.buildSams
              ? html`<p class="text-xs text-amber-300/90 -mt-2">
                  ${translateText("delegation_panel.status_no_units")}
                </p>`
              : nothing}
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.structures")}
              </h3>
              <div class="flex gap-2">
                <button
                  class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                    .buildPosts
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-700 text-white/60 hover:bg-slate-600"}"
                  @click=${() => this.togglePosts()}
                >
                  ${translateText("delegation_panel.struct_post")}
                </button>
                <button
                  class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                    .buildSams
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-700 text-white/60 hover:bg-slate-600"}"
                  @click=${() => this.toggleSams()}
                >
                  ${translateText("delegation_panel.struct_sam")}
                </button>
              </div>
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.priority")}
              </h3>
              <div class="flex gap-2 mb-2">
                ${DEFENSE_PRIORITIES.map(
                  (p) => html`
                    <button
                      class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                        .priority === p
                        ? "bg-sky-600 text-white"
                        : "bg-slate-700 text-white/70 hover:bg-slate-600"}"
                      @click=${() => this.setPriority(p)}
                    >
                      ${translateText(`delegation_panel.priority_${p}`)}
                    </button>
                  `,
                )}
              </div>
              <p class="text-xs text-white/50">
                ${translateText("delegation_panel.priority_hint")}
              </p>
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.zone")}
              </h3>
              <p class="text-xs text-white/60 mb-2 leading-relaxed">
                ${translateText("delegation_panel.zone_desc")}
              </p>
              <div class="flex items-center gap-2">
                <span
                  class="flex-1 text-xs ${this.zoneTile === null
                    ? "text-white/50"
                    : "text-cyan-300"}"
                >
                  ${this.zoneTile === null
                    ? translateText("delegation_panel.zone_unset")
                    : translateText("delegation_panel.zone_set")}
                </span>
                <button
                  class="rounded-lg px-2 py-1.5 text-xs font-bold bg-slate-700 text-white/80 hover:bg-slate-600 transition-colors cursor-pointer"
                  @click=${() => this.startZonePick()}
                >
                  ${translateText("delegation_panel.zone_pick")}
                </button>
                ${this.zoneTile !== null
                  ? html`<button
                      class="rounded-lg px-2 py-1.5 text-xs font-bold bg-slate-700 text-white/60 hover:bg-slate-600 transition-colors cursor-pointer"
                      @click=${() => this.clearZone()}
                    >
                      ${translateText("delegation_panel.zone_clear")}
                    </button>`
                  : nothing}
              </div>
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
              ${this.enabled && this.reserveFloor() !== null
                ? html`<p class="text-xs text-amber-300/90 mt-1 tabular-nums">
                    ${translateText("delegation_panel.reserve_floor", {
                      amount: this.reserveFloor()!.toLocaleString(),
                    })}
                  </p>
                  <p class="text-xs text-white/40 mt-1">
                    ${translateText("delegation_panel.reserve_reset_hint")}
                  </p>`
                : nothing}
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("delegation_panel.econ_heading")}
              </h3>
              <p class="text-xs text-white/60 mb-3 leading-relaxed">
                ${translateText("delegation_panel.econ_desc")}
              </p>
              <button
                class="w-full rounded-lg px-3 py-2 text-sm font-bold transition-colors cursor-pointer ${this
                  .econEnabled
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                  : "bg-slate-700 hover:bg-slate-600 text-white/80"}"
                @click=${() => this.setEconEnabled(!this.econEnabled)}
              >
                ${this.econEnabled
                  ? translateText("delegation_panel.on")
                  : translateText("delegation_panel.off")}
              </button>
              ${this.econEnabled && this.econStatus !== null
                ? html`<p
                    class="mt-2 text-xs ${this.econStatus === "hold"
                      ? "text-amber-300/90"
                      : "text-white/55"}"
                  >
                    ${translateText(
                      `delegation_panel.econ_status_${this.econStatus}`,
                    )}
                  </p>`
                : nothing}
              <div class="flex gap-2 mt-3">
                <button
                  class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                    .econCities
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-700 text-white/60 hover:bg-slate-600"}"
                  @click=${() => this.toggleEconCities()}
                >
                  ${translateText("delegation_panel.struct_city")}
                </button>
                <button
                  class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                    .econFactories
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-700 text-white/60 hover:bg-slate-600"}"
                  @click=${() => this.toggleEconFactories()}
                >
                  ${translateText("delegation_panel.struct_factory")}
                </button>
              </div>
              <div class="flex gap-2 mt-3 mb-2">
                ${RESERVE_OPTIONS.map(
                  (pct) => html`
                    <button
                      class="flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer ${this
                        .econReservePercent === pct
                        ? "bg-sky-600 text-white"
                        : "bg-slate-700 text-white/70 hover:bg-slate-600"}"
                      @click=${() => this.setEconReserve(pct)}
                    >
                      ${pct}%
                    </button>
                  `,
                )}
              </div>
              <p class="text-xs text-white/50">
                ${translateText("delegation_panel.econ_reserve_hint", {
                  pct: this.econReservePercent,
                })}
              </p>
              ${this.econEnabled && this.econCombinedFloor() !== null
                ? html`<p class="text-xs text-amber-300/90 mt-1 tabular-nums">
                    ${translateText("delegation_panel.econ_reserve_floor", {
                      amount: this.econCombinedFloor()!.toLocaleString(),
                    })}
                  </p>`
                : nothing}
            </section>
            ${this.renderHistory()}
          </div>
        </div>
      </div>
    `;
  }
}
