"""Build the square logo + favicon set from one 1024x1024 urufu gemu image.

    python web/scripts/make-brand-icons.py web/public/brand/0598.png

Writes:
  web/public/brand/logo-{512,256,128,64}.png  square logo (head crop, ears included)
  web/src/app/favicon.ico                     16/32/48 (tighter face crop so it reads tiny)
  web/src/app/icon.png                        512x512 (Next app-router icon convention)
  web/src/app/apple-icon.png                  180x180
Crops are in source pixels for a 1024 image; other sizes are scaled to match.
"""
import sys
from pathlib import Path
from PIL import Image

LOGO_CROP = (130, 10, 890, 770)   # full head with ears
SMALL_CROP = (170, 60, 850, 740)  # tighter, for 16 to 48px

def main(src_path: str) -> None:
    public = Path(__file__).resolve().parent.parent / 'public'
    src = Image.open(src_path).convert('RGBA')
    k = src.width / 1024
    def crop(box):
        return src.crop(tuple(round(v * k) for v in box))
    logo = crop(LOGO_CROP)
    small = crop(SMALL_CROP)

    brand = public / 'brand'
    brand.mkdir(exist_ok=True)
    for size in (512, 256, 128, 64):
        logo.resize((size, size), Image.LANCZOS).save(brand / f'logo-{size}.png', optimize=True)
    app = public.parent / 'src' / 'app'
    logo.resize((512, 512), Image.LANCZOS).save(app / 'icon.png', optimize=True)
    logo.convert('RGB').resize((180, 180), Image.LANCZOS).save(app / 'apple-icon.png', optimize=True)
    small.resize((48, 48), Image.LANCZOS).save(
        app / 'favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48)]
    )
    print('wrote logo to', brand, 'and favicon/app icons to', app)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent / 'public' / 'brand' / '0598.png'))
