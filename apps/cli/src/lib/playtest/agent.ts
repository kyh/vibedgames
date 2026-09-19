/**
 * The in-page playtester.
 *
 * `vg playtest run` injects this function's SOURCE into the game's page and
 * calls it there, so the whole decide → apply → measure loop runs inside the
 * browser: no CLI round trip per decision, and a per-frame reflex layer that
 * a subprocess could never keep up with. The CLI's only jobs are to mint the
 * token, inject, poll `window.__PLAYTEST_AGENT__.done`, and read the
 * records back.
 *
 * Rules that follow from being stringified: `inPageAgent` and `browserEnv`
 * must be entirely self-contained — no imports, no module-scope references
 * (the `declare`d globals below are erased and resolve to the page's own) —
 * which is why every helper lives inside them. The agent talks to the page
 * only through `env`, the real browser in production and a fake in tests.
 *
 * The decision is the hold: the previous inputs stay down while the model
 * answers, so the game runs continuously and the loop decides at the
 * model's latency, with `tickMs` as a floor. A move option in the game's
 * `__GAME_PLAYTEST__` may carry a `reflex(game)` function; while that option
 * is the current intent, the reflex runs every frame and its returned inputs
 * are what is held — the model sets intent a few times a second, the reflex
 * turns it into input at 60 fps.
 */

// oxlint-disable unicorn/consistent-function-scoping -- the two exported functions are stringified and injected into the page, so their helpers cannot live at module scope

/** A parsed JSON document — the shape of everything that crosses the page boundary. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface AgentKeyInit {
  code: string;
  key: string;
  keyCode: number;
  which: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  bubbles: true;
}

export interface AgentPointer {
  x: number;
  y: number;
  down: boolean;
}

export interface AgentMove {
  description: string;
  inits: AgentKeyInit[];
  pointer: AgentPointer | null;
}

export interface AgentAction {
  description: string;
  inits: AgentKeyInit[];
}

export interface AgentConfig {
  decideUrl: string;
  token: string;
  model: string;
  /** Hold this move for the whole run and never call the model — for tuning a reflex. */
  pinMove: string | null;
  goal: string;
  move: Record<string, AgentMove>;
  actions: Record<string, AgentAction>;
  /** Every supported KeyboardEvent code, for inputs a reflex returns. */
  keyTable: Record<string, AgentKeyInit>;
  ticks: number;
  tickMs: number;
  finalHoldMs: number;
  actionThreshold: number;
  motionEpsilon: number;
  stuckRun: number;
  /** Decisions in a row of holding nothing, going nowhere, before the no-input option is rested. */
  idleRun: number;
  /** How many decisions a rested no-input option stays out of the question. */
  idleRestTicks: number;
  trailLength: number;
  decisionRetries: number;
  decisionTimeoutMs: number;
}

export interface AgentSample {
  x: number;
  y: number;
  z: number;
  frame: number;
  score: number;
  complete: boolean;
}

export interface AgentWindow {
  path: number;
  peak: number;
  frameBefore: number;
  frame: number;
  scoreBefore: number;
  score: number;
  x: number;
  y: number;
  z: number;
  complete: boolean;
}

export interface AgentRecord {
  tick: number;
  move: string;
  actions: string[];
  actionProbabilities: Record<string, number>;
  confidence: number | null;
  decisionMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Frames on which the option's reflex produced the held input. */
  reflexFrames: number;
  /**
   * The model's own read of how close the player is to `goal`, 0–1, from the
   * `progress` score question; null when it gave none.
   */
  progress: number | null;
  /** Whether the move asked the player to move at all, so a still window can count as stuck. */
  askedToMove: boolean;
  window: AgentWindow;
}

export interface AgentUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalDecisionMs: number;
  maxDecisionMs: number;
}

export interface AgentResult {
  done: boolean;
  error: string | null;
  records: AgentRecord[];
  usage: AgentUsage;
  wallMs: number;
  completedAtTick: number | null;
  stop: () => void;
}

/** The game's diagnostics, as far as the agent reads them. */
export interface Diagnostics {
  frame?: number;
  score?: number;
  complete?: boolean;
  player?: { x?: number; y?: number; z?: number };
}

/** What a reflex may hand back: key codes to hold and/or a pointer position. */
export interface ReflexInputs {
  keys?: string[];
  pointer?: { x: number; y: number; down?: boolean } | null;
  /** The reflex is trying to move and getting nowhere; see `settle`. */
  stuck?: boolean;
}

