/**
 * 工作台右栏当前是否显示回收站（Q6 签字的「左栏底部一个回收站入口」）。
 *
 * 为什么是一个共享 ref 而不是 `CategoryFilter` 的第四个成员：
 * 加进那个判别联合要同轮改完 `matchesFilter`、`filterLabel`、会话分页 sentinel、
 * 以及"系统两行不可拖 / 不是排序落点"那条判据 —— 少改一处不会编译错，
 * 只会让右栏在选中回收站时仍然列出会话。这里换成一个正交的视图开关，
 * 那四处一行都不用动，拖拽判据也天然管不到它（它不是分类行）。
 *
 * 它是**视图状态**不是数据：刷新工作台就回到会话列表，和"上次选中的分类"同理不该持久化。
 */

import { ref } from 'vue';

export const showTrash = ref(false);

export function toggleTrashView(): void {
  showTrash.value = !showTrash.value;
}

/** 任何一次"选分类 / 搜索 / 点会话"都要把视图交还给会话列表，否则开关会卡住主路径。 */
export function leaveTrashView(): void {
  showTrash.value = false;
}
