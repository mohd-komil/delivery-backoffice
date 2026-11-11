export const localeNames = {
  en: 'English',
  uz: 'O‘zbekcha',
  it: 'Italiano',
  ru: 'Русский',
} as const;

export type Locale = keyof typeof localeNames;
export const defaultLocale: Locale = 'en';
export const localeCookie = 'delivery-backoffice-language';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(localeNames, value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale;
}

const formatLocales: Record<Locale, string> = {
  en: 'en-GB',
  uz: 'uz-Latn-UZ',
  it: 'it-IT',
  ru: 'ru-RU',
};

export function formatLocale(locale: string): string {
  return formatLocales[resolveLocale(locale)];
}
