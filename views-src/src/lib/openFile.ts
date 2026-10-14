/**
 * 「打开中的文件」这个视图侧模型，以及它的两次不同性质的更新。
 *
 * 为什么需要 loadToken：编辑器里的文档只有在「从磁盘读进来」时才该替换。
 * 保存成功后 openFile 也要更新（新的 mtime / size 是下一次乐观锁的期望值），
 * 但那是元数据更新，文档必须原样留在编辑器里。两者以前共用同一个对象、
 * 结果保存后 EditorPane 的 effect 会把文档换回打开时那份旧文本——用户看到
 * 「保存后内容跳回旧版本」，而界面同时又显示「已保存」。
 *
 * 所以：从磁盘装载 → 新 token；保存 → token 不变。判定写在 EditorPane，
 * 不变式由 verify-viewers.mjs 断言。
 */

import type { GitEntryStatus, ReadResponse, SqliteInfo } from "./rpc";

export type OpenFileKind = "text" | "binary" | "image" | "media" | "pdf" | "tooLarge" | "sqlite";

export type OpenFile = {
  path: string;
  kind: OpenFileKind;
  text: string;
  eol: "lf" | "crlf";
  bom: boolean;
  size: number;
  mtimeMs: number;
  /** 图片 / 音视频 / PDF：主进程读好的 data URI（面板是 file://，拿不到真实路径）。 */
  dataUri?: string;
  mime?: string;
  /**
   * 这个文件相对 HEAD 的 git 状态（0.7.0）。它决定右侧有没有「变更」可看：
   * 宿主请求打开文件时左侧列表是收起的，那时树里没有这一行可查。
   * 树里的徽标由 fm.list 给，两处都是主进程现算的同一份快照。
   */
  git?: GitEntryStatus | null;
  /** 仅 tooLarge：该类型的体积上限，用来把提示写具体。 */
  limit?: number;
  /** 仅 sqlite：头部概览，以及宿主运行时是否带 node:sqlite。 */
  sqlite?: { available: boolean; info: SqliteInfo };
  /** 每次「从磁盘读进编辑器」递增；保存不动它。 */
  loadToken: number;
};

/** 读响应 → 打开中的文件。字节类（图片 / 音视频 / PDF）只带 data URI，没有文本。 */
export function toOpenFile(response: ReadResponse, loadToken: number): OpenFile {
  const base = { path: response.path, size: response.size, mtimeMs: response.mtimeMs, loadToken };
  const empty = { text: "", eol: "lf" as const, bom: false };
  // 只有文本能看差异；其余形态带过去也只是白占一个字段。
  const git = response.kind === "text" ? (response.git ?? null) : null;

  if (response.kind === "text") {
    return { ...base, kind: "text", text: response.text, eol: response.eol, bom: response.bom, git };
  }
  if (response.kind === "image" || response.kind === "media" || response.kind === "pdf") {
    return { ...base, ...empty, kind: response.kind, mime: response.mime, dataUri: response.dataUri };
  }
  if (response.kind === "tooLarge") {
    return { ...base, ...empty, kind: "tooLarge", limit: response.limit };
  }
  if (response.kind === "sqlite") {
    return {
      ...base,
      ...empty,
      kind: "sqlite",
      sqlite: { available: response.available, info: response.info },
    };
  }
  return { ...base, ...empty, kind: "binary" };
}

/**
 * 保存成功后的 openFile。
 * text 一并更新：编辑器万一被重建（重新挂载、重连面板），装载的就是刚存下的
 * 内容，而不是打开时那份。loadToken 保持不变——文档不需要、也不允许重装。
 */
export function withSavedContent(
  file: OpenFile,
  saved: { mtimeMs: number; size: number },
  text: string,
): OpenFile {
  return { ...file, mtimeMs: saved.mtimeMs, size: saved.size, text };
}

/** 编辑器里装的文档是否就是当前这份文件；不是就还不能拿它渲染预览。 */
export function isDocumentLoaded(file: OpenFile | null, loadedToken: number | null): boolean {
  return Boolean(file && loadedToken === file.loadToken);
}
