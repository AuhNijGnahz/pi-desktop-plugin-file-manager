import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      hint?: string;
      icon?: React.ReactNode;
      disabled?: boolean;
      danger?: boolean;
      onPick: () => void;
    }
  | {
      kind: "submenu";
      /**
       * 链路上的稳定标识：展开状态按 id 记，所以重启渲染（entries 每次都是新数组）
       * 不会把已经展开的那一层弄丢。同一个 id 在链路上只出现一次。
       */
      id: string;
      label: string;
      hint?: string;
      icon?: React.ReactNode;
      disabled?: boolean;
      danger?: boolean;
      items: MenuEntry[];
    };

type Props = {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
};

const MARGIN = 8;
/** 鼠标离开触发器后等一小会儿再收：斜着划过去的那一段不该把子菜单闪没。 */
const CLOSE_DELAY_MS = 140;
/** 子菜单相对触发器的偏移：右 4px、上 5px（与自身内边距对齐，看起来像同一张菜单）。 */
const SUBMENU_OFFSET_X = 4;
const SUBMENU_OFFSET_Y = 5;

const SURFACE_ATTR = "data-menu-surface";
const TRIGGER_ATTR = "data-menu-trigger";

/** 当前焦点的按钮所在的菜单面；不在任何菜单面里时是 null。 */
function surfaceOf(target: EventTarget | null): HTMLElement | null {
  const node = target as HTMLElement | null;
  return node?.closest?.(`[${SURFACE_ATTR}]`) ?? null;
}

function itemsOf(surface: HTMLElement | null): HTMLButtonElement[] {
  if (!surface) return [];
  return [...surface.querySelectorAll<HTMLButtonElement>("button[data-item]:not([disabled])")];
}

/** 一条链路上的一层：id 为空串表示根菜单。 */
/**
 * 一条链路上的一层：id 为空串表示根菜单。
 *
 * anchor 三个量：
 *   left     —— 正常情况下的左边缘（子菜单 = 触发器右边缘 + 间隙）
 *   top      —— 上边缘（与触发器对齐）
 *   flipLeft —— 右侧放不下时，子菜单**左边缘**该落在哪：触发器左边缘再往左一个间隙。
 *               只有子菜单才有（根菜单为 null，它自己按视口夹取，从不翻边）。
 *               必须记触发器左边缘而不是「trigger.right - 子菜单宽」——触发器横跨整张
 *               父菜单，用右边缘回推会把子菜单推回去盖在父菜单上。
 */
type LayerAnchor = { left: number; top: number; flipLeft: number | null };
type Layer = { id: string; entries: MenuEntry[]; anchor: LayerAnchor };

/**
 * 右键菜单（0.9.0 起带二级子菜单）。
 *
 * 结构：一个 `fixed inset-0` 的透明外壳包住所有菜单面。外壳不接收指针事件，
 * 每个菜单面自己接收——这样「点到菜单外面」的判定可以是「不在任何一个菜单面里」，
 * 子菜单（DOM 上是兄弟节点，不是父层的孩子）也就不会被自己的父层当成外面点掉。
 *
 * 交互：鼠标停在带子菜单的项上就展开（hover 即二级，不用点）；方向键 → 展开并进入、
 * ← 返回上一层、↑↓/Home/End 在本层移动、Escape 整个菜单关掉。子菜单超出视口时
 * 翻到触发器左侧，不会跑到屏幕外。
 */
