/**
 * 一个够用的 XML 扫描器 —— **不用 DOMParser**。
 *
 * 为什么要有这个文件：`http-webdav.ts` 原先用 `new DOMParser()` 解 PROPFIND 的 207 正文，
 * 而 **DOMParser 不属于 Worker/ServiceWorker 全局**。同步引擎按 既有约定 就跑在
 * background service worker 里 ⇒ 列目录在真机上必然抛 `ReferenceError`，
 * 而它被 `readRemoteView` 的 `.catch(() => [])` 咽掉之后，表现是"远端永远是空的"：
 * 去重失效、revision 恒为 1、manifest 每轮被覆盖写。
 *
 * 假件与单测都没抓到，因为它们跑在 jsdom 里，而 **jsdom 有 DOMParser** ——
 * 假环境比生产宽容，这类缺陷就只能靠真服务器暴露。所以这个文件刻意做成
 * 纯字符串处理：**在 node 环境下也能跑**，配套用例就是这么测的。
 *
 * 只实现 PROPFIND 真正需要的那几个语法子集，并且把边界写清楚：
 * 支持元素嵌套、自闭合、实体引用；**跳过**注释、`<?…?>`、`<!DOCTYPE>`；
 * 不处理命名空间前缀以外的 XML 特性（属性值里的 `>` 会让标签提前结束 —— 见下）。
 * 之所以不用正则直接抓 `<response>`：WebDAV 各家前缀写法不同（`d:`/`D:`/无前缀/全大写），
 * 必须先成树、再按**本地标签名**筛，才不会出现"列目录成功但一条都没看见"。
 */

export interface XmlNode {
  /** 去掉前缀并转小写的标签名。`D:href` 与 `href` 与 `HREF` 都是 `href`。 */
  local: string;
  children: XmlNode[];
  /** 直接文本（已解实体）。嵌套元素的文本不算 —— 取值一律走 textOf()。 */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    const named = ENTITIES[entity.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * 标签切分。
 *
 * 属性段按引号感知地吃掉，是为了让 `<d:href a="x>y">` 这种（少见但合法）写法不会把元素
 * 提前截断成 `href a="x`。`<` 与 `>` 在 XML 里必须以实体出现于文本，所以标签外的
 * `<` 一定是新标签的开始。
 */
interface OpenTag {
  local: string;
  selfClosing: boolean;
  end: number;
}

function localPart(qname: string): string {
  const colon = qname.indexOf(':');
  return (colon === -1 ? qname : qname.slice(colon + 1)).toLowerCase();
}

function readOpenTag(xml: string, from: number): OpenTag | undefined {
  // 标签名
  let at = from + 1;
  const nameStart = at;
  while (at < xml.length && /[\w:.-]/.test(xml[at] ?? '')) at += 1;
  const rawName = xml.slice(nameStart, at);
  if (!rawName) return undefined;

  // 属性区：引号感知地找到本标签的 '>'
  let cursor = at;
  let quote = '';
  while (cursor < xml.length) {
    const char = xml[cursor];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      break;
    }
    cursor += 1;
  }
  if (cursor >= xml.length) return undefined;

  const selfClosing = xml[cursor - 1] === '/';
  return { local: localPart(rawName), selfClosing, end: cursor + 1 };
}

/**
 * 解析出根元素。返回 `undefined` 表示"这不是一个能用的 XML 文档"——
 * 调用方按"正文不是 multistatus"处理，而不是抛一个没有信息量的异常。
 */
export function parseXmlRoot(xml: string): XmlNode | undefined {
  const root: XmlNode = { local: '#document', children: [], text: '' };
  const stack: XmlNode[] = [root];
  let cursor = 0;

  while (cursor < xml.length) {
    const lt = xml.indexOf('<', cursor);
    if (lt === -1) break;
    const text = xml.slice(cursor, lt);
    const open = stack[stack.length - 1];
    if (text && open) open.text += decodeEntities(text);
    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt);
      cursor = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt);
      cursor = close === -1 ? xml.length : close + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const close = xml.indexOf('>', lt);
      cursor = close === -1 ? xml.length : close + 1;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const close = xml.indexOf('>', lt);
      if (close === -1) return undefined;
      const name = localPart(xml.slice(lt + 2, close).trim());
      // 出栈到匹配的标签：遇到不匹配就认为文档坏了（服务器回的半截 XML 就是这个形状）
      const top = stack[stack.length - 1];
      if (stack.length <= 1 || !top || top.local !== name) return undefined;
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const tag = readOpenTag(xml, lt);
    if (!tag) return undefined;
    const node: XmlNode = { local: tag.local, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (!parent) return undefined;
    parent.children.push(node);
    if (!tag.selfClosing) stack.push(node);
    cursor = tag.end;
  }

  // 有没闭合的元素 ⇒ 半截文档
  if (stack.length > 1) return undefined;
  return root.children[0];
}

export function childrenByLocal(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => child.local === local);
}

export function descendantsByLocal(node: XmlNode, local: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.local === local) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** 文档顺序里第一个匹配后代的文本；空文本与缺失统一返回 undefined（不要拿 '' 当"有值"）。 */
export function textOf(node: XmlNode, local: string): string | undefined {
  const [found] = descendantsByLocal(node, local);
  const text = found ? (found.text + found.children.map((child) => child.text).join('')).trim() : '';
  return text ? text : undefined;
}
