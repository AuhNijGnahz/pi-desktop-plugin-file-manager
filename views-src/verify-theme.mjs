#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, "src", "styles", "index.css"), "utf8");
const bundle = readFileSync(join(here, "..", "views", "assets", "index.js"), "utf8");

/**
 * CodeMirror 查找 / 替换面板与它自己的对话框（Mod-Alt-g 的「跳转到行」）共用
 * `.cm-textfield` 与 `.cm-button`。编辑器没有打开 CodeMirror 的 dark 主题，基础主题的
 * `&light` 分支会把这些控件刷成白底 / 浅色渐变，文字却继承 `.cm-panels` 的
 * `var(--fg)`——暗色外观下就是白底白字。以下断言钉住「显式跟随插件调色板」这条契约，
 * 并且同时检查源码与真正发出去的 `views/assets/index.js`：只改 CSS 忘了 `pnpm build`
 * 时，产物里仍然是旧样式，插件照旧白底白字。
 */
const PANEL = ".cm-editor .cm-panel:is(.cm-search, .cm-dialog)";

const panelRules = new Map([
  [`${PANEL} .cm-textfield`, ["background: var(--surface)", "color: var(--fg)", "caret-color: var(--fg)"]],
  [`${PANEL} .cm-textfield::placeholder`, ["color: var(--muted)"]],
  [`${PANEL} .cm-button`, ["background: var(--surface-hover)", "color: var(--fg)"]],
  [`${PANEL} .cm-button:hover:not(:disabled)`, ["background: var(--surface-active)"]],
]);

/** 取出某个选择器的声明块，去掉缩进与换行，避免断言绑死在属性顺序或排版上。 */
function declarations(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing theme rule for "${selector}"`);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

for (const [selector, expected] of panelRules) {
  const body = declarations(selector);
  for (const declaration of expected) {
    assert.ok(
      body.includes(declaration),
      `"${selector}" must declare ${declaration} so the control follows the plugin palette`,
    );
  }
}

// 构建产物是压缩过的：断言前把空白全部去掉，只认可语义等价的样式表。
const minified = bundle.replace(/\s+/g, "");
for (const selector of [".cm-textfield", ".cm-button"]) {
  assert.ok(
    minified.includes(`.cm-panel:is(.cm-search,.cm-dialog)${selector}{`),
    `views/assets/index.js is stale: rebuild it ("pnpm build") so it ships the themed ${selector}`,
  );
}
assert.ok(
  minified.includes("background:var(--surface);color:var(--fg);caret-color:var(--fg)"),
  "views/assets/index.js is stale: the shipped rule must set surface, foreground and caret colour",
);

console.log("theme checks passed (source + views/assets/index.js)");
