import { Cell } from "@openfront/engine-api/game/GameTypes";
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, query } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { AlternateViewEvent } from "../../InputHandler";
import { TransformHandler } from "../../TransformHandler";
import { GameView } from "../../view";
import { WarPlanMarker, WarPlanMarkersEvent } from "../../WarPlan";

/**
 * 개선 10: draws the pause operation plan on the map — a numbered badge per
 * queued order (the number matches the 작전 panel's row), linked in order by
 * a dashed route line so the attack sequence and direction read at a glance.
 * Badges sit exactly on the clicked tile for land attacks and on the
 * transport destination for boat orders; a badge pulses briefly right after
 * the player located it from the list. Glued to the map while panning and
 * zooming, same as the delegation zone ring.
 *
 * Singleplayer only; hidden during spawn, in replays, after elimination,
 * and in the alternate (terrain) view. Visible whether or not the game is
 * paused, so the remaining queue stays on the map while it executes.
 */

const BADGE_FILL = "rgba(245, 158, 11,"; // amber-500
const ROUTE_STROKE = "rgba(251, 191, 36,"; // amber-400
const HIGHLIGHT_MS = 2600;
const BADGE_R = 11;

@customElement("war-plan-map-layer")
export class WarPlanMapLayer extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transform: TransformHandler;

  @query("canvas") private canvas: HTMLCanvasElement;

  private markers: WarPlanMarker[] = [];
  private highlightId: number | null = null;
  private highlightUntil = 0;
  private alternateView = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(WarPlanMarkersEvent, (e) => {
      this.markers = e.markers;
      if (e.highlightId !== null) {
        this.highlightId = e.highlightId;
        this.highlightUntil = performance.now() + HIGHLIGHT_MS;
      } else {
        this.highlightId = null;
      }
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

  private active(): boolean {
    if (this.alternateView || this.markers.length === 0) return false;
    if (this.game === undefined || this.game === null) return false;
    if (this.game.config().isReplay()) return false;
    if (
      this.game.config().gameConfig().gameType !== GameType.Singleplayer
    ) {
      return false;
    }
    if (this.game.inSpawnPhase()) return false;
    const me = this.game.myPlayer();
    return me !== null && me !== undefined && me.isAlive();
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
    if (this.highlightId !== null && now > this.highlightUntil) {
      this.highlightId = null;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const pts = this.markers
      .slice()
      .sort((a, b) => a.row - b.row)
      .map((m) => ({
        m,
        s: this.transform.worldToScreenCoordinates(new Cell(m.x, m.y)),
      }));

    // Route line through the queued orders in execution order.
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ROUTE_STROKE + "0.45)";
      let started = false;
      for (const { s } of pts) {
        if (!started) {
          ctx.moveTo(s.x, s.y);
          started = true;
        } else {
          ctx.lineTo(s.x, s.y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const { m, s } of pts) {
      if (
        s.x < -BADGE_R * 2 ||
        s.y < -BADGE_R * 2 ||
        s.x > w + BADGE_R * 2 ||
        s.y > h + BADGE_R * 2
      ) {
        continue;
      }
      const highlighted = this.highlightId === m.id;
      const pulse = highlighted
        ? 0.5 + 0.5 * Math.sin((now / 300) * Math.PI * 2)
        : 0;
      const r = BADGE_R + (highlighted ? 2 + pulse * 2 : 0);

      if (highlighted) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 4 + pulse * 3, 0, Math.PI * 2);
        ctx.strokeStyle = BADGE_FILL + `${0.9 - pulse * 0.5})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      ctx.beginPath();
      if (m.kind === "boat") {
        // Diamond for transport-ship orders, circle for land attacks.
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
      } else {
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = BADGE_FILL + "0.92)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(12, 10, 9, 0.85)";
      ctx.stroke();

      ctx.fillStyle = "rgba(12, 10, 9, 0.95)";
      ctx.font = `bold ${m.row > 9 ? 10 : 12}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.row), s.x, s.y + 0.5);
    }
  }

  render() {
    return html`<canvas
      class="fixed inset-0 pointer-events-none"
      style="z-index: 28;"
    ></canvas>`;
  }
}
