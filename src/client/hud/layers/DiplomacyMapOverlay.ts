import { Cell } from "@openfront/engine-api/game/GameTypes";
import {
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, query } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  aggregateIncomingTroops,
  computeDiplomacyMarkers,
  DiplomacyMarker,
  DiplomacyOverlayStatusEvent,
  MarkerNationInput,
  ToggleDiplomacyOverlayEvent,
} from "../../DiplomacyMarkers";
import { AlternateViewEvent } from "../../InputHandler";
import { TransformHandler } from "../../TransformHandler";
import { UserSettings } from "../../UserSettings";
import { GameView, PlayerView } from "../../view";

/**
 * 개선 8: 지도 위 외교·위협 표시.
 *
 * Canvas overlay that draws, directly on the map:
 *  - emerald ring + 🤝 over my allies' capitals
 *  - pulsing red ring + ⚔ over the capitals of nations attacking me
 *  - pulsing amber diamond + ⚠ over the runaway leader (패권 위협)
 *  - pulsing red zones on the front-line clusters where enemies are pushing
 *    into my territory (positions cached from attackClusteredPositions)
 *
 * Singleplayer only; hidden during spawn, in replays, after my elimination,
 * and in the alternate (terrain) view. Toggled from the left sidebar;
 * the toggle persists in UserSettings (default on).
 *
 * Marker positions are recomputed on a 200ms tick; drawing runs every
 * animation frame so rings stay glued to the map while panning/zooming.
 */

const RING_ATTACKER = "rgba(248, 113, 113,"; // red-400
const RING_ALLY = "rgba(52, 211, 153,"; // emerald-400
const RING_HEGEMON = "rgba(251, 191, 36,"; // amber-400
const ZONE_FILL = "rgba(239, 68, 68,"; // red-500

const FRONT_POLL_MS = 400;
const PULSE_MS = 900;

