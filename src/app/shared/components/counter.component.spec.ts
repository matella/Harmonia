import { ComponentFixture, TestBed } from '@angular/core/testing';

import { fixedClock } from '../../core/domain/clock';
import type { CounterFormat, RelationshipProfile } from '../../core/domain/models';
import { computeRelationshipCounter } from '../../core/domain/relationship-duration';
import { CounterComponent } from './counter.component';

const profile: Pick<RelationshipProfile, 'startDate' | 'startTime' | 'startTimeZoneId' | 'calendarTimeZoneId'> = {
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
};

describe('CounterComponent', () => {
  let fixture: ComponentFixture<CounterComponent>;

  function render(today: string, format: CounterFormat = 'calendar') {
    fixture.componentRef.setInput('counter', computeRelationshipCounter(profile, fixedClock(`${today}T10:00:00Z`, 'Europe/Brussels')));
    fixture.componentRef.setInput('format', format);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    fixture = TestBed.createComponent(CounterComponent);
  });

  it('shows the calendar duration with large numerals and unit words', () => {
    const el = render('2026-10-18');
    const parts = [...el.querySelectorAll('.part')].map(
      (p) => `${p.querySelector('.value')?.textContent?.trim()} ${p.querySelector('.unit')?.textContent?.trim()}`,
    );
    expect(parts).toEqual(['2 years', '4 months', '4 days']);
    expect(el.querySelector('.secondary')?.textContent?.trim()).toBe('856 days together');
  });

  it('shows total days and weeks formats', () => {
    let el = render('2026-10-18', 'days');
    expect(el.querySelector('.value')?.textContent?.trim()).toBe('856');
    el = render('2026-10-18', 'weeks');
    expect([...el.querySelectorAll('.value')].map((v) => v.textContent?.trim())).toEqual(['122', '2']);
  });

  it('greets day zero without fake numbers', () => {
    const el = render('2024-06-14');
    expect(el.querySelector('.figure--first')?.textContent?.trim()).toBe('Your first day together');
    expect(el.querySelector('.value')).toBeNull();
  });

  it('exposes a complete sentence to screen readers', () => {
    const el = render('2026-10-18');
    expect(el.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Together for 2 years, 4 months, 4 days. 856 days together. Change how time is shown',
    );
  });

  it('asks to cycle formats when tapped', () => {
    const el = render('2026-10-18');
    let cycled = 0;
    fixture.componentInstance.cycle.subscribe(() => cycled++);
    el.querySelector('button')?.click();
    expect(cycled).toBe(1);
  });
});
