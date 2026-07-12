// Headed flyover screenshot harness for world verification: boots nothing —
// point it at a RUNNING dev server (pnpm dev), it starts the game, pins noon,
// enables freecam and shoots each spot. Edit SPOTS per investigation.
//
//   node tools/flyover-shots.mjs <outDir> [port]
import { chromium } from "playwright-core";
const OUT = process.argv[2] ?? "/tmp/shots";
const PORT = process.argv[3] ?? "5199";
const SPOTS = [
  ["tilted-a", 452, 70, -862, 428, 38, -906],
  ["tilted-b", 400, 75, -940, 430, 40, -905],
];
const browser = await chromium.launch({ headless: false, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__taxi?.game?.isReady === true, null, { timeout: 180000, polling: 500 });
await page.evaluate(() => { globalThis.__taxi.game.handleStartPress(); });
await page.waitForTimeout(4500);
await page.evaluate(() => { globalThis.__taxi.setPhase(0.25); globalThis.__taxi.setFreecam(true); });
for (const [name, cx, cy, cz, tx, ty, tz] of SPOTS) {
  await page.evaluate(([a,b,c,d,e,f]) => globalThis.__taxi.lookFrom(a,b,c,d,e,f), [cx,cy,cz,tx,ty,tz]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
}
await browser.close();
