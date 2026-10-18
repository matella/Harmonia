import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular';

import { EmblemComponent } from './emblem.component';

/** A calm invitation to act when a list has nothing in it yet. */
@Component({
  selector: 'hm-empty-state',
  imports: [IonIcon, EmblemComponent],
  template: `
    <div class="empty" [class.empty--compact]="compact()">
      @if (icon()) {
        <span class="mark" aria-hidden="true"><ion-icon [name]="icon()" /></span>
      } @else {
        <hm-emblem [size]="compact() ? 32 : 44" />
      }
      <h2 class="title">{{ title() }}</h2>
      @if (body()) {
        <p class="body">{{ body() }}</p>
      }
      @if (actionLabel()) {
        <button type="button" class="hm-btn" (click)="action.emit()">
          <ion-icon name="add" aria-hidden="true" />{{ actionLabel() }}
        </button>
      }
    </div>
  `,
  styles: `
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: var(--hm-space-3);
      padding: var(--hm-space-10) var(--hm-space-4);
    }
    .empty--compact {
      padding: var(--hm-space-6) var(--hm-space-2);
      align-items: flex-start;
      text-align: start;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--hm-surface-muted);
      color: var(--hm-berry);
      font-size: 26px;
    }
    .title {
      font-size: var(--hm-text-xl);
      margin-top: var(--hm-space-2);
    }
    .body {
      max-width: 34ch;
      color: var(--hm-ink-muted);
    }
    .hm-btn {
      margin-top: var(--hm-space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly body = input('');
  readonly icon = input('');
  readonly actionLabel = input('');
  readonly compact = input(false);
  readonly action = output<void>();
}