export function ContextMenu({ x, y, entries, onClose }: Props) {
  const surfaces = useRef(new Map<string, HTMLElement>());
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  /** 展开链路：根下面的第一层、第二层……；空数组 = 只开着根菜单。 */
  const [openPath, setOpenPath] = useState<string[]>([]);
  const closeTimer = useRef<number | null>(null);

  // entries / onClose / openPath 每次渲染都是新引用，直接放进 effect 依赖会让监听器
  // 与首次聚焦反复重建——按方向键时焦点会被不断拽回第一项。所以用 ref 取最新值。
  const latest = useRef({ entries, onClose, openPath });
  latest.current = { entries, onClose, openPath };

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  /** 展开某一层之后要把焦点送进哪个子菜单（键盘 → 用）。 */
  const pendingFocus = useRef<string | null>(null);

  /** 展开某一层子菜单；focus 只有键盘方向键那条路才给 true。 */
  const openSubmenu = (id: string, depth: number, focus: boolean) => {
    clearCloseTimer();
    if (focus) pendingFocus.current = id;
    setOpenPath((prev) => [...prev.slice(0, depth), id]);
  };

  /**
   * 子菜单渲染出来之后再聚焦。刻意**不用** requestAnimationFrame：面板不可见时
   * 浏览器不派发 rAF，键盘 → 就会「展开了但焦点还留在父层」，紧接着的 ↑↓ 与 ←
   * 全部作用在错误的层上。渲染由 state 驱动，所以放在 effect 里既准确又不依赖帧。
   */
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !openPath.includes(id)) return;
    pendingFocus.current = null;
    itemsOf(surfaces.current.get(id) ?? null)[0]?.focus();
  }, [openPath]);

  /** 收起某一层的子菜单；focusParent 给键盘 ← 用（焦点交回触发器）。 */
  const closeSubmenu = (id: string, focusParent: boolean) => {
    setOpenPath((prev) => (prev.includes(id) ? prev.slice(0, prev.indexOf(id)) : prev));
    if (focusParent) triggers.current.get(id)?.focus();
  };

  const closeSoon = (id: string) => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenPath((prev) => (prev.includes(id) ? prev.slice(0, prev.indexOf(id)) : prev));
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => {
    itemsOf(surfaces.current.get("") ?? null)[0]?.focus();

    const dismiss = () => latest.current.onClose();

    const onPointerDown = (event: MouseEvent) => {
      if (!surfaceOf(event.target)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const surface = surfaceOf(active);
      if (!surface) return;
      const id = surface.getAttribute(SURFACE_ATTR) ?? "";

      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key === "ArrowRight") {
        const trigger = (active as HTMLElement | null)?.closest?.(`[${TRIGGER_ATTR}]`);
        if (!trigger) return;
        event.preventDefault();
        const depth = latest.current.openPath.indexOf(id) + 1;
        openSubmenu(trigger.getAttribute(TRIGGER_ATTR) ?? "", depth, true);
        return;
      }
      if (event.key === "ArrowLeft") {
        if (!id) return;
        event.preventDefault();
        closeSubmenu(id, true);
        return;
      }

      const list = itemsOf(surface);
      if (list.length === 0) return;
      const index = list.indexOf(active as HTMLButtonElement);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(index + 1 + list.length) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
    // 只建一次：处理函数一律经 latest / 稳定回调读取最新状态。
  }, []);

  // 卸载时别留下那个「稍后收起」的计时器。
  useEffect(() => clearCloseTimer, []);

  /** 从根往下按 openPath 走一遍，得出这次要渲染的每一层。 */
  const layers: Layer[] = [{ id: "", entries, anchor: { left: x, top: y, flipLeft: null } }];
  for (const [depth, id] of openPath.entries()) {
    const parent = layers[depth];
    if (!parent) break;
    const entry = parent.entries.find(
      (candidate): candidate is Extract<MenuEntry, { kind: "submenu" }> =>
        candidate.kind === "submenu" && candidate.id === id,
    );
    if (!entry || entry.disabled) break;
    const trigger = triggers.current.get(id);
    const rect = trigger?.getBoundingClientRect();
    layers.push({
      id,
      entries: entry.items,
      anchor: rect
        ? {
            left: rect.right + SUBMENU_OFFSET_X,
            top: rect.top - SUBMENU_OFFSET_Y,
            // 翻到左侧时贴着触发器的左边缘（不是父面板的右边缘）。
            flipLeft: rect.left - SUBMENU_OFFSET_X,
          }
        : { left: x, top: y, flipLeft: null },
    });
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {layers.map((layer) => (
        <MenuSurface
          key={layer.id || "root"}
          id={layer.id}
          entries={layer.entries}
          anchor={layer.anchor}
          openPath={openPath}
          connect={(node) => {
            if (node) surfaces.current.set(layer.id, node);
            else surfaces.current.delete(layer.id);
          }}
          registerTrigger={(entryId, node) => {
            if (node) triggers.current.set(entryId, node);
            else triggers.current.delete(entryId);
          }}
          onPickEntry={(entry) => {
            if (entry.kind === "submenu") {
              if (entry.disabled) return;
              openSubmenu(entry.id, layers.indexOf(layer), false);
              return;
            }
            if (entry.kind !== "item" || entry.disabled) return;
            latest.current.onClose();
            entry.onPick();
          }}
          onHoverEntry={(entry) => {
            // 停在没有子菜单的项上：收起更深的那几层（回到本层为止）。
            const depth = layers.indexOf(layer);
            if (entry.kind === "submenu" && !entry.disabled) {
              openSubmenu(entry.id, depth, false);
              return;
            }
            clearCloseTimer();
            setOpenPath((prev) => prev.slice(0, depth));
          }}
          onLeaveEntry={(entry) => {
            if (entry.kind === "submenu" && !entry.disabled) closeSoon(entry.id);
          }}
          onEnterSurface={() => clearCloseTimer()}
        />
      ))}
    </div>
  );
}

