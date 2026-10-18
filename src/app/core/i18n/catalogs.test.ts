import { describe, expect, it } from 'vitest';

import { toPlainDate } from '../domain/local-date';
import { upcomingTogetherMarks } from '../domain/together-milestones';
import { formatCalendarDuration, formatTogetherTitle } from './duration-format';
import { EN, type EnCatalog } from './messages.en';
import { FR } from './messages.fr';
import { NL } from './messages.nl';
import { Translator, type Message } from './translator';

const CATALOGS: Record<string, EnCatalog> = { fr: FR, nl: NL };

function placeholders(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : Object.values(message);
  const names = new Set<string>();
  for (const text of texts) for (const match of (text ?? '').matchAll(/\{(\w+)\}/g)) names.add(match[1]);
  return [...names].sort();
}

describe('translation catalogs', () => {
  for (const [language, catalog] of Object.entries(CATALOGS)) {
    it(`${language} has exactly the English keys`, () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(EN).sort());
    });

    it(`${language} keeps every placeholder and message kind`, () => {
      for (const key of Object.keys(EN) as (keyof typeof EN)[]) {
        const source: Message = EN[key];
        const target: Message = catalog[key];
        expect(typeof target, key).toBe(typeof source);
        expect(placeholders(target), key).toEqual(placeholders(source));
        if (typeof target !== 'string') expect(target.other, key).toBeTruthy();
      }
    });

    it(`${language} has no empty messages`, () => {
      for (const [key, value] of Object.entries(catalog)) {
        const texts = typeof value === 'string' ? [value] : Object.values(value);
        for (const text of texts) expect((text as string).trim().length, key).toBeGreaterThan(0);
      }
    });
  }
});

describe('localized wording', () => {
  const fr = new Translator<EnCatalog>(FR, 'fr-BE');
  const nl = new Translator<EnCatalog>(NL, 'nl-BE');

  it('formats durations and plurals in French and Dutch', () => {
    const duration = { years: 2, months: 4, days: 1 };
    expect(formatCalendarDuration(fr, duration)).toBe('2 ans, 4 mois et 1 jour');
    expect(formatCalendarDuration(nl, duration)).toBe('2 jaar, 4 maanden en 1 dag');
    expect(fr.plural('counter.daysTogether', 856)).toBe('856 jours ensemble');
    expect(nl.plural('counter.daysTogether', 1)).toBe('1 dag samen');
  });

  it('formats dates with the regional conventions of the language', () => {
    expect(fr.formatDate(toPlainDate('2024-06-14'), 'long')).toBe('14 juin 2024');
    expect(nl.formatDate(toPlainDate('2024-06-14'), 'long')).toBe('14 juni 2024');
  });

  it('titles together milestones', () => {
    const marks = upcomingTogetherMarks('2024-06-14', toPlainDate('2026-10-18'), { months: 'key', days: true, skipWholeYears: false }, 2);
    expect(marks.map((m) => formatTogetherTitle(fr, m))).toEqual(['2 ans et 6 mois ensemble', '1\u202f000 jours ensemble']);
    expect(marks.map((m) => formatTogetherTitle(nl, m))).toEqual(['2 jaar en 6 maanden samen', '1.000 dagen samen']);
  });
});
