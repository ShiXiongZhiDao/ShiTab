/**
 * 拖拽载荷。工作台里同时存在四种拖放（组排序、组内 tab 排序、跨组移动、分类排序），
 * 而 dataTransfer 里也可能出现**根本不是我们发起的**拖放（用户从桌面拖文件、
 * 拖一段选中的文字进来），所以解码必须是防御式的。
 *
 * 四种拖放共用一个 `text/plain` 是不行的：分类行既接受"会话拖进来 = 归类"，
 * 也接受"分类拖进来 = 排序"，同一只手在同一块像素上做两件事，
 * 只能靠 MIME 分辨发起方，否则一次排序会把会话搬进错误的分类。
 */

export const GROUP_MIME = 'text/shitab-group' as const;
export const TAB_MIME = 'text/shitab-tab' as const;
/** 分类行自身被拖动（排序）。曾经是这个文件之外的字面量，见 既有约定。 */
export const CAT_MIME = 'text/shitab-category' as const;

export interface GroupDragPayload {
  groupId: string;
}

export interface TabDragPayload {
  tabId: string;
  groupId: string;
}

export interface CategoryDragPayload {
  categoryId: string;
}

export function encode(payload: GroupDragPayload | TabDragPayload | CategoryDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeGroup(raw: string | null): GroupDragPayload | undefined {
  const parsed = parse(raw);
  return parsed && typeof parsed.groupId === 'string' ? { groupId: parsed.groupId } : undefined;
}

export function decodeTab(raw: string | null): TabDragPayload | undefined {
  const parsed = parse(raw);
  if (parsed && typeof parsed.tabId === 'string' && typeof parsed.groupId === 'string') {
    return { tabId: parsed.tabId, groupId: parsed.groupId };
  }
  return undefined;
}

/** 分类载荷只认 `categoryId`：带 groupId 的会话载荷绝不能被它认领（那是归类，不是排序）。 */
export function decodeCategory(raw: string | null): CategoryDragPayload | undefined {
  const parsed = parse(raw);
  return parsed && typeof parsed.categoryId === 'string' ? { categoryId: parsed.categoryId } : undefined;
}

/** 解析失败或形状不对一律返回 undefined，而不是抛错打断 drop。 */
function parse(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
