import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const plugin = require("../main.js");
const shadow = await mkdtemp(join(tmpdir(), "pi-remote-shadow-"));
const local = await mkdtemp(join(tmpdir(), "pi-local-control-"));
const remote = { path: "remote-project:remote-fixture", name: "SSH repository", remote: { path: shadow, readOnly: true } };
let workspace = remote;
const requests = [];
let finish;
let previewEntered;
globalThis.pi = {
  workspace: { get: async () => workspace },
  plugin: { getSettings: async () => ({}), setSettings: async () => {}, getDataPath: async () => local },
  fs: {
    list: async (path, options) => {
      requests.push({ operation: "list", path, options });
      return path === "" ? [
        { name: ".env", path: ".env", isDirectory: false, size: 12, mtimeMs: 1234 },
        { name: "server.pem", path: "server.pem", isDirectory: false, size: 40, mtimeMs: 1234 },
        { name: "src", path: "src", isDirectory: true },
      ] : [
        { name: "a.md", path: "src/a.md", isDirectory: false, size: 15, mtimeMs: 1234 },
        { name: ".env.local", path: "src/.env.local", isDirectory: false, size: 9, mtimeMs: 1234 },
      ];
    },
    readPreview: async (path, options) => {
      requests.push({ operation: "preview", path, options });
      previewEntered?.resolve();
      if (finish) return finish;
      if (path.endsWith(".png")) return { kind: "image", dataUrl: "data:image/png;base64,iVBORw==", size: 4, mtimeMs: 1234 };
      return { kind: "text", content: "REMOTE CONTENT\n", size: 15, mtimeMs: 1234 };
    },
  },
};
try {
  await writeFile(join(shadow, "a.md"), "LOCAL SHADOW MUST NEVER APPEAR");
  await writeFile(join(local, "local.txt"), "local control");
  await plugin.onLoad();
  const hello = await plugin.onPanelInvoke("fm.hello", {});
  assert.deepEqual(hello.root.remote, remote.remote);
  assert.equal(hello.watch.available, false);
  const root = await plugin.onPanelInvoke("fm.list", { path: "", workspacePath: remote.path });
  assert.equal(root.ok, true, JSON.stringify(root));
  assert.deepEqual(root.entries.map(entry => entry.name), ["src"]);
  const nested = await plugin.onPanelInvoke("fm.list", { path: "src", workspacePath: remote.path });
  // 凭据类条目与本地列目录一样连名字都不出现（Host 只跳过 .git / node_modules 这类目录）。
  assert.deepEqual(nested.entries.map(entry => entry.name), ["a.md"]);
  const text = await plugin.onPanelInvoke("fm.read", { path: "src/a.md", workspacePath: remote.path });
  assert.equal(text.text, "REMOTE CONTENT\n"); assert.equal(text.readOnly, true); assert.equal(text.mtimeMs, 1234);
  const image = await plugin.onPanelInvoke("fm.read", { path: "image.png", workspacePath: remote.path });
  assert.equal(image.kind, "image"); assert.equal(image.dataUri, "data:image/png;base64,iVBORw==");
  const absolute = await plugin.onPanelInvoke("fm.read", { path: `${shadow}/a.md`, external: true, workspacePath: remote.path });
  assert.equal(absolute.text, "REMOTE CONTENT\n");
  for (const path of ["../outside", `${shadow}-other/file`, "C:\\local.txt", ".env", "dir/../../outside"]) {
    assert.equal((await plugin.onPanelInvoke("fm.read", { path })).ok, false, path);
  }
  for (const channel of ["fm.write", "fm.create", "fm.rename", "fm.move", "fm.delete", "fm.sqlite.open", "fm.openWith", "fm.search", "fm.watch"]) {
    const response = await plugin.onPanelInvoke(channel, { path: "src/a.md", text: "MUST NOT WRITE", name: "new.txt" });
    assert.equal(response.ok, false, channel); assert.match(response.code, /REMOTE/);
  }
  assert(requests.every(request => request.options.workspacePath === remote.path));
  workspace = { path: local, name: "Local control" };
  const stale = await plugin.onPanelInvoke("fm.read", { path: "local.txt", workspacePath: remote.path });
  assert.equal(stale.ok, false); assert.equal(stale.code, "WORKSPACE_CHANGED");
  const control = await plugin.onPanelInvoke("fm.read", { path: "local.txt" });
  assert.equal(control.text, "local control");
  workspace = remote;
  let release;
  previewEntered = Promise.withResolvers();
  finish = new Promise(resolve => { release = resolve; });
  const pending = plugin.onPanelInvoke("fm.read", { path: "src/a.md", workspacePath: remote.path });
  // Wait for the boundary to be entered instead of relying on a wall-clock sleep.
  await Promise.race([previewEntered.promise, pending.then(() => assert.fail("remote preview boundary was bypassed"))]);
  workspace = { path: local, name: "Local control" };
  release({ kind: "text", content: "late remote", size: 11, mtimeMs: 1234 });
  assert.equal((await pending).code, "WORKSPACE_CHANGED");
  console.log("REMOTE VERIFY PASSED: nested browsing, preview, isolation, read-only and late responses");
} finally {
  await plugin.onUnload(); delete globalThis.pi;
  await Promise.all([rm(shadow, { recursive: true, force: true }), rm(local, { recursive: true, force: true })]);
}