export type Reflex = (game: Diagnostics | null) => ReflexInputs | null | undefined;

export interface AgentResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export interface AgentRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The page, as the agent sees it. */
export interface AgentEnv {
  now: () => number;
  fetch: (url: string, init: AgentRequest) => Promise<AgentResponse>;
  raf: (frame: () => void) => number;
  caf: (id: number) => void;
  delay: (ms: number) => Promise<void>;
  read: () => AgentSample;
  /** A JSON-safe copy of the diagnostics, for the model. */
  snapshot: () => Json;
  /** The live diagnostics object, for a reflex. */
  live: () => Diagnostics | null;
  dispatchKey: (type: "keydown" | "keyup", init: AgentKeyInit) => void;
  dispatchPointer: (
    pointer: AgentPointer,
    type: "pointermove" | "pointerdown" | "pointerup",
  ) => void;
  reflexFor: (label: string) => Reflex | null;
  publish: (result: AgentResult) => void;
}

interface Manifest {
  move?: Record<string, { reflex?: Reflex }>;
}

interface PageEvent {
  type: string;
}

interface EventTargetLike {
  dispatchEvent: (event: PageEvent) => boolean;
}

interface PointerInit {
  bubbles: boolean;
  button: number;
  buttons: number;
  cancelable: boolean;
  clientX: number;
  clientY: number;
  composed: boolean;
  isPrimary: boolean;
  movementX: number;
  movementY: number;
  pointerId: number;
  pointerType: string;
  screenX: number;
  screenY: number;
}

