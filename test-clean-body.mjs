/**
 * test-clean-body.mjs
 *
 * Unit tests for cleanCommentBody — the content-policy contract:
 *
 *   KEEP  — every word a reader sees: prose byte-faithful (never escaped,
 *           never reflowed), link TEXT, bare URLs the author typed, file
 *           paths, identifiers, fenced code/diff material untouched.
 *   DROP  — web furniture: link TARGETS (unwrap), angle autolinks from the
 *           page→markdown translation, images entirely, HTML comments,
 *           bot promo/footer lines, promo-only comments (→ "").
 *
 * Run:  node test-clean-body.mjs   (after `pnpm build`)
 */

import { cleanCommentBody } from "./dist/pr-renderer.js";

let pass = 0;
const failures = [];

function eq(name, input, expected) {
  const got = cleanCommentBody(input);
  if (got === expected) { pass++; return; }
  failures.push({ name, input, expected, got });
}

function checks(name, input, preds) {
  const got = cleanCommentBody(input);
  for (const [label, fn] of Object.entries(preds)) {
    if (fn(got)) { pass++; }
    else failures.push({ name: `${name} :: ${label}`, input, expected: "(predicate)", got });
  }
}

// ─── Link unwrapping: text is content, target is furniture ───────────────────

eq("inline link unwraps to text",
  "Check [this guide](https://example.com/setup) for setup",
  "Check this guide for setup");

eq("link text with code span unwraps",
  "See [`config_loader.ts`](https://github.com/x/y/blob/main/config_loader.ts) for details",
  "See `config_loader.ts` for details");

eq("angle autolink removed",
  "Translated page debris <https://whatever.side/random?link=1> here",
  "Translated page debris here");

eq("mailto autolink removed",
  "Contact <mailto:bot@example.com> for help",
  "Contact for help");

eq("empty link removed",
  "Badge husk [](https://shield.example.com) gone",
  "Badge husk gone");

eq("reference link unwraps when defined",
  "See [docs][1] and [api][2] here\n\n[1]: https://docs.example.com\n[2]: https://api.example.com",
  "See docs and api here");

eq("undefined bracket pair kept literally",
  "Indexing arr[1][2] and map[key][field] stays",
  "Indexing arr[1][2] and map[key][field] stays");

eq("reference-looking prose kept (target not URL-shaped)",
  "[ERROR]: timeout after 30s",
  "[ERROR]: timeout after 30s");

// ─── Bare URLs: author content stays ─────────────────────────────────────────

eq("bare URL typed by author stays",
  "The spec lives at https://spec.example.com/v2 today",
  "The spec lives at https://spec.example.com/v2 today");

// ─── Images: removed completely ──────────────────────────────────────────────

eq("inline image removed entirely (alt text too)",
  "Before ![coverage badge](https://img.shields.io/x.svg) after",
  "Before after");

eq("image-only comment becomes empty",
  "![mascot](https://bot.example.com/mascot.png)",
  "");

eq("html img removed",
  "Before <img src=\"https://x.com/badge.png\" alt=\"b\"> after",
  "Before after");

// ─── Code protection: fences and inline code are sacred ─────────────────────

eq("diff fence contents byte-faithful",
  "```diff\n-[a](b) <https://keep.example.com> ![img](x.png)\n+code line\n```",
  "```diff\n-[a](b) <https://keep.example.com> ![img](x.png)\n+code line\n```");

eq("inline code span with link syntax kept",
  "Use `[x](y)` in your markdown",
  "Use `[x](y)` in your markdown");

eq("inline code span with angle URL kept",
  "The literal `<https://example.com>` form",
  "The literal `<https://example.com>` form");

eq("suggestion fence untouched",
  "Try this:\n\n```suggestion\nconst x = arr[0];\n```",
  "Try this:\n\n```suggestion\nconst x = arr[0];\n```");

checks("fence with trailing whitespace and blank runs preserved",
  "prose\n\n```\nline  \n\n\n\nend\n```",
  {
    "fence bytes exact": (g) => g.includes("```\nline  \n\n\n\nend\n```"),
  });

// ─── No escaping, no reflow: prose is byte-faithful ──────────────────────────

eq("identifiers never escaped",
  "Use snake_case_var and call foo_bar() on array[0].",
  "Use snake_case_var and call foo_bar() on array[0].");

eq("multi-line prose not reflowed",
  "First line of the paragraph\nsecond line stays on its own line\nthird line too",
  "First line of the paragraph\nsecond line stays on its own line\nthird line too");

// ─── Bot noise lines ─────────────────────────────────────────────────────────

eq("copilot footer dropped",
  "Real finding prose here.\n\nCopilot uses AI. Check for mistakes.",
  "Real finding prose here.");

eq("share-spam line dropped BY its link (ordering contract)",
  "Real review prose here.\n[Share on Twitter](https://twitter.com/intent/tweet?x=1)\nMore prose with a [doc](https://docs.example.com/guide).",
  "Real review prose here.\nMore prose with a doc.");

