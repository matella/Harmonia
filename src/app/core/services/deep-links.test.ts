import { describe, expect, it } from 'vitest';

import { routeForLink } from './deep-links';

describe('routeForLink', () => {
  it('maps widget and notification links to routes', () => {
    expect(routeForLink('harmonia://home')).toBe('/tabs/home');
    expect(routeForLink('harmonia://dates')).toBe('/tabs/dates');
    expect(routeForLink('harmonia://counter')).toBe('/counter');
    expect(routeForLink('harmonia://milestone/6f1c2a7e-0d7b-4c51-9a55-0b8f6a1d2e3f')).toBe(
      '/milestone/6f1c2a7e-0d7b-4c51-9a55-0b8f6a1d2e3f',
    );
    expect(routeForLink('/milestone/abc-123')).toBe('/milestone/abc-123');
    expect(routeForLink('harmonia://home/?source=widget')).toBe('/tabs/home');
  });

  it('falls back to Home for unknown or malformed links', () => {
    expect(routeForLink(undefined)).toBe('/tabs/home');
    expect(routeForLink('harmonia://settings/privacy')).toBe('/tabs/home');
    expect(routeForLink('https://example.com/milestone/1')).toBe('/tabs/home');
    expect(routeForLink('harmonia://milestone/../../etc')).toBe('/tabs/home');
    expect(routeForLink('harmonia://milestone/a b')).toBe('/tabs/home');
  });
});
