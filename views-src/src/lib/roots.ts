/**
 * 项目组（0.5.0）与「当前在看哪个 folder root」——纯函数。
 *
 * 宿主可以把一个项目注册成多个本地文件夹，随 workspace.get() / workspace:changed
 * 一起送来：
 *   { path, name, projectId?, roots?: [{ path, name, primary }] }
 * path / name 仍是「组的**主根**」（活动工作区），roots 按组顺序给出全部 folder
 * root（主根在前）。老宿主不送 projectId / roots —— 那就退化成单根，视图行为与
 * 0.4 完全一致。
 *
 * 选中的是哪个：prefs.projectRoots（projectKey → 绝对路径）是唯一真相，
 * main.js 用同一套规则推导包含基点。这里的每个判定都必须是**纯**的：视图与主
 * 进程各算一遍，规则一致才不会各说各话。
 */

import { baseNameOf } from "./format";

/** 宿主给的单个 folder root；也是唯一允许作为包含基点的东西。 */
export type WorkspaceRoot = { path: string; name: string; primary: boolean };

/** workspace.get() / workspace:changed 的载荷（后两个字段老宿主不送）。 */
export type ProjectWorkspace = {
  path: string;
  name: string;
  /** 活动项目组的稳定 id；缺省时按主根路径记忆。 */
  projectId?: string;
  /** 组的全部 folder root，按组顺序、主根在前。 */
  roots?: WorkspaceRoot[];
};

/** 一个绝对路径落在某个 root 里时给出的那一份：基点 root 与它内部的相对路径。 */
export type RootHit = { root: WorkspaceRoot; rel: string };

const SEGMENT_SPLIT = /[\\/]+/;

/** 绝对路径判定（与 lib/hostOpen.ts 的 isExternalPath 是同一条规则）。 */
function isAbsolutePath(target: string): boolean {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\");
}

/**
 * 去尾部分隔符、把反斜杠统一成正斜杠后的比较形态。
 *
 * 宿主给的目录是正斜杠（`C:/Users/me/Docs`），而这个插件自己的主进程会用 Node 的
 * `path.resolve()` 把记忆里的值写成反斜杠（`C:\Users\me\Docs`）。同一个目录的这两种
 * 写法必须算同一个目录，否则「切到 B 之后记住」在写盘那一刻就自己失效了：视图用原样
 * 字符串还能匹配（头部名字会换），主进程匹配不上就退回主目录（列表不换）。
 */
function canonicalPath(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, "");
  return (trimmed || target).replace(/\\/g, "/");
}

/** 路径 → 段（丢掉空段与 `.`）。两侧都按段比，`\` 与 `/` 混用也不会误判。 */
function splitPath(target: string): string[] {
  return target.split(SEGMENT_SPLIT).filter((part) => part && part !== ".");
}

/** 同一个目录的两种写法（Windows 盘符 / 路径大小写、末尾斜杠、分隔符混用）。 */
export function samePath(left: string, right: string): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** roots 里按路径命中一个 root：先精确比，再忽略大小写比一次。 */
export function matchRoot(roots: WorkspaceRoot[], target: string): WorkspaceRoot | null {
  return (
    roots.find((entry) => entry.path === target) ??
    roots.find((entry) => samePath(entry.path, target)) ??
    null
  );
}

/**
 * 宿主给的 roots 规整结果；没送（或送来的全是垃圾）时退化成一个根——主根就是
 * workspace.path，与 0.4 的单根行为完全一致（此时切换器只显示不响应）。
 */
export function normalizeRoots(workspace: ProjectWorkspace): WorkspaceRoot[] {
  const roots: WorkspaceRoot[] = [];
  if (Array.isArray(workspace.roots)) {
    for (const entry of workspace.roots) {
      if (!entry || typeof entry.path !== "string" || !entry.path) continue;
      roots.push({
        path: entry.path,
        name: typeof entry.name === "string" && entry.name ? entry.name : baseNameOf(entry.path),
        primary: entry.primary === true,
      });
    }
  }
  if (roots.length > 0) return roots;
  return [
    {
      path: workspace.path,
      name: workspace.name || baseNameOf(workspace.path),
      primary: true,
    },
  ];
}

/** 主根：宿主标了 primary 的那个；一个都没标就按组顺序取第一个。 */
export function primaryRootOf(roots: WorkspaceRoot[]): WorkspaceRoot | null {
  return roots.find((entry) => entry.primary === true) ?? roots[0] ?? null;
}

/** 记忆键：优先 projectId；宿主没给就退回主根路径（前缀让两种键不会互相撞上）。 */
export function projectKeyOf(workspace: ProjectWorkspace): string {
  return typeof workspace.projectId === "string" && workspace.projectId
    ? `p:${workspace.projectId}`
    : `r:${workspace.path}`;
}

/**
 * 记忆里的 root 必须命中组里当前的 roots 才被信任（文件夹可能已经被移出组），
 * 否则退回主根——绝不给用户看一棵空树。
 */
export function resolveSelectedRoot(
  roots: WorkspaceRoot[],
  remembered: string | undefined,
): WorkspaceRoot | null {
  const hit = typeof remembered === "string" ? matchRoot(roots, remembered) : null;
  return hit ?? primaryRootOf(roots);
}

