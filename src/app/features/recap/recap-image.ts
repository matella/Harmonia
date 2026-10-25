import { photoCells, type GridRect as Rect } from '../../core/domain/photo-grid';

/**
 * Draws the shareable picture of a year together (docs/ARCHITECTURE.md › Your year
 * together): numbers and up to four photos on the app's own colours and fonts. Nothing
 * leaves the phone here; the picture is handed to the share sheet by the page. No names
 * or dates are drawn.
 */

export const RECAP_IMAGE_WIDTH = 1080;
export const RECAP_IMAGE_HEIGHT = 1350;

const PAD = 80;

export interface RecapImageText {
  brand: string;
  year: string;
  heading: string;
  dayCount: string;
  dayLabel: string;
  stats: readonly { value: string; label: string }[];
}

export async function renderRecapImage(text: RecapImageText, photoUrls: readonly string[]): Promise<Blob> {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const display = '"Fraunces Variable", "Fraunces", Georgia, serif';
  const ui = '"DM Sans", system-ui, sans-serif';
  await Promise.all([document.fonts.load(`600 100px ${display}`), document.fonts.load(`400 40px ${ui}`)]).catch(() => undefined);

  const images = (await Promise.all(photoUrls.map(loadImage))).filter((i): i is HTMLImageElement => i !== null);
  const hasPhotos = images.length > 0;
  const height = hasPhotos ? RECAP_IMAGE_HEIGHT : 900;

  const canvas = document.createElement('canvas');
  canvas.width = RECAP_IMAGE_WIDTH;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('No canvas');

  g.fillStyle = color('--hm-canvas');
  g.fillRect(0, 0, RECAP_IMAGE_WIDTH, height);

  const inner = RECAP_IMAGE_WIDTH - PAD * 2;
  const draw = (value: string, x: number, y: number, font: string, fill: string, align: CanvasTextAlign, maxWidth: number) => {
    g.textAlign = align;
    g.fillStyle = fill;
    g.font = font;
    g.fillText(value, x, y, maxWidth);
  };

  draw(text.brand, PAD, 120, `400 38px ${ui}`, color('--hm-ink-muted'), 'left', inner / 2);
  draw(text.year, RECAP_IMAGE_WIDTH - PAD, 120, `400 38px ${ui}`, color('--hm-ink-muted'), 'right', inner / 2);
  draw(text.heading, PAD, 250, `italic 500 76px ${display}`, color('--hm-ink'), 'left', inner);
  draw(text.dayCount, PAD, 470, `600 220px ${display}`, color('--hm-berry'), 'left', inner);
  draw(text.dayLabel, PAD, 540, `400 48px ${ui}`, color('--hm-ink-muted'), 'left', inner);

  g.strokeStyle = color('--hm-line');
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(PAD, 600);
  g.lineTo(RECAP_IMAGE_WIDTH - PAD, 600);
  g.stroke();

  const columnWidth = inner / text.stats.length;
  text.stats.forEach((stat, i) => {
    const x = PAD + i * columnWidth;
    draw(stat.value, x, 720, `600 100px ${display}`, color('--hm-ink'), 'left', columnWidth - 20);
    draw(stat.label, x, 780, `400 34px ${ui}`, color('--hm-ink-muted'), 'left', columnWidth - 20);
  });

  if (hasPhotos) {
    const area = { x: PAD, y: 850, w: inner, h: RECAP_IMAGE_HEIGHT - 850 - PAD };
    photoCells(images.length, area).forEach((cell, i) => drawCover(g, images[i], cell, 28, color('--hm-surface-muted')));
  }

  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No picture'))), 'image/png'),
  );
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null); // a photo that can't be read is left out
    image.src = url;
  });
}

/** Fills the rounded cell with the photo, cropped to cover it. */
function drawCover(g: CanvasRenderingContext2D, image: HTMLImageElement, cell: Rect, radius: number, backdrop: string): void {
  g.save();
  g.beginPath();
  g.roundRect(cell.x, cell.y, cell.w, cell.h, radius);
  g.clip();
  g.fillStyle = backdrop;
  g.fillRect(cell.x, cell.y, cell.w, cell.h);
  const scale = Math.max(cell.w / image.naturalWidth, cell.h / image.naturalHeight);
  const sw = cell.w / scale;
  const sh = cell.h / scale;
  g.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, cell.x, cell.y, cell.w, cell.h);
  g.restore();
}
