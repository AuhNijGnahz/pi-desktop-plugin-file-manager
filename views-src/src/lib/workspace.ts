/**
 * 当前项目（0.5.0 起：一个项目可以是一组本地文件夹）。
 *
 * 宿主没有暴露「工作区已切换」的推送（仅独立面板窗有事件），因此沿用宿主
 * 内置 pi.files 的做法：低频轮询 workspace.get()，项目一变就整体重载。
 * workspace.get 不需要任何权限，且返回的是绝对路径。
 *
 * 轮询的判断键不能只看主根路径：只在组里加 / 减一个文件夹时主根是不变的。
 * 组身份（projectId 或主根路径）与 roots 列表一起进键，任何一个变了都重载。
 */

import { invoke } from "./bridge";
import { normalizeRoots, projectKeyOf, type ProjectWorkspace } from "./roots";

export type Workspace = ProjectWorkspace;

const POLL_MS = 2000;

export function getWorkspace(): Promise<Workspace | null> {
  return invoke<Workspace | null>("workspace.get").catch(() => null);
}

/** 项目组的身份：组 id / 主根路径 + 全部 root 路径。 */
export function workspaceKey(workspace: Workspace | null): string | null {
  if (!workspace) return null;
  const roots = normalizeRoots(workspace).map((root) => root.path);
  return [projectKeyOf(workspace), ...roots, workspace.remote?.path ?? ""].join("\u0000");
}

export function watchWorkspace(onChange: (workspace: Workspace | null) => void): () => void {
  let last: string | null | undefined;

  const tick = async () => {
    const workspace = await getWorkspace();
    const key = workspaceKey(workspace);
    if (key === last) return;
    last = key;
    onChange(workspace);
  };

  void tick();
  const timer = window.setInterval(() => void tick(), POLL_MS);
  return () => window.clearInterval(timer);
}
