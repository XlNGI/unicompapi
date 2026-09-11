"""Generate desktop packaging assets from the existing UniComp brand mark.

Optional maintainer tool: Python 3 and Pillow. Generated assets are committed,
so application builds do not require Python or Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/assets/brand/unicomp-mark.png"
OUTPUT = ROOT / "build-resources"
WINDOWS_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def generate() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as source:
        mark = source.convert("RGBA")
    bounds = mark.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("The brand mark is empty")
    mark = mark.crop(bounds)

    # A light tile preserves the black mark on both light and dark desktops.
    # Reuse the artwork; no new lettering or brand geometry is introduced.
    icon = Image.new("RGBA", (1024, 1024))
    ImageDraw.Draw(icon).rounded_rectangle(
        (48, 48, 975, 975), radius=208, fill=(250, 249, 246, 255)
    )
    fitted = ImageOps.contain(mark, (680, 736), Image.Resampling.LANCZOS)
    icon.alpha_composite(fitted, ((1024 - fitted.width) // 2, (1024 - fitted.height) // 2))
    icon.save(OUTPUT / "icon.png", optimize=True)
    icon.save(OUTPUT / "icon.ico", sizes=[(size, size) for size in WINDOWS_SIZES])
    icon.save(OUTPUT / "icon.icns")

    # NSIS assisted installers use a BMP header, not installerHeaderIcon.
    header = Image.new("RGBA", (150, 57), "white")
    header_mark = ImageOps.contain(mark, (42, 45), Image.Resampling.LANCZOS)
    header.alpha_composite(header_mark, (146 - header_mark.width, (57 - header_mark.height) // 2))
    header.convert("RGB").save(OUTPUT / "installer-header.bmp")
    print("Generated icon.png, icon.ico, icon.icns and installer-header.bmp")


if __name__ == "__main__":
    generate()
