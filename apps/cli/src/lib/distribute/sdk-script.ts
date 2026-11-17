/**
 * The packaged index.html with a portal SDK's script tag first in <head>, ahead
 * of every game script, as the SDK requires. Unchanged when the tag is already
 * there.
 */
export const withSdkScript = (html: string, script: string): string => {
  if (html.includes(`src="${script}"`) || html.includes(`src='${script}'`)) {
    return html;
  }
  const tag = `<script src="${script}"></script>`;
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
  }
  const firstScript = html.search(/<script\b/iu);
  return firstScript === -1
    ? `${tag}\n${html}`
    : `${html.slice(0, firstScript)}${tag}\n${html.slice(firstScript)}`;
};
