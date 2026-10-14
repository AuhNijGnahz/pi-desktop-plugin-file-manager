 import { useCallback, useEffect, useRef, useState } from "react";
import { createEditor, type EditorHandle } from "../lib/editor";
import type { Base } from "../lib/appearance";
import type { CopyKey, T } from "../i18n";
import { baseNameOf, formatSize, formatTime } from "../lib/format";
import { FileIcon } from "../lib/fileIcons";
import { MarkdownPreview } from "../lib/markdown";
import { MODE_LABEL, csvDelimiterOf, type ViewerMode, type ViewerView } from "../lib/viewers";
import { activeTabKey, contentKind, tabs as paneTabs } from "../lib/pane";
import { isDocumentLoaded, type OpenFile } from "../lib/openFile";
 import { invoke } from "../lib/bridge";
 import { absolutePathOf } from "../lib/roots";
 import type { WorkspaceRoot } from "../lib/roots";
import { CsvTable } from "./CsvTable";
import { ImageView } from "./ImageView";
import { JsonTree } from "./JsonTree";
import { MediaPlayer } from "./MediaPlayer";
import { PdfView } from "./PdfView";
import { SqliteView } from "./SqliteView";
import { gitColor, gitGlyph, gitTitle } from "../lib/git";
import type { GitEntryStatus, GitStatusKind } from "../lib/rpc";
import { GitDiffView, type DiffViewState } from "./GitDiffView";

type Props = {
  file: OpenFile | null;
  base: Base;
  locale: "en" | "zh";
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** 当前文件可用的视图模式（源码 / Markdown / 表格 / 树）；纯文本为 null。 */
  viewer: ViewerView | null;
  /** 表格每页行数（偏好里记着）。 */
  tablePageSize: number;
  /**
   * 打开的文件在外部被改动、而缓冲里还有未保存的改动（0.8.0）。
   * 这种情况下**不自动装载**（会丢掉用户刚敲的字），只亮一条提示。
   */
  externalChange: boolean;
   activeRoot: WorkspaceRoot | null;
  /**
   * 当前文件的 git 状态（0.7.0）。为 null 时工具栏就没有「变更」入口。
   * App 负责算（读文件时带回来的那份，或树里的徽标），这里只管摆出来。
   */
  git: GitEntryStatus | null;
   t: T;
  handleRef: React.MutableRefObject<EditorHandle | null>;
  onDirty: () => void;
  onSave: () => void;
  onReload: () => void;
  onViewerMode: (mode: ViewerMode) => void;
  onTablePageSize: (size: number) => void;
  onLink: (url: string) => void;
  /**
   * git 差异（0.7.0）。state 为 null = 没打开差异视图；path 与当前文件不一致时
   * 也不显示（用户已经切到别的文件去了，那份差异不该跟着串场）。
   */
  diff: (DiffViewState & { path: string }) | null;
  onOpenDiff: () => void;
  onCloseDiff: () => void;
  onRefreshDiff: () => void;
};

/** 页签文案。「变更」复用已有的 changes 键，不新增同义词。 */
const TAB_LABEL: Record<string, CopyKey> = { ...MODE_LABEL, diff: "changes" };

