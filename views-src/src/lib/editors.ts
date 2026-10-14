/**
 * 「通过…打开」里哪些程序该出现在哪个条目上——纯函数，verify-editors.mjs 直接断言。
 *
 * 编辑器什么都能打开（文件、文件夹都行），但**浏览器只对网页类文件有意义**：
 * 拿 Chrome 打开 `App.tsx` 只会看到一个纯文本加载页，那是把噪音摆进菜单。所以
 * 浏览器只出现在它真能渲染的那几种扩展名上，其余文件与文件夹一律不列。
 *
 * 判定必须在这里（而不是主进程）做：主进程只知道「这台机器上装了什么」，只有视图
 * 手里才有「正在右键的是哪个文件」。两边合起来的规则只有一条——kind 决定适用面。
 */

/** 探测结果里的程序种类；老缓存缺 kind 时由主进程补成 editor。 */
export type EditorKind = "editor" | "browser";

export type EditorOption = {
  id: string;
  label: string;
  kind: EditorKind;
};

/**
 * 浏览器能直接渲染的扩展名（小写，含点）。
 *
 * 刻意收得窄：只列「浏览器打开是有意义的」那一类。图片（png/jpg）与纯文本（txt）
 * 技术上浏览器也能开，但默认应用已经是更自然的选择，列进来只是让菜单变长；
 * 而 Markdown 在浏览器里是源码，不如用本插件的预览。
 */
export const BROWSER_EXTENSIONS: readonly string[] = [
  ".html",
  ".htm",
  ".shtml",
  ".xhtml",
  ".mhtml",
  ".svg",
  ".pdf",
  ".xml",
];

/** 从文件名取小写扩展名（没有扩展名时是空串）。 */
export function extensionOf(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // 开头就是点的隐藏文件（.env）不算有扩展名。
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** 这个程序该不该出现在这个条目上。 */
export function editorAppliesTo(
  kind: EditorKind,
  target: { name: string; isDirectory: boolean },
): boolean {
  if (kind === "editor") return true;
  // 浏览器：只对网页类**文件**有意义（文件夹在浏览器里只是一个目录列表）。
  if (target.isDirectory) return false;
  return BROWSER_EXTENSIONS.includes(extensionOf(target.name));
}

/** 过滤出当前条目可用的程序，保持原有顺序。 */
export function editorsFor(
  editors: readonly EditorOption[] | null,
  target: { name: string; isDirectory: boolean },
): EditorOption[] {
  return (editors ?? []).filter((entry) => editorAppliesTo(entry.kind, target));
}
