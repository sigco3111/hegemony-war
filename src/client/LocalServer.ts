import {
  AllPlayersStats,
  ClientID,
  StampedIntent,
  Turn,
} from "@openfront/engine-api/Schemas";
import { EventBus } from "@openfront/shared/EventBus";
import {
  createPartialGameRecord,
  decompressGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import {
  ClientMessage,
  ClientSendWinnerMessage,
  PartialGameRecord,
  PartialGameRecordSchema,
  PlayerRecord,
  ServerMessage,
  ServerStartGameMessage,
} from "@openfront/shared/WireSchemas";
import { ClientEnv } from "src/client/ClientEnv";
import { z } from "zod";
import { getApiBase } from "./Api";
import { getAuthHeader, getPersistentID } from "./Auth";
import { LobbyConfig } from "./ClientGameRunner";
import {
  GameSpeedDownIntentEvent,
  GameSpeedUpIntentEvent,
  ReplaySpeedChangeEvent,
} from "./InputHandler";
import {
  buildSavedMatch,
  isSaveBlocked,
  markMatchOver,
  setActiveGame,
  takeResume,
  writeSavedMatch,
} from "./SaveGame";
import { startSingleplayerHeartbeat } from "./SingleplayerHeartbeat";
import {
  defaultReplaySpeedMultiplier,
  ReplaySpeedMultiplier,
} from "./utilities/ReplaySpeedMultiplier";

// Order: 0.5, 1, 2, max (same as ReplayPanel)
const SPEED_ORDER: ReplaySpeedMultiplier[] = [
  ReplaySpeedMultiplier.slow,
  ReplaySpeedMultiplier.normal,
  ReplaySpeedMultiplier.fast,
  ReplaySpeedMultiplier.fastest,
];

// build a small backlog so MAX can catch up.
const MAX_REPLAY_BACKLOG_TURNS = 60;

export class LocalServer {
  // All turns from the game record on replay.
  private replayTurns: Turn[] = [];

  private turns: Turn[] = [];

  private intents: StampedIntent[] = [];
  private startedAt: number;

  private paused = false;
  private replaySpeedMultiplier = defaultReplaySpeedMultiplier;

  private clientID: ClientID | undefined;
  private winner: ClientSendWinnerMessage | null = null;
  private allPlayersStats: AllPlayersStats = {};
  // Set only once an upload got a 2xx, so endGame() retries failed or
  // skipped win-time uploads during teardown.
  private archived = false;
  private archiveInFlight = false;

  // 이어하기: 저장에서 불러온 턴(해시 검증용)과 마지막 저장 시점.
  private resumedTurns: Turn[] = [];
  private lastSavedTurnCount = 0;
  private saveListenersOn = false;
  private turnsExecuted = 0;
  private turnStartTime = 0;

  private turnCheckInterval: NodeJS.Timeout;
  private stopHeartbeat: (() => void) | null = null;
  private clientConnect: () => void;
  private clientMessage: (message: ServerMessage) => void;

  constructor(
    private lobbyConfig: LobbyConfig,
    private isReplay: boolean,
    private eventBus: EventBus,
  ) {}

  public updateCallback(
    clientConnect: () => void,
    clientMessage: (message: ServerMessage) => void,
  ) {
    this.clientConnect = clientConnect;
    this.clientMessage = clientMessage;
  }

  start() {
    console.log("local server starting");
    this.turnCheckInterval = setInterval(() => {
      const turnIntervalMs =
        ClientEnv.turnIntervalMs() * this.replaySpeedMultiplier;
      const backlog = Math.max(0, this.turns.length - this.turnsExecuted);
      const allowReplayBacklog =
        this.replaySpeedMultiplier === ReplaySpeedMultiplier.fastest &&
        this.lobbyConfig.gameRecord !== undefined;
      const maxBacklog = allowReplayBacklog ? MAX_REPLAY_BACKLOG_TURNS : 0;

      const canQueueNextTurn =
        backlog === 0 || (maxBacklog > 0 && backlog < maxBacklog);
      if (
        canQueueNextTurn &&
        Date.now() > this.turnStartTime + turnIntervalMs
      ) {
        this.turnStartTime = Date.now();
        // "Ending" the turn hands it to the client, which starts processing it.
        this.endTurn();
      }
    }, 5);

    this.eventBus.on(ReplaySpeedChangeEvent, (event) => {
      this.replaySpeedMultiplier = event.replaySpeedMultiplier;
    });

    if (!this.isReplay) {
      this.eventBus.on(GameSpeedUpIntentEvent, () => {
        const idx = SPEED_ORDER.indexOf(this.replaySpeedMultiplier);
        if (idx < 0 || idx >= SPEED_ORDER.length - 1) return;
        this.replaySpeedMultiplier = SPEED_ORDER[idx + 1];
        this.eventBus.emit(
          new ReplaySpeedChangeEvent(this.replaySpeedMultiplier),
        );
      });

      this.eventBus.on(GameSpeedDownIntentEvent, () => {
        const idx = SPEED_ORDER.indexOf(this.replaySpeedMultiplier);
        if (idx <= 0) return;
        this.replaySpeedMultiplier = SPEED_ORDER[idx - 1];
        this.eventBus.emit(
          new ReplaySpeedChangeEvent(this.replaySpeedMultiplier),
        );
      });
    }

    this.startedAt = Date.now();
    const info = this.lobbyConfig.gameStartInfo;
    if (info !== undefined) {
      this.clientID = info.players[0]?.clientID;
    if (!this.isReplay && !this.lobbyConfig.gameRecord) {
      setActiveGame(info.gameID);
      const saved = takeResume(info.gameID);
      if (saved !== null) {
        // 저장된 턴을 그대로 다시 먹여 같은 상태를 만든다(rejoin 경로).
        this.turns = saved.turns;
        this.resumedTurns = saved.turns;
        this.lastSavedTurnCount = saved.turns.length;
        // 따라잡은 뒤 일시정지 상태로 열어 상황을 보게 한다.
        // (클라이언트에는 아직 아무것도 보내지 않았으므로 rejoin이 전부 전달한다.)
        // 일시정지 중 접수돼 저장된 위임 인텐트는 재개 후 첫 턴에 적용한다.
        this.intents = [...(saved.pending ?? [])] as StampedIntent[];
        // 저장이 이미 일시정지 상태(마지막 pause 인텐트가 정지)라면 턴을 더하지 않는다.
        // 그래야 저장→이어하기를 반복해도 시뮬레이션이 한 틱도 더 가지 않는다.
        // 실행 중에 저장된 경우(자동 저장)만 정지시키려고 pause 턴 하나를 더한다.
        let alreadyPaused = false;
        for (const t of this.turns) {
          for (const i of t.intents) {
            if (i.type === "toggle_pause") alreadyPaused = i.paused === true;
          }
        }
        if (!alreadyPaused) {
          this.turns.push({
            turnNumber: this.turns.length,
            intents: [
              {
                type: "toggle_pause",
                paused: true,
                clientID: this.clientID,
              } as StampedIntent,
            ],
          });
        }
        this.paused = true;
      }
      this.installSaveListeners();
    }
    }
    this.clientConnect();
    if (this.lobbyConfig.gameRecord) {
      this.replayTurns = decompressGameRecord(
        this.lobbyConfig.gameRecord,
      ).turns;
    }
    if (this.lobbyConfig.gameStartInfo === undefined) {
      throw new Error("missing gameStartInfo");
    }
    this.clientID = this.lobbyConfig.gameStartInfo.players[0]?.clientID;
    if (!this.clientID) {
      throw new Error("missing clientID");
    }
    this.clientMessage({
      type: "start",
      gameStartInfo: this.lobbyConfig.gameStartInfo,
      turns: [],
      lobbyCreatedAt: this.lobbyConfig.gameStartInfo.lobbyCreatedAt,
      // Don't send myClientID for replays — viewer has no player identity.
      myClientID: this.lobbyConfig.gameRecord ? undefined : this.clientID,
    } satisfies ServerStartGameMessage);
    // Last, so a start() that throws above leaves no interval behind.
    if (!this.isReplay) {
      this.stopHeartbeat = startSingleplayerHeartbeat(
        this.lobbyConfig.gameStartInfo.gameID,
      );
    }
  }

  onMessage(clientMsg: ClientMessage) {
    if (clientMsg.type === "rejoin") {
      if (!this.clientID) {
        throw new Error("missing clientID");
      }
      this.clientMessage({
        type: "start",
        gameStartInfo: this.lobbyConfig.gameStartInfo!,
        turns: this.turns,
        lobbyCreatedAt: this.lobbyConfig.gameStartInfo!.lobbyCreatedAt,
        myClientID: this.lobbyConfig.gameRecord ? undefined : this.clientID,
      } satisfies ServerStartGameMessage);
    }
    if (clientMsg.type === "intent") {
      // Server stamps clientID - client doesn't send it
      const stampedIntent = {
        ...clientMsg.intent,
        clientID: this.clientID!,
      };
      if (stampedIntent.type === "toggle_pause") {
        if (stampedIntent.paused) {
          // Pausing: add intent and end turn before pause takes effect
          this.intents.push(stampedIntent);
          this.endTurn();
          this.paused = true;
          this.saveNow();
        } else {
          // Unpausing: clear pause flag before adding intent so next turn can execute
          this.paused = false;
          this.intents.push(stampedIntent);
          this.endTurn();
        }
        return;
      }
      // Don't process non-pause intents during replays or while paused
      if (this.lobbyConfig.gameRecord) return;
      if (this.paused) {
        // 위임 설정·긴급 중지는 일시정지 중에도 접수해 재개 후 첫 턴에 적용한다
        // (패널 표시와 엔진 상태가 어긋나지 않게).
        if (
          stampedIntent.type === "set_defense_delegation" ||
          stampedIntent.type === "set_economy_delegation"
        ) {
          this.intents.push(stampedIntent);
          // 곧바로 새로고침해도 긴급 중지가 사라지지 않도록 바로 저장한다.
          this.saveNow();
        }
        return;
      }

      this.intents.push(stampedIntent);
    }
    if (clientMsg.type === "hash") {
      if (!this.lobbyConfig.gameRecord) {
        if (clientMsg.turnNumber % 100 === 0) {
          // In singleplayer, only store hash every 100 turns to reduce size of game record.
          const turn = this.turns[clientMsg.turnNumber];
          if (turn) {
            const saved = this.resumedTurns[clientMsg.turnNumber]?.hash;
            if (saved !== undefined && saved !== null && saved !== clientMsg.hash) {
              console.error(`resume desync on turn ${clientMsg.turnNumber}`);
              this.clientMessage({
                type: "desync",
                turn: clientMsg.turnNumber,
                correctHash: saved,
                clientsWithCorrectHash: 0,
                totalActiveClients: 1,
                yourHash: clientMsg.hash,
              });
            }
            turn.hash = clientMsg.hash;
          }
        }
        return;
      }
      // If we are replaying a game then verify hash.
      const archivedHash = this.replayTurns[clientMsg.turnNumber].hash;
      if (!archivedHash) {
        console.warn(
          `no archived hash found for turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}`,
        );
        return;
      }
      if (archivedHash !== clientMsg.hash) {
        console.error(
          `desync detected on turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}, server hash: ${archivedHash}`,
        );
        this.clientMessage({
          type: "desync",
          turn: clientMsg.turnNumber,
          correctHash: archivedHash,
          clientsWithCorrectHash: 0,
          totalActiveClients: 1,
          yourHash: clientMsg.hash,
        });
      } else {
        console.log(
          `hash verified on turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}, server hash: ${archivedHash}`,
        );
      }
    }
    if (clientMsg.type === "winner") {
      this.winner = clientMsg;
      this.allPlayersStats = clientMsg.allPlayersStats;
      if (!this.isReplay) markMatchOver();
      if (!this.isReplay) {
        // Archive as soon as the game is decided: endGame() only runs during
        // page teardown, where the auth refresh and upload race document
        // destruction and can silently lose the record (#4931).
        this.archiveGameRecord(false);
      }
    }
  }

  // This is so the client can tell us when it finished processing the turn.
  public turnComplete() {
    this.turnsExecuted++;
  }

  // endTurn in this context means the server has collected all the intents
  // and will send the turn to the client.
  private endTurn() {
    if (this.paused) {
      return;
    }
    if (this.replayTurns.length > 0) {
      if (this.turns.length >= this.replayTurns.length) {
        this.endGame();
        return;
      }
      this.intents = this.replayTurns[this.turns.length].intents;
    }
    const pastTurn: Turn = {
      turnNumber: this.turns.length,
      intents: this.intents,
    };
    this.turns.push(pastTurn);
    this.intents = [];
    // 30초(300턴)마다 자동 저장.
    if (this.turns.length - this.lastSavedTurnCount >= 300) this.saveNow();
    this.clientMessage({
      type: "turn",
      turn: pastTurn,
    });
  }

  /** 현재까지의 턴을 저장 슬롯에 쓴다. 끝난 판·리플레이는 저장하지 않는다. */
  private saveNow(): void {
    const info = this.lobbyConfig.gameStartInfo;
    if (
      this.isReplay ||
      this.lobbyConfig.gameRecord !== undefined ||
      info === undefined ||
      this.winner !== null ||
      isSaveBlocked(info.gameID) ||
      this.turns.length === 0
    ) {
      return;
    }
    const prev = this.lastSavedTurnCount;
    this.lastSavedTurnCount = this.turns.length;
    // 쓰기가 실패하면(용량·권한 등) 표식을 되돌려 다음 시점에 다시 시도한다.
    void writeSavedMatch(
      buildSavedMatch(info, this.turns.slice(), this.intents.slice()),
    ).then((ok) => {
      if (!ok) this.lastSavedTurnCount = Math.min(this.lastSavedTurnCount, prev);
    });
  }

  private installSaveListeners(): void {
    if (this.saveListenersOn) return;
    this.saveListenersOn = true;
    // 탭을 숨기거나 닫을 때도 저장한다(모바일 포함).
    const onHide = () => {
      if (document.visibilityState === "hidden") this.saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", () => this.saveNow());
  }

  public endGame() {
    console.log("local server ending game");
    this.saveNow();
    clearInterval(this.turnCheckInterval);
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    if (this.isReplay) {
      return;
    }
    // Fallback for games that end without a winner (e.g. quitting early);
    // decided games were already archived at win time.
    this.archiveGameRecord(true);
  }

  private archiveGameRecord(unloading: boolean) {
    if (this.archived || this.archiveInFlight) {
      return;
    }
    const players: PlayerRecord[] = [
      {
        persistentID: getPersistentID(),
        username: this.lobbyConfig.playerName,
        clanTag: this.lobbyConfig.playerClanTag ?? null,
        clientID: this.clientID!,
        stats: this.allPlayersStats[this.clientID!],
        cosmetics: this.lobbyConfig.gameStartInfo?.players[0].cosmetics,
      },
    ];
    if (this.lobbyConfig.gameStartInfo === undefined) {
      throw new Error("missing gameStartInfo");
    }
    const record = createPartialGameRecord(
      this.lobbyConfig.gameStartInfo.gameID,
      this.lobbyConfig.gameStartInfo.config,
      players,
      this.turns,
      this.startedAt,
      Date.now(),
      this.winner?.winner,
    );

    const result = PartialGameRecordSchema.safeParse(record);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Error parsing game record", error);
      return;
    }

    this.archiveGame(result.data, unloading);
  }

  private async archiveGame(
    record: PartialGameRecord,
    unloading: boolean,
  ): Promise<void> {
    this.archiveInFlight = true;
    try {
      const authHeader = await getAuthHeader();
      if (authHeader === "") {
        // The archive API requires a session. Guests have one too, so this
        // only trips when none could be established (e.g. API unreachable).
        return;
      }
      // Replays refuse to load unless the archived commit matches the client
      // build, and the API worker can't stamp it (it has a different build).
      const jsonString = JSON.stringify(
        { ...record, gitCommit: ClientEnv.gitCommit() },
        replacer,
      );
      const compressedData = await compress(jsonString);
      const response = await fetch(
        `${getApiBase()}/archive_singleplayer_game`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            Authorization: authHeader,
          },
          body: compressedData,
          // keepalive lets the request outlive page teardown but caps the body
          // at 64 KiB, so only set it when the page is actually unloading.
          keepalive: unloading,
        },
      );
      if (response.ok) {
        this.archived = true;
      } else {
        console.error(
          `Failed to archive singleplayer game: ${response.status}`,
        );
      }
    } catch (error) {
      console.warn("Failed to archive singleplayer game:", error);
    } finally {
      this.archiveInFlight = false;
    }
  }
}

async function compress(data: string): Promise<ArrayBuffer> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // Write the data to the compression stream
  writer.write(new TextEncoder().encode(data));
  writer.close();

  // Read the compressed data
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      chunks.push(value);
    }
  }

  // Combine all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const compressedData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    compressedData.set(chunk, offset);
    offset += chunk.length;
  }

  return compressedData.buffer;
}