interface BrowserGlobals {
  __GAME_DIAGNOSTICS__?: Diagnostics;
  __GAME_PLAYTEST__?: Manifest;
  __PLAYTEST_AGENT__?: AgentResult;
  innerWidth: number;
  innerHeight: number;
  requestAnimationFrame: (frame: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  fetch: AgentEnv["fetch"];
  dispatchEvent: EventTargetLike["dispatchEvent"];
}

interface DocumentLike {
  activeElement: EventTargetLike | null;
  body: EventTargetLike | null;
  elementFromPoint: (x: number, y: number) => EventTargetLike | null;
  querySelector: (selector: string) => EventTargetLike | null;
}

// Ambient only: these exist in the page and nowhere else. Nothing here is
// emitted, so stringifying the agent stays self-contained.
declare const window: BrowserGlobals;
declare const document: DocumentLike;
declare const KeyboardEvent: new (type: string, init: AgentKeyInit) => PageEvent;
declare const PointerEvent: new (type: string, init: PointerInit) => PageEvent;
declare const MouseEvent: new (type: string, init: PointerInit) => PageEvent;

/** The real page as an AgentEnv. Only ever runs in the browser; injected beside the agent. */
export const browserEnv = (): AgentEnv => {
  const read = (): AgentSample => {
    const d = window.__GAME_DIAGNOSTICS__;
    const p = d?.player ?? {};
    return {
      complete: d?.complete === true,
      frame: d?.frame ?? 0,
      score: d?.score ?? 0,
      x: p.x ?? 0,
      y: p.y ?? 0,
      z: p.z ?? 0,
    };
  };
  const pointerTarget = (cx: number, cy: number): EventTargetLike =>
    document.elementFromPoint(cx, cy) ?? document.querySelector("canvas") ?? window;
  const mouseType = (type: string): string => {
    if (type === "pointermove") {
      return "mousemove";
    }
    return type === "pointerdown" ? "mousedown" : "mouseup";
  };
  // Relative-look games steer from `movementX/Y`, which a synthetic event
  // leaves at 0 unless told otherwise — so each move carries its real delta.
  let lastPointer: { x: number; y: number } | null = null;
  const isFunction = (value: Reflex | undefined): value is Reflex =>
    Object.prototype.toString.call(value) === "[object Function]";
  return {
    caf: (id) => window.cancelAnimationFrame(id),
    delay: (ms) =>
      // oxlint-disable-next-line promise/avoid-new -- the page has no timers/promises; wrapping setTimeout is the only way to await a delay there
      new Promise((resolve) => {
        window.setTimeout(resolve, ms);
      }),
    dispatchKey: (type, init) => {
      // At the focused element, not `window`: a real keypress starts there
      // and bubbles up, so listeners on element, document and window all fire.
      const target = document.activeElement ?? document.body ?? window;
      target.dispatchEvent(new KeyboardEvent(type, init));
    },
    dispatchPointer: (pointer, type) => {
      const cx = Math.round(window.innerWidth * pointer.x);
      const cy = Math.round(window.innerHeight * pointer.y);
      const pressed = type === "pointerdown" || (type === "pointermove" && pointer.down);
      const moved = type === "pointermove" && lastPointer !== null;
      const movementX = moved && lastPointer ? cx - lastPointer.x : 0;
      const movementY = moved && lastPointer ? cy - lastPointer.y : 0;
      if (type === "pointermove") {
        lastPointer = { x: cx, y: cy };
      }
      const init: PointerInit = {
        bubbles: true,
        button: 0,
        buttons: pressed ? 1 : 0,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        composed: true,
        isPrimary: true,
        movementX,
        movementY,
        pointerId: 1,
        pointerType: "mouse",
        screenX: cx,
        screenY: cy,
      };
      const target = pointerTarget(cx, cy);
      target.dispatchEvent(new PointerEvent(type, init));
      target.dispatchEvent(new MouseEvent(mouseType(type), init));
    },
    fetch: (url, init) => window.fetch(url, init),
    live: () => window.__GAME_DIAGNOSTICS__ ?? null,
    now: () => Date.now(),
    publish: (result) => {
      window.__PLAYTEST_AGENT__ = result;
    },
    raf: (frame) => window.requestAnimationFrame(frame),
    read,
    reflexFor: (label) => {
      const reflex = window.__GAME_PLAYTEST__?.move?.[label]?.reflex;
      return isFunction(reflex) ? reflex : null;
    },
    snapshot: () => {
      try {
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone throws on a function-valued field; JSON drops it, and the contract is JSON anyway
        return JSON.parse(JSON.stringify(window.__GAME_DIAGNOSTICS__ ?? null));
      } catch {
        return null;
      }
    },
  };
};

/**
 * Run the playtest inside the page. Returns the live result object, which is
 * also published as `window.__PLAYTEST_AGENT__`; `done` flips when the run
 * ends, `error` says why if it ended early.
 */
export const inPageAgent = (config: AgentConfig, env: AgentEnv): AgentResult => {
  // Object() is the identity only on objects; arrays are split off explicitly.
  const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
    Object(value) === value && !Array.isArray(value);
  const round = (value: number): number => Number(value.toFixed(2));
  const started = env.now();
  const usage: AgentUsage = {
    calls: 0,
    inputTokens: 0,
    maxDecisionMs: 0,
    outputTokens: 0,
    totalDecisionMs: 0,
  };
  let stopped = false;
  let rafId = 0;

  // ---- held input --------------------------------------------------------
  interface HeldInputs {
    keys: AgentKeyInit[];
    pointer: AgentPointer | null;
  }
  let heldKeys: AgentKeyInit[] = [];
  let heldPointer: AgentPointer | null = null;

  const samePointer = (a: AgentPointer | null, b: AgentPointer | null): boolean =>
    a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.down === b.down);

  /** Switch the held inputs, dispatching only the changes. */
  const hold = (next: HeldInputs): void => {
    if (!samePointer(heldPointer, next.pointer)) {
      // A button that stays down while the cursor moves is a drag: one
      // press, moves, one release. Releasing and re-pressing per move would
      // re-fire every click-edge verb 60 times a second under a reflex.
      const wasDown = heldPointer?.down === true;
      const staysDown = wasDown && next.pointer?.down === true;
      if (heldPointer && wasDown && !staysDown) {
        env.dispatchPointer(heldPointer, "pointerup");
      }
      if (next.pointer) {
        env.dispatchPointer(next.pointer, "pointermove");
        if (next.pointer.down && !staysDown) {
          env.dispatchPointer(next.pointer, "pointerdown");
        }
      }
      heldPointer = next.pointer;
    }
    const wanted = new Set(next.keys.map((init) => init.code));
    const have = new Set(heldKeys.map((init) => init.code));
    for (const init of heldKeys) {
      if (!wanted.has(init.code)) {
        env.dispatchKey("keyup", init);
      }
    }
    for (const init of next.keys) {
      if (!have.has(init.code)) {
        env.dispatchKey("keydown", init);
      }
    }
    heldKeys = next.keys;
  };