type SurfaceProps = {
  id: string;
  entries: MenuEntry[];
  anchor: LayerAnchor;
  openPath: string[];
  connect: (node: HTMLElement | null) => void;
  registerTrigger: (entryId: string, node: HTMLButtonElement | null) => void;
  onPickEntry: (entry: MenuEntry) => void;
  onHoverEntry: (entry: MenuEntry) => void;
  onLeaveEntry: (entry: MenuEntry) => void;
  onEnterSurface: () => void;
};

/** 一层菜单。自己负责量尺寸并把位置夹进视口；子菜单超出右边就翻到左手边。 */
function MenuSurface(props: SurfaceProps) {
  const { id, anchor, entries } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.top });

  // 先量一次真实尺寸再夹取，避免闪一下再跳位。
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - MARGIN;
    const maxTop = window.innerHeight - height - MARGIN;
    // 子菜单默认贴触发器右侧；右边放不下就翻到触发器左侧（flipLeft 已经算好）。
    const overflowRight = anchor.left + width > window.innerWidth - MARGIN;
    const preferred =
      overflowRight && anchor.flipLeft !== null ? anchor.flipLeft - width : anchor.left;
    setPosition({
      left: Math.max(MARGIN, Math.min(preferred, maxLeft)),
      top: Math.max(MARGIN, Math.min(anchor.top, maxTop)),
    });
  }, [anchor.left, anchor.top, anchor.flipLeft, id, entries.length]);

  return (
    <div
      ref={(node) => {
        ref.current = node;
        props.connect(node);
      }}
      role="menu"
      aria-orientation="vertical"
      {...{ [SURFACE_ATTR]: id }}
      className="pointer-events-auto fixed min-w-[178px] rounded-lg border py-1 shadow-2xl"
      style={{
        left: position.left,
        top: position.top,
        borderColor: "var(--border-strong)",
        background: "var(--surface-raised)",
        color: "var(--fg)",
      }}
      onMouseEnter={props.onEnterSurface}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return (
            <div
              key={`sep-${index}`}
              role="separator"
              className="my-1 h-px"
              style={{ background: "var(--border)" }}
            />
          );
        }

        const isSubmenu = entry.kind === "submenu";
        const expanded = isSubmenu && props.openPath.includes(entry.id);
        return (
          <button
            key={`${entry.label}-${index}`}
            data-item
            type="button"
            role="menuitem"
            aria-haspopup={isSubmenu ? "menu" : undefined}
            aria-expanded={isSubmenu ? expanded : undefined}
            disabled={entry.disabled}
            title={entry.hint}
            {...(isSubmenu ? { [TRIGGER_ATTR]: entry.id } : {})}
            ref={isSubmenu ? (node) => props.registerTrigger(entry.id, node) : undefined}
            onClick={() => props.onPickEntry(entry)}
            onMouseEnter={() => props.onHoverEntry(entry)}
            onMouseLeave={() => props.onLeaveEntry(entry)}
            className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-[5px] text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            style={{
              minHeight: 26,
              color: entry.danger ? "var(--danger)" : "var(--secondary)",
            }}
          >
            <span className="inline-flex w-[15px] flex-none items-center justify-center" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint ? (
              <span className="flex-none text-[10.5px]" style={{ color: "var(--faint)" }}>
                {entry.hint}
              </span>
            ) : null}
            {isSubmenu ? (
              <span className="flex-none text-[10px]" aria-hidden="true" style={{ color: "var(--faint)" }}>
                ▶
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}