import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const distribution = path.join(root, "dist");
const output = path.join(distribution, "runtime");
const entries = ["manifest.json", "main.js", "README.md", "CHANGELOG.md", "views"];

async function rejectSymlinks(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) throw new Error(`Runtime packaging refuses symlinks: ${file}`);
  if (stat.isDirectory()) {
    for (const name of await readdir(file)) await rejectSymlinks(path.join(file, name));
  }
}

// Validate the inputs before replacing this generated directory.
for (const entry of entries) await rejectSymlinks(path.join(root, entry));
for (const directory of [distribution, output]) {
  const stat = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Expected a regular generated directory: ${directory}`);
  }
}
await mkdir(distribution, { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const entry of entries) await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
console.log("Runtime files prepared in dist/runtime; run official PluginCheck and PluginPack on that directory.");
