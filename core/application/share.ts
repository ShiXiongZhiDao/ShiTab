/**
 * "把一批 tab 交出去"的两种本地方式。
 *
 * 用户要的清单里有一项"共享为网页"。实测 TabClip 0.1.2：**这个功能在它身上不存在**
 * （`host_permissions: []`，全 bundle 只有 3 处 fetch 且都是抓 favicon，没有任何上报接口）。
 * 而我们自己签过的底线是 PRD §42"只本地保存、不上传服务器、不统计 URL"。
 * 所以这里给的是两条**零权限、零上传**的替代：复制到剪贴板、导出成自包含 HTML 文件。
 *
 * 复制格式不跟我自己上一轮的推荐，跟参照物的实测结果：
 * 每条 `标题\nURL`，条目之间空一行（TabClip 的 `copyLinks` 就是这个形状，
 * 粘到微信/飞书/备忘录里都能直接读）。Markdown 列表反而会让纯文本场景多出一层噪声。
 */

import type { SavedTab, TabGroup } from '@/shared/types';

/** 按用户看到的顺序排（sortOrder 优先，originalIndex 次级 —— 与恢复一致）。 */
function inRestoreOrder(tabs: SavedTab[]): SavedTab[] {
  return [...tabs].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.originalIndex - b.originalIndex,
  );
}

function displayTitle(tab: SavedTab): string {
  return tab.title.trim() || tab.url;
}

/**
 * 剪贴板载荷：`标题\nURL`，条目间空行。
 *
 * 不可恢复的条目（`restorable=false`，比如 `chrome://` 页）**照样列出来** ——
 * 用户复制的是"我当时开着什么"，不是"哪些链接能点"；悄悄丢掉几条会更难解释。
 */
export function clipboardText(tabs: SavedTab[]): string {
  return inRestoreOrder(tabs).map((tab) => `${displayTitle(tab)}\n${tab.url}`).join('\n\n');
}

export function clipboardTextOfGroup(group: TabGroup): string {
  return clipboardText(group.tabs);
}

/** 单条：只给 URL（行级"复制"按钮的载荷 —— 粘到地址栏就能用）。 */
export function clipboardTextOfTab(tab: SavedTab): string {
  return tab.url;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 自包含 HTML：不引任何外部资源（没有 favicon、没有 CSS 文件、没有脚本），
 * 这样"发给别人"才是真的能打开一个文件而已，而不是把用户的浏览历史挂到某个域下。
 *
 * `brand` 由调用方从 i18n 取（既有约定 决定 1）：这一层不碰翻译，
 * 而导出页上的品牌字必须与界面同源 —— 写第二份字面量就是留第二个会过期的副本。
 */
export function buildShareHtml(group: TabGroup, at: number, brand: string): string {
  const items = inRestoreOrder(group.tabs)
    .map(
      (tab) =>
        `      <li><a href="${escapeHtml(tab.url)}">${escapeHtml(displayTitle(tab))}</a>` +
        `<span class="url">${escapeHtml(tab.url)}</span></li>`,
    )
    .join('\n');
  const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(group.title || brand)} · ${group.tabs.length} 个标签页</title>
    <style>
      body { margin: 0; padding: 32px 20px; background: #f6f7f9; color: #1d242c;
             font: 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
      main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e8ebef;
             border-radius: 16px; padding: 24px 28px; }
      h1 { margin: 0 0 4px; font-size: 18px; }
      .meta { margin: 0 0 20px; color: #7b8490; font-size: 12px; }
      ol { margin: 0; padding-left: 22px; }
      li { margin: 0 0 12px; }
      a { color: #356d52; font-weight: 600; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .url { display: block; color: #7b8490; font-size: 11px; word-break: break-all; }
      footer { margin-top: 24px; color: #7b8490; font-size: 11px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(group.title || '未命名标签组')}</h1>
      <p class="meta">${group.tabs.length} 个标签页 · 导出于 ${escapeHtml(stamp)}</p>
      <ol>
${items}
      </ol>
      <footer>由 ${escapeHtml(brand)} 导出 · 本文件不含任何外部资源或脚本</footer>
    </main>
  </body>
</html>
`;
}

/** 文件名：可排序的时间前缀 + 清洗过的标题，避免 `/\:*?"<>|` 这些非法字符。 */
export function shareFilename(title: string, at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
  const safe = title
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `shitab-${stamp}${safe ? `-${safe}` : ''}.html`;
}
