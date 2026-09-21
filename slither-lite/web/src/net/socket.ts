import { Replica } from "../game/replica";
import type { InputState } from "../game/input";
import { PROTOCOL_VERSION, isServerMessage, type CashOutReceiptMessage, type EliminatedMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "connected" | "resyncing" | "disconnected" | "error";

export interface SocketCallbacks {
  onState: () => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  onLatency: (milliseconds: number) => void;
  onEliminated: (message: EliminatedMessage) => void;
  onReceipt: (message: CashOutReceiptMessage) => void;
  onEntered: (ticketNanos: number) => void;
}

export class GameSocket {
  private socket?: WebSocket;
  private inputTimer?: number;
  private pingTimer?: number;
  private inputSequence = 0;
  private resyncRequested = false;

  constructor(
    readonly replica: Replica,
    private readonly callbacks: SocketCallbacks,
  ) {}

  connect(name: string, skin: string, input: InputState): void {
    this.close();
    this.callbacks.onStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", protocol: PROTOCOL_VERSION, name, skin }));
      this.inputTimer = window.setInterval(() => this.sendInput(input), 1000 / 30);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    });
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      this.stopTimers();
      this.callbacks.onStatus("disconnected");
    });
    socket.addEventListener("error", () => this.callbacks.onStatus("error", "WebSocket connection failed"));
  }

  reenter(): void {
    this.send({
      type: "reenter",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  cashOut(): void {
    this.send({
      type: "cashOut",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  close(): void {
    this.stopTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  private sendInput(input: InputState): void {
    if (!this.replica.playerId) return;
    this.inputSequence += 1;
    this.send({
      type: "input",
      inputSeq: this.inputSequence,
      aim: input.aim,
      boost: input.boost,
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
    });
  }

  private ping(): void {
    this.send({ type: "ping", sentAt: Date.now() });
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.callbacks.onStatus("error", "Server sent invalid JSON");
      return;
    }
    if (!isServerMessage(message)) {
      this.callbacks.onStatus("error", "Server sent an unknown message");
      return;
    }
    switch (message.type) {
      case "bootstrap": {
        this.resyncRequested = false;
        const matches = this.replica.applyBootstrap(message);
        this.callbacks.onStatus(matches ? "connected" : "resyncing", matches ? message.reason : "Bootstrap digest mismatch");
        if (!matches) this.requestResync("digestMismatch");
        this.callbacks.onState();
        break;
      }
      case "delta": {
        if (message.sequence <= this.replica.sequence) break;
        const expectedSequence = this.replica.sequence + 1;
        if (!this.replica.applyDelta(message)) {
          const reason = message.sequence === expectedSequence ? "digestMismatch" : "sequenceGap";
          this.callbacks.onStatus("resyncing", "State mismatch; requesting authority resync");
          this.requestResync(reason);
        }
        this.callbacks.onState();
        break;
      }
      case "entered":
        this.callbacks.onEntered(message.ticketNanos);
        break;
      case "eliminated":
        this.callbacks.onEliminated(message);
        break;
      case "cashOutReceipt":
        this.callbacks.onReceipt(message);
        break;
      case "pong":
        this.callbacks.onLatency(Date.now() - message.sentAt);
        break;
      case "error":
        this.callbacks.onStatus("error", `${message.code}: ${message.message}`);
        break;
    }
  }

  private requestResync(reason: "sequenceGap" | "digestMismatch"): void {
    if (this.resyncRequested) return;
    this.resyncRequested = true;
    this.send({
      type: "resync",
      stateSequence: this.replica.sequence,
      stateDigest: this.replica.digest,
      reason,
    });
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private stopTimers(): void {
    if (this.inputTimer !== undefined) window.clearInterval(this.inputTimer);
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.inputTimer = undefined;
    this.pingTimer = undefined;
  }
}
