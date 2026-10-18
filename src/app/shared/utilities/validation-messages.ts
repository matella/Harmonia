import type { ValidationCode } from '../../core/domain/validation';
import type { AppTranslator } from '../../core/i18n/duration-format';

/** Field-specific wording for a validation code. */
export function validationMessage(
  t: AppTranslator,
  code: ValidationCode | undefined,
  field?: 'title' | 'date' | 'startDate' | 'reminders',
): string | null {
  switch (code) {
    case undefined:
      return null;
    case 'required':
      if (field === 'title') return t.t('validation.titleRequired');
      if (field === 'date' || field === 'startDate') return t.t('validation.dateRequired');
      if (field === 'reminders') return t.t('validation.remindersRequired');
      return t.t('validation.required');
    case 'invalidDate':
      return t.t('validation.invalidDate');
    case 'futureDate':
      return t.t('validation.futureStart');
    case 'invalidTime':
      return t.t('validation.invalidTime');
    case 'invalidTimeZone':
      return t.t('validation.invalidTimeZone');
    case 'tooLong':
      return t.t('validation.tooLong');
    case 'invalidOffset':
      return t.t('validation.invalidOffset');
    case 'duplicateOffset':
      return t.t('validation.duplicateOffset');
    case 'invalidCategory':
      return t.t('validation.invalidCategory');
    case 'bodyOrPhotoRequired':
      return t.t('validation.bodyOrPhoto');
  }
}
