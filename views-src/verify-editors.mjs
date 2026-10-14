/**
 * 编辑器探测与「通过…打开」（0.9.0）：离线校验。
 *
 * 三层：
 *   ① 纯解析：注册表 App Paths / StartMenuInternet 的文本形态、shell 命令行里可执行
 *      文件的剥离、PATH 上候选文件名的顺序、注册表键名的精确与前缀匹配。这些都是
 *      文本解析，很容易在系统版本变化时悄悄错一次——错了的后果是菜单里多出一个点了
 *      没反应的编辑器，或者少掉机器上真实存在的那个。
 *   ② 端到端：临时 workspace + 真 main.js（onLoad + onPanelInvoke），断言探测结果
 *      的形状、落盘缓存的形状，以及**视图拿不到可执行文件路径**这条边界。
 *   ③ 一天一次：再起一个真进程读同一份缓存——文件没有被重写、结果与第一次一致。
 *      这正是「多开多启动不重复探测」要保证的东西。
 *   ④ 适用面（lib/editors.ts 纯函数）：浏览器只出现在网页类文件上，编辑器哪里都能出现。
 *      判错了两边都难看——Chrome 挂在 App.tsx 上是噪音，漏掉 index.html 才是真丢功能。
 *
 * 用法：pnpm verify:editors
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginMain = join(here, "..", "main.js");
const require = createRequire(pluginMain);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label} ${detail}`);
}

const { internals } = require(pluginMain);

// ── 1. 纯解析 ────────────────────────────────────────────────────────────────

console.log("1. 注册表与命令行的文本形态");

const APP_PATHS_SAMPLE = [
  "",
  "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe",
  "    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  "",
  "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Doubao.exe",
  "    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Doubao\\Doubao.exe",
  "    Path    REG_SZ    C:\\Users\\me\\AppData\\Local\\Doubao",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  "    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "",
].join("\r\n");

const appPaths = internals.parseAppPathsRegistry(APP_PATHS_SAMPLE);
check("App Paths 键名小写", appPaths.get("code.exe")?.endsWith("Code.exe") === true);
check(
  "非 (Default) 的值不当作可执行文件",
  appPaths.get("doubao.exe")?.endsWith("Doubao.exe") === true && !appPaths.has("path"),
);
check("HKLM 的条目也在", appPaths.get("chrome.exe")?.includes("chrome.exe") === true);
check("空输入不炸", internals.parseAppPathsRegistry("").size === 0);

const START_MENU_SAMPLE = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome",
  "    (Default)    REG_SZ    Google Chrome",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command",
  '    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"',
  "",
  "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\FIREFOX.EXE-308046b0af4a39cb\\shell\\open\\command",
  '    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"',
  "",
  "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Zen Browser\\shell\\open\\command",
  '    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Zen\\zen.exe "%1"',
  "",
].join("\r\n");

const menus = internals.parseStartMenuRegistry(START_MENU_SAMPLE);
check("带引号的命令行剥出可执行文件", menus.get("google chrome")?.endsWith("chrome.exe") === true);
check(
  "带客户端哈希后缀的子键也能读出来",
  menus.get("firefox.exe-308046b0af4a39cb")?.endsWith("firefox.exe") === true,
);
check("不带引号的命令行同样能剥", menus.get("zen browser")?.endsWith("zen.exe") === true);
check("非 shell\\open\\command 的值不算", menus.size === 3);

check("带引号 + 参数", internals.executableFromCommand('"C:\\a b\\x.exe" -- "%1"') === "C:\\a b\\x.exe");
check("不带引号", internals.executableFromCommand("C:\\a\\x.exe %1") === "C:\\a\\x.exe");
check("只有 exe 没有参数", internals.executableFromCommand("C:\\a\\x.exe") === "C:\\a\\x.exe");
check("空串给 null", internals.executableFromCommand("   ") === null);
check("不是 exe 就给 null", internals.executableFromCommand("C:\\a\\run.cmd %1") === null);

const orderWin = internals.pathLookupOrder("code", "win32", ".COM;.EXE;.BAT;.CMD");
check("Windows：.exe 排第一", orderWin[0] === "code.exe");
check("Windows：exe 只出现一次", orderWin.filter((name) => name === "code.exe").length === 1);
check("非 Windows：命令名原样", internals.pathLookupOrder("code", "linux", "").join() === "code");
check(
  "PATHEXT 缺失时按默认集合补上 .exe",
  internals.pathLookupOrder("code", "win32", "").includes("code.exe"),
);

const keyMap = new Map([
  ["firefox.exe-308046b0af4a39cb", "C:/firefox.exe"],
  ["chromehtm", "C:/chromehtml.exe"],
  ["chrome", "C:/chrome.exe"],
]);
check("精确匹配优先", internals.lookupRegistryKey(keyMap, "chrome") === "C:/chrome.exe");
check("前缀兜底命中", internals.lookupRegistryKey(keyMap, "firefox.exe") === "C:/firefox.exe");
check("同前缀取最短的那个", internals.lookupRegistryKey(keyMap, "chrome") !== "C:/chromehtml.exe");
check("没有命中给 null", internals.lookupRegistryKey(keyMap, "zed.exe") === null);

const stamp = internals.todayStamp();
check("日期戳是 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(stamp), stamp);
const now = new Date();
const expected = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
check("日期戳是本地时区的今天", stamp === expected, `${stamp} vs ${expected}`);

// ── 2. 端到端：真的 main.js ─────────────────────────────────────────────────

console.log("\n2. 端到端：真 main.js 的 fm.editors / fm.openWith");

const root = mkdtempSync(join(tmpdir(), "pifm-editors-"));
const project = join(root, "project");
const dataDir = join(root, "data");
mkdirSync(project, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(project, "a.ts"), "one\n");
writeFileSync(join(project, ".env"), "SECRET=1\n");

const settings = { fmPrefs: {} };
const workspace = { path: project, name: "project" };
globalThis.pi = {
  workspace: { get: async () => workspace },
  plugin: {
    getDataPath: async () => dataDir,
    getSettings: async () => settings,
    setSettings: async (value) => {
      settings = value;
      return true;
    },
  },
  ui: { showToast: () => {} },
  fs: {},
};

const { onLoad, onPanelInvoke } = require(pluginMain);
await onLoad();

const editors = await onPanelInvoke("fm.editors", {});
check("fm.editors 成功", editors?.ok === true, JSON.stringify(editors));
check("platform 是当前系统", editors.platform === process.platform, String(editors.platform));
check("stamp 是今天", editors.stamp === stamp);
check("editors 是数组", Array.isArray(editors.editors));
check(
  "每一项都有字符串 id 与 label",
  editors.editors.every(
    (entry) => typeof entry.id === "string" && entry.id && typeof entry.label === "string" && entry.label,
  ),
  JSON.stringify(editors.editors),
);
check(
  "视图拿不到可执行文件路径（只给 id 与名字）",
  editors.editors.every((entry) => !("command" in entry)),
  JSON.stringify(editors.editors[0] ?? null),
);
check(
  "候选里的 id 不重复",
  new Set(editors.editors.map((entry) => entry.id)).size === editors.editors.length,
);

const cacheFile = join(dataDir, internals.EDITOR_CACHE_FILE);
check("落盘缓存在数据目录里", existsSync(cacheFile), cacheFile);
const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
check("缓存里有 stamp / platform / editors", cached.stamp === stamp && cached.platform === process.platform);
check("缓存里存了真实路径（只有主进程能看到）", Array.isArray(cached.editors) && cached.editors.every((entry) => typeof entry.command === "string"));

const again = await onPanelInvoke("fm.editors", {});
check(
  "同进程第二次内容一致（内存缓存命中，不再探测）",
  JSON.stringify(again.editors) === JSON.stringify(editors.editors),
);

// ── 3. 一天一次：另一个进程读同一份缓存 ─────────────────────────────────────

console.log("\n3. 一天一次：另一个进程不会重新探测");

const mtimeBefore = statSync(cacheFile).mtimeMs;
const childScript = `
const pluginMain = ${JSON.stringify(pluginMain)};
const workspace = { path: ${JSON.stringify(project)}, name: "project" };
let settings = { fmPrefs: {} };
globalThis.pi = {
  workspace: { get: async () => workspace },
  plugin: {
    getDataPath: async () => ${JSON.stringify(dataDir)},
    getSettings: async () => settings,
    setSettings: async (value) => { settings = value; return true; },
  },
  ui: { showToast: () => {} },
  fs: {},
};
const mod = require(pluginMain);
(async () => {
  await mod.onLoad();
  const response = await mod.onPanelInvoke("fm.editors", {});
  process.stdout.write(JSON.stringify({ ok: response.ok, editors: response.editors, platform: response.platform }));
})();
`;
const childOut = execFileSync(process.execPath, ["-e", childScript], { encoding: "utf8" });
const childResult = JSON.parse(childOut);
check("另一个进程也能拿到探测结果", childResult.ok === true && Array.isArray(childResult.editors));
check(
  "另一个进程拿到的与第一个一致（用的就是那份缓存）",
  JSON.stringify(childResult.editors) === JSON.stringify(editors.editors),
  `${JSON.stringify(childResult.editors)} vs ${JSON.stringify(editors.editors)}`,
);
check("缓存文件没有被重写（命中当日缓存）", statSync(cacheFile).mtimeMs === mtimeBefore);

// ── 4. 边界：视图递不了编辑器，路径守卫照旧 ─────────────────────────────────

console.log("\n4. 边界：只认探测出来的 id，路径守卫一条不松");

const unknown = await onPanelInvoke("fm.openWith", { path: "a.ts", id: "definitely-not-installed" });
check("未知编辑器 id 被拒", unknown.ok === false && unknown.code === "UNKNOWN_EDITOR", JSON.stringify(unknown));

const first = editors.editors[0];
if (first) {
  const escape = await onPanelInvoke("fm.openWith", { path: "../outside.txt", id: first.id });
  check("越出根的相对路径被拒", escape.ok === false, JSON.stringify(escape));

  const denied = await onPanelInvoke("fm.openWith", { path: ".env", id: first.id });
  check("凭据黑名单照旧生效", denied.ok === false && denied.code === "DENIED_PATH", JSON.stringify(denied));

  const external = await onPanelInvoke("fm.openWith", {
    path: join(project, "a.ts"),
    id: first.id,
    external: true,
  });
  check("不接受 external 形态（项目外路径不经这条路）", external.ok === false, JSON.stringify(external));
}

const missing = await onPanelInvoke("fm.openWith", {});
check("缺参数被拒", missing.ok === false, JSON.stringify(missing));

// ── 5. 真的启动了一次：目标路径原样交给编辑器 ───────────────────────────────

console.log("\n5. 真的启动了一次：交给编辑器的是那个被点的文件");

/**
 * 用一个**假的编辑器**把「确实 spawn 了、参数就是那个文件」变成可断言的事实：
 * 编辑器可执行文件就是 node 自己，被打开的文件是一段小脚本——node 跑它就会把
 * 自己收到的 argv[1] 写到标记文件里。于是「有没有启动」与「打开的到底是哪个文件」
 * 两件事都由一个真实进程写出来，不靠猜。
 *
 * 探测结果来自一份**伪造的当日缓存**（只有 id/command 是我们塞的，形状与真的一样），
 * 所以这条用例不走注册表、在任何机器上都能跑。
 */
