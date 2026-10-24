#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, "src", "styles", "index.css"), "utf8");

assert.match(
  styles,
  /\.cm-editor \.cm-panel\.cm-search \.cm-textfield\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--fg\);[^}]*caret-color:\s*var\(--fg\);/s,
  "CodeMirror find and replace fields must use the active theme surface and foreground",
);
assert.match(
  styles,
  /\.cm-editor \.cm-panel\.cm-search \.cm-textfield::placeholder\s*\{[^}]*color:\s*var\(--muted\);/s,
  "CodeMirror search placeholders must remain visible in both themes",
);
assert.match(
  styles,
  /\.cm-editor \.cm-panel\.cm-search \.cm-button\s*\{[^}]*background:\s*var\(--surface-hover\);[^}]*color:\s*var\(--fg\);/s,
  "CodeMirror search actions must use the active theme surface and foreground",
);

console.log("theme checks passed");
