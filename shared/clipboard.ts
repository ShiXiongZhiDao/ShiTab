/**
 * 剪贴板写入。
 *
 * 不申请 `clipboardWrite` 权限：TabClip 实测也没有申请（全库 `clipboardWrite` 命中 0），
 * 而它是在扩展页面里、用户手势下写的 —— MV3 扩展页是安全上下文，
 * `navigator.clipboard.writeText` 这条路径就够。多一个权限就多一条安装提示（PRD §1 原则 4）。
 *
 * 保留 `execCommand('copy')` 兜底只为了两件事：老版本 Firefox，以及
 * jsdom（它两个都没有，测试里会走到"抛错"分支而不是静默成功）。
 */

export async function copyToClipboard(text: string): Promise<void> {
  const nav = (globalThis.navigator ?? undefined) as
    | (Navigator & { clipboard?: { writeText(value: string): Promise<void> } })
    | undefined;

  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(text);
    return;
  }

  if (legacyCopy(text)) return;
  throw new Error('这个浏览器不允许扩展页面写入剪贴板');
}

function legacyCopy(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.execCommand) return false;

  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  doc.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