const markerFile = join(root, "launched.txt");
const fakeProject = join(root, "fake-project");
mkdirSync(fakeProject, { recursive: true });
writeFileSync(
  join(fakeProject, "target.js"),
  'require("node:fs").writeFileSync(process.env.PIFM_MARKER, String(process.argv[1] ?? "no-argv"));\n',
  "utf8",
);

const fakeData = join(root, "fake-data");
mkdirSync(fakeData, { recursive: true });
writeFileSync(
  join(fakeData, internals.EDITOR_CACHE_FILE),
  JSON.stringify({
    stamp,
    platform: process.platform,
    editors: [{ id: "fake-editor", label: "Fake Editor", command: process.execPath }],
  }),
  "utf8",
);

const launchScript = `
const pluginMain = ${JSON.stringify(pluginMain)};
let settings = { fmPrefs: {} };
globalThis.pi = {
  workspace: { get: async () => ({ path: ${JSON.stringify(fakeProject)}, name: "fake-project" }) },
  plugin: {
    getDataPath: async () => ${JSON.stringify(fakeData)},
    getSettings: async () => settings,
    setSettings: async (value) => { settings = value; return true; },
  },
  ui: { showToast: () => {} },
  fs: {},
};
process.env.PIFM_MARKER = ${JSON.stringify(markerFile)};
const mod = require(pluginMain);
(async () => {
  await mod.onLoad();
  const response = await mod.onPanelInvoke("fm.openWith", { path: "target.js", id: "fake-editor" });
  process.stdout.write(JSON.stringify(response));
})();
`;
const launched = JSON.parse(
  execFileSync(process.execPath, ["-e", launchScript], { encoding: "utf8" }),
);
check("fm.openWith 返回成功", launched.ok === true, JSON.stringify(launched));
check("返回里带上用的是哪个编辑器", launched.editor?.id === "fake-editor", JSON.stringify(launched.editor));

