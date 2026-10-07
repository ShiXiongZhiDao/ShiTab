/**
 * 开源仓库地址（既有约定 追加）。
 *
 * 单独一个文件、单独一份配置，是因为**这一条是要印在产物里的地址**：
 * `url` 留空的条目在界面上整块不出现（`AboutPanel` 走 `filledRepos()`），
 * 所以"填"这个动作等于向用户承诺一个链接得是真的。
 *
 * 填之前跑过探测，结果如实记着（判据要自己跑一次，别信"应该就是这个"）：
 * - `https://gitee.com/ShiXiongZhiDao/ShiTab` ⇒ HTTP 200，`git ls-remote` 成功但**0 条 ref**
 *   （仓库存在，当时还没推过内容）；
 * - `https://github.com/ShiXiongZhiDao/ShiTab` ⇒ 当时 **HTTP 404**。据此把它留空过一轮，
 *   后来按产品决定两条都显示 ⇒ 可达性归真机判（`既有约定` §6b O15），
 *   代码这边只保证"两处渲染同一个值"。
 */
export type RepoLink = {
  /** 稳定标识，只用来当 v-for 的 key。 */
  id: 'github' | 'gitee';
  /** 屏幕上显示的名字，是品牌名所以不进 i18n 目录。 */
  label: string;
  /** 公开仓库地址；留空 = 这一条不显示。 */
  url: string;
};

/** 顺序是**主仓在前**：Gitee 是 issue 提的那一个，中文用户也从这里进。 */
export const REPOS: readonly RepoLink[] = [
  { id: 'gitee', label: 'Gitee', url: 'https://gitee.com/ShiXiongZhiDao/ShiTab' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/ShiXiongZhiDao/ShiTab' },
];

/** 只把填好的那条交给界面。 */
export function filledRepos(repos: readonly RepoLink[] = REPOS): RepoLink[] {
  return repos.filter((repo) => repo.url.trim() !== '');
}
