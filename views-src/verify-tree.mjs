import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-file-tree-"));
const output = join(temp, "tree.cjs");
try {
  await build({ stdin: { contents: `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Tree } from ${JSON.stringify(join(here, "src/components/Tree.tsx"))};
import { makeT } from ${JSON.stringify(join(here, "src/i18n.ts"))};
export function render(directories, expanded = []) {
 return renderToStaticMarkup(React.createElement(Tree, { directories: new Map(directories), expanded: new Set(expanded),
 selected: null, showIgnored: false, t: makeT("en"), onToggle() {}, onOpen() {}, onRefreshDir() {}, onContextMenu() {} }));
}`, resolveDir: here }, platform: "node", bundle: true, format: "cjs", jsx: "automatic", outfile: output });
  const { render } = createRequire(import.meta.url)(output);
  const failed = render([["", { error: "Host disconnected — refresh to retry" }]]);
  assert.match(failed, /Host disconnected/);
  assert.match(failed, /Retry/);
  assert.match(failed, /aria-busy="false"/);
  assert.doesNotMatch(failed, /Loading/);
  const nested = render([["", { entries: [{ name: "docs", path: "docs", isDirectory: true }] }],
    ["docs", { error: "Remote directory is unavailable" }]], ["docs"]);
  assert.match(nested, /Remote directory is unavailable/);
  assert.match(render([["", { loading: true }]]), /aria-busy="true"/);
  assert.match(render([["", { entries: [] }]]), /This folder is empty/);
  console.log("TREE VERIFY PASSED: root/nested failures are visible and retryable, loading and empty remain distinct");
} finally { rmSync(temp, { recursive: true, force: true }); }
