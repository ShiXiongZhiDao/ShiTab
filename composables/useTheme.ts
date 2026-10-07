import { onScopeDispose, ref } from 'vue';
import { resolveIsDark } from '@/core/domain/settings';
import { storagePort } from '@/shared/services';
import type { Theme } from '@/shared/types';

/**
 * 主题。真相在 Settings 里（storage），这里只负责把它投影到 <html class="dark">，
 * 并在另一个 surface 改了设置时跟着变（既有约定 的 watch 同步）。
 */
export function useTheme() {
  const theme = ref<Theme>('system');
  const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;

  function apply(): void {
    document.documentElement.classList.toggle('dark', resolveIsDark(theme.value, media?.matches === true));
  }

  function onSystemChange(): void {
    if (theme.value === 'system') apply();
  }

  let stop: (() => void) | undefined;

  async function init(): Promise<void> {
    theme.value = (await storagePort.getSettings()).theme;
    apply();
    stop = storagePort.watchSettings((settings) => {
      theme.value = settings.theme;
      apply();
    });
    media?.addEventListener('change', onSystemChange);
  }

  async function set(next: Theme): Promise<void> {
    theme.value = next;
    apply();
    const current = await storagePort.getSettings();
    await storagePort.setSettings({ ...current, theme: next });
  }

  /** 顶部 ☾ 按钮：system -> light -> dark -> system。 */
  async function cycle(): Promise<void> {
    const order: Theme[] = ['system', 'light', 'dark'];
    await set(order[(order.indexOf(theme.value) + 1) % order.length] ?? 'system');
  }

  onScopeDispose(() => {
    stop?.();
    media?.removeEventListener('change', onSystemChange);
  });

  return { theme, init, set, cycle };
}
