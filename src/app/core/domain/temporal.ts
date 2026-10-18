/**
 * Single import point for the Temporal API. The polyfill is used explicitly (rather
 * than a global shim) so behaviour is identical in every WebView and in Node tests.
 * See docs/DATE_AND_TIME_RULES.md.
 */
export { Temporal } from 'temporal-polyfill';
