import { test } from "node:test";
import assert from "node:assert/strict";
import type { VNode } from "preact";
import { linkify } from "../../src/web/linkify.ts";

/** The pieces as plain data: strings stay strings, links become `[href, text]`. */
function pieces(text: string): (string | [string, string])[] {
  return linkify(text).map((piece) => {
    if (typeof piece === "string") return piece;
    const { type, props } = piece as VNode<{ href: string; target: string; rel: string; children: string }>;
    assert.equal(type, "a");
    assert.equal(props.target, "_blank");
    assert.equal(props.rel, "noreferrer");
    return [props.href, props.children];
  });
}

test("http and https URLs become links; the rest stays text", () => {
  assert.deepEqual(pieces("opened https://github.com/o/r/pull/12 and http://x.dev/a?b=1#c too"), [
    "opened ",
    ["https://github.com/o/r/pull/12", "https://github.com/o/r/pull/12"],
    " and ",
    ["http://x.dev/a?b=1#c", "http://x.dev/a?b=1#c"],
    " too",
  ]);
  assert.deepEqual(pieces("no links here"), ["no links here"]);
  assert.deepEqual(pieces(""), []);
});

test("trailing punctuation and unmatched closing brackets stay outside the link", () => {
  assert.deepEqual(pieces("see https://a.dev/x."), ["see ", ["https://a.dev/x", "https://a.dev/x"], "."]);
  assert.deepEqual(pieces("(at https://a.dev/x)!"), ["(at ", ["https://a.dev/x", "https://a.dev/x"], ")!"]);
  assert.deepEqual(pieces("https://en.wikipedia.org/wiki/Foo_(bar), ok"), [
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ", ok",
  ]);
  assert.deepEqual(pieces('"https://a.dev/q";'), ['"', ["https://a.dev/q", "https://a.dev/q"], '";']);
});

test("markup in the text stays text and never becomes part of a link", () => {
  assert.deepEqual(pieces('<img src=x onerror=alert(1)> https://a.dev/<script>'), [
    "<img src=x onerror=alert(1)> ",
    ["https://a.dev/", "https://a.dev/"],
    "<script>",
  ]);
  assert.deepEqual(pieces("javascript:alert(1)"), ["javascript:alert(1)"]);
});

test("trimming a URL ending in thousands of unmatched brackets stays fast", () => {
  const started = performance.now();
  assert.deepEqual(pieces(`https://example.com/${")".repeat(50_000)}`), [["https://example.com/", "https://example.com/"], ")".repeat(50_000)]);
  assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
});
