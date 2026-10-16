import type { MenuEntry } from "../components/ContextMenu";

export type FileContextMenuTarget = {
  path: string;
  isDirectory: boolean;
  git?: object | null;
};

const BUILT_IN_BROWSER_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/** Add the host's bundled Browser action only when both the host and file support it. */
export function withBuiltInBrowserEntry<T extends FileContextMenuTarget>(
  target: T,
  available: boolean,
  label: string,
  entries: MenuEntry[],
  onOpen: (target: T) => void,
): MenuEntry[] {
  if (!available || target.isDirectory) return entries;
  const basename = target.path.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || !BUILT_IN_BROWSER_EXTENSIONS.has(basename.slice(dot).toLowerCase())) {
    return entries;
  }
  return [
    { kind: "item", label, onPick: () => onOpen(target) },
    { kind: "separator" },
    ...entries,
  ];
}

export type FileContextMenuLabels = {
  newFile: string;
  newFolder: string;
  rename: string;
  move: string;
  delete: string;
  copyRelativePath: string;
  copyAbsolutePath: string;
  openWithSubmenu: string;
  viewChanges: string;
  revealInFolder: string;
  refresh: string;
};

export type FileContextMenuOptions<T extends FileContextMenuTarget> = {
  target: T | null;
  labels: FileContextMenuLabels;
  openWithEntries: MenuEntry[];
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRename: (target: T) => void;
  onMove: (target: T) => void;
  onDelete: (target: T) => void;
  onCopyRelativePath: (target: T) => void;
  onCopyAbsolutePath: (target: T) => void;
  onViewChanges: (target: T) => void;
  onRevealInFolder: (target: T) => void;
  onRefresh: (directory: string) => void;
};

/**
 * Build the tree context menu in stable action groups. Missing-target actions
 * are omitted, so a blank-area menu contains only create and refresh actions.
 */
export function buildFileContextMenuEntries<T extends FileContextMenuTarget>(
  options: FileContextMenuOptions<T>,
): MenuEntry[] {
  const { target, labels } = options;
  const isDirectory = target?.isDirectory === true;
  const parent = target ? (isDirectory ? target.path : parentOf(target.path)) : "";
  const sections: MenuEntry[][] = [];

  if (target) {
    sections.push([
      {
        kind: "submenu",
        id: "openWith",
        label: labels.openWithSubmenu,
        items: options.openWithEntries,
      },
    ]);
  }

  sections.push([
    {
      kind: "item",
      label: labels.newFile,
      onPick: () => options.onNewFile(parent),
    },
    {
      kind: "item",
      label: labels.newFolder,
      onPick: () => options.onNewFolder(parent),
    },
  ]);

  if (target) {
    sections.push([
      {
        kind: "item",
        label: labels.rename,
        onPick: () => options.onRename(target),
      },
      {
        kind: "item",
        label: labels.move,
        onPick: () => options.onMove(target),
      },
      {
        kind: "item",
        label: labels.delete,
        danger: true,
        onPick: () => options.onDelete(target),
      },
    ]);

    sections.push([
      {
        kind: "item",
        label: labels.copyRelativePath,
        onPick: () => options.onCopyRelativePath(target),
      },
      {
        kind: "item",
        label: labels.copyAbsolutePath,
        onPick: () => options.onCopyAbsolutePath(target),
      },
    ]);

    if (!isDirectory) {
      const fileActions: MenuEntry[] = [];
      if (target.git) {
        fileActions.push({
          kind: "item",
          label: labels.viewChanges,
          onPick: () => options.onViewChanges(target),
        });
      }
      fileActions.push({
        kind: "item",
        label: labels.revealInFolder,
        onPick: () => options.onRevealInFolder(target),
      });
      sections.push(fileActions);
    }
  }

  sections.push([
    {
      kind: "item",
      label: labels.refresh,
      onPick: () => options.onRefresh(parent),
    },
  ]);

  return sections.flatMap((section, index) =>
    index === 0 ? section : [{ kind: "separator" as const }, ...section],
  );
}

function parentOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}
