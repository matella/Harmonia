import { Capacitor } from '@capacitor/core';

/**
 * Scanning an invite's QR code with the camera (docs/PARTNER_SYNC.md §20). On Android the
 * ZXing engine is used and ML Kit is left out of the build: its terms let it send usage
 * metrics to Google, and Harmonia makes no such calls.
 */
export interface QrScannerPort {
  readonly available: boolean;
  /** The scanned text, or null when cancelled or nothing was read. */
  scan(): Promise<string | null>;
}

export class NoQrScanner implements QrScannerPort {
  readonly available = false;
  async scan(): Promise<string | null> {
    return null;
  }
}

export class CapacitorQrScanner implements QrScannerPort {
  readonly available = true;

  async scan(): Promise<string | null> {
    const {
      CapacitorBarcodeScanner,
      CapacitorBarcodeScannerTypeHint,
      CapacitorBarcodeScannerAndroidScanningLibrary,
    } = await import('@capacitor/barcode-scanner');
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING },
      });
      return result.ScanResult || null;
    } catch {
      return null; // cancelled, or no camera permission
    }
  }
}

export function createQrScanner(): QrScannerPort {
  return Capacitor.isNativePlatform() ? new CapacitorQrScanner() : new NoQrScanner();
}
