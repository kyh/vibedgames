/**
 * Stale-tab refresh for deployed games.
 *
 * index.html is served with a 60s cache, so fresh navigations pick up a new
 * deploy quickly — but a mobile tab restored from memory/bfcache makes NO
 * network request and can keep running a weeks-old build forever. The worker
 * injects a tiny script into every served game page: when the tab returns
 * after being hidden for a while (or is restored from the back/forward
 * cache), it asks the worker for the current deployment id and reloads if a
 * new build shipped. A reload only ever fires when the build actually
 * changed, and never mid-play — only on resume after a real absence.
 */

/** How long a tab must have been hidden before a resume triggers the check —
 *  quick app switches during a run never yank the player. */
const MIN_HIDDEN_MS = 5 * 60 * 1000;

export const VERSION_PATH = "/__vg/version";

export function versionResponse(deploymentId: string): Response {
  return new Response(deploymentId, {
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store",
    },
  });
}

/**
 * Insert the freshness script at the end of `<head>` (same insertion rules as
 * the share-meta block; malformed documents are served untouched).
 */
export function injectFreshness(html: string, deploymentId: string): string {
  const script = renderFreshnessScript(deploymentId);
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) {
    return html.slice(0, headClose.index) + script + html.slice(headClose.index);
  }
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + "\n" + script + html.slice(at);
  }
  return html;
}

function renderFreshnessScript(deploymentId: string): string {
  // Deployment ids come from our DB (url-safe), but stringify anyway so the
  // inline script can never be broken by an unexpected character.
  const id = JSON.stringify(deploymentId);
  return (
    `    <script>(()=>{var v=${id},hiddenAt=0;` +
    `function check(){fetch(${JSON.stringify(VERSION_PATH)},{cache:"no-store"})` +
    `.then(r=>r.ok?r.text():v).then(cur=>{if(cur&&cur!==v)location.reload()})` +
    `.catch(()=>{})}` +
    `document.addEventListener("visibilitychange",()=>{` +
    `if(document.visibilityState==="hidden"){hiddenAt=Date.now()}` +
    `else if(hiddenAt&&Date.now()-hiddenAt>${MIN_HIDDEN_MS}){check()}});` +
    `addEventListener("pageshow",e=>{if(e.persisted&&hiddenAt&&Date.now()-hiddenAt>${MIN_HIDDEN_MS})check()});` +
    `})()</script>\n`
  );
}
