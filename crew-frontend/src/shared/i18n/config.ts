export const localeNames = {
  en: 'English',
  it: 'Italiano',
  ru: 'Русский',
  uz: 'O‘zbekcha',
} as const;

export type Locale = keyof typeof localeNames;
export const localeCookie = 'crew_locale';
export const crewTimeZone = 'Europe/Rome';

const formatLocales: Record<Locale, string> = {
  en: 'en-GB',
  it: 'it-IT',
  ru: 'ru-RU',
  uz: 'uz-Latn-UZ',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(localeNames, value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : 'en';
}

export function formatLocale(value: unknown) {
  return formatLocales[resolveLocale(value)];
}
