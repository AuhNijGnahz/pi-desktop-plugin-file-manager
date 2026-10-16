/**
 * 由宿主代为执行的文件动作：用默认应用打开、在文件夹中显示、在内置 Browser 中预览 HTML。
 *
 * 和插件自己的读写不同，这两个**必须**走宿主网关：只有宿主进程能调起系统程序，
 * 也只有它能拿到真实路径。因此 manifest 里声明了 `fs.read`（root workspace、
 * scope `**`）——与内置 Files 视图逐项相同——这两个通道会按声明的范围校验，
 * 越界会被宿主自己拒掉。
 *
 * 契约（见宿主 plugin-runtime.ts）：参数通常是工作区相对路径；项目组的兄弟文件夹
 * 可传其已注册 root 内的绝对路径。宿主只接受通过 fs.read 检查的文件，目录会返回
 * INVALID_ARGUMENT，所以调用方要对目录禁用这些动作。
 */

import { invoke } from "./bridge";

type HostResponse = { ok?: boolean; message?: string } | undefined;

/**
 * 宿主通道失败时有两种表现：抛错（preload 拒绝）或返回 `{ ok: false }`。
 * 这里统一成抛错，调用方只写一个 catch。
 */
async function runHostAction(channel: string, path: string): Promise<void> {
  const response = await invoke<HostResponse>(channel, { path });
  if (response && response.ok === false) {
    throw new Error(response.message ?? "the host refused the request");
  }
}

export function openWithDefaultApp(path: string): Promise<void> {
  return runHostAction("fs.openDefault", path);
}

export function openInBuiltInBrowser(path: string): Promise<void> {
  return runHostAction("fs.openInBrowser", path);
}

export function revealInFileManager(path: string): Promise<void> {
  return runHostAction("fs.reveal", path);
}

/**
 * 「通过…打开」不走宿主网关，而是本插件主进程的 fm.openWith：宿主只给了
 * 「用默认应用打开」这一个入口，没有「用某个指定程序打开」的通道，而插件进程
 * 本来就能 spawn（git 联动已经在用）。路径由主进程按同一套根内包含与凭据黑名单
 * 解析，编辑器则只认 fm.editors 探测出来的 id——视图递不了可执行文件。
 */
export async function openWithEditor(path: string, id: string): Promise<void> {
  const response = await invoke<HostResponse>("fm.openWith", { path, id });
  if (response && response.ok === false) {
    throw new Error(response.message ?? "the plugin refused the request");
  }
}
