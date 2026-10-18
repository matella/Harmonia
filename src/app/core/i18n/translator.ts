import type { Temporal } from '../domain/temporal';

/** A plural message keyed by CLDR plural category; `other` is mandatory. */
export interface PluralMessage {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | PluralMessage;
export type MessageCatalog = Record<string, Message>;

export type StringKeys<C extends MessageCatalog> = {
  [K in keyof C]: C[K] extends string ? K : never;
}[keyof C] &
  string;
export type PluralKeys<C extends MessageCatalog> = {
  [K in keyof C]: C[K] extends string ? never : K;
}[keyof C] &
  string;

export type Params = Record<string, string | number>;

/** The shape every translation must match: same keys, strings stay strings, plurals stay plurals. */
export type CatalogShape<C extends MessageCatalog> = {
  readonly [K in keyof C]: C[K] extends string ? string : PluralMessage;
};

export type DateStyle = 'full' | 'long' | 'medium' | 'monthDay' | 'monthYear' | 'year' | 'weekdayDay';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  monthDay: { day: 'numeric', month: 'long' },
  monthYear: { month: 'long', year: 'numeric' },
  year: { year: 'numeric' },
  weekdayDay: { weekday: 'long', day: 'numeric', month: 'long' },
};

/**
 * Framework-free message lookup with ICU-style plural selection and locale-aware
 * formatting. Whole sentences live in the catalog (never concatenated fragments) so
 * translations can reorder words freely.
 */
export class Translator<C extends MessageCatalog> {
  private catalog!: C;
  private currentLocale!: string;
  private pluralRules!: Intl.PluralRules;
  private numberFormat!: Intl.NumberFormat;
  private readonly dateFormats = new Map<DateStyle, Intl.DateTimeFormat>();
  private timeFormat!: Intl.DateTimeFormat;

  constructor(catalog: C, locale: string) {
    this.use(catalog, locale);
  }

  get locale(): string {
    return this.currentLocale;
  }

  /**
   * Switches catalog and formatting locale in place, so every holder of this instance
   * follows. Done once at startup, before anything renders (a language change reloads).
   */
  use(catalog: C, locale: string): void {
    this.catalog = catalog;
    this.currentLocale = locale;
    this.pluralRules = new Intl.PluralRules(locale);
    this.numberFormat = new Intl.NumberFormat(locale);
    this.timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    this.dateFormats.clear();
  }

  t(key: StringKeys<C>, params?: Params): string {
    const message = this.catalog[key];
    return interpolate(typeof message === 'string' ? message : message.other, params, this.numberFormat);
  }

  plural(key: PluralKeys<C>, count: number, params?: Params): string {
    const message = this.catalog[key] as PluralMessage;
    const category = count === 0 && message.zero ? 'zero' : this.pluralRules.select(count);
    const template = message[category] ?? message.other;
    return interpolate(template, { ...params, count }, this.numberFormat);
  }

  formatNumber(value: number): string {
    return this.numberFormat.format(value);
  }

  /**
   * Formats a calendar date without any time-zone conversion: the date is rendered
   * as a UTC midnight and formatted in UTC, so it can never shift by a day.
   */
  formatDate(date: Temporal.PlainDate, style: DateStyle = 'long'): string {
    let format = this.dateFormats.get(style);
    if (!format) {
      format = new Intl.DateTimeFormat(this.locale, { ...DATE_OPTIONS[style], timeZone: 'UTC' });
      this.dateFormats.set(style, format);
    }
    return format.format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
  }

  /** Formats an `HH:mm` wall-clock time in the user's locale. */
  formatTime(localTime: string): string {
    const [hours, minutes] = localTime.split(':').map(Number);
    return this.timeFormat.format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
  }
}

function interpolate(template: string, params: Params | undefined, numbers: Intl.NumberFormat): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? numbers.format(value) : value;
  });
}