  /**
   * Release these keys if held, so the next `hold` presses them again. An
   * action the model picks on consecutive decisions would otherwise stay down
   * as one long press, and a game that acts on the keydown edge — jump, fire,
   * drop a bomb — would see the first of them and none of the rest.
   */
  const release = (inits: AgentKeyInit[]): void => {
    const codes = new Set(inits.map((init) => init.code));
    for (const init of heldKeys) {
      if (codes.has(init.code)) {
        env.dispatchKey("keyup", init);
      }
    }
    heldKeys = heldKeys.filter((init) => !codes.has(init.code));
  };

  // ---- motion tracker ----------------------------------------------------
  const dist = (a: AgentSample, b: AgentSample): number =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  let trackStart = env.read();
  let trackLast = trackStart;
  let trackPath = 0;
  let trackPeak = 0;
  let trackScore = trackStart.score;

  const sample = (): void => {
    const c = env.read();
    trackPath += dist(c, trackLast);
    trackPeak = Math.max(trackPeak, dist(c, trackStart));
    trackLast = c;
    trackScore = Math.max(trackScore, c.score);
  };

  /** The window since the last flush; the next window starts now. */
  const flush = (): AgentWindow => {
    sample();
    const c = trackLast;
    const measured: AgentWindow = {
      complete: c.complete,
      frame: c.frame,
      frameBefore: trackStart.frame,
      path: Number(trackPath.toFixed(3)),
      peak: Number(Math.max(trackPeak, dist(c, trackStart)).toFixed(3)),
      score: Math.max(trackScore, c.score),
      scoreBefore: trackStart.score,
      x: c.x,
      y: c.y,
      z: c.z,
    };
    trackStart = c;
    trackPath = 0;
    trackPeak = 0;
    trackScore = c.score;
    return measured;
  };

  // ---- decisions ---------------------------------------------------------
  interface Decision {
    move: string;
    actions: string[];
    actionProbabilities: Record<string, number>;
    confidence: number | null;
    progress: number | null;
    inputTokens: number;
    outputTokens: number;
  }

  interface Pending {
    decision: Decision;
    tick: number;
    decisionMs: number;
    appliedAt: number;
    reflexFrames: number;
    reflexStuck: boolean;
    reflex: Reflex | null;
  }

  interface ChoiceQuestion {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
  }

  interface NoulQuestion {
    type: "noul";
    instructions: string;
    criteria: { false: string; true: string };
  }

  interface ScoreQuestion {
    type: "score";
    instructions: string;
    criteria: string[];
  }

  interface Questions {
    move: ChoiceQuestion;
    progress: ScoreQuestion;
    [action: string]: ChoiceQuestion | NoulQuestion | ScoreQuestion;
  }

  // Ordered lowest to highest; the answer is a probability-weighted position
  // along them, which the agent normalises to 0–1. The model reads the same
  // state it moves from, so this is its judgment of the run, not a metric —
  // useful because it is the one signal that tracks the GOAL rather than the
  // game's score field, which a goal like "survive" never raises.
  const PROGRESS_LEVELS = [
    "No progress: the player is not moving towards the goal, or is losing (dying, falling behind)",
    "Barely started: moving, but the goal is far off or the player is in trouble",
    "Halfway: clear progress towards the goal and out of immediate danger",
    "Nearly there: the goal is close, or the score is rising steadily",
    "Achieved, or about to be",
  ];

  interface DecisionState {
    game: Json;
    goal: string;
    recent: {
      blockedMoves: string[];
      held: { actions: string[]; move: string } | null;
      movedLastTick: number | null;
      scoreDeltaLastTick: number | null;
      stuckTicksInARow: number;
      trail: { x: number; y: number; z: number }[];
    };
    tick: { index: number; of: number };
  }

  let pending: Pending | null = null;
  let blocked: string[] = [];
  let stuckRun = 0;
  let idleRun = 0;
  let rested: { label: string; untilTick: number } | null = null;
  const trail: { x: number; y: number; z: number }[] = [];
  let lastWindow: AgentWindow | null = null;

  const result: AgentResult = {
    completedAtTick: null,
    done: false,
    error: null,
    records: [],
    stop: () => {
      stopped = true;
    },
    usage,
    wallMs: 0,
  };
  env.publish(result);

