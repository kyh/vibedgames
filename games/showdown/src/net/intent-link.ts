// A guest's own controls on their way to the host. Every intent is stamped for
// time alignment (prediction.ts); movement is quantized and rate-capped
// (input-intent.ts), and the body moves by exactly what was sent, so the host
// replays the input the prediction ran.
import type { Brawler } from "../entities/brawler";
import { leapFlight } from "../entities/movement";
import { directionVector, InputGate, quantizeDirection, quantizeLook } from "./input-intent";
import { OwnPrediction } from "./prediction";
import type { OwnBody } from "./prediction";
import type { SequencedIntent } from "./protocol";

/** Where intents leave from: the session, or a test's simulated wire. */
export interface IntentPort {
  readonly reachable: boolean;
  sendIntent: (intent: SequencedIntent) => void;
}

export interface Aim {
  dx: number;
  dz: number;
  x: number;
  z: number;
}

export class IntentLink {
  readonly prediction = new OwnPrediction();
  private readonly gate = new InputGate();
  private readonly port: () => IntentPort | null;

  constructor(port: () => IntentPort | null) {
    this.port = port;
  }

  /** Can intents reach a live host right now? */
  get reachable(): boolean {
    return this.port()?.reachable === true;
  }

  /**
   * This step's movement. The body runs what the host was sent, so a change
   * held back by the rate cap moves neither copy and they cannot disagree.
   */
  steer(
    body: Pick<Brawler, "moveX" | "moveZ"> | null,
    x: number,
    z: number,
    look: number | null,
    now = performance.now(),
  ): void {
    const next = { dir: quantizeDirection(x, z), look: quantizeLook(look) };
    if (this.gate.due(next, now)) {
      const port = this.port();
      if (port?.reachable) {
        const seq = this.prediction.stamp("input");
        port.sendIntent({ dir: next.dir, kind: "input", look: next.look, seq });
      }
      this.gate.mark(next, now);
    }
    if (body) {
      const move = directionVector(this.gate.applied.dir);
      body.moveX = move.x;
      body.moveZ = move.z;
    }
  }

  /** A predicted attack or super already started on the body; the host plays it too. */
  sendAction(body: Pick<Brawler, "def" | "leap">, kind: "attack" | "super", aim: Aim): void {
    const port = this.port();
    if (!port?.reachable) {
      return;
    }
    const seq = this.prediction.stamp(kind);
    port.sendIntent({ dx: aim.dx, dz: aim.dz, kind, seq, x: aim.x, z: aim.z });
    if (kind === "super" && body.leap) {
      this.prediction.leapSent(seq, leapFlight(body.def));
    }
  }

  /** A predicted evade already started; the host's verdict comes back in the row. */
  sendEvade(body: OwnBody, dx: number, dz: number): void {
    const port = this.port();
    if (!port?.reachable) {
      return;
    }
    const seq = this.prediction.stamp("evade");
    port.sendIntent({ dx, dz, kind: "evade", seq });
    this.prediction.evadeSent(body, seq);
  }

  /** Send the current input at the next chance whether or not it changed (a new body, a new host). */
  resend(): void {
    this.gate.force();
  }
}