/**
 * child 在 parent 之内时的 POSIX 相对路径；child === parent 时是空串，组外是 null。
 * child 必须是绝对路径（相对路径没有「落在哪个 root 里」这回事）。
 */
export function relativeInside(parent: string, child: string): string | null {
  if (!isAbsolutePath(child)) return null;
  const base = splitPath(parent);
  const target = splitPath(child);
  if (base.length === 0 || target.length < base.length) return null;
  for (let index = 0; index < base.length; index += 1) {
    if (base[index]?.toLowerCase() !== target[index]?.toLowerCase()) return null;
  }
  return target.slice(base.length).join("/");
}

/** 绝对路径落在组的哪个 root 里；null 表示组外（照旧走 external）。 */
export function findRootForPath(roots: WorkspaceRoot[], absolutePath: string): RootHit | null {
  const exact = matchRoot(roots, absolutePath);
  if (exact) return { root: exact, rel: "" };
  for (const root of roots) {
    const rel = relativeInside(root.path, absolutePath);
    if (rel !== null) return { root, rel };
  }
  return null;
}

/** 一段「哪个项目在看哪个 root」的记忆：projectKey → 绝对路径。 */
export type ProjectRootMemory = Record<string, string>;

/** 记忆上限（与 main.js 的 MAX_PROJECT_ROOTS 一致，两边必须是同一个数）。 */
export const MAX_PROJECT_ROOTS = 20;

/**
 * 记下一条「这个项目在看哪个 root」：重写一次就把这条挪到末尾（最近写入 = 最近
 * 使用），超过 MAX_PROJECT_ROOTS 条时丢最旧的。JS 对象保持字符串键的插入顺序，
 * 所以插入顺序本身就是淘汰顺序。
 *
 * 这是 main.js rememberProjectRoot 的同一套规则：视图与主进程都按这份记忆推导
 * 包含基点，给出不同的结果就会各按一个基点解析。
 */
export function rememberProjectRoot(
  map: ProjectRootMemory | undefined,
  key: string,
  value: string,
): ProjectRootMemory {
  const next: ProjectRootMemory = {};
  for (const [entryKey, entryValue] of Object.entries(map ?? {})) {
    if (entryKey === key || typeof entryValue !== "string") continue;
    next[entryKey] = entryValue;
  }
  next[key] = value;

  const keys = Object.keys(next);
  if (keys.length <= MAX_PROJECT_ROOTS) return next;
  const bounded: ProjectRootMemory = {};
  for (const entryKey of keys.slice(keys.length - MAX_PROJECT_ROOTS)) {
    bounded[entryKey] = next[entryKey];
  }
  return bounded;
}

/**
 * 条目路径（相对当前基点）→ 绝对路径，供视图展示与「复制路径」使用。
 *
 * 基点就是主文件夹时，条目路径本身就是工作区相对路径，原样返回；
 * 基点换成了组里的兄弟文件夹时，要拼成绝对路径才有意义。规则与
 * hostActionPath 完全一致（那是送给宿主执行的同一条路径）。
 */
export function absolutePathOf(entryPath: string, root: WorkspaceRoot | null): string {
  if (!root || root.primary) return entryPath;
  return joinAbsolute(root.path, entryPath);
}

/**
 * 条目路径 → **始终是绝对路径**的形态，供「复制绝对路径」与「通过…打开」使用。
 *
 * 与 absolutePathOf 的区别只有一点：基点就是主根时后者按原样返回相对路径（宿主与
 * 基点解析都把它当工作区相对路径用，那是对的），而这里要的是用户能直接贴到别处的
 * 绝对路径，所以任何情况下都拼上 root.path。rel 为空（root 本身）时就是 root 路径。
 */
export function absoluteFullPath(entryPath: string, root: WorkspaceRoot | null): string {
  if (!root) return entryPath;
  return joinAbsolute(root.path, entryPath);
}

/** 两个路径片段拼成绝对路径；分隔符跟着 base 走（Windows 上仍是 `\`）。 */
function joinAbsolute(base: string, rel: string): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const trimmedRel = rel.replace(/^[\\/]+/, "");
  if (!trimmedRel) return trimmedBase;
  const separator = trimmedBase.includes("\\") ? "\\" : "/";
  // 条目路径永远是正斜杠（fm.list 的约定），拼出来的绝对路径要跟 base 同一种写法。
  const tail = separator === "/" ? trimmedRel : trimmedRel.replace(/\//g, "\\");
  return `${trimmedBase}${separator}${tail}`;
}

/**
 * 「用默认应用打开」与「在文件夹中显示」交给宿主执行时要送出去的路径。
 *
 * 宿主这两条通道只接受**工作区相对路径**（plugin-runtime 的 resolveFsRequest 会把
 * 开头的分隔符剥掉、再按工作区根解析），所以：
 *   - 基点就是主文件夹时，相对路径原样送出去，与 0.4 完全一致；
 *   - 基点换成了组里的兄弟文件夹时，相对路径会被宿主按**主文件夹**解析——两个文件夹
 *     里有同名文件的话，打开的就是另一个文件（0.5.0 修掉的正是这个缺陷），因此必须
 *     送绝对路径。宿主对「本项目已注册文件夹根」下的绝对路径有对应的窄放行（ADR 0253）。
 */
export function hostActionPath(entryPath: string, root: WorkspaceRoot | null): string {
  return absolutePathOf(entryPath, root);
}
