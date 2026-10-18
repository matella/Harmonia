import { Injectable } from '@angular/core';

import type { AppTranslator } from '../i18n/duration-format';
import { EN } from '../i18n/messages.en';
import { Translator } from '../i18n/translator';

/**
 * English copy with the device's regional formatting conventions (e.g. "14 June 2024"
 * in Europe, "June 14, 2024" in the US). When more catalogs exist, pick the catalog by
 * language here.
 */
export function resolveFormattingLocale(deviceLocale: string | undefined): string {
  try {
    const region = deviceLocale ? new Intl.Locale(deviceLocale).maximize().region : undefined;
    const candidate = region ? `en-${region}` : 'en';
    return Intl.DateTimeFormat.supportedLocalesOf(candidate).length > 0 ? candidate : 'en';
  } catch {
    return 'en';
  }
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly translator: AppTranslator = new Translator(
    EN,
    resolveFormattingLocale(typeof navigator !== 'undefined' ? navigator.language : undefined),
  );
}
