"""
Generates Harmonia's raster brand assets from one geometric definition (two interlocking
rings — the same mark as src/app/shared/components/emblem.component.ts).

Outputs (overwrites):
  android/app/src/main/res/mipmap-*/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png
  android/app/src/main/res/drawable*/splash.png
  android/wear/src/main/res/mipmap-*/ic_launcher.png
  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png
  assets/brand/icon-1024.png (store listing master)

Usage: python scripts/generate-brand-assets.py   (requires Pillow)
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BERRY = (109, 36, 59)
IVORY = (255, 252, 248)
CANVAS = (248, 243, 237)
CANVAS_DARK = (23, 19, 21)
ROSE = (194, 106, 119)
ROSE_SOFT = (231, 196, 197)
SS = 4  # supersampling factor


def rings(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, width: float, color_a, color_b) -> None:
    """Two rings whose centres are r*10/11 apart (emblem geometry: r=11, offset 5 → 10/11)."""
    offset = r * 5 / 11
    ax, bx = cx - offset, cx + offset

    def ring(x: float, color) -> None:
        draw.ellipse([x - r, cy - r, x + r, cy + r], outline=color, width=round(width))

    ring(ax, color_a)
    ring(bx, color_b)
    # Redraw the left ring's inner arc over the right ring near the top crossing so the
    # rings interlock (over at the top, under at the bottom).
    half = math.degrees(math.acos(offset / r))  # angle of the crossing points from A's centre
    # Start before the crossing so the arc's square end hides inside ring A's own stroke.
    draw.arc([ax - r, cy - r, ax + r, cy + r], start=-half - 14, end=half * 0.55, fill=color_a, width=round(width))


def icon(size: int, *, background=BERRY, scale: float = 0.56, round_mask: bool = False, transparent: bool = False) -> Image.Image:
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0) if transparent else (*background, 255))
    draw = ImageDraw.Draw(img)
    r = big * scale / 2 / (1 + 5 / 11)
    rings(draw, big / 2, big / 2, r, max(2, big * 0.045), IVORY, ROSE_SOFT)
    img = img.resize((size, size), Image.LANCZOS)
    if round_mask:
        mask = Image.new('L', (size * SS, size * SS), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size * SS - 1, size * SS - 1], fill=255)
        img.putalpha(mask.resize((size, size), Image.LANCZOS))
    return img


def splash(size: int, dark: bool = False) -> Image.Image:
    big = 1024
    bg = CANVAS_DARK if dark else CANVAS
    mark = Image.new('RGBA', (big, big), (*bg, 255))
    draw = ImageDraw.Draw(mark)
    r = big * 0.26 / 2 / (1 + 5 / 11)
    rings(draw, big / 2, big / 2, r, big * 0.016, (209, 138, 154) if dark else BERRY, ROSE)
    img = Image.new('RGB', (size, size), bg)
    scaled = mark.resize((min(size, 1024), min(size, 1024)), Image.LANCZOS)
    img.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print('wrote', path.relative_to(ROOT))


def main() -> None:
    res = ROOT / 'android/app/src/main/res'
    densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for name, d in densities.items():
        save(icon(round(48 * d), scale=0.6), res / f'mipmap-{name}/ic_launcher.png')
        save(icon(round(48 * d), scale=0.52, round_mask=True), res / f'mipmap-{name}/ic_launcher_round.png')
        # Adaptive foreground: 108dp canvas, mark inside the 66dp safe zone.
        save(icon(round(108 * d), scale=0.40, transparent=True), res / f'mipmap-{name}/ic_launcher_foreground.png')
        wear = ROOT / f'android/wear/src/main/res/mipmap-{name}/ic_launcher.png'
        save(icon(round(48 * d), scale=0.52, round_mask=True), wear)

    splash_light = splash(2732)
    splash_dark = splash(2732, dark=True)
    # One density-independent splash (plus night variant) is enough for the
    # windowBackground; remove Capacitor's per-density defaults.
    for folder in (f'drawable-{o}-{d}' for o in ('port', 'land') for d in densities):
        stale = res / folder / 'splash.png'
        if stale.exists():
            stale.unlink()
            if not any(stale.parent.iterdir()):
                stale.parent.rmdir()
    save(splash_light.resize((1280, 1280), Image.LANCZOS), res / 'drawable-nodpi/splash.png')
    legacy = res / 'drawable/splash.png'
    if legacy.exists():
        legacy.unlink()
    night = res / 'drawable-night-nodpi/splash.png'
    stale_night = res / 'drawable-night/splash.png'
    if stale_night.exists():
        stale_night.unlink()
        if not any(stale_night.parent.iterdir()):
            stale_night.parent.rmdir()
    save(splash_dark.resize((1280, 1280), Image.LANCZOS), night)

    ios = ROOT / 'ios/App/App/Assets.xcassets'
    if ios.exists():
        save(icon(1024, scale=0.56).convert('RGB'), ios / 'AppIcon.appiconset/AppIcon-512@2x.png')
        for name in ('splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'):
            save(splash_light, ios / 'Splash.imageset' / name)

    save(icon(1024, scale=0.56).convert('RGB'), ROOT / 'assets/brand/icon-1024.png')


if __name__ == '__main__':
    main()
