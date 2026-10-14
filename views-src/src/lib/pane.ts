/**
 * 右侧那一栏「现在显示什么」的唯一判定点（0.8.1 修重叠时抽出来的）。
 *
 * 0.8.0 之前的结构是：头部一个「编辑 / 预览」切换器，旁边**另挂**一个「变更」开关，
 * 内容区则按各自的布尔条件各渲染各的。于是「预览开着 + 变更开着」是一个合法的
 * 组合——Markdown 预览与差异视图两个整块高的视图同时挂载，压在一起。
 *
 * 这里的做法是把「显示哪一种」收敛成一个**单值**：
 *   · `tabs()` 给出头部那组互斥页签（编辑 / 预览 / 表格 / 树 / 变更）；
 *   · `contentKind()` 给出内容区唯一该渲染的那一种。
 * 两者都由同一组输入算出，所以「两个整块视图同时在场」这件事在结构上就不可能
 * 发生——不是靠渲染层记得加 `!diffOpen`，而是根本没有第二个 true。
 */

import type { ViewerMode } from "./viewers";

/** 内容区一次只显示其中一种。 */
export type ContentKind =
  | "editor"
  | "diff"
  | "markdown"
  | "table"
  | "tree"
  | "image"
  | "media"
  | "pdf"
  | "sqlite"
  | "binary"
  | "tooLarge";

/** 头部那组页签。「变更」与编辑 / 预览同组，因此天然互斥。 */
export type PaneTab = { key: ViewerMode | "diff"; status?: string };

export function tabs(input: {
  /** 当前文件可用的看法（resolveViewer 的结果）；纯文本文件是 null。 */
  modes: ViewerMode[] | null;
  /** 这个文件相对 HEAD 有没有变化；没有就不给「变更」页签。 */
  hasGit: boolean;
  /** 只有文本文件能逐行看差异。 */
  isText: boolean;
}): PaneTab[] {
  // 去重这一下是防御性的：调用方传进来的是 `viewer.modes`，它本来就该是干净的，
  // 但重复的 key 会让 React 复用出错的节点（两个页签共用一个 key），而这种问题
  // 只在某个 mode 恰好重复时才出现——难查。宁可在这里挡一下。
  const list: PaneTab[] = [];
  for (const mode of input.modes ?? ["source"]) {
    if (list.some((tab) => tab.key === mode)) continue;
    list.push({ key: mode });
  }
  if (input.hasGit && input.isText) {
    list.push({ key: "diff", status: "git" });
  }
  return list;
}

/** 页签组里当前选中的是哪一个：变更开着就是它，否则是当前的看法。 */
export function activeTabKey(input: { diffOpen: boolean; mode: ViewerMode }): string {
  return input.diffOpen ? "diff" : input.mode;
}

/**
 * 内容区唯一该渲染的那一种视图。**顺序即优先级**：变更 > 预览类 > 字节类。
 *
 * 之所以把变更排在预览前面而不是反过来：点了「变更」就是要看它，不该被上一个
 * 预览模式挡住；而两边都成立时只可能是有重叠 bug，宁可少渲染一个。
 */
export function contentKind(input: {
  fileKind: string | null;
  viewerMode: ViewerMode;
  /** 差异视图是否正对这个文件开着。 */
  diffOpen: boolean;
}): ContentKind {
  if (!input.fileKind) return "editor";
  if (input.diffOpen) return "diff";
  if (input.fileKind === "image") return "image";
  if (input.fileKind === "media") return "media";
  if (input.fileKind === "pdf") return "pdf";
  if (input.fileKind === "sqlite") return "sqlite";
  if (input.fileKind === "tooLarge") return "tooLarge";
  if (input.fileKind === "binary") return "binary";
  if (input.viewerMode !== "source") return input.viewerMode;
  return "editor";
}
