import { messages, type Locale } from '../shared/messages';

export function createNodePrompt(node: { id: string; name: string }, locale: Locale = 'en'): string {
  const name = node.name.replace(/\s+/g, ' ').trim() || (locale === 'zh' ? '未命名节点' : 'Untitled node');
  return messages(locale).promptTemplate(name, node.id);
}