/** 编辑器是独立进程，写标记要等它跑起来。 */
async function waitForMarker(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerFile)) return readFileSync(markerFile, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

const marker = await waitForMarker();
check("编辑器进程真的被启动了", marker !== null, "标记文件一直没出现");
check(
  "交给编辑器的正是那个被打开的文件的绝对路径",
  marker === join(fakeProject, "target.js"),
  `${marker} vs ${join(fakeProject, "target.js")}`,
);
// ── 6. 适用面：浏览器只出现在网页类文件上 ───────────────────────────────────

console.log("\n6. 适用面：浏览器只出现在网页类文件上（lib/editors.ts）");

const { build } = await import(
  pathToFileURL(join(here, "node_modules", "esbuild", "lib", "main.js")).href
);
const bundleDir = mkdtempSync(join(tmpdir(), "pifm-editors-lib-"));
const bundleOut = join(bundleDir, "editors.mjs");
await build({
  entryPoints: [join(here, "src", "lib", "editors.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundleOut,
  logLevel: "silent",
});
const editorsLib = await import(pathToFileURL(bundleOut).href);

const sample = [
  { id: "vscode", label: "Visual Studio Code", kind: "editor" },
  { id: "chrome", label: "Google Chrome", kind: "browser" },
  { id: "zen", label: "Zen Browser", kind: "browser" },
];
const names = (target) => editorsLib.editorsFor(sample, target).map((e) => e.id).join(",");
const file = (name) => ({ name, isDirectory: false });
const dir = (name) => ({ name, isDirectory: true });

check("扩展名取小写", editorsLib.extensionOf("index.HTML") === ".html");
check("无扩展名给空串", editorsLib.extensionOf("LICENSE") === "");
check(
  "点开头的隐藏文件不算扩展名",
  editorsLib.extensionOf(".env") === "" && editorsLib.extensionOf(".gitignore") === "",
);
check("带路径的名字取末段", editorsLib.extensionOf("src/views/App.TSX") === ".tsx");

check("index.html 上：编辑器与浏览器都在", names(file("index.html")) === "vscode,chrome,zen", names(file("index.html")));
check("App.tsx 上：只有编辑器（不再出现 Chrome）", names(file("App.tsx")) === "vscode", names(file("App.tsx")));
check("styles.css 上：只有编辑器", names(file("styles.css")) === "vscode");
check("LICENSE 上：只有编辑器", names(file("LICENSE")) === "vscode");
check("文件夹上：只有编辑器，顺序不变", names(dir("views-src")) === "vscode", names(dir("views-src")));
check(".svg 也算网页类", names(file("logo.svg")) === "vscode,chrome,zen");
check(".pdf 算", names(file("doc.pdf")) === "vscode,chrome,zen");
check("大小写不敏感", names(file("INDEX.HTML")) === "vscode,chrome,zen");
check("没探到任何程序时是空表", editorsLib.editorsFor(null, file("index.html")).length === 0);
check("editor 恒适用（含文件夹）", editorsLib.editorAppliesTo("editor", dir("any")) === true);
check("browser 对文件夹不适用", editorsLib.editorAppliesTo("browser", dir("any")) === false);
check("browser 对普通源码文件不适用", editorsLib.editorAppliesTo("browser", file("main.js")) === false);
// ── 7. 接线：kind 一路传到视图，视图确实按它过滤 ─────────────────────────────

console.log("\n7. 接线：kind 从探测传到视图，视图走的就是那个过滤器");

check(
  "fm.editors 的每一项都带 kind",
  editors.editors.every((e) => e.kind === "editor" || e.kind === "browser"),
  JSON.stringify(editors.editors),
);
check(
  "浏览器被标成 browser、编辑器被标成 editor",
  editors.editors.every((e) => (["chrome", "edge", "firefox", "zen"].includes(e.id) ? e.kind === "browser" : e.kind === "editor")),
  JSON.stringify(editors.editors.map((e) => `${e.id}:${e.kind}`)),
);
check(
  "缓存里也带 kind（第二个进程读缓存才不会丢）",
  JSON.parse(readFileSync(cacheFile, "utf8")).editors.every((e) => e.kind === "editor" || e.kind === "browser"),
);
check(
  "老缓存缺 kind 时兜底成 editor（不会被误判成浏览器）",
  (() => {
    const legacyFile = join(root, "legacy-data");
    mkdirSync(legacyFile, { recursive: true });
    writeFileSync(
      join(legacyFile, internals.EDITOR_CACHE_FILE),
      JSON.stringify({
        stamp,
        platform: process.platform,
        editors: [{ id: "old", label: "Old Editor", command: process.execPath }],
      }),
      "utf8",
    );
    const script = `
      const pluginMain = ${JSON.stringify(pluginMain)};
      let settings = { fmPrefs: {} };
      globalThis.pi = {
        workspace: { get: async () => ({ path: ${JSON.stringify(project)}, name: "project" }) },
        plugin: {
          getDataPath: async () => ${JSON.stringify(legacyFile)},
          getSettings: async () => settings,
          setSettings: async (v) => { settings = v; return true; },
        },
        ui: { showToast: () => {} },
        fs: {},
      };
      const mod = require(pluginMain);
      (async () => {
        await mod.onLoad();
        const r = await mod.onPanelInvoke("fm.editors", {});
        process.stdout.write(JSON.stringify(r.editors));
      })();
    `;
    const legacy = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
    return legacy.length === 1 && legacy[0].kind === "editor";
  })(),
);

// 视图侧：App.tsx 必须真的走 lib/editors.ts 的过滤器，而不是自己再写一份判断。
const appSource = readFileSync(join(here, "src", "App.tsx"), "utf8");
check("App.tsx 引入了 editorsFor", /import\s*\{[^}]*\beditorsFor\b[^}]*\}\s*from\s*"\.\/lib\/editors"/.test(appSource));
check("App.tsx 用 editorsFor 过滤 openWith 的候选", /editorsFor\(\s*editors\s*,/.test(appSource));
check(
  "App.tsx 里没有另起一份浏览器 id 名单（kind 才是唯一判据）",
  !/"(chrome|msedge|firefox|zen)"\s*[,\]\)]/.test(appSource),
);

console.log(`\n${failures === 0 ? "EDITORS VERIFY PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
