import {
  Difficulty,
  GameMode,
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { formatRecordDuration } from "../../LocalRecords";
import {
  SendAllianceRequestIntentEvent,
  SendBreakAllianceIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/** Toggles the diplomacy board overlay (외교). */
export class ToggleDiplomacyBoardEvent {
  constructor(public readonly isVisible?: boolean) {}
}

// 개선5: mirror of the engine's runawayLeadFactor (NationUtils.ts) so the
// board can flag the same hegemon the AI containment logic reacts to.
function runawayFactor(d: Difficulty): number | null {
  switch (d) {
    case Difficulty.Easy:
      return null;
    case Difficulty.Medium:
      return 3;
    case Difficulty.Hard:
      return 2;
    case Difficulty.Impossible:
      return 1.5;
  }
}

type RelationStatus = "allied" | "pendingOut" | "pendingIn" | "war" | "neutral";

@customElement("diplomacy-board")
export class DiplomacyBoard extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private show = false;
  // Bumping this re-renders on data ticks while the panel is open.
  @state() private dataVersion = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ToggleDiplomacyBoardEvent, (e) => {
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
    if (this.show) this.dataVersion++;
  }

  private chip(p: PlayerView): TemplateResult {
    return html`<span
      class="w-2.5 h-2.5 rounded-sm shrink-0 inline-block"
      style="background:${p.territoryColor().toRgbString()}"
    ></span>`;
  }

  private nameSpan(p: PlayerView): TemplateResult {
    return html`<span
      class="font-bold truncate"
      style="color:${p.territoryColor().toRgbString()}"
      >${p.name()}</span
    >`;
  }

  // The runaway leader, computed exactly like the engine sees it: FFA only,
  // non-bot players, leader must own factor x the runner-up's tiles.
  private runawayLeader(): PlayerView | null {
    const cfg = this.game.config().gameConfig();
    if (cfg.gameMode !== GameMode.FFA) return null;
    const factor = runawayFactor(cfg.difficulty);
    if (factor === null) return null;
    let leader: PlayerView | null = null;
    let runnerUp: PlayerView | null = null;
    for (const p of this.game.playerViews()) {
      if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
      if (leader === null || p.numTilesOwned() > leader.numTilesOwned()) {
        runnerUp = leader;
        leader = p;
      } else if (
        runnerUp === null ||
        p.numTilesOwned() > runnerUp.numTilesOwned()
      ) {
        runnerUp = p;
      }
    }
    if (leader === null || runnerUp === null) return null;
    return leader.numTilesOwned() >= runnerUp.numTilesOwned() * factor
      ? leader
      : null;
  }

  private renderThreatSection(me: PlayerView): TemplateResult {
    const valid = this.game.numLandTiles() - this.game.numTilesWithFallout();
    const leader = this.runawayLeader();
    const leaderPct =
      leader !== null && valid > 0
        ? ((leader.numTilesOwned() / valid) * 100).toFixed(1)
        : null;

    // Aggregate my incoming attacks by attacker.
    const incoming = new Map<number, number>();
    for (const atk of me.incomingAttacks()) {
      if (atk.retreating) continue;
      incoming.set(
        atk.attackerID,
        (incoming.get(atk.attackerID) ?? 0) + atk.troops,
      );
    }
    const attackers = [...incoming.entries()]
      .map(([smallID, troops]) => {
        try {
          const p = this.game.playerBySmallID(smallID);
          return p.isPlayer() ? { p, troops } : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: PlayerView; troops: number } => x !== null)
      .sort((a, b) => b.troops - a.troops)
      .slice(0, 5);

    return html`
      <section>
        <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
          ${translateText("diplomacy_board.threats")}
        </h3>
        ${leader !== null && leaderPct !== null
          ? html`<div
              class="mb-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
            >
              ${translateText("diplomacy_board.hegemon", {
                name: leader.name(),
                pct: leaderPct,
              })}
            </div>`
          : nothing}
        ${attackers.length === 0
          ? html`<div class="text-white/40 text-sm py-2">
              ${translateText("diplomacy_board.threats_empty")}
            </div>`
          : html`<div class="flex flex-col gap-1">
              ${attackers.map(
                ({ p, troops }) => html`
                  <div class="flex items-center gap-2 text-xs">
                    ${this.chip(p)}
                    <span class="text-white/85 truncate">${p.name()}</span>
                    <span class="ml-auto text-red-300 tabular-nums"
                      >${Math.round(troops).toLocaleString()}</span
                    >
                  </div>
                `,
              )}
            </div>`}
      </section>
    `;
  }

  private renderAllianceSection(me: PlayerView): TemplateResult {
    // Dedupe pairs: each side's own alliances() view lists the same link.
    const seen = new Set<string>();
    const rows: {
      a: PlayerView;
      b: PlayerView;
      expiresAt: number;
      mine: boolean;
    }[] = [];
    for (const p of this.game.playerViews()) {
      if (!p.isAlive()) continue;
      for (const al of p.alliances()) {
        let other: PlayerView;
        try {
          other = this.game.player(al.other);
        } catch {
          continue;
        }
        if (!other.isAlive()) continue;
        const key = [p.id(), other.id()].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          a: p,
          b: other,
          expiresAt: al.expiresAt,
          mine: p.id() === me.id() || other.id() === me.id(),
        });
      }
    }
    rows.sort((x, y) => Number(y.mine) - Number(x.mine));

    return html`
      <section>
        <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
          ${translateText("diplomacy_board.alliances")}
        </h3>
        ${rows.length === 0
          ? html`<div class="text-white/40 text-sm py-2">
              ${translateText("diplomacy_board.alliances_empty")}
            </div>`
          : html`<div class="flex flex-col gap-1">
              ${rows.map(
                (r) => html`
                  <div
                    class="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${r.mine
                      ? "bg-emerald-500/10 border border-emerald-400/30"
                      : ""}"
                  >
                    ${this.chip(r.a)} ${this.nameSpan(r.a)}
                    <span class="text-white/40">↔</span>
                    ${this.chip(r.b)} ${this.nameSpan(r.b)}
                    <span class="ml-auto text-white/45 tabular-nums shrink-0">
                      ${translateText("diplomacy_board.remaining", {
                        time: formatRecordDuration(
                          Math.max(0, r.expiresAt - this.game.ticks()),
                        ),
                      })}
                    </span>
                  </div>
                `,
              )}
            </div>`}
      </section>
    `;
  }

  private statusOf(me: PlayerView, other: PlayerView): RelationStatus {
    if (me.isAlliedWith(other)) return "allied";
    if (me.isRequestingAllianceWith(other)) return "pendingOut";
    if (other.isRequestingAllianceWith(me)) return "pendingIn";
    const atWar =
      me.outgoingAttacks().some((a) => a.targetID === other.smallID()) ||
      other.outgoingAttacks().some((a) => a.targetID === me.smallID());
    return atWar ? "war" : "neutral";
  }

  private renderNationRow(me: PlayerView, other: PlayerView): TemplateResult {
    const valid = this.game.numLandTiles() - this.game.numTilesWithFallout();
    const pct = valid > 0 ? (other.numTilesOwned() / valid) * 100 : 0;
    const status = this.statusOf(me, other);
    const statusKey = {
      allied: "diplomacy_board.st_allied",
      pendingOut: "diplomacy_board.st_pending_out",
      pendingIn: "diplomacy_board.st_pending_in",
      war: "diplomacy_board.st_war",
      neutral: "diplomacy_board.st_neutral",
    }[status];
    const statusClass = {
      allied: "text-emerald-300 border-emerald-400/40",
      pendingOut: "text-sky-300 border-sky-400/40",
      pendingIn: "text-amber-300 border-amber-400/40",
      war: "text-red-300 border-red-400/40",
      neutral: "text-white/45 border-white/20",
    }[status];

    const allyNames = other
      .allies()
      .filter((a) => a.isAlive())
      .map((a) => a.name());

    const alliancesOn = !this.game.config().disableAlliances();
    return html`
      <div
        class="flex flex-col gap-1 px-2 py-2 rounded-lg hover:bg-white/5 border border-white/5"
      >
        <div class="flex items-center gap-2 text-xs min-w-0">
          ${this.chip(other)}
          <span class="text-white/85 font-bold truncate">${other.name()}</span>
          <span
            class="px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${statusClass}"
            >${translateText(statusKey)}</span
          >
          <span class="ml-auto text-white/50 tabular-nums shrink-0"
            >${pct.toFixed(1)}%</span
          >
          ${alliancesOn
            ? status === "allied"
              ? html`<button
                  class="shrink-0 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/35 border border-red-400/40 text-red-200 text-[11px] cursor-pointer"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.eventBus.emit(
                      new SendBreakAllianceIntentEvent(me, other),
                    );
                  }}
                >
                  ${translateText("diplomacy_board.break")}
                </button>`
              : status === "pendingOut"
                ? html`<span
                    class="shrink-0 px-2 py-1 text-white/40 text-[11px]"
                    >${translateText("diplomacy_board.waiting_reply")}</span
                  >`
                : html`<button
                    class="shrink-0 px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/40 text-emerald-200 text-[11px] cursor-pointer"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.eventBus.emit(
                        new SendAllianceRequestIntentEvent(me, other),
                      );
                    }}
                  >
                    ${translateText("diplomacy_board.offer")}
                  </button>`
            : nothing}
        </div>
        ${allyNames.length > 0
          ? html`<div class="text-[10px] text-white/40 truncate pl-5">
              ${translateText("diplomacy_board.allies_of", {
                list: allyNames.join(", "),
              })}
            </div>`
          : nothing}
      </div>
    `;
  }

  render() {
    if (!this.show || !this.isSolo()) return nothing;
    const me = this.game.myPlayer();
    if (me === null || me === undefined || !me.isAlive()) return nothing;

    const nations = this.game
      .playerViews()
      .filter(
        (p) => p.isAlive() && p.id() !== me.id() && p.type() !== PlayerType.Bot,
      )
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());

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
              >${translateText("diplomacy_board.title")}</span
            >
            <button
              class="text-white/50 hover:text-white text-lg leading-none px-2 cursor-pointer"
              @click=${() => (this.show = false)}
            >
              ✕
            </button>
          </div>
          <div class="flex flex-col gap-5 p-4">
            ${this.renderThreatSection(me)} ${this.renderAllianceSection(me)}
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("diplomacy_board.nations")}
              </h3>
              ${this.game.config().disableAlliances()
                ? html`<div class="text-white/40 text-sm py-2">
                    ${translateText("diplomacy_board.disabled")}
                  </div>`
                : html`<div class="flex flex-col gap-1">
                    ${nations.map((n) => this.renderNationRow(me, n))}
                  </div>`}
            </section>
          </div>
        </div>
      </div>
    `;
  }
}
