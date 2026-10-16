/**
 * 文件管理插件主进程（main.js）在「项目组里选中的那个文件夹」上的校验。
 *
 * 0.5.0 起，包含基点由 prefs.projectRoots 推导：项目关联了多个文件夹时，基点
 * 是用户选中的那一个，而不是工作区根。这件事是**越狱**行为，不看代码只看结果：
 * 所以这里用桩宿主驱动真实的 main.js（onLoad + onPanelInvoke），把基点当成可观
 * 测量来断言——列出的是哪个文件夹的目录、根相对读取解析到哪、兄弟文件夹的绝对
 * 路径算不算「组内」。
 *
 * 脚本放在 views-src：打包是把仓库副本的 views-src 整个删掉之后再打的（ADR 0241
 * 的发布流程），所以它不会变成包里的未知文件。
 *
 * 用法：pnpm verify:jail
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginMain = join(here, "..", "main.js");
const require = createRequire(pluginMain);

const root = mkdtempSync(join(tmpdir(), "pifm-jail-"));
const alpha = join(root, "alpha");
const beta = join(root, "beta");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label} ${detail}`);
}

async function main() {
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  writeFileSync(join(alpha, "only-in-alpha.txt"), "alpha\n");
  writeFileSync(join(beta, "only-in-beta.txt"), "beta\n");
  writeFileSync(join(beta, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "outside.txt"), "outside\n");

  let settings = { fmPrefs: {} };
  let prefsWrites = 0;
  // 项目组：alpha 是主根（工作区就是它），beta 是同一个项目里的另一个文件夹。
  const workspace = {
    path: alpha,
    name: "alpha",
    projectId: "grp-1",
    roots: [
      { path: alpha, name: "alpha", primary: true },
      { path: beta, name: "beta", primary: false },
    ],
  };

  globalThis.pi = {
    workspace: { get: async () => workspace },
    plugin: {
      getDataPath: async () => join(root, "data"),
      getSettings: async () => settings,
      setSettings: async (value) => {
        settings = value;
        prefsWrites += 1;
        return true;
      },
    },
    ui: { showToast: () => {} },
    fs: { openInBrowser: async () => {} },
  };

  const { onLoad, onPanelInvoke } = require(pluginMain);
  await onLoad();

  console.log("1. 初始基点 = 主根");
  const hello = await onPanelInvoke("fm.hello", {});
  check("hello 报的是主根（工作区）", hello.root.path === alpha, hello.root.path);
  check("hello 暴露内置 Browser 能力", hello.capabilities?.openHtmlInBrowser === true);
  check("hello 带上了组里的全部文件夹", hello.root.roots?.length === 2);
  check("主根带 primary 标记", hello.root.roots?.[0]?.primary === true);
  delete globalThis.pi.fs.openInBrowser;
  const legacyHello = await onPanelInvoke("fm.hello", {});
  check("旧宿主不暴露内置 Browser 能力", legacyHello.capabilities?.openHtmlInBrowser === false);
  globalThis.pi.fs.openInBrowser = async () => {};
  const alphaListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "主根列出自己的文件",
    alphaListing.entries?.some((entry) => entry.name === "only-in-alpha.txt"),
    JSON.stringify(alphaListing).slice(0, 160),
  );

  console.log("\n2. 切到兄弟文件夹后基点跟着走");
  // 视图就是这样写的：一份「项目键 → 绝对路径」的记忆。
  await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { "p:grp-1": beta } } });
  check("选择被落盘", prefsWrites > 0 && settings.fmPrefs.projectRoots["p:grp-1"] === beta);
  // hello 报的是**工作区**（主根 + 组），不是「当前在看哪个」：后者是独立状态，
  // 可观测的是基点，所以断基点而不是从载荷里读一个选中项出来。
  const helloBeta = await onPanelInvoke("fm.hello", {});
  check("hello 仍然报主根", helloBeta.root.path === alpha);
  check("文件夹列表不变", helloBeta.root.roots?.length === 2);
  const betaListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "兄弟文件夹列出自己的文件",
    betaListing.entries?.some((entry) => entry.name === "only-in-beta.txt"),
    JSON.stringify(betaListing).slice(0, 160),
  );
  check(
    "主根的文件不再出现",
    !betaListing.entries?.some((entry) => entry.name === "only-in-alpha.txt"),
  );
  const siblingRead = await onPanelInvoke("fm.read", { path: "only-in-beta.txt" });
  check("根相对读取按选中的文件夹解析", siblingRead.ok === true, JSON.stringify(siblingRead).slice(0, 160));
  const primaryRead = await onPanelInvoke("fm.read", { path: "only-in-alpha.txt" });
  check(
    "主根的文件不能从兄弟文件夹根相对读到",
    primaryRead.ok === false,
    JSON.stringify(primaryRead).slice(0, 160),
  );

  console.log("\n3. 包含校验与凭据黑名单照旧");
  const escape = await onPanelInvoke("fm.read", { path: "../outside.txt" });
  check("向上一级被拒绝", escape.ok === false && escape.code === "ESCAPE", JSON.stringify(escape));
  const denied = await onPanelInvoke("fm.read", { path: ".env" });
  check("凭据文件被拒绝", denied.ok === false && denied.code === "DENIED_PATH", JSON.stringify(denied));

  console.log("\n4. 已注册文件夹下的绝对路径被归一化");
  // ADR 0249 §5：落在另一个已注册根里的绝对路径可以用那个根当基点。
  // 宿主送给视图的兄弟文件夹文件就是这个形状。
  const canonical = await onPanelInvoke("fm.read", { path: join(alpha, "only-in-alpha.txt") });
  check(
    "另一个已注册文件夹的文件按组内读取，不需要 external",
    canonical.ok === true && String(canonical.text ?? "").includes("alpha"),
    JSON.stringify(canonical).slice(0, 160),
  );
  const outsideAbsolute = await onPanelInvoke("fm.read", { path: join(root, "outside.txt") });
  check(
    "组外绝对路径被拒绝",
    outsideAbsolute.ok === false,
    JSON.stringify(outsideAbsolute).slice(0, 160),
  );
  const externalDenied = await onPanelInvoke("fm.read", { path: join(beta, ".env"), external: true });
  check("外部路径同样过凭据黑名单", externalDenied.ok === false && externalDenied.code === "DENIED_PATH");

  console.log("\n5. 按项目记忆");
  await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { "p:grp-1": alpha } } });
  const backToListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "切回来也记得住",
    backToListing.entries?.some((entry) => entry.name === "only-in-alpha.txt") === true,
    JSON.stringify(backToListing).slice(0, 160),
  );

  // 视图的写入形状：每次把「自己的有界记忆 + 当前项目」整份发过来（当前项目在
  // 末尾）。照同样顺序走 22 个项目，模拟用户先后在这些项目里切换过文件夹。
  let memory = { "p:grp-1": alpha };
  for (let index = 2; index <= 22; index += 1) {
    memory = { ...memory, [`p:grp-${index}`]: beta };
    if (Object.keys(memory).length > 20) {
      const keys = Object.keys(memory);
      memory = Object.fromEntries(keys.slice(keys.length - 20).map((key) => [key, memory[key]]));
    }
    await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: memory } });
  }
  await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { ...memory, "p:grp-1": beta } } });
  const afterCap = Object.keys(settings.fmPrefs.projectRoots);
  check("记忆上限 20 个项目", afterCap.length === 20, `got ${afterCap.length}`);
  check("当前项目还在记忆里", afterCap.includes("p:grp-1"));
  check("最旧的那条被挤掉", !afterCap.includes("p:grp-2"));
  check("当前项目是最后一条（写入顺序 = 淘汰顺序）", afterCap.at(-1) === "p:grp-1");
  const afterCapListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "淘汰之后基点仍然是记住的那个文件夹",
    afterCapListing.entries?.some((entry) => entry.name === "only-in-beta.txt") === true,
    JSON.stringify(afterCapListing).slice(0, 160),
  );
  // 合并语义：只带一个键的写入（视图在偏好到手之前的那次点击）不能抹掉别的项目。
  await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { "p:grp-1": beta } } });
  check(
    "单键写入不影响别的项目",
    Object.keys(settings.fmPrefs.projectRoots).length === 20 && settings.fmPrefs.projectRoots["p:grp-22"] === beta,
  );

  console.log("\n6. 记忆指向已经不在组里的目录时退回主根");
  await onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { "p:grp-1": join(root, "gone") } } });
  const staleListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "组外的旧记忆退回主根",
    staleListing.entries?.some((entry) => entry.name === "only-in-alpha.txt") === true,
    JSON.stringify(staleListing).slice(0, 160),
  );
  console.log("\n7. 宿主用正斜杠报目录（真实宿主就是这样），基点照样跟着记忆走");
  // 之前这一节不存在，用例里的桩宿主用的是反斜杠，形状太「一致」，于是掩盖了
  // 「记忆写盘时被 path.resolve 变成反斜杠、宿主却报正斜杠」这条真实链路。
  workspace.projectId = "grp-1";
  workspace.path = alpha.replace(/\\/g, "/");
  workspace.roots = [
    { path: alpha.replace(/\\/g, "/"), name: "alpha", primary: true },
    { path: beta.replace(/\\/g, "/"), name: "beta", primary: false },
  ];
  await onPanelInvoke("fm.prefs.set", {
    partial: { projectRoots: { "p:grp-1": beta.replace(/\\/g, "/") } },
  });
  const slashListing = await onPanelInvoke("fm.list", { path: "" });
  check(
    "切到兄弟文件夹后列的是它自己的文件",
    slashListing.entries?.some((entry) => entry.name === "only-in-beta.txt") === true,
    JSON.stringify(slashListing).slice(0, 160),
  );
  check(
    "主根的文件不再出现",
    !slashListing.entries?.some((entry) => entry.name === "only-in-alpha.txt"),
  );


  console.log("\n8. 老宿主（不带 roots / projectId）照旧");
  workspace.path = alpha;
  workspace.roots = undefined;
  workspace.projectId = undefined;
  const legacy = await onPanelInvoke("fm.hello", {});
  check("载荷里还是 path 与 name", legacy.root.path === alpha && legacy.root.name === "alpha");
  check("不报文件夹列表", legacy.root.roots === undefined);
  const legacyRead = await onPanelInvoke("fm.read", { path: "only-in-alpha.txt" });
  check("单根读取仍然能解析", legacyRead.ok === true);

  console.log(`\n${failures === 0 ? "JAIL VERIFY PASSED" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("JAIL VERIFY ERROR:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
