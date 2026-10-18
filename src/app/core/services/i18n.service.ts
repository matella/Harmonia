import { Injectable, signal } from '@angular/core';

import type { LanguagePreference } from '../domain/models';
import type { AppTranslator } from '../i18n/duration-format';
import { EN, type EnCatalog } from '../i18n/messages.en';
import { FR } from '../i18n/messages.fr';
import { NL } from '../i18n/messages.nl';
import { Translator } from '../i18n/translator';

export const CATALOGS: Record<SupportedLanguage, EnCatalog> = { en: EN, fr: FR, nl: NL };
export type SupportedLanguage = 'en' | 'fr' | 'nl';

function deviceLocale(): string | undefined {
  return typeof navigator !== 'undefined' ? navigator.language : undefined;
}

/** The catalog to use: the user's choice, else the device language when supported, else English. */
export function resolveLanguage(preference: LanguagePreference, device: string | undefined): SupportedLanguage {
  if (preference !== 'system') return preference;
  try {
    const language = device ? new Intl.Locale(device).language : '';
    return language === 'fr' || language === 'nl' ? language : 'en';
  } catch {
    return 'en';
  }
}

/**
 * The language plus the device's region, so formats follow local conventions
 * ("14 June 2024" in Europe, "June 14, 2024" in the US, "14 juin 2024" in Belgium).
 */
export function resolveFormattingLocale(language: SupportedLanguage, device: string | undefined): string {
  try {
    const region = device ? new Intl.Locale(device).maximize().region : undefined;
    const candidate = region ? `${language}-${region}` : language;
    return Intl.DateTimeFormat.supportedLocalesOf(candidate).length > 0 ? candidate : language;
  } catch {
    return language;
  }
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  /** One shared instance; `apply` switches it in place before the UI renders. */
  readonly translator: AppTranslator = new Translator<EnCatalog>(EN, 'en');
  readonly language = signal<SupportedLanguage>('en');

  constructor() {
    // Device language until settings load, so the loading and startup-error screens match.
    this.apply('system');
  }

  apply(preference: LanguagePreference): void {
    const device = deviceLocale();
    const language = resolveLanguage(preference, device);
    this.translator.use(CATALOGS[language], resolveFormattingLocale(language, device));
    this.language.set(language);
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }
}
