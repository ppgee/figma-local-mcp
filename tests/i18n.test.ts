import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../src/plugin/i18n';

describe('resolveLocale', () => {
  it('follows the environment language when no override is set', () => {
    expect(resolveLocale('zh-CN', null)).toBe('zh');
    expect(resolveLocale('zh-Hant-TW', null)).toBe('zh');
    expect(resolveLocale('ZH', null)).toBe('zh');
    expect(resolveLocale('en-US', null)).toBe('en');
    expect(resolveLocale('ja-JP', null)).toBe('en');
  });

  it('falls back to English for unknown or missing environments', () => {
    expect(resolveLocale(undefined, null)).toBe('en');
    expect(resolveLocale('', null)).toBe('en');
  });

  it('gives the explicit override precedence', () => {
    expect(resolveLocale('zh-CN', 'en')).toBe('en');
    expect(resolveLocale('en-US', 'zh')).toBe('zh');
  });

  it('ignores invalid overrides', () => {
    expect(resolveLocale('zh-CN', 'fr')).toBe('zh');
    expect(resolveLocale('en-US', 'jp')).toBe('en');
    expect(resolveLocale('zh-CN', '')).toBe('zh');
  });
});
