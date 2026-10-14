/**
 * 复制到系统剪贴板。
 *
 * 面板是 file:// 的沙箱页：安全上下文不一定成立，`navigator.clipboard` 可能整个缺失
 * 或直接抛错。所以先试标准 API，失败再退回 `document.execCommand("copy")` 那条老路
 * （在 textarea 上选中再复制）。两条都失败才返回 false，调用方据此给「复制失败」的
 * 提示——绝不会静默地什么都没发生。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}