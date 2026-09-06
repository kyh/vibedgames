// One owned headed browser and persistent CDP connection per verification run.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function createMobileSession({ sessionPrefix, output }) {
  const session = process.env.WAYMO_BROWSER_SESSION ?? `${sessionPrefix}-${process.pid}`;
  mkdirSync(output, { recursive: true });
  function browser(...args) {
    return execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf8",
      timeout: 90_000,
    }).trim();
  }
  let launched = false;
  let socket;
  try {
    launched = true;
    browser("--headed", "open", "about:blank");
    socket = new WebSocket(browser("get", "cdp-url"));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 15000);
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
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 90_000);
        pending.set(id, { resolve, reject, timer });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        socket.send(JSON.stringify(message));
      });
    }
    const { targetInfos } = await send("Target.getTargets");
    const target = targetInfos.find(
      (entry) => entry.type === "page" && entry.url === "about:blank",
    );
    if (!target) throw new Error("Owned mobile tab missing");
    const { sessionId } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const call = (method, params) => send(method, params, sessionId);
    async function evaluate(expression) {
      const { result, exceptionDetails } = await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
      return result.value;
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function until(expression, timeout = 90_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Mobile condition timed out: ${expression}`);
    }
    async function tap(selector) {
      await until(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,
      );
      const point = await touchPoint(selector, 1);
      await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await sleep(80);
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    function touchPoint(selector, id) {
      return evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing touch target');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:${id}}})()`,
      );
    }
    async function screenshot(name) {
      const { data } = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, "base64"));
    }
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Browser closed"));
      }
      pending.clear();
      socket.close();
      browser("close");
    }
    return { call, evaluate, sleep, until, tap, touchPoint, screenshot, close, pageErrors };
  } catch (error) {
    socket?.close();
    if (launched) {
      try {
        browser("close");
      } catch {}
    }
    throw error;
  }
}
