import { Pipe, type PipeTransform, inject } from '@angular/core';

import { toPlainDate } from '../../core/domain/local-date';
import type { MilestoneCategory } from '../../core/domain/models';
import type { Temporal } from '../../core/domain/temporal';
import { formatRelativeDays } from '../../core/i18n/duration-format';
import type { EnCatalog } from '../../core/i18n/messages.en';
import type { DateStyle, Params, PluralKeys, StringKeys } from '../../core/i18n/translator';
import { I18nService } from '../../core/services/i18n.service';

export type MessageKey = StringKeys<EnCatalog>;
export type PluralKey = PluralKeys<EnCatalog>;

/** `{{ 'home.story' | t }}` — catalog lookup with optional parameters. */
@Pipe({ name: 't' })
export class TranslatePipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(key: MessageKey, params?: Params): string {
    return this.t.t(key, params);
  }
}

/** `{{ 'dates.showPast' | tp: count }}` — plural selection. */
@Pipe({ name: 'tp' })
export class TranslatePluralPipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(key: PluralKey, count: number, params?: Params): string {
    return this.t.plural(key, count, params);
  }
}

/** Formats an ISO calendar date or PlainDate without any time-zone shift. */
@Pipe({ name: 'hmDate' })
export class LocalDatePipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(value: string | Temporal.PlainDate | null | undefined, style: DateStyle = 'long'): string {
    if (!value) return '';
    return this.t.formatDate(typeof value === 'string' ? toPlainDate(value) : value, style);
  }
}

@Pipe({ name: 'hmTime' })
export class LocalTimePipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(value: string | null | undefined): string {
    return value ? this.t.formatTime(value) : '';
  }
}

@Pipe({ name: 'relativeDays' })
export class RelativeDaysPipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(days: number): string {
    return formatRelativeDays(this.t, days);
  }
}

/** "On the day" / "3 days before". */
@Pipe({ name: 'offsetLabel' })
export class OffsetLabelPipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(offsetDays: number): string {
    return offsetDays === 0 ? this.t.t('reminder.onTheDay') : this.t.plural('reminder.daysBefore', offsetDays);
  }
}

/** Localized name of a milestone category. */
@Pipe({ name: 'categoryLabel' })
export class CategoryLabelPipe implements PipeTransform {
  private readonly t = inject(I18nService).translator;
  transform(category: MilestoneCategory): string {
    return this.t.t(`category.${category}`);
  }
}

export const I18N_PIPES = [
  CategoryLabelPipe,
  TranslatePipe,
  TranslatePluralPipe,
  LocalDatePipe,
  LocalTimePipe,
  RelativeDaysPipe,
  OffsetLabelPipe,
] as const;
