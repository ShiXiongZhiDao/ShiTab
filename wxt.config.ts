import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// ShiTab · 构建配置
//
// 事实依据（均核实自 node_modules 里的 wxt 0.21.4 源码，见 既有约定）：
// - V1.1 起 surface 只有两个：入口页 `app.html`（未列出，不产生 manifest 键）与 options。
//   popup / sidepanel entrypoint 已删除，`sidePanel` 权限随 entrypoint 一起消失。
// - 设置 manifest.manifest_version 会被显式忽略并告警，必须用下面的
//   manifestVersion 选项（manifest.mjs:43-45）。
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],

  // 既有约定：三端统一 MV3。不依赖任何默认值（WXT 对 firefox 的默认是 MV2）。
  manifestVersion: 3,

  // 项目结构沿用 WXT 默认的 root srcDir（entrypoints/ 与 core/ 都在仓库根），
  // 与 既有约定 §2 的 src/ 前缀不同，但分层与目录内部结构一致。
  // 理由：脚手架已在根目录，挪动只会放大 diff 而无功能收益。已在 log.md 记录。

  vite: () => ({
    plugins: [tailwindcss()],
  }),

  manifest: (env) => ({
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    // **这里不写 version**：WXT 从 package.json 取（核实自 node_modules 里的
    // `dist/core/utils/manifest.mjs:28,33` —— `manifest.version ?? simplifyVersion(pkg.version)`）。
    // 手写一份就是第二个真相，改名那次发现的"界面 v0.1.0 / 清单另一处"的漂移就是这么来的。
    default_locale: 'en',

    // 既有约定 §3 的最小权限集。
    // sidePanel 由 WXT 自动加（仅 Chrome/Edge）。
    //
    // `alarms` 是 既有约定 加的第一个"为了定时"而申请的权限，加之前把代价查清了（一手来源见
    // 既有约定 的出处段）：**Chrome 的权限警告列表里没有 alarms**（那条描述只有
    // "Gives access to the chrome.alarms API."），而"更新时可能被临时禁用"只发生在新增
    // **会触发警告**的权限时 ⇒ 老用户升级不会被禁用、不会弹提示。
    // Firefox 要声明同一个权限，且它的 alarm **不跨浏览器会话**（MDN 原文
    // "Alarms do not persist across browser sessions."）⇒ worker 每次启动都得 ensure。
    // 为什么值得：没有它，"对面改了我要拉进来"只在扩展页面开着时发生（既有约定 的心跳挂在页面上）。
    //
    // `contextMenus` 是 既有约定 加的，用来把六项「收纳」放进**网页右键**与**工具栏图标右键**
    // 两个菜单。代价在开工前查清了，与 `alarms` 那条同形：官方权限表里这一行只有
    // `Gives access to the chrome.contextMenus API.`，**没有 warning 行** ⇒ 安装时不多弹提示、
    // 老用户升级不会被临时禁用（对照 `tabGroups` 那行是有警告的 "View and manage your tab groups."，
    // 所以「按标签组收纳」将来只能走 optional，不能 required —— 既有约定 决定 3）。
    // 它**不带来读网页内容的能力**：我们只注册 `page` 与 `action` 两个上下文，
    // `linkUrl` / `selectionText` 那些要元素级上下文才会给的东西我们一项都不接。
    permissions: ['tabs', 'storage', 'alarms', 'contextMenus'],

    // 明确不申请，留此注释防止后来者"顺手加上"：
    //   host_permissions / <all_urls> / history / bookmarks / tabGroups
    //   scripting / sessions / notifications / unlimitedStorage
    //
    // ⚠ **`host_permissions` 仍然缺席**，这条底线没动。WebDAV 同步走的是
    // `optional_host_permissions` + 运行时 `permissions.request()`：
    // - 安装时的权限提示保持原样（可选权限不产生安装警告），老用户升级不会被禁用；
    // - 官方 chrome.permissions 文档原文：**"Chrome won't disable it for your users if
    //   the upgrade adds optional rather than required permissions."** —— 既有约定 当年
    //   把"升级会被临时禁用"算进第三方上传的成本，那条对 optional 这一路不成立；
    // - 用户点"测试连接"之前，一个跨源请求都发不出去。
    // 代价如实记着：清单里声明了通配，Edge/Chrome 的权限详情会写成"读取和更改您在所有
    // 网站上的数据"那一类，Firefox AMO 要单独解释这一项。见 既有约定 的 P6。
    optional_host_permissions: ['https://*/*', 'http://*/*'],

    // 工具栏图标 = 收纳入口（V1.1 既有约定）。
    //
    // **不能有 default_popup**：官方文档明写设置了 popup 就不会触发 action.onClicked
    // （Chrome action API / MDN action.onClicked 两处同文）。popup entrypoint 已删除，
    // 所以这里必须**显式**给出 action 键 —— 隔壁仓库踩过"manifest 里没有 action 键，
    // 图标点击没有反应"的坑。标题走 i18n，收纳完成后由 background 改标题。
    action: {
      default_title: '__MSG_action_default_title__',
    },

    // Firefox 需要 gecko.id 才能安装/上架；WXT 会补默认值，这里显式声明来源，
    // 便于 AMO 上架时替换成真实扩展 id。
    //
    // `data_collection_permissions` 是 AMO 对**新扩展**的强制项（2025-11-03 起；现有扩展暂时豁免），
    // 缺它构建就会 WARN、提交时会被打回。值取 `required: ['none']`：本扩展不申请 host_permissions、
    // 没有 content script、没有任何服务器，数据只落 `storage.local` —— 需要"收集并传出"的那一档不存在。
    // 口径来自 MDN 与 extensionworkshop 两份文档交叉核对：这个枚举的"不收集"拼作 `none`（不是 `none_needed`），
    // 且 `required` 里 `none` 与其他值互斥；`optional` 不接受 `none`，所以整个键省略。
    // ⚠ 提交 AMO 时仍要被人工复核一次：discourse 上有"校验说缺这个字段但 manifest 里明明有"的报告。
    ...(env.browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'shitab@example.com',
              strict_min_version: '115.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
