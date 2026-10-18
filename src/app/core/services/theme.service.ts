import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';

import { AppStore } from '../state/app-store';

/**
 * Applies the theme preference (system/light/dark) and accent preset to <html>.
 * Dark mode uses `.hm-dark` (our tokens) plus `.ion-palette-dark` (Ionic internals).
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly store = inject(AppStore);
  private readonly systemDark = signal(false);

  constructor() {
    const query = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (query) {
      this.systemDark.set(query.matches);
      query.addEventListener('change', (event) => this.systemDark.set(event.matches));
    }
    effect(() => {
      const { theme, accent } = this.store.settings();
      const dark = theme === 'dark' || (theme === 'system' && this.systemDark());
      const root = this.document.documentElement;
      root.classList.toggle('hm-dark', dark);
      root.classList.toggle('ion-palette-dark', dark);
      root.dataset['accent'] = accent;
      root.style.colorScheme = dark ? 'dark' : 'light';
      this.document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171315' : '#F8F3ED');
    });
  }

  isDark(): boolean {
    return this.document.documentElement.classList.contains('hm-dark');
  }
}
