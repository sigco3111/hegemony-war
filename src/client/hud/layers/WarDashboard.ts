import { GameType } from "@openfront/engine-api/game/GameTypes";
import {
  AllianceExpiredUpdate,
  AllianceRequestReplyUpdate,
  BrokeAllianceUpdate,
  ConquestUpdate,
  DiplomacyNoteReason,
  DiplomacyNoteUpdate,
  EmbargoUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, svg, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { formatRecordDuration } from "../../LocalRecords";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/** Toggles the war dashboard overlay (전황). */
export class ToggleWarDashboardEvent {
  constructor(public readonly isVisible?: boolean) {}
}

interface PlayerFace {
  name: string;
  color: string;
}

interface ShareSample {
  tick: number;
  // playerID -> tiles owned, alive players only
  tiles: Record<string, number>;
}

type ChronicleKind =
  | "attack"
  | "conquest"
  | "alliance"
  | "allianceBroken"
  | "allianceExpired"
  | "embargo";

interface ChronicleEntry {
  tick: number;
  kind: ChronicleKind;
  a?: PlayerFace;
  b?: PlayerFace;
  troops?: number;
  // 개선5: factual reason the acting AI nation emitted for this move.
  reason?: { code: DiplomacyNoteReason; threat?: PlayerFace };
}

interface RecentNote {
  tick: number;
  reason: DiplomacyNoteReason;
  threatID: number | null;
}

// Samples land every SAMPLE_EVERY_TICKS; when the buffer is full every other
// sample is dropped, so a long game keeps its whole arc at half resolution.
const SAMPLE_EVERY_TICKS = 20; // 2s at 100ms/tick
const MAX_SAMPLES = 600;
const MAX_CHRONICLE = 200;
const PIE_TOP = 7;
const TREND_TOP = 5;

@customElement("war-dashboard")
export class WarDashboard extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private show = false;
  // Bumping this re-renders on data ticks while the panel is open.
  @state() private dataVersion = 0;

  private samples: ShareSample[] = [];
  private chronicle: ChronicleEntry[] = [];
  private faces = new Map<string, PlayerFace>();
  private seenAttacks = new Set<string>();
  private lastTickSampled = -1;
  // "actorSmallID->targetSmallID" -> latest note, kept for a few ticks so a
  // note and the event it explains match even across a tick boundary.
  private recentNotes = new Map<string, RecentNote>();

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ToggleWarDashboardEvent, (e) => {
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

    this.rememberFaces();
    this.collectChronicle();

    const t = this.game.ticks();
    if (t % SAMPLE_EVERY_TICKS === 0 && t !== this.lastTickSampled) {
      this.lastTickSampled = t;
      const tiles: Record<string, number> = {};
      for (const p of this.game.playerViews()) {
        if (!p.isAlive()) continue;
        const n = p.numTilesOwned();
        if (n > 0) tiles[p.id()] = n;
      }
      this.samples.push({ tick: t, tiles });
      if (this.samples.length > MAX_SAMPLES) {
        this.samples = this.samples.filter((_, i) => i % 2 === 0);
      }
    }

    if (this.show) this.dataVersion++;
  }

  private rememberFaces() {
    for (const p of this.game.playerViews()) {
      if (!this.faces.has(p.id())) {
        this.faces.set(p.id(), {
          name: p.name(),
          color: p.territoryColor().toRgbString(),
        });
      }
    }
  }

  private faceOf(p: PlayerView): PlayerFace {
    const known = this.faces.get(p.id());
    if (known) return known;
    return { name: p.name(), color: p.territoryColor().toRgbString() };
  }

  // Conquest updates carry PlayerIDs; alliance/embargo/attack updates carry
  // small IDs.
  private face(id: string): PlayerFace {
    const known = this.faces.get(id);
    if (known) return known;
    try {
      return this.faceOf(this.game.player(id));
    } catch {
      return { name: "?", color: "#888888" };
    }
  }

  private faceBySmallID(id: number): PlayerFace {
    try {
      const p = this.game.playerBySmallID(id);
      if (!p.isPlayer()) return { name: "?", color: "#888888" };
      return this.faceOf(p);
    } catch {
      return { name: "?", color: "#888888" };
    }
  }

  // The acceptor's note explains a formed alliance (actor = recipient, or
  // the requestor for AI-initiated containment outreach); the breaker's note
  // explains a break (actor = traitor). Match either direction of the pair.
  private findNote(
    x: number,
    y: number,
  ): { code: DiplomacyNoteReason; threat?: PlayerFace } | undefined {
    const note =
      this.recentNotes.get(`${x}->${y}`) ?? this.recentNotes.get(`${y}->${x}`);
    if (note === undefined) return undefined;
    return {
      code: note.reason,
      threat:
        note.threatID === null ? undefined : this.faceBySmallID(note.threatID),
    };
  }

  private pushChronicle(entry: ChronicleEntry) {
    this.chronicle.push(entry);
    if (this.chronicle.length > MAX_CHRONICLE) {
      this.chronicle.splice(0, this.chronicle.length - MAX_CHRONICLE);
    }
  }

  private collectChronicle() {
    // New attacks: every player's outgoing attacks carry a stable id.
    // The set is capped: a very long game would otherwise grow it without
    // bound. Clearing risks re-listing attacks still in flight, which is
    // the acceptable trade.
    if (this.seenAttacks.size > 50000) this.seenAttacks.clear();
    for (const p of this.game.playerViews()) {
      for (const atk of p.outgoingAttacks()) {
        if (this.seenAttacks.has(atk.id)) continue;
        this.seenAttacks.add(atk.id);
        let target: PlayerView | null = null;
        try {
          const t = this.game.playerBySmallID(atk.targetID);
          target = t.isPlayer() ? t : null;
        } catch {
          target = null;
        }
        // Attacks on unclaimed land have no player target; the chronicle is
        // about wars between nations, not settlement.
        if (target === null) continue;
        if (target.id() === p.id()) continue;
        this.pushChronicle({
          tick: this.game.ticks(),
          kind: "attack",
          a: this.faceOf(p),
          b: this.faceOf(target),
          troops: atk.troops,
        });
      }
    }

    const updates = this.game.updatesSinceLastTick();
    if (updates === null) return;
    const t = this.game.ticks();

    // Notes first: the alliance/break entries below look them up.
    for (const n of (updates[GameUpdateType.DiplomacyNote] ??
      []) as DiplomacyNoteUpdate[]) {
      this.recentNotes.set(`${n.actorID}->${n.targetID}`, {
        tick: t,
        reason: n.reason,
        threatID: n.threatID,
      });
    }
    if (this.recentNotes.size > 120) {
      for (const [k, v] of this.recentNotes) {
        if (v.tick < t - 200) this.recentNotes.delete(k);
      }
    }

    for (const c of (updates[GameUpdateType.ConquestEvent] ??
      []) as ConquestUpdate[]) {
      this.pushChronicle({
        tick: t,
        kind: "conquest",
        a: this.face(c.conquerorId),
        b: this.face(c.conqueredId),
      });
    }
    for (const r of (updates[GameUpdateType.AllianceRequestReply] ??
      []) as AllianceRequestReplyUpdate[]) {
      if (!r.accepted) continue;
      this.pushChronicle({
        tick: t,
        kind: "alliance",
        a: this.faceBySmallID(r.request.requestorID),
        b: this.faceBySmallID(r.request.recipientID),
        reason: this.findNote(
          r.request.recipientID,
          r.request.requestorID,
        ),
      });
    }
    for (const b of (updates[GameUpdateType.BrokeAlliance] ??
      []) as BrokeAllianceUpdate[]) {
      this.pushChronicle({
        tick: t,
        kind: "allianceBroken",
        a: this.faceBySmallID(b.traitorID),
        b: this.faceBySmallID(b.betrayedID),
        reason: this.findNote(b.traitorID, b.betrayedID),
      });
    }
    for (const x of (updates[GameUpdateType.AllianceExpired] ??
      []) as AllianceExpiredUpdate[]) {
      this.pushChronicle({
        tick: t,
        kind: "allianceExpired",
        a: this.faceBySmallID(x.player1ID),
        b: this.faceBySmallID(x.player2ID),
      });
    }
    for (const e of (updates[GameUpdateType.EmbargoEvent] ??
      []) as EmbargoUpdate[]) {
      if (e.event !== "start") continue;
      this.pushChronicle({
        tick: t,
        kind: "embargo",
        a: this.faceBySmallID(e.playerID),
        b: this.faceBySmallID(e.embargoedID),
      });
    }
  }

  private currentShares(): { face: PlayerFace; pct: number }[] {
    const valid =
      this.game.numLandTiles() - this.game.numTilesWithFallout();
    if (valid <= 0) return [];
    const rows = this.game
      .playerViews()
      .filter((p) => p.isAlive() && p.numTilesOwned() > 0)
      .map((p) => ({
        face: this.face(p.id()),
        tiles: p.numTilesOwned(),
      }))
      .sort((a, b) => b.tiles - a.tiles);
    const top = rows.slice(0, PIE_TOP);
    const restTiles = rows
      .slice(PIE_TOP)
      .reduce((acc, r) => acc + r.tiles, 0);
    const out = top.map((r) => ({
      face: r.face,
      pct: (r.tiles / valid) * 100,
    }));
    if (restTiles > 0) {
      out.push({
        face: {
          name: translateText("war_dashboard.others"),
          color: "#64748b",
        },
        pct: (restTiles / valid) * 100,
      });
    }
    return out;
  }

  private renderPie(): TemplateResult {
    const shares = this.currentShares();
    if (shares.length === 0) {
      return html`<div class="text-white/40 text-sm py-6 text-center">
        ${translateText("war_dashboard.waiting")}
      </div>`;
    }
    // Circle segments via stroke-dasharray on a pathLength-100 circle.
    let offset = 25; // start at 12 o'clock
    const segs = shares.map((s) => {
      const len = Math.max(s.pct, 0.2);
      const seg = svg`<circle
        r="15.915"
        cx="21"
        cy="21"
        fill="none"
        stroke=${s.face.color}
        stroke-width="10"
        pathLength="100"
        stroke-dasharray="${len} ${100 - len}"
        stroke-dashoffset=${offset}
      />`;
      offset -= len;
      return seg;
    });
    return html`
      <div class="flex items-center gap-3">
        <svg viewBox="0 0 42 42" class="w-32 h-32 shrink-0">${segs}</svg>
        <div class="flex flex-col gap-1 min-w-0 flex-1">
          ${shares.map(
            (s) => html`
              <div class="flex items-center gap-2 text-xs min-w-0">
                <span
                  class="w-2.5 h-2.5 rounded-sm shrink-0"
                  style="background:${s.face.color}"
                ></span>
                <span class="text-white/85 truncate">${s.face.name}</span>
                <span class="ml-auto text-white/50 tabular-nums"
                  >${s.pct.toFixed(1)}%</span
                >
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderTrend(): TemplateResult {
    if (this.samples.length < 2) {
      return html`<div class="text-white/40 text-sm py-6 text-center">
        ${translateText("war_dashboard.waiting")}
      </div>`;
    }
    const valid =
      this.game.numLandTiles() - this.game.numTilesWithFallout();
    const latest = this.samples[this.samples.length - 1].tiles;
    const topIds = Object.entries(latest)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TREND_TOP)
      .map(([id]) => id);
    const myId = this.game.myPlayer()?.id();
    if (myId && !topIds.includes(myId) && latest[myId] !== undefined) {
      topIds.push(myId);
    }
    const W = 300;
    const H = 110;
    const n = this.samples.length;
    const maxPct = Math.max(
      20,
      ...this.samples.flatMap((s) =>
        topIds.map((id) => ((s.tiles[id] ?? 0) / valid) * 100),
      ),
    );
    const lines = topIds.map((id) => {
      const face = this.face(id);
      const pts = this.samples
        .map((s, i) => {
          const x = (i / (n - 1)) * W;
          const pct = ((s.tiles[id] ?? 0) / valid) * 100;
          const y = H - (pct / maxPct) * (H - 8) - 4;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      const emphasized = id === myId;
      return svg`
        <polyline
          points=${pts}
          fill="none"
          stroke=${face.color}
          stroke-width=${emphasized ? 2.4 : 1.4}
          stroke-opacity=${emphasized ? 1 : 0.75}
        />
      `;
    });
    const first = this.samples[0].tick;
    const last = this.samples[n - 1].tick;
    return html`
      <div>
        <svg
          viewBox="0 0 ${W} ${H}"
          class="w-full h-28 bg-black/30 rounded-lg"
          preserveAspectRatio="none"
        >
          ${lines}
        </svg>
        <div
          class="flex justify-between text-[10px] text-white/40 tabular-nums mt-1"
        >
          <span>${formatRecordDuration(first)}</span>
          <span>${formatRecordDuration(last)}</span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1">
          ${topIds.map((id) => {
            const face = this.face(id);
            return html`<span class="flex items-center gap-1 text-[10px]">
              <span
                class="w-2 h-2 rounded-sm"
                style="background:${face.color}"
              ></span>
              <span class="text-white/70"
                >${face.name}${id === myId
                  ? ` (${translateText("war_dashboard.you")})`
                  : nothing}</span
              >
            </span>`;
          })}
        </div>
      </div>
    `;
  }

  private renderChronicleRow(e: ChronicleEntry): TemplateResult {
    const name = (f?: PlayerFace) =>
      f === undefined
        ? nothing
        : html`<span class="font-bold" style="color:${f.color}"
            >${f.name}</span
          >`;
    const twoWay = e.kind === "alliance" || e.kind === "allianceExpired";
    const labelKey = {
      attack: "war_dashboard.k_attack",
      conquest: "war_dashboard.k_conquest",
      alliance: "war_dashboard.k_alliance",
      allianceBroken: "war_dashboard.k_broken",
      allianceExpired: "war_dashboard.k_expired",
      embargo: "war_dashboard.k_embargo",
    }[e.kind];
    return html`
      <div
        class="flex items-baseline gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5"
      >
        <span class="text-[10px] text-white/40 tabular-nums shrink-0 w-10"
          >${formatRecordDuration(e.tick)}</span
        >
        <span class="text-xs text-white/80 leading-snug"
          >${name(e.a)}
          <span class="text-white/40">${twoWay ? " ↔ " : " → "}</span>
          ${name(e.b)}
          <span class="text-white/55"> ${translateText(labelKey)}</span>
          ${e.reason === undefined
            ? nothing
            : html`<span class="text-white/40">
                —
                ${translateText(`war_dashboard.r_${e.reason.code}`, {
                  threat: e.reason.threat?.name ?? "",
                })}</span
              >`}</span
        >
      </div>
    `;
  }

  render() {
    if (!this.show || !this.isSolo()) return nothing;
    const entries = [...this.chronicle].reverse();
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
              >${translateText("war_dashboard.title")}</span
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
                ${translateText("war_dashboard.shares")}
              </h3>
              ${this.renderPie()}
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("war_dashboard.trend")}
              </h3>
              ${this.renderTrend()}
            </section>
            <section>
              <h3 class="text-xs font-bold text-white/60 uppercase mb-2">
                ${translateText("war_dashboard.chronicle")}
              </h3>
              ${entries.length === 0
                ? html`<div class="text-white/40 text-sm py-4 text-center">
                    ${translateText("war_dashboard.chronicle_empty")}
                  </div>`
                : html`<div class="flex flex-col">
                    ${entries.map((e) => this.renderChronicleRow(e))}
                  </div>`}
            </section>
          </div>
        </div>
      </div>
    `;
  }
}
