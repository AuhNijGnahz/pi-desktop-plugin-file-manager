/**
 * 查看器判定与解析的离线校验。
 *
 * 表格和折叠树都是「把文件内容变成界面」的路径：解析器写错不会抛异常，只会
 * 静默显示错——少一列、多一行、把引号里的逗号当成分隔符、把注释里的 // 当数据。
 * 这里断言的是纯函数的返回值，不需要 DOM（与 verify-markdown.mjs 同样的做法）。
 *
 * 用法：pnpm verify:viewers
 */

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-viewers-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  const src = join(process.cwd(), "src", "lib");

  writeFileSync(
    entry,
    `export * as csv from ${JSON.stringify(join(src, "csv.ts"))};\n` +
      `export * as json from ${JSON.stringify(join(src, "json.ts"))};\n` +
      `export * as viewers from ${JSON.stringify(join(src, "viewers.ts"))};\n` +
      `export * as openFile from ${JSON.stringify(join(src, "openFile.ts"))};\n` +
      `export * as pane from ${JSON.stringify(join(src, "pane.ts"))};\n`,
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });

  return import(pathToFileURL(out).href);
}

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? `  → ${detail}` : ""}`);
};

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

const main = async () => {
  const { csv, json, viewers, openFile, pane } = await loadModule();

  console.log("--- CSV 解析 ---");
  const cases = [
    ["普通两行", "a,b\n1,2\n", [["a", "b"], ["1", "2"]]],
    ["末行无换行", "a,b\n1,2", [["a", "b"], ["1", "2"]]],
    ["引号包裹的逗号", '"a,b",c\n', [["a,b", "c"]]],
    ["双引号转义", '"say ""hi""",x\n', [['say "hi"', "x"]]],
    ["字段内换行", '"l1\nl2",x\n', [["l1\nl2", "x"]]],
    ["CRLF", "a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    ["空字段", "a,,\n", [["a", "", ""]]],
    ["参差的行", "a,b,c\n1\n", [["a", "b", "c"], ["1"]]],
    ["字段中间的引号是普通字符", 'a"b,c\n', [['a"b', "c"]]],
    ["空文件", "", []],
    ["单行", "only\n", [["only"]]],
    ["制表符分隔", "a\tb\n1\t2\n", [["a", "b"], ["1", "2"]]],
  ];

  for (const [label, source, expected] of cases) {
    const delimiter = label === "制表符分隔" ? "\t" : ",";
    const result = csv.parseDelimited(source, delimiter);
    check(
      same(result.rows, expected) && result.truncated === false,
      `${label} → ${JSON.stringify(expected)}`,
      `got ${JSON.stringify(result.rows)} truncated=${result.truncated}`,
    );
  }

  const capped = csv.parseDelimited("1\n2\n3\n4\n", ",", 2);
  check(
    capped.rows.length === 2 && capped.truncated === true,
    "超过行数上限时截断并标记 truncated",
    `rows=${capped.rows.length} truncated=${capped.truncated}`,
  );

  check(
    csv.tableWidth([["a", "b", "c"], ["d"]]) === 3,
    "列数取最宽的一行",
    csv.tableWidth([["a", "b", "c"], ["d"]]),
  );

  const wide = [Array.from({ length: csv.MAX_TABLE_COLUMNS + 25 }, (_, index) => String(index))];
  check(
    csv.tableWidth(wide) === csv.MAX_TABLE_COLUMNS,
    `列数封顶在 ${csv.MAX_TABLE_COLUMNS}`,
    csv.tableWidth(wide),
  );

  console.log("\n--- 分页 ---");
  const firstPage = csv.pageBounds(12345, 1000, 1);
  check(
    firstPage.page === 1 && firstPage.pageCount === 13 && firstPage.from === 0 && firstPage.to === 1000,
    "第 1 页：1–1000 / 共 13 页",
    JSON.stringify(firstPage),
  );
  const lastPage = csv.pageBounds(12345, 1000, 13);
  check(
    lastPage.from === 12000 && lastPage.to === 12345,
    "末页只切到实际行数（最后一页通常不满）",
    JSON.stringify(lastPage),
  );
  check(csv.pageBounds(12345, 1000, 99).page === 13, "页码越界夹到末页，而不是显示空白");
  check(
    csv.pageBounds(0, 1000, 1).pageCount === 1 && csv.pageBounds(0, 1000, 1).to === 0,
    "空表也有 1 页（不会出现第 0 页）",
  );
  check(csv.pageBounds(10, 5000, 1).pageCount === 1, "每页行数大于总行数时只有一页");
  check(csv.DEFAULT_PAGE_SIZE === 1000, "默认每页 1000 行");
  check(csv.PAGE_SIZES.includes(csv.DEFAULT_PAGE_SIZE), "默认值在可选项里（否则下拉框显示空白）");

  console.log("\n--- 数字列 ---");
  check(
    same(csv.numericColumns([["1", "2.5", "x"], ["-3", "1e6", "y"]], 3), [true, true, false]),
    "整列都是数字才右对齐",
  );
  check(same(csv.numericColumns([[""], ["  "]], 1), [false]), "整列空值不算数字列");
  check(same(csv.numericColumns([["1"], ["n/a"]], 1), [false]), "混进一个非数字就退回左对齐");

  console.log("\n--- 表头排序 ---");
  const sortable = [["b", "2"], ["a", "10"], ["", "1"], ["a", "2"]];
  check(
    same(csv.sortRows(sortable, null).map((row) => row.index), [0, 1, 2, 3]),
    "不排序时保持文件原序，只把行号附上",
  );
  check(
    same(csv.sortRows(sortable, { column: 0, direction: "asc" }).map((row) => row.cells[0]), ["a", "a", "b", ""]),
    "文本列升序，空值沉底",
  );
  check(
    same(csv.sortRows(sortable, { column: 0, direction: "desc" }).map((row) => row.cells[0]), ["b", "a", "a", ""]),
    "降序时空值仍然沉底（不会一股脑飘到最前面）",
  );
  check(
    same(csv.sortRows(sortable, { column: 0, direction: "asc" }).map((row) => row.index), [1, 3, 0, 2]),
    "行号跟着原行走，排完还能看出它原来是第几行",
  );
  check(
    same(csv.sortRows(sortable, { column: 1, direction: "asc" }).map((row) => row.cells[1]), ["1", "2", "2", "10"]),
    "整列都是数字 → 按数值排：10 在 2 后面",
  );
  // 这两条说明「整列数字」为什么要单独判：文本序会把小数和负数排反
  check(
    same(csv.sortRows([["9.5"], ["9.25"]], { column: 0, direction: "asc" }).map((r) => r.cells[0]), ["9.25", "9.5"]),
    "小数按数值排（文本序会把 9.5 排在 9.25 前面）",
  );
  check(
    same(csv.sortRows([["-5"], ["-10"]], { column: 0, direction: "asc" }).map((r) => r.cells[0]), ["-10", "-5"]),
    "负数按数值排（-10 在 -5 前面）",
  );
  check(
    same(csv.sortRows([["file10"], ["file2"]], { column: 0, direction: "asc" }).map((r) => r.cells[0]), ["file2", "file10"]),
    "文本列用自然序：file2 在 file10 前面",
  );
  check(csv.sortRows(sortable, { column: 1, direction: "asc" })[0].cells.length === 2, "排序不改变行的内容");

  console.log("\n--- JSON 解析 ---");
  const good = json.parseJson('{"a":[1,true,null],"b":"x"}');
  check(good.ok === true, "合法 JSON 解析成功");
  check(good.ok === true && Array.isArray(good.value.a) && good.value.a.length === 3, "取值可用");
  check(json.describeJson({ a: 1, b: 2 }) === "2", "对象摘要给的是键数", json.describeJson({ a: 1, b: 2 }));
  check(json.describeJson([1, 2, 3]) === "3", "数组摘要给的是元素数");
  check(json.describeJson(null) === "null", "null 摘要");

  for (const bad of ["{", '{"a":1,}', "// 注释", ""]) {
    const result = json.parseJson(bad);
    check(result.ok === false && result.message.length > 0, `非法 JSON 返回错误而不是抛异常：${JSON.stringify(bad)}`);
  }

  console.log("\n--- 打开中的文件 / 保存后的更新 ---");
  const textRead = openFile.toOpenFile(
    { ok: true, kind: "text", path: "a.ts", text: "hi\n", eol: "crlf", bom: true, size: 4, mtimeMs: 100 },
    7,
  );
  check(
    textRead.kind === "text" && textRead.loadToken === 7 && textRead.text === "hi\n" && textRead.bom === true,
    "文本读响应带上了这次装载的 token",
    JSON.stringify(textRead),
  );

  const imageRead = openFile.toOpenFile(
    { ok: true, kind: "image", path: "a.png", size: 9, mtimeMs: 1, mime: "image/png", dataUri: "data:image/png;base64,AA" },
    8,
  );
  check(
    imageRead.kind === "image" && imageRead.dataUri.startsWith("data:image/png") && imageRead.text === "",
    "图片读响应没有文本、只有 data URI",
  );

  const pdfRead = openFile.toOpenFile(
    { ok: true, kind: "pdf", path: "report.PDF", size: 9, mtimeMs: 1, mime: "application/pdf", dataUri: "data:application/pdf;base64,AA" },
    9,
  );
  check(
    pdfRead.kind === "pdf" && pdfRead.mime === "application/pdf" && pdfRead.text === "" && pdfRead.git == null,
    "PDF 保留二进制数据、不进入文本编辑或逐行差异",
  );

  const tooLargeRead = openFile.toOpenFile(
    { ok: true, kind: "tooLarge", path: "big.mp4", size: 99, mtimeMs: 1, limit: 24 },
    9,
  );
  check(tooLargeRead.kind === "tooLarge" && tooLargeRead.limit === 24, "超限响应带上具体上限");

  const binaryRead = openFile.toOpenFile({ ok: true, kind: "binary", path: "x.zip", size: 3, mtimeMs: 1 }, 10);
  check(binaryRead.kind === "binary" && binaryRead.dataUri === undefined, "二进制响应没有 data URI");

  // 回归用例：保存成功后 openFile 必须换新（mtime / size 变了），但 loadToken
  // 绝不能变——变了 EditorPane 就会执行 setDocument，把编辑器里刚写的内容换成
  // 打开时那份旧文本（光标归零、滚动回顶），而界面还显示「已保存」。
  const saved = openFile.withSavedContent({ ...textRead }, { mtimeMs: 250, size: 6 }, "hi\nthere\n");
  check(saved.loadToken === textRead.loadToken, "保存不改 loadToken（改了就会把文档换回旧内容）", saved.loadToken);
  check(saved.mtimeMs === 250 && saved.size === 6, "保存更新 mtime 与 size（下一次乐观锁的期望值）");
  check(saved.text === "hi\nthere\n", "保存把文本同步成刚写下去的那份");
  check(openFile.isDocumentLoaded(saved, saved.loadToken) === true, "token 一致 → 可以拿编辑器内容渲染预览");
  check(
    openFile.isDocumentLoaded(textRead, textRead.loadToken + 1) === false,
    "编辑器里装的还是上一个文件（token 对不上）→ 不能拿它的内容渲染",
  );
  check(
    openFile.isDocumentLoaded(textRead, null) === false && openFile.isDocumentLoaded(null, 7) === false,
    "还没装载 / 没打开文件 → 不能拿编辑器内容渲染",
  );

  console.log("\n--- 视图模式判定 ---");
  const prefs = { mdPreview: false, csvTable: true, jsonTree: false };

  const md = viewers.resolveViewer("docs/readme.md", prefs);
  check(same(md?.modes, ["source", "markdown"]) && md.mode === "source", "Markdown 有源码/预览两侧，默认源码", JSON.stringify(md));
  check(
    viewers.resolveViewer("docs/readme.md", { ...prefs, mdPreview: true })?.mode === "markdown",
    "偏好记忆：Markdown 默认落在预览",
  );

  const table = viewers.resolveViewer("data/people.csv", prefs);
  check(same(table?.modes, ["source", "table"]) && table.mode === "table", "CSV 默认落在表格", JSON.stringify(table));
  check(
    viewers.resolveViewer("data/people.CSV", prefs)?.mode === "table",
    "扩展名判定不受大小写影响",
  );
  check(
    viewers.resolveViewer("data/people.csv", { ...prefs, csvTable: false })?.mode === "source",
    "偏好记忆：CSV 可以默认落在源码",
  );

  check(viewers.csvDelimiterOf("a.tsv") === "\t", "TSV 用制表符");
  check(viewers.csvDelimiterOf("a.csv") === ",", "CSV 用逗号");
  check(viewers.csvDelimiterOf("a.txt") === null, "其他扩展名没有表格视图");

  const tree = viewers.resolveViewer("package.json", prefs);
  check(same(tree?.modes, ["source", "tree"]) && tree.mode === "source", "JSON 默认落在源码", JSON.stringify(tree));
  check(
    viewers.resolveViewer("tsconfig.jsonc", { ...prefs, jsonTree: true })?.mode === "tree",
    "jsonc 也能看树，且跟随偏好",
  );

  for (const path of ["src/app.ts", "LICENSE", "photo.png", "a.tsv.bak"]) {
    check(viewers.resolveViewer(path, prefs) === null, `${path} 没有结构化视图`);
  }
  check(viewers.resolveViewer("notes.markdown", prefs)?.mode === "source", ".markdown 同样识别");

  const modes = ["source", "markdown", "table", "tree"];
  check(
    modes.every((mode) => typeof viewers.MODE_LABEL[mode] === "string"),
    "每个模式都有按钮文案（漏了会在界面上显示成 key）",
  );

  // ── 内容区一次只显示一种（0.8.1：预览与「变更」重叠的回归） ──────────────
  //
  // 修之前的结构：「变更」是 tablist 之外的独立开关，内容区又按各自的布尔条件
  // 各渲染各的，于是「预览开着 + 变更开着」是合法组合 → Markdown 预览与差异视图
  // 两个整块高的视图同时挂载、压在一起。现在判定收敛到 lib/pane.ts 的一个**单值**，
  // 这里把它钉死：任何输入组合下都只能得出一种内容视图，且页签组内互斥。

  console.log("\n内容区一次只显示一种（lib/pane.ts）");

  const { contentKind, tabs, activeTabKey } = pane;
  const kinds = new Set([
    "editor", "diff", "markdown", "table", "tree", "image", "media", "pdf", "sqlite", "binary", "tooLarge",
  ]);
  const fileKinds = ["text", "image", "media", "pdf", "sqlite", "binary", "tooLarge"];
  const viewerModes = ["source", "markdown", "table", "tree"];

  // 全组合扫描：任何输入下都只能是一种内容视图（单值本身就是保证，这里是防回归）
  const seen = new Set();
  let combinations = 0;
  for (const fileKind of [null, ...fileKinds]) {
    for (const viewerMode of viewerModes) {
      for (const diffOpen of [false, true]) {
        const kind = contentKind({ fileKind, viewerMode, diffOpen });
        check(kinds.has(kind), `未知的内容视图 ${kind}`);
        seen.add(kind);
        combinations += 1;
      }
    }
  }
  check(
    combinations === (fileKinds.length + 1) * viewerModes.length * 2,
    "全组合扫描后仍是单值（每次只返回一个 kind）",
    `${combinations} combos`,
  );
  check(seen.size === 11, [...seen].join(","), "十一种内容视图都可达（含 PDF）");

  check(
    contentKind({ fileKind: "text", viewerMode: "markdown", diffOpen: true }) === "diff" &&
      contentKind({ fileKind: "text", viewerMode: "table", diffOpen: true }) === "diff" &&
      contentKind({ fileKind: "text", viewerMode: "tree", diffOpen: true }) === "diff",
    "变更开着时压过任何预览模式（就是那个重叠场景）",
    contentKind({ fileKind: "text", viewerMode: "markdown", diffOpen: true }),
  );
  check(
    contentKind({ fileKind: "text", viewerMode: "markdown", diffOpen: false }) === "markdown" &&
      contentKind({ fileKind: "text", viewerMode: "table", diffOpen: false }) === "table" &&
      contentKind({ fileKind: "text", viewerMode: "tree", diffOpen: false }) === "tree",
    "变更关掉时预览照旧（没有把预览改没了）",
  );
  check(
    contentKind({ fileKind: "text", viewerMode: "source", diffOpen: false }) === "editor",
    "编辑态没有变更时仍然是编辑器",
  );
  check(
    contentKind({ fileKind: "image", viewerMode: "source", diffOpen: false }) === "image" &&
      contentKind({ fileKind: "media", viewerMode: "source", diffOpen: false }) === "media" &&
      contentKind({ fileKind: "pdf", viewerMode: "source", diffOpen: false }) === "pdf" &&
      contentKind({ fileKind: "sqlite", viewerMode: "source", diffOpen: false }) === "sqlite" &&
      contentKind({ fileKind: "binary", viewerMode: "source", diffOpen: false }) === "binary" &&
      contentKind({ fileKind: "tooLarge", viewerMode: "source", diffOpen: false }) === "tooLarge",
    "字节类文件各归各位（图片 / 媒体 / 数据库 / 二进制 / 过大）",
  );
  check(contentKind({ fileKind: null, viewerMode: "source", diffOpen: false }) === "editor", "没打开文件时是编辑器（空面板）");

  // ── 页签组：编辑 / 预览 / 变更 同组，且组内唯一选中 ──────────────────────
  console.log("\n页签组（编辑 / 预览 / 变更 同组互斥）");
  const mdTabs = tabs({ modes: ["source", "markdown"], hasGit: true, isText: true });
  check(mdTabs.map((tab) => tab.key).join("|") === "source|markdown|diff", mdTabs.map((tab) => tab.key).join("|"), "Markdown：编辑、预览、变更三者同组");
  const csvTabs = tabs({ modes: ["source", "table"], hasGit: true, isText: true });
  check(csvTabs.map((tab) => tab.key).join("|") === "source|table|diff", "CSV：表格也进同一组");
  check(tabs({ modes: null, hasGit: true, isText: true }).map((tab) => tab.key).join("|") === "source|diff", "纯文本文件：至少有一个可点的页签");
  check(tabs({ modes: ["source", "markdown"], hasGit: false, isText: true }).map((tab) => tab.key).join("|") === "source|markdown", "没有变化时不给变更页签");
  check(tabs({ modes: null, hasGit: true, isText: false }).map((tab) => tab.key).join("|") === "source", "非文本文件不给变更页签（逐行差异对它没意义）");
  check(new Set(mdTabs.map((tab) => tab.key)).size === mdTabs.length, "页签 key 不重复（重复会让 React 复用出怪东西）");
  check(mdTabs.at(-1)?.status === "git", "变更页签带 git 状态（徽标要用）");

  for (const mode of viewerModes) {
    for (const diffOpen of [false, true]) {
      const active = activeTabKey({ diffOpen, mode });
      const keys = tabs({ modes: ["source", mode], hasGit: true, isText: true }).map((tab) => tab.key);
      check(
        keys.includes(active) && keys.filter((key) => key === active).length === 1,
        `选中项 ${active} 一定在本组内且唯一（mode=${mode} diff=${diffOpen}）`,
        `${active} vs ${keys.join("|")}`,
      );
    }
  }

  console.log(`\n${failures === 0 ? "VIEWERS VERIFY PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("VERIFY HARNESS ERROR:", error);
  process.exit(1);
});
