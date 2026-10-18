<script lang="ts" setup>
/**
 * 「关于」分区（既有约定，二维码取图方式经 既有约定 改过）。
 *
 * 里面三件事：这个扩展是什么（品牌 + 版本 + 一句话）、它能碰到什么（权限说明），
 * 以及怎么支持它（公众号 + 支付宝 + 微信三张码）。
 *
 * 四条不是顺手做出的选择，别在下次"再简化一点"时弄丢：
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
 * 3. **图位尺寸是写死的，图没到之前就占好位。**`width`/`height` 属性给的是图片真实像素，
 *    配合工具类让浏览器在解码前就把框撑起来；图读不到时换成**同尺寸的虚线占位**，
 *    不能是浏览器那个裂图图标 —— 照 `TabRow.vue` 对 favicon 的处置，布局不跳。
 *
 * 4. **三张码不在扩展包里，走网络取。**三张共 210 KB，占 chrome 产物 zip 的
 *    54.8%，而它们只有打开这一屏才看得见。代价如实记着：**断网或资产仓不可达时，这一屏
 *    没有图** —— 所以失败必须是看得见的（一条错误提示 + 重试），不能是"白板一块"。
 */
import { computed, onMounted, ref } from 'vue';
import PaneHeader from '@/components/PaneHeader.vue';
import { t } from '@/shared/i18n';
import { filledRepos, type RepoLink } from '@/shared/repos';
import {
  QR_FILES,
  chooseQrMirrorCached,
  qrUrls,
  resetQrMirrorCache,
  type QrField,
  type QrMirror,
} from '@/shared/qr-mirror';
import { useQrImage } from '@/composables/useQrImage';

/**
 * 选源结果。`null` = 两个源都没探通（或还没探完）。
 *
 * 注意 **`null` 不等于"没图"**：`qrUrls(null, …)` 会按原序给出两个候选，
 * 图照样一张张试。探活失败只说明"探测那一次没通"，不代表现在一定不通 ——
 * 所以下面那条提示是**提前告知**，不是"宣判死刑"。
 */
const mirror = ref<QrMirror | null>(null);
/** 探活是不是已经跑完（用来决定要不要显示那条提示，避免刚打开就闪一下红字）。 */
const probeDone = ref(false);

const official = useQrImage(() => qrUrls(mirror.value, 'wechatOfficial'));
const alipay = useQrImage(() => qrUrls(mirror.value, 'alipay'));
const wechatPay = useQrImage(() => qrUrls(mirror.value, 'wechatPay'));

/**
 * 那条提示什么时候出现：**探活没选出源，而且一张图都没真的出来**。
 *
 * 两个条件缺一不可 ——
 * - 只满足前者就提示，会在"探测那一次网络抖了一下、图其实全加载出来了"时说谎；
 * - 只满足后者（三张全挂）时，各自的位置上已经有占位了，再叠一条提示是重复。
 *
 * 单张挂（某一张 404）不牵连整屏：那个位置自己有占位。
 */
const showOfflineHint = computed(
  () =>
    probeDone.value &&
    mirror.value === null &&
    !official.loaded.value &&
    !alipay.loaded.value &&
    !wechatPay.loaded.value,
);

async function probe(): Promise<void> {
  probeDone.value = false;
  mirror.value = await chooseQrMirrorCached();
  probeDone.value = true;
}

/** 重试：作废选源缓存再探一次，三张图的回落也从头开始（由 `useQrImage` 的 watch 兜住）。 */
async function retry(): Promise<void> {
  resetQrMirrorCache();
  await probe();
}

onMounted(probe);

/** 版本号读 manifest，不在这里手写第二遍（既有约定；`options/App.vue` 里那条守卫用例盯着同一件事）。 */
const version = `v${browser.runtime.getManifest().version}`;

/**
 * 仓库列表默认取 `shared/repos.ts` 里填好的那些。
 * 这颗 prop 只为测试存在（照 `SyncPanel` 的 `webdav?` 那个先例）：
 * 不注入的话，"哪天他把地址填进去，这张卡真的会亮"这一半**没有任何东西能证明** ——
 * 只测"空列表时不渲染"是不够的。
 */
const props = withDefaults(defineProps<{ repos?: RepoLink[] }>(), { repos: () => filledRepos() });

/** 占位里说的那个文件名，由 `QR_FILES` 派生，不是又抄一遍字符串。 */
function fileName(field: QrField): string {
  return QR_FILES[field];
}
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

    <!--
      图走网络取 ⇒ 有可能一张都拿不到。探活跑完却没选出源时把话说在前面，
      并给一颗重试 —— 静默地白板一块是这仓最不能接受的那类失败。
      只在"真的拿不到"时出现：单张 404 由下面各自的占位兜住，不该牵连整屏。
    -->
    <section
      v-if="showOfflineHint"
      class="mb-3.5 flex flex-wrap items-center gap-3 rounded-card border border-line bg-panel p-4"
      data-testid="qr-offline-hint"
    >
      <p class="m-0 min-w-0 flex-1 text-[11px] leading-relaxed text-muted">{{ t('options_qr_offline') }}</p>
      <button
        type="button"
        class="shrink-0 rounded-control border border-line bg-chip px-3 py-1.5 text-[11.5px] font-bold text-ink transition-colors hover:border-brand hover:text-brand"
        data-testid="qr-retry"
        @click="retry"
      >
        {{ t('options_qr_retry') }}
      </button>
    </section>

    <section class="mb-3.5 rounded-card border border-line bg-panel p-5">
      <h3 class="m-0 mb-3.5 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_official_section') }}</h3>
      <div class="flex flex-wrap items-start gap-5">
        <div class="qr-pad rounded-control">
          <img
            v-if="!official.exhausted.value"
            alt=""
            class="block h-auto w-full max-w-[520px]"
            data-testid="qr-img-official"
            :src="official.current.value"
            height="380"
            width="1040"
            @error="official.onError"
            @load="official.onLoad"
          />
          <div v-else class="qr-missing rounded-tight h-[190px] w-full max-w-[520px]" data-testid="qr-missing-official">
            {{ t('options_qr_missing', { file: fileName('wechatOfficial') }) }}
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
              v-if="!alipay.exhausted.value"
              alt=""
              class="block h-[168px] w-[168px] object-contain"
              data-testid="qr-img-alipay"
              :src="alipay.current.value"
              height="418"
              width="420"
              @error="alipay.onError"
              @load="alipay.onLoad"
            />
            <div v-else class="qr-missing rounded-tight h-[168px] w-[168px]" data-testid="qr-missing-alipay">
              {{ t('options_qr_missing', { file: fileName('alipay') }) }}
            </div>
          </div>
          <p class="m-0 text-[12px] font-bold">{{ t('options_sponsor_alipay') }}</p>
          <p class="m-0 mt-0.5 text-[11px] leading-relaxed text-muted">{{ t('options_sponsor_hint_alipay') }}</p>
          <p class="sr-only">{{ t('options_qr_alt_alipay') }}</p>
        </div>
        <div>
          <div class="qr-pad rounded-control mb-2.5 w-fit">
            <img
              v-if="!wechatPay.exhausted.value"
              alt=""
              class="block h-[168px] w-[168px] object-contain"
              data-testid="qr-img-wechat-pay"
              :src="wechatPay.current.value"
              height="415"
              width="420"
              @error="wechatPay.onError"
              @load="wechatPay.onLoad"
            />
            <div v-else class="qr-missing rounded-tight h-[168px] w-[168px]" data-testid="qr-missing-wechat-pay">
              {{ t('options_qr_missing', { file: fileName('wechatPay') }) }}
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
