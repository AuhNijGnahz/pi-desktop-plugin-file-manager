import { useEffect, useMemo, useRef } from "react";
import type { FileEntry } from "../lib/rpc";
import { FileIcon } from "../lib/fileIcons";
import { formatSize } from "../lib/format";
import type { T } from "../i18n";
import { gitColor, gitGlyph, gitTitle } from "../lib/git";

export type DirState = {
  loading?: boolean;
  entries?: FileEntry[];
  error?: string;
};

type Props = {
  directories: Map<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  showIgnored: boolean;
  t: T;
  onToggle: (path: string) => void;
  onOpen: (entry: FileEntry) => void;
  onRefreshDir: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry | null) => void;
};

type Row =
  | { kind: "note"; path: string; depth: number; text: string; error: boolean }
  | { kind: "entry"; path: string; depth: number; entry: FileEntry };

/**
 * 把「已展开的目录链」摊平成一维行列表再渲染。
 * 树是懒加载的，屏幕内容完全由 directories + expanded 决定；摊平之后
 * 键盘导航只需要处理一个数组，比在 DOM 里上上下下简单得多。
 */
function buildRows(
  dirPath: string,
  depth: number,
  directories: Map<string, DirState>,
  expanded: Set<string>,
  showIgnored: boolean,
  t: T,
): Row[] {
  const state = directories.get(dirPath);
  if (state?.error) {
    return [{ kind: "note", path: dirPath, depth, text: state.error, error: true }];
  }
  if (!state || !state.entries) {
    return [{ kind: "note", path: dirPath, depth, text: t("loading"), error: false }];
  }

  const entries = showIgnored
    ? state.entries
    : state.entries.filter((entry) => !entry.ignored);

  if (entries.length === 0) {
    return [{ kind: "note", path: dirPath, depth, text: t("empty"), error: false }];
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    rows.push({ kind: "entry", path: entry.path, depth, entry });
    if (entry.isDirectory && expanded.has(entry.path)) {
      rows.push(...buildRows(entry.path, depth + 1, directories, expanded, showIgnored, t));
    }
  }
  return rows;
}

export function Tree({
  directories,
  expanded,
  selected,
  showIgnored,
  t,
  onToggle,
  onOpen,
  onRefreshDir,
  onContextMenu,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () => buildRows("", 0, directories, expanded, showIgnored, t),
    [directories, expanded, showIgnored, t],
  );

  // 选中项滚入视野——搜索跳转之后需要它。
  useEffect(() => {
    if (!selected) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${clamped}"]`)
      ?.focus();
  };

  const activate = (row: Row) => {
    if (row.kind !== "entry") {
      if (row.error) onRefreshDir(row.path);
      return;
    }
    if (row.entry.isDirectory) onToggle(row.entry.path);
    else onOpen(row.entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number, row: Row) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusRow(0);
        return;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(row);
        return;
      case "ArrowRight":
        if (row.kind === "entry" && row.entry.isDirectory && !expanded.has(row.entry.path)) {
          event.preventDefault();
          onToggle(row.entry.path);
        }
        return;
      case "ArrowLeft":
        if (row.kind === "entry" && row.entry.isDirectory && expanded.has(row.entry.path)) {
          event.preventDefault();
          onToggle(row.entry.path);
        }
        return;
      default:
    }
  };

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label={t("treeSection")}
      aria-busy={!directories.has("") || directories.get("")?.loading === true}
      className="min-h-0 flex-1 overflow-auto px-1.5 pb-4"
      onContextMenu={(event) => {
        // 空白处右键：不带条目，菜单只提供「在此新建」与刷新。
        if ((event.target as HTMLElement).closest(".tree-row")) return;
        event.preventDefault();
        onContextMenu(event, null);
      }}
    >
      {rows.map((row, index) => {
        if (row.kind === "note") {
          return (
            <div
              key={`note:${row.path}:${row.text}`}
              className="flex min-h-[24px] items-center gap-1.5 py-0.5 pr-2 text-[11.5px]"
              style={{
                paddingLeft: 12 + row.depth * 14,
                color: row.error ? "var(--danger)" : "var(--muted)",
              }}
            >
              {row.text === t("loading") ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-[11px] w-[11px] flex-none animate-spin rounded-full border-[1.5px]"
                  style={{
                    borderColor: "var(--border-strong)",
                    borderTopColor: "var(--secondary)",
                  }}
                />
              ) : null}
              <span className="min-w-0">{row.text}</span>
              {row.error ? (
                <button
                  type="button"
                  className="ml-auto border-0 bg-transparent p-0 underline underline-offset-2"
                  style={{ color: "var(--secondary)" }}
                  onClick={() => onRefreshDir(row.path)}
                >
                  {t("retry")}
                </button>
              ) : null}
            </div>
          );
        }

        const { entry } = row;
        const isSelected = selected === entry.path;
        const isExpanded = expanded.has(entry.path);
        const dimmed = entry.ignored && showIgnored;

        return (
          <button
            key={entry.path}
            type="button"
            data-path={entry.path}
            data-row-index={index}
            data-selected={isSelected ? "true" : undefined}
            data-ignored={dimmed ? "true" : undefined}
            role="treeitem"
            aria-expanded={entry.isDirectory ? isExpanded : undefined}
            aria-selected={isSelected}
            aria-level={row.depth + 1}
            // tooltip 把状态讲全：徽标只有一个字母，鼠标停上去才知道是未跟踪还是已暂存。
            title={[
              entry.path,
              entry.outside ? t("symlinkOutside") : entry.ignored ? t("ignoredBadge") : null,
              entry.git ? gitTitle(entry.git, t) : null,
            ]
              .filter(Boolean)
              .join(" — ")}
            disabled={entry.isSymlink}
            onClick={() => activate(row)}
            onKeyDown={(event) => onKeyDown(event, index, row)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(event, entry);
            }}
            className="tree-row"
            style={{ paddingLeft: 6 + row.depth * 14 }}
          >
            <span
              aria-hidden="true"
              className="tree-caret"
              style={{ transform: isExpanded ? "rotate(90deg)" : undefined }}
            >
              {entry.isDirectory ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              ) : null}
            </span>

            <FileIcon name={entry.name} isDirectory={entry.isDirectory} expanded={isExpanded} />

            <span className="tree-name">{entry.name}</span>

            {entry.isSymlink ? (
              <span aria-hidden="true" className="tree-mark">
                ↪
              </span>
            ) : null}

            {/* git 状态：徽标（哪一类变化）+ 行尾的增删行数（改了多少）。
                目录上是子树的汇总，所以带一个受影响文件数而不是行数。 */}
            {entry.git ? (
              <>
                <span
                  className="git-badge"
                  style={{ color: gitColor(entry.git.status) }}
                  title={gitTitle(entry.git, t)}
                >
                  {gitGlyph(entry.git.status)}
                  {entry.isDirectory && typeof entry.git.changed === "number" ? (
                    <span className="git-badge-count">{entry.git.changed}</span>
                  ) : null}
                </span>
                {!entry.isDirectory && (entry.git.added > 0 || entry.git.deleted > 0) ? (
                  <span className="git-stats" title={gitTitle(entry.git, t)}>
                    {entry.git.added > 0 ? <span className="git-add">+{entry.git.added}</span> : null}
                    {entry.git.deleted > 0 ? <span className="git-del">−{entry.git.deleted}</span> : null}
                  </span>
                ) : null}
              </>
            ) : null}

            {entry.isDirectory ? null : (
              <span className="tree-size">{formatSize(entry.size)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
