import { signal, type Signal } from '@angular/core';

/**
 * A photo chosen in a form but not yet saved: keeps the Blob and an object URL for
 * the preview, and revokes the URL when replaced or discarded.
 */
export class PendingPhoto {
  private readonly _url = signal<string | null>(null);
  private _blob: Blob | null = null;
  readonly url: Signal<string | null> = this._url.asReadonly();

  get blob(): Blob | null {
    return this._blob;
  }

  set(blob: Blob): void {
    this.clear();
    this._blob = blob;
    this._url.set(URL.createObjectURL(blob));
  }

  clear(): void {
    const url = this._url();
    if (url) URL.revokeObjectURL(url);
    this._url.set(null);
    this._blob = null;
  }
}
