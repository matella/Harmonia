import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';

import { MediaStorageService } from '../../core/platform/media-storage.service';
import { EmblemComponent } from './emblem.component';

/**
 * Elegant frame for a private photo (or a local preview URL). Without a photo it shows
 * the brand emblem on a soft panel, so screens look complete either way.
 * Shapes: "arch" (hero), "round" (avatar), "soft" (rounded rectangle).
 */
@Component({
  selector: 'hm-photo-frame',
  imports: [EmblemComponent],
  template: `
    <div
      [class]="'frame frame--' + shape()"
      [class.frame--natural]="ratio() === 'auto'"
      [style.aspect-ratio]="ratio() === 'auto' ? null : ratio()"
    >
      @if (url(); as src) {
        <img [src]="src" [alt]="alt()" loading="lazy" decoding="async" />
      } @else {
        <div class="placeholder" aria-hidden="true">
          <hm-emblem [size]="emblemSize()" />
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .frame {
      position: relative;
      overflow: hidden;
      background: var(--hm-surface-muted);
      width: 100%;
    }
    .frame--arch {
      border-radius: 999px 999px var(--hm-radius-card) var(--hm-radius-card);
    }
    .frame--round {
      border-radius: 50%;
    }
    .frame--soft {
      border-radius: var(--hm-radius-control);
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .frame--natural {
      min-height: 160px;
    }
    .frame--natural img {
      height: auto;
    }
    .placeholder {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background:
        radial-gradient(120% 90% at 50% 100%, color-mix(in srgb, var(--hm-rose-soft) 55%, transparent), transparent 70%),
        var(--hm-surface-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoFrameComponent {
  private readonly media = inject(MediaStorageService);

  /** App-private media path. */
  readonly path = input<string | null>(null);
  /** Direct URL (e.g. an object URL for a photo that is not saved yet). */
  readonly src = input<string | null>(null);
  readonly alt = input('');
  readonly shape = input<'arch' | 'round' | 'soft'>('soft');
  readonly ratio = input('1 / 1');
  readonly emblemSize = input(40);

  protected readonly url = signal<string | null>(null);

  constructor() {
    effect(() => {
      const direct = this.src();
      const path = this.path();
      if (direct) {
        this.url.set(direct);
        return;
      }
      this.url.set(null);
      if (path) void this.media.displayUrl(path).then((u) => this.path() === path && this.url.set(u));
    });
  }
}