@customElement("diplomacy-map-overlay")
export class DiplomacyMapOverlay extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transform: TransformHandler;

  @query("canvas") private canvas: HTMLCanvasElement;

  private userSettings = new UserSettings();
  private visible = true;
  private alternateView = false;
  private markers: DiplomacyMarker[] = [];
  private frontZones: { x: number; y: number }[] = [];
  private lastFrontPoll = 0;
  private frontPollInFlight = false;
  private attackTroopsById = new Map<string, number>();
  private lastStatusKey = "";
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.visible = this.userSettings.diplomacyMapOverlay();
    this.eventBus.on(ToggleDiplomacyOverlayEvent, (e) => {
      this.visible = e.isVisible ?? !this.visible;
      this.userSettings.setDiplomacyMapOverlay(this.visible);
      if (!this.visible) {
        this.markers = [];
        this.frontZones = [];
      }
      this.emitStatus();
    });
    this.eventBus.on(AlternateViewEvent, (e) => {
      this.alternateView = e.alternateView;
    });
    this.resizeObserver = new ResizeObserver(() => this.sizeCanvas());
    this.resizeObserver.observe(document.body);
    window.addEventListener("resize", () => this.sizeCanvas());
    const drive = () => {
      this.draw();
      this.rafId = requestAnimationFrame(drive);
    };
    this.rafId = requestAnimationFrame(drive);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
  }

  getTickIntervalMs() {
    return 200;
  }

  private active(): boolean {
    if (!this.visible || this.alternateView) return false;
    if (this.game === undefined || this.game === null) return false;
    if (this.game.config().isReplay()) return false;
    if (
      this.game.config().gameConfig().gameType !== GameType.Singleplayer
    )
      return false;
    if (this.game.inSpawnPhase()) return false;
    const me = this.game.myPlayer();
    return me !== null && me !== undefined && me.isAlive();
  }

  tick() {
    if (this.game === undefined || this.game === null) return;
    if (!this.active()) {
      if (this.markers.length > 0) this.markers = [];
      if (this.frontZones.length > 0) this.frontZones = [];
      this.emitStatus();
      return;
    }
    const me = this.game.myPlayer()!;
    const incoming = aggregateIncomingTroops(me.incomingAttacks());

    const nations: MarkerNationInput[] = [];
    for (const p of this.game.playerViews()) {
      if (p.id() === me.id()) continue;
      const loc = p.nameLocation();
      nations.push({
        smallID: p.smallID(),
        isMe: false,
        isAlive: p.isAlive(),
        isBot: p.type() === PlayerType.Bot,
        tilesOwned: p.numTilesOwned(),
        alliedWithMe: me.isAlliedWith(p),
        nameLocation: loc ? { x: loc.x, y: loc.y } : null,
      });
    }
    const cfg = this.game.config().gameConfig();
    this.markers = computeDiplomacyMarkers(
      nations,
      incoming,
      cfg.gameMode,
      cfg.difficulty,
    );
    this.emitStatus();
    this.pollFrontZones(me);
  }

  private emitStatus() {
    if (this.eventBus === undefined || this.eventBus === null) return;
    const attackers = this.markers.filter(
      (m) => m.kind === "attacker",
    ).length;
    const key = `${this.visible}:${attackers}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.eventBus.emit(new DiplomacyOverlayStatusEvent(this.visible, attackers));
  }

  // Cache incoming-attack front positions via one worker round-trip. Only
  // attacks from actual nations (mirrors AttackingTroopsController's filter).
  private pollFrontZones(me: PlayerView) {
    const now = performance.now();
    if (now - this.lastFrontPoll < FRONT_POLL_MS) return;
    if (this.frontPollInFlight) return;
    this.lastFrontPoll = now;

    const activeIDs = new Set<string>();
    this.attackTroopsById.clear();
    for (const atk of me.incomingAttacks()) {
      if (atk.retreating) continue;
      let isNation = false;
      try {
        const attacker = this.game.playerBySmallID(atk.attackerID);
        isNation = attacker.isPlayer() && attacker.type() !== PlayerType.Bot;
      } catch {
        isNation = false;
      }
      if (!isNation) continue;
      activeIDs.add(atk.id);
      this.attackTroopsById.set(atk.id, atk.troops);
    }
    if (activeIDs.size === 0) {
      if (this.frontZones.length > 0) this.frontZones = [];
      return;
    }

    this.frontPollInFlight = true;
    void me
      .attackClusteredPositions()
      .then((attacks) => {
        const zones: { x: number; y: number }[] = [];
        for (const { id, positions } of attacks) {
          if (!activeIDs.has(id)) continue;
          for (const pos of positions) zones.push({ x: pos.x, y: pos.y });
        }
        this.frontZones = zones;
      })
      .catch(() => {
        this.frontZones = [];
      })
      .finally(() => {
        this.frontPollInFlight = false;
      });
  }

  private sizeCanvas() {
    if (this.canvas === undefined || this.canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  private draw() {
    if (this.canvas === undefined || this.canvas === null) return;
    this.sizeCanvas();
    const ctx = this.canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!this.active()) return;

    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin((now / PULSE_MS) * Math.PI * 2);

    // Threat zones on my invaded front-line clusters.
    for (const z of this.frontZones) {
      const s = this.transform.worldToScreenCoordinates(new Cell(z.x, z.y));
      if (!this.onScreen(s.x, s.y, 40)) continue;
      const r = 13 + 5 * pulse;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_FILL + "0.22)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ZONE_FILL + "0.55)";
      ctx.stroke();
    }

    for (const m of this.markers) {
      const s = this.transform.worldToScreenCoordinates(new Cell(m.x, m.y));
      if (!this.onScreen(s.x, s.y, 60)) continue;
      if (m.kind === "attacker") {
        const r = 15 + 4 * pulse;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = RING_ATTACKER + "0.95)";
        ctx.stroke();
        this.emoji(ctx, "⚔️", s.x, s.y - r - 10);
        this.label(ctx, renderTroops(m.troops), s.x, s.y + r + 14, "#fca5a5");
      } else if (m.kind === "hegemon") {
        const r = 16 + 4 * pulse;
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(Math.PI / 4);
        ctx.lineWidth = 3;
        ctx.strokeStyle = RING_HEGEMON + "0.95)";
        ctx.strokeRect(-r / 1.4, -r / 1.4, r * 1.4, r * 1.4);
        ctx.restore();
        this.emoji(ctx, "⚠️", s.x, s.y - r - 10);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 13, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = RING_ALLY + "0.9)";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.x, s.y, 17, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = RING_ALLY + "0.4)";
        ctx.stroke();
        this.emoji(ctx, "🤝", s.x, s.y - 23 - 10);
      }
    }
  }

  private onScreen(x: number, y: number, margin: number): boolean {
    return (
      x >= -margin &&
      y >= -margin &&
      x <= window.innerWidth + margin &&
      y <= window.innerHeight + margin
    );
  }

  private emoji(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number) {
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch, x, y);
  }

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
  ) {
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  render() {
    return html`<canvas
      class="fixed inset-0 pointer-events-none"
      style="z-index: 30;"
    ></canvas>`;
  }
}
