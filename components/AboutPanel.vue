<script lang="ts" setup>
/**
 * 「关于」分区。
 *
 * 里面三件事：这个扩展是什么（品牌 + 版本 + 一句话）、它能碰到什么（权限说明），
 * 以及怎么支持它（公众号 + 支付宝 + 微信三张码）。
 *
 * 三条不是顺手做出的选择，别在下次"再简化一点"时弄丢：
 *
 * 1. **码永远坐在白色底垫上，暗色主题也不反色。**扫码 app 靠深浅模块的对比与三个定位角工作，
 *    把 QR 画成"暗底亮块"经常扫不出来。所以 `.qr-pad` 的白是**故意的硬编码**，
 *    不是漏改的魔法数 —— 它是 `assets/styles/shitab.css` 那份 token 唯一一处例外。
 *
 * 2. **不画支付宝/微信的品牌色点，也不裁公众号那张图。**原型里我在两张赞助码标题前放过
 *    一颗蓝点一颗绿点（#1677ff / #07c160），落地时删了：那是我凭印象估的品牌色，
 *    而品牌资产的配色与比例不该由一个第三方扩展猜。公众号那张同理 —— 它是微信官方的
 *    「微信搜一搜」传播样式（1040×380 的横幅，左 QR 右"微信搜一搜 + 账号名"），
 *    裁掉右半就丢了"搜什么"这句引导，所以整张按横幅排版。
 *
 * 3. **图读不到时要留一个形状不变的占位**，不能是浏览器那个裂图图标。
 *    照 `TabRow.vue` 对 favicon 的处置：`@error` 退回同尺寸占位 ⇒ 布局不跳。
 *    `width`/`height` 属性给的是图片真实像素，配合 `h-auto` 让浏览器在解码前就占好位。
 */
import { ref } from 'vue';
import type { PublicPath } from 'wxt/browser';
import PaneHeader from '@/components/PaneHeader.vue';
import { t } from '@/shared/i18n';
import { filledRepos, type RepoLink } from '@/shared/repos';

/**
 * 三张码的路径只在这里写一遍。
 *
 * 为什么不用模板里的静态 `src="/qr/alipay.png"`：`@vitejs/plugin-vue` 默认开着
 * `transformAssetUrls`，会把静态 `src` 改写成**模块 import**，测试环境里加载这一步就直接抛
 * `ERR_INVALID_ARG_VALUE`（实测：报的是 `file:///qr/wechat-official.png`）。
 *
 * 为什么类型是 `PublicPath` 而不是 `string`：WXT 从 `public/` 的实际内容生成这个联合
 * （`.wxt/types/paths.d.ts`，含 `/qr/alipay.png` 三条，**带开头的斜杠**）。
 * 用它当参数类型，等于"图被改名或删掉 ⇒ `vue-tsc` 当场红"，
 * 而不是等用户在设置页看到一个裂图。所以这里不写 `as never` 之类的绕过。
 */
const QR = {
  official: '/qr/wechat-official.png',
  alipay: '/qr/alipay.png',
  wechatPay: '/qr/wechat-pay.png',
} as const satisfies Record<string, PublicPath>;

/** 缺图提示里说的那个路径，由真正去取的那条派生（去掉开头的斜杠），不是又抄一遍。 */
function qrPath(path: PublicPath): string {
  return path.slice(1);
}
/** 走函数而不是在模板里直接点 `browser`：模板表达式里的自动导入不稳，脚本里一定注入。 */
function qrUrl(path: PublicPath): string {
  return browser.runtime.getURL(path);
}

/** 版本号读 manifest，不在这里手写第二遍（既有约定；`options/App.vue` 里那条守卫用例盯着同一件事）。 */
const version = `v${browser.runtime.getManifest().version}`;

const broken = ref<Record<string, boolean>>({});
function markBroken(id: string): void {
  broken.value = { ...broken.value, [id]: true };
}

/**
 * 仓库列表默认取 `shared/repos.ts` 里填好的那些。
 * 这颗 prop 只为测试存在（照 `SyncPanel` 的 `webdav?` 那个先例）：
 * 不注入的话，"哪天他把地址填进去，这张卡真的会亮"这一半**没有任何东西能证明** ——
 * 只测"空列表时不渲染"是不够的。
 */