  /** The move options on offer this tick: everything the reflex hasn't withdrawn. */
  const offeredMoves = (tick: number) => {
    const resting = rested !== null && tick < rested.untilTick ? rested.label : null;
    const criteria: Record<string, string> = {};
    for (const [label, option] of Object.entries(config.move)) {
      if (!blocked.includes(label) && label !== resting) {
        criteria[label] = option.description;
      }
    }
    // A choice needs two options; the rested one comes back before that breaks.
    if (resting !== null && Object.keys(criteria).length < 2) {
      criteria[resting] = config.move[resting]?.description ?? resting;
    }
    return criteria;
  };

  const questions = (criteria: Record<string, string>): Questions => {
    const out: Questions = {
      move: {
        criteria,
        instructions:
          "Which movement input should the player hold next to pursue `goal`? Decide from `game` (the live state) and `recent` (what the last inputs achieved). Options that recently produced no movement have been removed.",
        type: "choice",
      },
      progress: {
        criteria: PROGRESS_LEVELS,
        instructions:
          "How close is the player to achieving `goal` right now, judging from `game` and `recent`?",
        type: "score",
      },
    };
    for (const [label, action] of Object.entries(config.actions)) {
      out[`act:${label}`] = {
        criteria: { false: "Not now", true: "Yes, do it now" },
        instructions: `Given \`game\` and \`goal\`, should the player ${action.description} right now?`,
        type: "noul",
      };
    }
    return out;
  };

  const answerFor = (answers: { [key: string]: Json }, key: string): { [key: string]: Json } => {
    const answer = answers[key];
    return isObject(answer) ? answer : {};
  };

