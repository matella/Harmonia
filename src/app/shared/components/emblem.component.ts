import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The Harmonia mark: two rings that pass through each other — two lives joined, with
 * the shared lens between them. Decorative unless a label is given.
 */
@Component({
  selector: 'hm-emblem',
  template: `
    <svg
      viewBox="0 0 48 48"
      [attr.width]="size()"
      [attr.height]="size()"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label() || null"
      [attr.aria-hidden]="label() ? null : 'true'"
      focusable="false"
    >
      <circle class="ring ring--a" cx="19" cy="24" r="11" />
      <circle class="ring ring--b" cx="29" cy="24" r="11" />
      <!-- Redraw most of the left ring's inner arc on top: over at the top crossing,
           under at the bottom one, so the rings interlock. -->
      <path class="ring ring--a" d="M24 14.2 A11 11 0 0 1 24 33.8" stroke-dasharray="19 40" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      color: var(--hm-berry);
    }
    .ring {
      fill: none;
      stroke-width: 2.4;
      stroke-linecap: round;
    }
    .ring--a {
      stroke: currentColor;
    }
    .ring--b {
      stroke: var(--hm-rose);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmblemComponent {
  readonly size = input(32);
  readonly label = input<string>('');
}
