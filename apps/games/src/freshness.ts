const MIN_HIDDEN_MS = 5 * 60 * 1000;

export const VERSION_PATH = "/__vg/version";

export const versionResponse = (deploymentId: string) =>
  new Response(deploymentId, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain",
    },
  });

const renderFreshnessScript = (deploymentId: string) => {
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
};

/**
 * Insert the freshness script at the end of `<head>` (same insertion rules as
 * the share-meta block; malformed documents are served untouched).
 */
export const injectFreshness = (html: string, deploymentId: string) => {
  const script = renderFreshnessScript(deploymentId);
  const headClose = /<\/head\s*>/iu.exec(html);

  if (headClose) {
    return html.slice(0, headClose.index) + script + html.slice(headClose.index);
  }

  const headOpen = /<head[^>]*>/iu.exec(html);

  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;

    return `${html.slice(0, at)}\n${script}${html.slice(at)}`;
  }

  return html;
};
