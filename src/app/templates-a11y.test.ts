import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every template in the app: `.html` files and inline templates in `.ts` files. */
function templates(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return templates(path);
    if (!/\.(html|ts)$/.test(entry.name) || /\.(spec|test)\.ts$/.test(entry.name)) return [];
    return [{ file: path, text: readFileSync(path, 'utf-8') }];
  });
}

const appTemplates = () =>
  templates(join(__dirname, 'features')).concat(templates(join(__dirname, 'shared')));

describe('templates', () => {
  // The switch inside ion-toggle sits in its shadow DOM, where an outside <label for> can't
  // reach it, so TalkBack and VoiceOver read it without a name (found on the emulator).
  it('give every ion-toggle an aria-label', () => {
    const unnamed = appTemplates().flatMap(({ file, text }) =>
      [...text.matchAll(/<ion-toggle\b[^>]*>/g)]
        .filter((match) => !/aria-label/.test(match[0]))
        .map((match) => `${file}: ${match[0].slice(0, 60)}`),
    );
    expect(unnamed).toEqual([]);
  });

  // Ionic's title is a plain element; screen reader users jump between headings.
  it('mark every page title as the page heading', () => {
    const plain = appTemplates().flatMap(({ file, text }) =>
      [...text.matchAll(/<ion-title\b[^>]*>/g)]
        .filter((match) => !/role="heading"/.test(match[0]))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(plain).toEqual([]);
  });
});