  const parseDecision = (text: string, offered: Record<string, string>): Decision => {
    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`decision response was not JSON: ${text.slice(0, 200)}`);
    }
    const answers = isObject(body) ? body.answers : undefined;
    if (!isObject(answers)) {
      throw new Error(`decision response had no answers: ${text.slice(0, 200)}`);
    }
    const move = answerFor(answers, "move");
    const choice = String(move.choice ?? "");
    if (!Object.hasOwn(offered, choice)) {
      throw new Error(`decision model answered \`move\` outside the offered options: ${choice}`);
    }
    const actions: string[] = [];
    const actionProbabilities: Record<string, number> = {};
    for (const label of Object.keys(config.actions)) {
      const probability = Number(answerFor(answers, `act:${label}`).noul);
      if (!Number.isFinite(probability)) {
        throw new TypeError(`decision model answered \`${label}\` without a probability`);
      }
      actionProbabilities[label] = Number(probability.toFixed(3));
      if (probability >= config.actionThreshold) {
        actions.push(label);
      }
    }
    const usageBody = isObject(body) && isObject(body.usage) ? body.usage : {};
    const confidence = Number(move.confidence);
    // Advisory, so a missing or malformed score never fails the run.
    const scored = Number(answerFor(answers, "progress").score);
    const progress = Number.isFinite(scored)
      ? Number(Math.min(1, Math.max(0, scored / (PROGRESS_LEVELS.length - 1))).toFixed(3))
      : null;
    return {
      actionProbabilities,
      actions,
      confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(3)) : null,
      inputTokens: Number(usageBody.input_tokens) || 0,
      move: choice,
      outputTokens: Number(usageBody.output_tokens) || 0,
      progress,
    };
  };

  // A hung request would otherwise hold the last inputs down until the CLI's
  // whole-run budget expired; a timed-out attempt is retried like a dropped one.
  const timeout = async (): Promise<never> => {
    await env.delay(config.decisionTimeoutMs);
    throw new Error(`no answer within ${config.decisionTimeoutMs} ms`);
  };

  /** One decision, with a short backoff on a rate limit, an upstream fault or a dropped connection. */
  const decide = async (state: DecisionState): Promise<Decision> => {
    if (config.pinMove !== null) {
      // One frame, so the loop still yields to the game between decisions.
      await env.delay(0);
      return {
        actionProbabilities: {},
        actions: [],
        confidence: null,
        inputTokens: 0,
        move: config.pinMove,
        outputTokens: 0,
        progress: null,
      };
    }
    const offered = offeredMoves(state.tick.index);
    const body = JSON.stringify({ model: config.model, questions: questions(offered), state });
    for (let attempt = 0; ; attempt += 1) {
      let response: AgentResponse | null = null;
      let failure = "";
      try {
        response = await Promise.race([
          env.fetch(config.decideUrl, {
            body,
            headers: {
              authorization: `Bearer ${config.token}`,
              "content-type": "application/json",
            },
            method: "POST",
          }),
          timeout(),
        ]);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (response?.ok) {
        const text = await response.text();
        return parseDecision(text, offered);
      }
      if (response !== null && response.status !== 429 && response.status < 500) {
        const text = await response.text();
        throw new Error(`decision failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
      }
      const reason = response === null ? failure : `HTTP ${response.status}`;
      if (attempt >= config.decisionRetries) {
        throw new Error(`decision failed after ${attempt + 1} attempts: ${reason}`);
      }
      await env.delay(500 * 2 ** attempt);
    }
  };

  // ---- reflex + frame loop -----------------------------------------------
  const pointerFrom = (input: ReflexInputs["pointer"]): AgentPointer | null => {
    if (!input) {
      return null;
    }
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return {
      down: input.down === true,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  };

  const keysFrom = (codes: string[] | undefined): AgentKeyInit[] => {
    const inits: AgentKeyInit[] = [];
    for (const code of codes ?? []) {
      const init = config.keyTable[code];
      if (init) {
        inits.push(init);
      }
    }
    return inits;
  };

  /** The keys of the chosen actions, deduplicated against `base`. */
  const withActions = (base: AgentKeyInit[], decision: Decision): AgentKeyInit[] => {
    const keys = [...base];
    const seen = new Set(keys.map((init) => init.code));
    for (const label of decision.actions) {
      for (const init of config.actions[label]?.inits ?? []) {
        if (!seen.has(init.code)) {
          seen.add(init.code);
          keys.push(init);
        }
      }
    }
    return keys;
  };

  const staticInputs = (decision: Decision): HeldInputs => {
    const option = config.move[decision.move];
    return { keys: withActions(option?.inits ?? [], decision), pointer: option?.pointer ?? null };
  };

  const runReflex = (current: Pending): void => {
    if (!current.reflex) {
      return;
    }
    let inputs: ReflexInputs | null | undefined = null;
    try {
      inputs = current.reflex(env.live());
    } catch {
      inputs = null;
    }
    // Actions the model chose stay held alongside whatever the reflex wants.
    // A reflex that returns nothing (or throws) holds nothing: leaving the
    // last frame's keys down would turn a tap into a press that never ends.
    hold({
      keys: withActions(keysFrom(inputs?.keys), current.decision),
      pointer: pointerFrom(inputs?.pointer),
    });
    if (inputs) {
      current.reflexFrames += 1;
      current.reflexStuck ||= inputs.stuck === true;
    }
  };

  const frame = (): void => {
    if (stopped) {
      return;
    }
    sample();
    if (pending) {
      runReflex(pending);
    }
    rafId = env.raf(frame);
  };

  // ---- the run -----------------------------------------------------------
  /** At least two options have to survive any withdrawal: a choice needs them. */
  const canWithdraw = (): boolean => Object.keys(config.move).length - blocked.length - 1 >= 2;

  // The reflex layer for the model: a move that produced nothing for two
  // ticks running is withdrawn from the question. Withdrawals accumulate
  // while the player stays stuck — with a single slot the model alternates
  // between the same two walls — and clear the moment it moves.
  const withdrawIfStuck = (move: string, stuck: boolean, still: boolean): void => {
    if (!still) {
      blocked = [];
    } else if (
      stuck &&
      stuckRun >= config.stuckRun &&
      move !== "none" &&
      !blocked.includes(move) &&
      canWithdraw()
    ) {
      blocked = [...blocked, move];
    }
  };

  // Given a state that points nowhere, the model's safe answer is the option
  // that holds nothing — confidently, every tick, and a playtester standing
  // still learns nothing about the game. A few idle decisions in a row rest
  // that option for a while, so the model has to commit to a direction; its
  // confidence then says honestly how little the state told it.
  const restIfIdle = (done: Pending, still: boolean): void => {
    const option = config.move[done.decision.move];
    const idle =
      done.reflex === null &&
      option !== undefined &&
      option.inits.length === 0 &&
      option.pointer === null;
    idleRun = idle && still ? idleRun + 1 : 0;
    if (idleRun >= config.idleRun && canWithdraw()) {
      rested = { label: done.decision.move, untilTick: done.tick + 1 + config.idleRestTicks };
      idleRun = 0;
    }
  };

  const settle = (done: Pending, measured: AgentWindow): void => {
    const option = config.move[done.decision.move];
    // Only a held direction can be "stuck". A parked pointer that has arrived
    // and a reflex that has converged are both still because they worked —
    // the agent cannot tell a reflex holding position from one wedged in
    // geometry, so a reflex says so itself (`stuck: true`), and then its
    // still windows count like any other.
    const askedToMove = done.reflex
      ? done.reflexStuck
      : option !== undefined && (option.inits.length > 0 || option.pointer?.down === true);
    const progressed = measured.score > measured.scoreBefore;
    let stuck = false;
    if (askedToMove) {
      stuck =
        measured.frame > measured.frameBefore &&
        measured.peak < config.motionEpsilon &&
        !progressed;
      stuckRun = stuck ? stuckRun + 1 : 0;
    }
    const still = measured.peak < config.motionEpsilon && !progressed;
    withdrawIfStuck(done.decision.move, stuck, still);
    restIfIdle(done, still);
    trail.push({ x: round(measured.x), y: round(measured.y), z: round(measured.z) });
    if (trail.length > config.trailLength) {
      trail.shift();
    }
    lastWindow = measured;
    result.records.push({
      actionProbabilities: done.decision.actionProbabilities,
      actions: done.decision.actions,
      askedToMove,
      confidence: done.decision.confidence,
      decisionMs: done.decisionMs,
      inputTokens: done.decision.inputTokens,
      move: done.decision.move,
      outputTokens: done.decision.outputTokens,
      progress: done.decision.progress,
      reflexFrames: done.reflexFrames,
      tick: done.tick,
      window: measured,
    });
  };

  const stateFor = (game: Json, tick: number): DecisionState => ({
    game,
    goal: config.goal,
    recent: {
      blockedMoves: blocked,
      held: pending ? { actions: pending.decision.actions, move: pending.decision.move } : null,
      movedLastTick: lastWindow ? lastWindow.peak : null,
      scoreDeltaLastTick: lastWindow ? lastWindow.score - lastWindow.scoreBefore : null,
      stuckTicksInARow: stuckRun,
      trail,
    },
    tick: { index: tick, of: config.ticks },
  });

  const record = (decision: Decision, decisionMs: number): void => {
    usage.calls += 1;
    usage.inputTokens += decision.inputTokens;
    usage.outputTokens += decision.outputTokens;
    usage.totalDecisionMs += decisionMs;
    usage.maxDecisionMs = Math.max(usage.maxDecisionMs, decisionMs);
  };

  const run = async (): Promise<void> => {
    rafId = env.raf(frame);
    let game = env.snapshot();
    for (let tick = 0; tick < config.ticks; tick += 1) {
      if (stopped) {
        break;
      }
      const t0 = env.now();
      const decision = await decide(stateFor(game, tick));
      const decisionMs = env.now() - t0;
      record(decision, decisionMs);
      if (stopped) {
        break;
      }

      // A floor on how long the previous inputs stay down, for a slower player.
      if (pending) {
        const remaining = config.tickMs - (env.now() - pending.appliedAt);
        if (remaining > 0) {
          await env.delay(remaining);
        }
      }

      // An option with a reflex takes over on the next frame; applying its
      // (empty) static inputs first would drop the pointer the reflex holds,
      // and a held button would be released and re-pressed on every decision.
      const reflex = env.reflexFor(decision.move);
      release(decision.actions.flatMap((label) => config.actions[label]?.inits ?? []));
      if (!reflex) {
        hold(staticInputs(decision));
      }
      const measured = flush();
      if (pending) {
        settle(pending, measured);
      }
      pending = {
        appliedAt: env.now(),
        decision,
        decisionMs,
        reflex,
        reflexFrames: 0,
        reflexStuck: false,
        tick,
      };
      game = env.snapshot();
      if (measured.complete) {
        // The game ended under the previous decision's inputs; this one
        // never got a window and is not counted.
        result.completedAtTick = Math.max(0, tick - 1);
        pending = null;
        break;
      }
    }
    if (pending && !stopped) {
      await env.delay(Math.max(config.tickMs, config.finalHoldMs));
      const measured = flush();
      settle(pending, measured);
      if (measured.complete && result.completedAtTick === null) {
        result.completedAtTick = pending.tick;
      }
      pending = null;
    }
  };

  const finish = (error: string | null): void => {
    stopped = true;
    env.caf(rafId);
    hold({ keys: [], pointer: null });
    result.error = error;
    result.wallMs = env.now() - started;
    result.done = true;
  };

  const main = async (): Promise<void> => {
    try {
      await run();
      finish(null);
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  };
  void main();
  return result;
};