export function EditorPane({
  file,
   base,
   activeRoot,
  locale,
  dirty,
  saving,
  error,
  viewer,
  tablePageSize,
  externalChange,
  git,
  t,
  handleRef,
  onDirty,
  onSave,
  onReload,
  onViewerMode,
  onTablePageSize,
  onLink,
  diff,
  onOpenDiff,
  onCloseDiff,
  onRefreshDiff,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 编辑器里装的是哪一次「从磁盘读进来」的内容；null = 还没装。
  const [loadedToken, setLoadedToken] = useState<number | null>(null);

  // 地址栏的路径要按当前基点展开成绝对路径：基点是主文件夹时它本来就是
  // 工作区相对路径，基点是组里的兄弟文件夹时拼出来才有意义。
  const displayPath = file ? absolutePathOf(file.path, activeRoot) : "";

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const copyPath = useCallback(
    async (path: string) => {
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(path);
          ok = true;
        }
      } catch {
        ok = false;
      }
      // file:// 沙箱页可能没有安全上下文，clipboard API 会失败：退回 execCommand。
      if (!ok) {
        try {
          const textarea = document.createElement("textarea");
          textarea.value = path;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          ok = document.execCommand("copy");
          document.body.removeChild(textarea);
        } catch {
          ok = false;
        }
      }
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (ok) {
        setCopied(true);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
        void invoke("ui.showToast", { message: t("pathCopied", { path }) }).catch(() => {});
      } else {
        void invoke("ui.showToast", { message: t("copyFailed") }).catch(() => {});
      }
    },
    [t],
  );

  // 卸载时别让「已复制」的回退计时器再去 setState。
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  // 编辑器只在挂载时创建一次，所以回调必须经 ref 转发，
  // 否则 Ctrl+S 会一直调用「首帧那次渲染」闭包里的 onSave（那时还没有打开文件）。
  const handlersRef = useRef({ onDirty, onSave });
  handlersRef.current = { onDirty, onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createEditor(host, {
      base,
      onDocChanged: () => handlersRef.current.onDirty(),
      onSave: () => handlersRef.current.onSave(),
    });
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setBase(base);
  }, [base, handleRef]);

  // 只有「从磁盘重新装载」才替换文档。保存成功后 openFile 也会换新对象
  // （mtime / size 变了），但 loadToken 不变——那一步必须原样跳过，否则会把
  // 用户刚写的内容换成打开时那份，光标与滚动位置也一起丢。
  useEffect(() => {
    if (!file) {
      // 换文件夹（或关闭文件）之后，编辑器里不能还留着上一个文件夹的那份文档：
      // 面板上已经是空态，缓冲区却还在——切回同一相对路径的文件、或者误按
      // Ctrl+S 都会撞见别人的内容。只有装过文档（loadToken 非空）才需要清一次；
      // setDocument 会抑制 change 回调，不会把脏标记点亮。
      if (loadedToken !== null) {
        handleRef.current?.setDocument("", "", true);
        setLoadedToken(null);
      }
      return;
    }
    if (loadedToken === file.loadToken) return;
    handleRef.current?.setDocument(file.text, file.path, file.kind !== "text");
    setLoadedToken(file.loadToken);
  }, [file, loadedToken, handleRef]);

  // 预览、表格、树渲染的是「编辑器里当前那份文本」，不是打开时的那份：
  // 改完再切过去必须看到刚写的内容。文件刚换、上面的 effect 还没跑时，
  // handle 里装的仍是上一个文件，此时退回 file.text（保存后它也是最新的）。
  const mode = viewer?.mode ?? "source";
  const imageSrc = file?.kind === "image" ? file.dataUri : undefined;
  const mediaSrc = file?.kind === "media" ? file.dataUri : undefined;
  const pdfSrc = file?.kind === "pdf" ? file.dataUri : undefined;
  const sqlite = file?.kind === "sqlite" ? file.sqlite : undefined;
  // 差异视图与图片 / 媒体 / 数据库一样，是「占住整个内容区」的一种形态：编辑器
  // 必须藏起来（CodeMirror 在 display:none 的容器里量不到尺寸）。
  const diffOpen = Boolean(file && diff && diff.path === file.path);
  // 内容区显示哪一种，由 lib/pane.ts 一处说了算（单值，所以不可能同时挂两种）。
  const content = contentKind({ fileKind: file?.kind ?? null, viewerMode: mode, diffOpen });
  const editorHidden = content !== "editor";
  /**
   * 页签只有一组：**编辑 / 预览（表格、树）/ 变更**。
   *
   * 「变更」必须在这组里，不能另做一个开关按钮——它是「同一份文件换一种看法」，
   * 与编辑、预览互斥。放在组外（0.7.0 的做法）时「预览」与「变更」可以同时成立，
   * 内容区就会把 Markdown 预览与差异视图一起挂上去：两个都是整块高的视图，于是
   * 互相压在一起（0.8.1 修掉的那个重叠）。互斥放在这一层，就没机会同时成立。
   *
   * 变更只对文本文件给出：图片 / 音视频 / 数据库各自占住整个内容区，再插一页签
   * 只会让人以为切过去能看到逐行差异。
   */
  const paneTabList = paneTabs({
    modes: viewer?.modes ?? null,
    hasGit: Boolean(git),
    isText: file?.kind === "text",
  });
  const activeTab = activeTabKey({ diffOpen, mode });

  const liveText =
    isDocumentLoaded(file, loadedToken) && file
      ? handleRef.current?.text() ?? file.text
      : file?.text ?? "";
  // 内容区现在不是编辑器时，预览/表格/树渲染的是「编辑器里当前那份文本」。
  const structuredText = content === "editor" ? "" : liveText;

  // 预览或查看器占位时编辑器必须藏起来、且要 false 掉 CodeMirror 的测量：
  // 它在 display:none 的容器里量不到尺寸，回到编辑态会排版错乱。
  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.style.display = editorHidden ? "none" : "";
    if (!editorHidden) handleRef.current?.view.requestMeasure();
  }, [editorHidden, handleRef]);

  // 图片与音视频是「查看」而不是「编辑」，不再挂只读横幅——换成查看器本身。
  const readOnlyReason =
    file && file.kind !== "text"
      ? file.kind === "binary"
        ? t("binary")
        : file.kind === "tooLarge"
          ? t("tooLarge")
          : null
      : null;

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("title")}>
      <header
        className="flex min-h-[42px] flex-none items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        {file ? (
          <>
            <FileIcon name={baseNameOf(file.path)} isDirectory={false} />
             <button
               type="button"
               className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 text-left font-mono text-[11px] transition-colors hover:text-[var(--fg)]"
               style={{ color: "var(--secondary)" }}
               title={t("copyPath")}
               aria-label={t("copyPath")}
               onClick={() => copyPath(displayPath)}
             >
               {displayPath}
               {copied ? <span style={{ color: "var(--accent)" }}> ✓</span> : null}
             </button>
            <span className="flex-none text-[10px] tabular-nums" style={{ color: "var(--muted)" }}>
              {formatSize(file.size)}
            </span>
            {file.kind === "text" ? (
              <span className="flex-none text-[10px]" style={{ color: "var(--muted)" }}>
                {dirty ? t("dirty") : saving ? t("saving") : t("saved")}
              </span>
            ) : null}

            {/* 编辑 / 预览 / 变更 是一组互斥页签。切到编辑或预览就是「关掉变更」，
                所以从任何一侧点进去都能再点回来，不会出现「预览还开着、差异又叠上来」。 */}
            {paneTabList.length > 0 && file.kind !== "pdf" ? (
              <div
                role="tablist"
                aria-label={t("viewMode")}
                className="flex flex-none items-center gap-0.5 rounded-md p-0.5"
                style={{ background: "var(--surface-hover)" }}
              >
                {paneTabList.map((tab) => {
                  const active = activeTab === tab.key;
                  const isDiff = tab.key === "diff";
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={isDiff && git ? gitTitle(git, t) : TAB_LABEL[tab.key]}
                      onClick={() => {
                        if (isDiff) onOpenDiff();
                        else {
                          onCloseDiff();
                          onViewerMode(tab.key as ViewerMode);
                        }
                      }}
                      className="flex items-center gap-1 rounded border-0 px-2 py-[3px] text-[11px] transition-colors"
                      style={{
                        background: active ? "var(--accent)" : "transparent",
                        color: active ? "var(--bg)" : "var(--secondary)",
                      }}
                    >
                      {isDiff && git ? (
                        <span
                          className="git-badge"
                          style={{ color: active ? "var(--bg)" : gitColor(git.status) }}
                        >
                          {gitGlyph(git.status)}
                        </span>
                      ) : null}
                      {t(TAB_LABEL[tab.key])}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* 一直可用：没有文件监听，外部改动只能靠这里拉进来。
                以前「没有未保存改动」时它是灰的，于是「文件在别处被改了，
                我想看看新的」正好点不动。有未保存改动时会先弹确认。 */}
            <IconButton
              label={t("reload")}
              onClick={onReload}
              d="M20 11a8 8 0 0 0-14.9-3.9L3 9M3 4v5h5M4 13a8 8 0 0 0 14.9 3.9L21 15M21 20v-5h-5"
            />
            {file.kind !== "pdf" ? (
              <IconButton
                label={t("save")}
                disabled={!dirty || saving || file.kind !== "text"}
                onClick={onSave}
                d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"
              />
            ) : null}
          </>
        ) : (
          <span className="px-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
            {t("projectFiles")}
          </span>
        )}
      </header>

      {error ? (
        <div
          className="flex-none px-3 py-2 text-[11.5px]"
          role="alert"
          style={{
            background: "color-mix(in oklab, var(--danger) 14%, transparent)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {/* 外部改动提示（0.8.0）：只有「有未保存改动」时才会出现——没改动的文件早
          就自动重新读取了，这里无事可提示。按钮走的是既有的「重新加载」，它内部
          已经带未保存确认框（保存 / 放弃 / 取消），所以这条横幅不重复造逻辑。 */}
      {externalChange && file ? (
        <div
          className="flex flex-none items-center gap-2 px-3 py-2 text-[11.5px]"
          role="status"
          style={{
            background: "color-mix(in oklab, var(--git-modified) 14%, transparent)",
            color: "var(--fg)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>{t("externalChanged")}</span>
          <button
            type="button"
            onClick={onReload}
            className="rounded border-0 bg-transparent px-1 text-[11px] underline underline-offset-2"
            style={{ color: "var(--secondary)" }}
          >
            {t("reload")}
          </button>
        </div>
      ) : null}

      {readOnlyReason ? (
        <div
          className="flex flex-none items-center gap-2 px-3 py-2 text-[11.5px]"
          style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}
        >
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--surface-hover)", color: "var(--secondary)" }}
          >
            {t("readOnly")}
          </span>
          <span>{readOnlyReason}</span>
          {typeof file?.limit === "number" ? (
            <span style={{ color: "var(--faint)" }}>
              {t("limitHint", { limit: formatSize(file.limit) })}
            </span>
          ) : null}
          {file ? (
            <span className="ml-auto" style={{ color: "var(--faint)" }}>
              {formatTime(file.mtimeMs, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="h-full" />

        {/* 整块视图只有一个在场上：content 是单值（见 lib/pane.ts），所以这里不可能
            出现「预览与差异叠在一起」。编辑器由 editorHidden 藏起来。 */}
        {content === "markdown" && file ? (
          <div className="md-scroll">
            <div className="md-body">
              <MarkdownPreview text={structuredText} base={base} onLink={onLink} />
            </div>
          </div>
        ) : null}

        {content === "table" && file ? (
          <CsvTable
            text={structuredText}
            delimiter={csvDelimiterOf(file.path) ?? ","}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {content === "tree" && file ? <JsonTree text={structuredText} t={t} /> : null}

        {content === "diff" && diff ? (
          <GitDiffView state={diff} t={t} onClose={onCloseDiff} onRefresh={onRefreshDiff} />
        ) : null}

        {content === "image" && file && imageSrc ? (
          <ImageView key={file.path} src={imageSrc} name={baseNameOf(file.path)} size={file.size} t={t} />
        ) : null}

        {content === "media" && file && mediaSrc ? (
          <MediaPlayer
            key={file.path}
            src={mediaSrc}
            mime={file.mime ?? ""}
            name={baseNameOf(file.path)}
            size={file.size}
            t={t}
          />
        ) : null}

        {content === "pdf" && file && pdfSrc ? (
          <PdfView key={`${file.path}#${file.loadToken}`} src={pdfSrc} name={baseNameOf(file.path)} size={file.size} locale={locale} t={t} />
        ) : null}

        {content === "sqlite" && file && sqlite ? (
          <SqliteView
            // 带上 loadToken：工具栏的「重新加载」会重新读一次头部，key 一变就重挂载，
            // schema 与当前页数据跟着刷新（数据库不能被编辑，所以只有这一种变化来源）
            key={`${file.path}#${file.loadToken}`}
            path={file.path}
            info={sqlite.info}
            available={sqlite.available}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {!file ? (
          <div
            className="absolute inset-0 flex items-center justify-center px-6 text-center"
            style={{ background: "var(--bg)", color: "var(--muted)" }}
          >
            <span className="max-w-[34ch] text-[12px] leading-relaxed">{t("searchHint")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function IconButton({
  label,
  d,
  onClick,
  disabled,
}: {
  label: string;
  d: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-xl border-0 bg-transparent transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] disabled:cursor-default disabled:opacity-40"
      style={{ color: "var(--secondary)" }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    </button>
  );
}
