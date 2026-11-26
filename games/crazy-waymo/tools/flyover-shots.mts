import { chromium } from "playwright-core";

import { inOrder } from "../src/shared/paced.ts";

const OUT = process.argv[2] ?? "/tmp/shots";
const PORT = process.argv[3] ?? "5199";

const SPOTS = [
  ["kit-chinatown", 547, 90, -710, 547, 0, -806],
  ["kit-fidi", 560, 60, -640, 680, 25, -850],
  ["kit-overview", 620, 380, -380, 640, 0, -830],
  ["kit-soma-street", 640, 16, -560, 700, 6, -600],
] as const;

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { height: 950, width: 1500 } });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

await page.waitForFunction(() => window.__taxi?.game.isReady === true, null, {
  polling: 500,
  timeout: 180_000,
});

await page.evaluate(() => {
  window.__taxi?.game.handleStartPress();
});

await page.waitForTimeout(4500);

await page.evaluate(() => {
  window.__taxi?.setPhase(0.25);
  window.__taxi?.setFreecam(true);
});

for await (const [name, cx, cy, cz, tx, ty, tz] of inOrder(SPOTS)) {
  await page.evaluate(
    ([a, b, c, d, e, f]) => {
      window.__taxi?.lookFrom(a, b, c, d, e, f);
    },
    [cx, cy, cz, tx, ty, tz] as const,
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
}

await browser.close();
