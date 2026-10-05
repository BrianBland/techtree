import { h, type ComponentChild } from "preact";

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"]$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[" };

/** `text` as text pieces and `<a>` links for its http(s) URLs; markup in `text` stays text. */
export function linkify(text: string): ComponentChild[] {
  const pieces: ComponentChild[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > at) pieces.push(text.slice(at, match.index));
    pieces.push(h("a", { href: url, target: "_blank", rel: "noreferrer", onClick: (e: Event) => e.stopPropagation() }, url));
    at = match.index + url.length;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return pieces;
}

/** Drop trailing punctuation and closing brackets whose opener is not part of the URL. */
function trimUrl(url: string): string {
  for (;;) {
    const last = url.at(-1)!;
    const opener = CLOSERS[last];
    const unbalanced = opener !== undefined && url.split(opener).length <= url.split(last).length - 1;
    if (!TRAILING_PUNCTUATION.test(url) && !unbalanced) return url;
    url = url.slice(0, -1);
  }
}
