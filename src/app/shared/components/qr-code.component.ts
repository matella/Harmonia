import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { encode } from 'uqr';

/**
 * A QR code drawn as one SVG path from the module grid (no injected markup). Dark modules
 * on a light quiet zone, whatever the theme, so every camera can read it.
 */
@Component({
  selector: 'hm-qr-code',
  template: `
    <svg
      class="qr"
      [attr.viewBox]="'0 0 ' + code().size + ' ' + code().size"
      role="img"
      [attr.aria-label]="label()"
      shape-rendering="crispEdges"
    >
      <rect [attr.width]="code().size" [attr.height]="code().size" fill="#ffffff" />
      <path [attr.d]="code().path" fill="#1a1416" />
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    .qr {
      display: block;
      width: min(100%, 280px);
      height: auto;
      border-radius: var(--hm-radius-card);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrCodeComponent {
  readonly value = input.required<string>();
  readonly label = input.required<string>();

  protected readonly code = computed(() => {
    const { data } = encode(this.value(), { ecc: 'M', border: 4 });
    let path = '';
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: data.length, path };
  });
}