const props = withDefaults(defineProps<{ repos?: RepoLink[] }>(), { repos: () => filledRepos() });
</script>

<template>
  <div>
    <PaneHeader :sub="t('options_about_sub')" :title="t('options_nav_about')" />

    <section class="mb-3.5 flex items-center gap-3.5 rounded-card border border-line bg-panel p-5">
      <div class="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-control bg-brand text-[23px] font-extrabold text-brand-contrast">T</div>
      <div class="min-w-0">
        <h3 class="m-0 text-[16px] font-extrabold">{{ t('brandName') }}</h3>
        <p class="m-0 mt-0.5 text-[11px] text-muted">{{ version }} · {{ t('options_about_free') }}</p>
        <p class="m-0 mt-1.5 text-[11.5px] leading-relaxed text-muted">{{ t('options_subtitle') }}</p>
      </div>
    </section>

    <section class="mb-3.5 rounded-card border border-line bg-panel p-5">
      <h3 class="m-0 mb-2.5 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_perms_section') }}</h3>
      <div class="mb-3 flex flex-wrap gap-1.5">
        <span class="rounded-full border border-line bg-chip px-2.5 py-1 font-mono text-[11px] font-semibold text-ink">tabs</span>
        <span class="rounded-full border border-line bg-chip px-2.5 py-1 font-mono text-[11px] font-semibold text-ink">storage</span>
        <span class="rounded-full border border-line bg-chip px-2.5 py-1 font-mono text-[11px] font-semibold text-ink">alarms</span>
      </div>
      <p class="m-0 text-[11px] leading-relaxed text-muted">{{ t('options_permissions_body') }}</p>
    </section>

    <!--
      开源仓库。地址只在 `shared/repos.ts` 一处，界面上两处都从同一个值来：
      那颗按钮的 href 与下面那行等宽地址（他这次要的是"把地址亮出来"，只给一个品牌名他复制不到）。
      `url` 留空的条目由 `filledRepos()` 挡掉 ⇒ 整块不出现；
      刻意不做"先放两个灰掉的按钮"：链不通或链错地方，比不链更容易让人以为那就是本项目的源码。
      图标只有一颗通用的 folder —— 不画 GitHub/Gitee 的品牌标志，理由与不画支付宝色点同一条。
    -->
    <section v-if="repos.length" class="mb-3.5 rounded-card border border-line bg-panel p-5">
      <h3 class="m-0 mb-1 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_repo_section') }}</h3>
      <p class="m-0 mb-3 text-[11px] leading-relaxed text-muted">{{ t('options_repo_hint') }}</p>
      <div class="flex flex-wrap gap-2">
        <a
          v-for="repo in repos"
          :key="repo.id"
          :data-testid="`repo-${repo.id}`"
          :href="repo.url"
          :title="repo.url"
          class="rounded-control border border-line bg-chip px-3 py-2 text-[11.5px] font-bold text-ink transition-colors hover:border-brand hover:text-brand"
          rel="noopener noreferrer"
          target="_blank"
        >
          {{ repo.label }}
        </a>
      </div>
      <!-- 地址摊出来一份：与 href 同一个值，不是第二份副本（改 repos.ts 两处一起变）。 -->
      <ul class="m-0 mt-2.5 list-none flex flex-col gap-1 p-0">
        <li v-for="repo in repos" :key="`addr-${repo.id}`" class="break-all font-mono text-[10.5px] leading-relaxed text-muted">
          {{ repo.url }}
        </li>
      </ul>
    </section>

    <section class="mb-3.5 rounded-card border border-line bg-panel p-5">
      <h3 class="m-0 mb-3.5 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_official_section') }}</h3>
      <div class="flex flex-wrap items-start gap-5">
        <div class="qr-pad rounded-control">
          <img
            v-if="!broken.official"
            alt=""
            class="block h-auto w-full max-w-[520px]"
            data-testid="qr-img-official"
            :src="qrUrl(QR.official)"
            height="380"
            width="1040"
            @error="markBroken('official')"
          />
          <div v-else class="qr-missing rounded-tight h-[190px] w-full max-w-[520px]" data-testid="qr-missing-official">
            {{ t('options_qr_missing', { file: qrPath(QR.official) }) }}
          </div>
        </div>
        <div class="min-w-0">
          <p class="m-0 mb-1 text-[12px] font-bold">{{ t('options_official_name') }}</p>
          <p class="m-0 text-[11px] leading-relaxed text-muted">{{ t('options_official_hint') }}</p>
        </div>
      </div>
      <!-- 横幅里已经写着"微信搜一搜 / 师兄知道"，所以这里不再叠一份说明；屏幕阅读器需要一个名字 -->
      <p class="sr-only">{{ t('options_qr_alt_official') }}</p>
    </section>

    <section class="rounded-card border border-line bg-panel p-5">
      <h3 class="m-0 mb-3.5 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_sponsor_section') }}</h3>
      <div class="flex flex-wrap items-start gap-5">
        <div>
          <div class="qr-pad rounded-control mb-2.5 w-fit">
            <img
              v-if="!broken.alipay"
              alt=""
              class="block h-[168px] w-[168px] object-contain"
              data-testid="qr-img-alipay"
              :src="qrUrl(QR.alipay)"
              height="418"
              width="420"
              @error="markBroken('alipay')"
            />
            <div v-else class="qr-missing rounded-tight h-[168px] w-[168px]" data-testid="qr-missing-alipay">
              {{ t('options_qr_missing', { file: qrPath(QR.alipay) }) }}
            </div>
          </div>
          <p class="m-0 text-[12px] font-bold">{{ t('options_sponsor_alipay') }}</p>
          <p class="m-0 mt-0.5 text-[11px] leading-relaxed text-muted">{{ t('options_sponsor_hint_alipay') }}</p>
          <p class="sr-only">{{ t('options_qr_alt_alipay') }}</p>
        </div>
        <div>
          <div class="qr-pad rounded-control mb-2.5 w-fit">
            <img
              v-if="!broken.wechatPay"
              alt=""
              class="block h-[168px] w-[168px] object-contain"
              data-testid="qr-img-wechat-pay"
              :src="qrUrl(QR.wechatPay)"
              height="415"
              width="420"
              @error="markBroken('wechatPay')"
            />
            <div v-else class="qr-missing rounded-tight h-[168px] w-[168px]" data-testid="qr-missing-wechat-pay">
              {{ t('options_qr_missing', { file: qrPath(QR.wechatPay) }) }}
            </div>
          </div>
          <p class="m-0 text-[12px] font-bold">{{ t('options_sponsor_wechat') }}</p>
          <p class="m-0 mt-0.5 text-[11px] leading-relaxed text-muted">{{ t('options_sponsor_hint_wechat') }}</p>
          <p class="sr-only">{{ t('options_qr_alt_wechat') }}</p>
        </div>
      </div>
      <p class="m-0 mt-3.5 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        {{ t('options_sponsor_note') }}
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 这里的变量名一律用 `--tn-*` 而不是 `--color-*`，圆角则一律走工具类而不是 `var(--radius-*)`：
   `shitab.css` 里那两份都写在 `@theme inline` 块里，而 Tailwind v4 对 `inline` 的处置是把值
   直接写进工具类、**不产出自定义属性**（实测：构建产物里搜得到 `--tn-line:#e8ebef`，
   搜不到 `--color-line` 也搜不到 `--radius-control`）。写 `var(--color-line)` 不会报错，
   只会静默解析成空值 ⇒ 边框与圆角一起消失。所以圆角落在模板的 `rounded-control` / `rounded-tight` 上。 */

/* 白底垫：暗色主题下也保持白，理由见文件头第 1 条。这是刻意的例外，不是漏网的魔法数。 */
.qr-pad {
  background: #fff;
  border: 1px solid var(--tn-line);
  padding: 9px;
  line-height: 0;
}

/* 缺图占位：虚线框 + 一句话，尺寸与真图一致，所以不会出现"图一到就整块往下跳"。 */
.qr-missing {
  border: 1px dashed var(--tn-line-strong);
  color: var(--tn-muted);
  display: grid;
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 8px;
  place-items: center;
  text-align: center;
}
</style>
