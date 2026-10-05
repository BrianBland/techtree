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

/** Drop trailing punctuation and closing brackets whose opener is not part of the URL, in one pass. */
function trimUrl(url: string): string {
  const counts: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0 };
  for (const char of url) if (char in counts) counts[char]++;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const opener = CLOSERS[last];
    if (opener !== undefined && counts[opener] < counts[last]) counts[last]--;
    else if (!TRAILING_PUNCTUATION.test(last)) break;
    end--;
  }
  return url.slice(0, end);
}
