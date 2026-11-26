import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { poll } from "@repo/smoke";
import { z } from "zod";
import type { JsonValue } from "../src/shared/json.ts";
import { jsonSchema } from "./page-shapes.mts";

/** The parameters of one Chrome DevTools Protocol command. */
export interface CdpParams {
  readonly [key: string]: JsonValue;
}

/** A touch point read back from the page. */
export const touchPointSchema = z.object({ id: z.number(), x: z.number(), y: z.number() });

/** A touch point as `Input.dispatchTouchEvent` takes it. */
export type TouchPoint = z.infer<typeof touchPointSchema>;

const messageSchema = z.object({
  error: z.unknown().optional(),
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
});

const exceptionSchema = z.object({ params: z.object({ exceptionDetails: jsonSchema }) });

const targetsSchema = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
});

const attachedSchema = z.object({ sessionId: z.string() });

const evaluatedSchema = z.object({
  exceptionDetails: z.unknown().optional(),
  result: z.object({ value: z.unknown().optional() }),
});

const screenshotSchema = z.object({ data: z.string() });

type CdpMessage = z.infer<typeof messageSchema>;

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (message: CdpMessage) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const connect = async (url: string) => {
  const socket = new WebSocket(url);
  const opened = Promise.withResolvers<null>();

  const timer = setTimeout(() => {
    opened.reject(new Error("CDP connection timeout"));
  }, 15_000);

  socket.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      opened.resolve(null);
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      clearTimeout(timer);
      opened.reject(new Error("CDP connection failed"));
    },
    { once: true },
  );

  try {
    await opened.promise;
  } catch (error) {
    socket.close();

    throw error;
  }

  return socket;
};

export const createMobileSession = async ({
  sessionPrefix,
  output,
}: {
  sessionPrefix: string;
  output: string;
}) => {
  const session = process.env.WAYMO_BROWSER_SESSION ?? `${sessionPrefix}-${process.pid}`;
  mkdirSync(output, { recursive: true });

  const browser = (...args: string[]) =>
    execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf-8",
      timeout: 90_000,
    }).trim();

  try {
    browser("--headed", "open", "about:blank");
  } catch (error) {
    try {
      browser("close");
    } catch (closeError) {
      console.warn(`browser close failed: ${String(closeError)}`);
    }

    throw error;
  }

  let socket: WebSocket;

  try {
    socket = await connect(browser("get", "cdp-url"));
  } catch (error) {
    try {
      browser("close");
    } catch (closeError) {
      console.warn(`browser close failed: ${String(closeError)}`);
    }

    throw error;
  }

  const pending = new Map<number, Pending>();
  const pageErrors: JsonValue[] = [];
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = messageSchema.parse(JSON.parse(String(event.data)));

    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(exceptionSchema.parse(message).params.exceptionDetails);
    }

    const request = message.id === undefined ? undefined : pending.get(message.id);

    if (message.id === undefined || request === undefined) {
      return;
    }

    pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error === undefined) {
      request.resolve(message);
    } else {
      request.reject(new Error(JSON.stringify(message.error)));
    }
  });

  const send = async (method: string, params?: CdpParams, sessionId?: string) => {
    const { promise, resolve, reject } = Promise.withResolvers<CdpMessage>();
    const id = nextId;
    nextId += 1;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 90_000);

    pending.set(id, { reject, resolve, timer });

    const message =
      sessionId === undefined
        ? { id, method, params: params ?? {} }
        : { id, method, params: params ?? {}, sessionId };

    socket.send(JSON.stringify(message));

    const answer = await promise;

    return answer.result;
  };

  try {
    const { targetInfos } = targetsSchema.parse(await send("Target.getTargets"));

    const target = targetInfos.find(
      (entry) => entry.type === "page" && entry.url === "about:blank",
    );

    if (!target) {
      throw new Error("Owned mobile tab missing");
    }

    const { sessionId } = attachedSchema.parse(
      await send("Target.attachToTarget", { flatten: true, targetId: target.targetId }),
    );

    const call = async (method: string, params?: CdpParams) =>
      await send(method, params, sessionId);

    const evaluate = async (expression: string) => {
      const { result, exceptionDetails } = evaluatedSchema.parse(
        await call("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true }),
      );

      if (exceptionDetails !== undefined) {
        throw new Error(JSON.stringify(exceptionDetails));
      }

      return result.value;
    };

    const read = async <T,>(expression: string, schema: z.ZodType<T>) =>
      schema.parse(await evaluate(expression));

    const until = async (expression: string, timeout = 90_000) => {
      const met = await poll(
        async () => Boolean(await evaluate(expression)),
        (value) => value,
        { intervalMs: 100, timeoutMs: timeout },
      );

      if (met === null) {
        throw new Error(`Mobile condition timed out: ${expression}`);
      }
    };

    const touchPoint = async (selector: string, id: number) =>
      await read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing touch target');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:${id}}})()`,
        touchPointSchema,
      );

    const tap = async (selector: string) => {
      await until(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,
      );
      const point = await touchPoint(selector, 1);
      await call("Input.dispatchTouchEvent", { touchPoints: [point], type: "touchStart" });
      await sleep(80);
      await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
    };

    const pause = async () => {
      const key = { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 };
      await call("Input.dispatchKeyEvent", { ...key, type: "keyDown" });
      await call("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
    };

    const screenshot = async (name: string) => {
      const { data } = screenshotSchema.parse(
        await call("Page.captureScreenshot", { format: "png" }),
      );

      writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, "base64"));
    };

    let closed = false;

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;

      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Browser closed"));
      }

      pending.clear();
      socket.close();
      browser("close");
    };

    return {
      call,
      close,
      evaluate,
      pageErrors,
      pause,
      read,
      screenshot,
      sleep,
      tap,
      touchPoint,
      until,
    };
  } catch (error) {
    socket.close();

    try {
      browser("close");
    } catch (closeError) {
      console.warn(`browser close failed: ${String(closeError)}`);
    }

    throw error;
  }
};
