import { createTranslator } from 'next-intl';
import { resolveLocale } from './config';
import * as messages from './messages/common';

export function commonTranslations(value: string) {
  const locale = resolveLocale(value);
  return createTranslator({ locale, messages: messages[locale] });
}
