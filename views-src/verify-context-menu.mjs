/** Offline behavior checks for the directory-tree context menu. */

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pifm-context-menu-"));
const output = join(temp, "file-context-menu.mjs");

try {
  await build({
    entryPoints: [join(here, "src/lib/file-context-menu.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
  });
  const { buildFileContextMenuEntries, withBuiltInBrowserEntry } = await import(pathToFileURL(output).href);
  const labels = {
    newFile: "New File",
    newFolder: "New Folder",
    rename: "Rename",
    move: "Move",
    delete: "Delete",
    copyRelativePath: "Copy Relative Path",
    copyAbsolutePath: "Copy Absolute Path",
    openWithSubmenu: "Open With…",
    viewChanges: "View Changes",
    revealInFolder: "Reveal in Folder",
    refresh: "Refresh",
  };
  const names = (entries) =>
    entries.map((entry) => (entry.kind === "separator" ? "|" : entry.label));
  const openWithEntries = [{ kind: "item", label: "System Default", onPick() {} }];

  const openedInBrowser = [];
  const htmlOpenWith = withBuiltInBrowserEntry(
    { path: "src/INDEX.HTML", isDirectory: false },
    true,
    "Open in built-in browser",
    openWithEntries,
    (target) => openedInBrowser.push(target.path),
  );
  assert.deepEqual(names(htmlOpenWith), [
    "Open in built-in browser", "|", "System Default",
  ]);
  htmlOpenWith[0].onPick();
  assert.deepEqual(openedInBrowser, ["src/INDEX.HTML"]);
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/readme.md", isDirectory: false }, true, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/page.xhtml", isDirectory: false }, false, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/page.html", isDirectory: true }, true, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );

  const blank = buildFileContextMenuEntries({
    target: null,
    labels,
    openWithEntries: [],
    onNewFile() {}, onNewFolder() {}, onRename() {}, onMove() {}, onDelete() {},
    onCopyRelativePath() {}, onCopyAbsolutePath() {}, onViewChanges() {},
    onRevealInFolder() {}, onRefresh() {},
  });
  assert.deepEqual(names(blank), ["New File", "New Folder", "|", "Refresh"]);

  const file = {
    path: "src/index.html",
    isDirectory: false,
    git: { status: "modified" },
  };
  const calls = [];
  const entries = buildFileContextMenuEntries({
    target: file,
    labels,
    openWithEntries,
    onNewFile: (parent) => calls.push(["newFile", parent]),
    onNewFolder: (parent) => calls.push(["newFolder", parent]),
    onRename: (target) => calls.push(["rename", target.path]),
    onMove: (target) => calls.push(["move", target.path]),
    onDelete: (target) => calls.push(["delete", target.path]),
    onCopyRelativePath: (target) => calls.push(["copyRelative", target.path]),
    onCopyAbsolutePath: (target) => calls.push(["copyAbsolute", target.path]),
    onViewChanges: (target) => calls.push(["viewChanges", target.path]),
    onRevealInFolder: (target) => calls.push(["reveal", target.path]),
    onRefresh: (directory) => calls.push(["refresh", directory]),
  });
  assert.deepEqual(names(entries), [
    "Open With…", "|", "New File", "New Folder", "|", "Rename", "Move", "Delete",
    "|", "Copy Relative Path", "Copy Absolute Path", "|", "View Changes",
    "Reveal in Folder", "|", "Refresh",
  ]);
  assert.equal(entries[0].kind, "submenu");
  assert.deepEqual(entries[0].items, openWithEntries);
  entries.find((entry) => entry.kind === "item" && entry.label === "New File").onPick();
  entries.find((entry) => entry.kind === "item" && entry.label === "Refresh").onPick();
  assert.deepEqual(calls, [["newFile", "src"], ["refresh", "src"]]);

  const directory = { path: "src/assets", isDirectory: true, git: null };
  const directoryCalls = [];
  const directoryEntries = buildFileContextMenuEntries({
    target: directory,
    labels,
    openWithEntries,
    onNewFile: (parent) => directoryCalls.push(parent),
    onNewFolder() {}, onRename() {}, onMove() {}, onDelete() {},
    onCopyRelativePath() {}, onCopyAbsolutePath() {}, onViewChanges() {},
    onRevealInFolder() {}, onRefresh: (parent) => directoryCalls.push(`refresh:${parent}`),
  });
  directoryEntries.find((entry) => entry.kind === "item" && entry.label === "New File").onPick();
  directoryEntries.find((entry) => entry.kind === "item" && entry.label === "Refresh").onPick();
  assert.deepEqual(directoryCalls, ["src/assets", "refresh:src/assets"]);
  assert.equal(directoryEntries.some((entry) => entry.kind === "item" && entry.label === "View Changes"), false);
  assert.equal(directoryEntries.some((entry) => entry.kind === "item" && entry.label === "Reveal in Folder"), false);

  const cleanFile = { ...file, git: null };
  const cleanEntries = buildFileContextMenuEntries({
    target: cleanFile,
    labels,
    openWithEntries,
    onNewFile() {}, onNewFolder() {}, onRename() {}, onMove() {}, onDelete() {},
    onCopyRelativePath() {}, onCopyAbsolutePath() {}, onViewChanges() {},
    onRevealInFolder() {}, onRefresh() {},
  });
  assert.equal(cleanEntries.some((entry) => entry.kind === "item" && entry.label === "View Changes"), false);
  assert.equal(cleanEntries.some((entry) => entry.kind === "item" && entry.label === "Reveal in Folder"), true);

  console.log("Context menu grouping, applicability, and action targets passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