eq("thanks-for-using dropped",
  "Finding text.\n\nThanks for using CodeRabbit! It's free for OSS.",
  "Finding text.");

eq("alert marker line dropped, note prose kept",
  "> [!NOTE]\n> The actual note content stays.",
  "> The actual note content stays.");

eq("view reviewed changes caption dropped",
  "Actionable comments were posted.\nView reviewed changes >",
  "Actionable comments were posted.");

// ─── Promo-only comments collapse to empty (caller skips the card) ──────────

eq("promo-only comment → empty",
  "Thanks for using CodeRabbit! It's free for OSS.\n[Share on Twitter](https://twitter.com/intent/tweet)",
  "");

eq("html-comment-only body → empty",
  "<!-- coderabbitai walkthrough marker -->",
  "");

// ─── HTML cleanup (bot summaries) ────────────────────────────────────────────

eq("html comment removed, code example showing one kept",
  "<!-- meta -->Prose and `<!-- in code -->` stays",
  "Prose and `<!-- in code -->` stays");

eq("details boilerplate removed",
  "Keep this.\n<details><summary>Tips</summary>Promo body</details>",
  "Keep this.");

eq("anchor tag unwrapped to text",
  "See <a href=\"https://x.com/profile\">the docs</a> here",
  "See the docs here");

// ─── Review-audit regression cases (findings 2.1–2.6) ───────────────────────

eq("fenced code example SHOWING a details tag is kept (finding 2.1)",
  "Add a details tag:\n```html\n<details><summary>foo</summary>bar</details>\n```\nUse that pattern.",
  "Add a details tag:\n```html\n<details><summary>foo</summary>bar</details>\n```\nUse that pattern.");

eq("bot details footer CONTAINING a fence is removed whole (finding 2.1 dual)",
  "Real finding.\n<details><summary>Walkthrough</summary>\n\n```log\nnoise line\n```\n\npromo</details>",
  "Real finding.");

eq("fenced code example SHOWING an html comment is kept (finding 2.1 dual)",
  "Example:\n```html\n<!-- keep me -->\n```\nDone.",
  "Example:\n```html\n<!-- keep me -->\n```\nDone.");

eq("mailto reference link unwraps when defined (finding 2.2)",
  "Mail [team][1]\n\n[1]: mailto:team@example.com",
  "Mail team");

eq("two-level paren URL unwraps (finding 2.3)",
  "See [text](https://wiki.org/foo_(bar_(baz))_qux) here",
  "See text here");

eq("anchor wrapping only an image leaves no double space (finding 2.5)",
  "Click <a href=\"x\"><img src=\"y\"/></a> here",
  "Click here");

// ─── Idempotency: clean(clean(x)) === clean(x) ───────────────────────────────

const idempotencyInputs = [
  "Check [this guide](https://example.com) for setup",
  "```diff\n-[a](b)\n+[c](d)\n```",
  "Use `[x](y)` and snake_case in array[0].",
  "See [docs][1]\n\n[1]: https://docs.example.com",
  "> [!NOTE]\n> Note prose.\n\n![img](https://x.png) and <https://y.com>",
  "Plain prose with https://bare.example.com typed by the author.",
  "Add a details tag:\n```html\n<details><summary>foo</summary>bar</details>\n```\nUse that pattern.",
  "Mail [team][1]\n\n[1]: mailto:team@example.com",
  "See [text](https://wiki.org/foo_(bar_(baz))_qux) here",
];
for (const input of idempotencyInputs) {
  const once = cleanCommentBody(input);
  const twice = cleanCommentBody(once);
  if (once === twice) { pass++; }
  else failures.push({ name: "idempotency", input, expected: once, got: twice });
}

// ─── Adversarial: never throws, always returns a string ──────────────────────

const adversarial = [
  "",
  null,
  undefined,
  "```\nunclosed fence with [link](https://x.com)",
  "<a href=",
  "![only](https://x.png)",
  "> > [nested](https://x.com) quote",
  "[",
  "]() [](",
  "`unclosed code span with [link](url)",
];
for (const bad of adversarial) {
  try {
    const got = cleanCommentBody(bad);
    if (typeof got === "string") { pass++; }
    else failures.push({ name: "adversarial returns string", input: String(bad), expected: "string", got: typeof got });
  } catch (e) {
    failures.push({ name: "adversarial must not throw", input: String(bad), expected: "no throw", got: e.message });
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`PASS — ${pass} assertions passed.`);
  process.exit(0);
} else {
  console.error(`FAIL — ${failures.length} of ${pass + failures.length} assertions failed:\n`);
  for (const f of failures) {
    console.error(`✗ ${f.name}`);
    console.error(`   input:    ${JSON.stringify(f.input)}`);
    console.error(`   expected: ${JSON.stringify(f.expected)}`);
    console.error(`   got:      ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
