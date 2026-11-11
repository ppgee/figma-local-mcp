export type UiLocale = 'zh' | 'en';

/**
 * Resolve the plugin UI locale: an explicit override (from clientStorage or a
 * user toggle) wins; otherwise follow the environment language.
 */
export function resolveLocale(navigatorLanguage: string | undefined, override: string | null): UiLocale {
  if (override === 'zh' || override === 'en') return override;
  return typeof navigatorLanguage === 'string' && navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
