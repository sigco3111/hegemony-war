import { Cell } from "@openfront/engine-api/game/GameTypes";
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, query } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { DelegationZoneChangedEvent } from "../../DelegationZoneEvents";
import { AlternateViewEvent } from "../../InputHandler";
import { TransformHandler } from "../../TransformHandler";
import { GameView } from "../../view";

/**
 * 개선 9: draws the rear-defense delegation's protected zone on the map —
 * a soft cyan fill with a pulsing ring, glued to the map while panning and
 * zooming. The panel owns the zone state and broadcasts changes; the radius
 * comes from the same shared rule the engine enforces, so the ring the
 * player sees is exactly the area the delegate builds in.
 *
 * Singleplayer only; hidden during spawn, in replays, after elimination,
 * and in the alternate (terrain) view.
 */

const ZONE_STROKE = "rgba(34, 211, 238,"; // cyan-400
const PULSE_MS = 1200;

@customElement("delegation-zone-layer")
export class DelegationZoneLayer extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transform: TransformHandler;

  @query("canvas") private canvas: HTMLCanvasElement;

  private zone: { x: number; y: number; radius: number } | null = null;
  private alternateView = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(DelegationZoneChangedEvent, (e) => {
      if (e.tile === null) {
        this.zone = null;
        return;
      }
      this.zone = {
        x: this.game.x(e.tile),
        y: this.game.y(e.tile),
        radius: e.radius,
      };
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
    if (this.zone === null || this.alternateView) return false;
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
    if (!this.active() || this.zone === null) return;

    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin((now / PULSE_MS) * Math.PI * 2);
    const s = this.transform.worldToScreenCoordinates(
      new Cell(this.zone.x, this.zone.y),
    );
    const r = this.zone.radius * this.transform.scale;
    if (
      s.x < -r ||
      s.y < -r ||
      s.x > window.innerWidth + r ||
      s.y > window.innerHeight + r
    ) {
      return;
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = ZONE_STROKE + "0.10)";
    ctx.fill();
    ctx.lineWidth = 2.5 + pulse;
    ctx.strokeStyle = ZONE_STROKE + "0.85)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = ZONE_STROKE + "0.9)";
    ctx.fill();
  }

  render() {
    return html`<canvas
      class="fixed inset-0 pointer-events-none"
      style="z-index: 29;"
    ></canvas>`;
  }
}
