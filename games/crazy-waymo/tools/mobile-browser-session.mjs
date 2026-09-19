// One owned headed browser and persistent CDP connection per verification run.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const createMobileSession = async ({ sessionPrefix, output }) => {
  const session = process.env.WAYMO_BROWSER_SESSION ?? `${sessionPrefix}-${process.pid}`;
  mkdirSync(output, { recursive: true });
  const browser = (...args) =>
    execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf-8",
      timeout: 90_000,
    }).trim();
  let launched = false;
  let socket;
  try {
    launched = true;
    browser("--headed", "open", "about:blank");
    socket = new WebSocket(browser("get", "cdp-url"));
    // oxlint-disable-next-line promise/avoid-new -- wraps the WebSocket open/error events
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 15_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
        { once: true },
      );
    });
    const pending = new Map();
    const pageErrors = [];
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        pageErrors.push(message.params.exceptionDetails);
      }
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(new Error(JSON.stringify(message.error)));
      } else {
        request.resolve(message.result);
      }
    });
    const send = (method, params, sessionId) =>
      // oxlint-disable-next-line promise/avoid-new -- wraps the CDP request/response message pair
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 90_000);
        pending.set(id, { reject, resolve, timer });
        const message = { id, method, params: params ?? {} };
        if (sessionId) {
          message.sessionId = sessionId;
        }
        socket.send(JSON.stringify(message));
      });
    const { targetInfos } = await send("Target.getTargets");
    const target = targetInfos.find(
      (entry) => entry.type === "page" && entry.url === "about:blank",
    );
    if (!target) {
      throw new Error("Owned mobile tab missing");
    }
    const { sessionId } = await send("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId,
    });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await call("Runtime.evaluate", {
        awaitPromise: true,
        expression,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(JSON.stringify(exceptionDetails));
      }
      return result.value;
    };
    const until = async (expression, timeout = 90_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) {
          return;
        }
        await sleep(100);
      }
      throw new Error(`Mobile condition timed out: ${expression}`);
    };
    const tap = async (selector) => {
      await until(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,
      );
      const point = await touchPoint(selector, 1);
      await call("Input.dispatchTouchEvent", { touchPoints: [point], type: "touchStart" });
      await sleep(80);
      await call("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
    };
    const touchPoint = (selector, id) =>
      evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing touch target');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:${id}}})()`,
      );
    const screenshot = async (name) => {
      const { data } = await call("Page.captureScreenshot", { format: "png" });
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
    return { call, close, evaluate, pageErrors, screenshot, sleep, tap, touchPoint, until };
  } catch (error) {
    socket?.close();
    if (launched) {
      try {
        browser("close");
      } catch {
        // the browser may already be gone; the original error is what matters
      }
    }
    throw error;
  }
};
