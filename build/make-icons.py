"""Draws the Interface app icon at every size Linux and macOS need.

Two agents (Claude clay, Codex teal) overlap; the shared middle holds a small spark.
Run: python3 build/make-icons.py   (needs Pillow)
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
SS = 4  # supersampling for smooth edges


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical_gradient(size, top, bottom):
    img = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=lerp(top, bottom, y / (size - 1)))
    return img


def radial_gradient(size, center, radius, inner, outer):
    """Soft radial fill used to give the circles some depth."""
    img = Image.new('RGBA', (size, size), outer)
    draw = ImageDraw.Draw(img)
    steps = 64
    for i in range(steps, 0, -1):
        r = radius * i / steps
        color = lerp(inner, outer, i / steps)
        draw.ellipse([center[0] - r, center[1] - r, center[0] + r, center[1] + r], fill=color)
    return img.filter(ImageFilter.GaussianBlur(radius / 18))


def circle_mask(size, cx, cy, r):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    return m


def spark(size, cx, cy, r, color):
    """Four-point star."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    w = r * 0.24
    pts = [
        (cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
        (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w),
    ]
    ImageDraw.Draw(img).polygon(pts, fill=color)
    return img


def draw_icon(final: int) -> Image.Image:
    n = final * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))

    # Rounded-square background with a gentle top-to-bottom shade and a thin rim.
    pad = round(n * 0.06)
    radius = round(n * 0.225)
    bg_mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(bg_mask).rounded_rectangle([pad, pad, n - pad, n - pad], radius=radius, fill=255)
    img.paste(vertical_gradient(n, (52, 47, 43, 255), (22, 20, 19, 255)), (0, 0), bg_mask)
    rim = Image.new('L', (n, n), 0)
    ImageDraw.Draw(rim).rounded_rectangle([pad, pad, n - pad, n - pad], radius=radius, outline=255, width=max(1, n // 256))
    img.paste(Image.new('RGBA', (n, n), (255, 255, 255, 38)), (0, 0), rim)

    # The two agents.
    r = n * 0.215
    cy = n * 0.5
    lx, rx = n * 0.385, n * 0.615
    left = radial_gradient(n, (lx - r * 0.3, cy - r * 0.35), r * 1.4, (240, 146, 108, 255), (196, 88, 52, 255))
    right = radial_gradient(n, (rx - r * 0.3, cy - r * 0.35), r * 1.4, (64, 214, 170, 255), (13, 136, 104, 255))
    lm = circle_mask(n, lx, cy, r)
    rm = circle_mask(n, rx, cy, r)

    # Soft shadow under the pair.
    shadow = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    sm = ImageChops.lighter(circle_mask(n, lx, cy + n * 0.018, r), circle_mask(n, rx, cy + n * 0.018, r))
    shadow.paste(Image.new('RGBA', (n, n), (0, 0, 0, 120)), (0, 0), sm)
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(n * 0.02)))

    img.paste(left, (0, 0), lm)
    img.paste(right, (0, 0), rm)

    # Where they meet: the shared room, with a spark.
    lens = ImageChops.multiply(lm, rm)
    img.paste(vertical_gradient(n, (255, 249, 238, 255), (236, 226, 208, 255)), (0, 0), lens)
    img = Image.alpha_composite(img, spark(n, n * 0.5, cy, r * 0.36, (38, 34, 31, 255)))

    return img.resize((final, final), Image.LANCZOS)


def main():
    big = draw_icon(1024)
    big.save(ROOT / 'icon.png')
    icons = ROOT / 'icons'
    icons.mkdir(exist_ok=True)
    for size in (16, 24, 32, 48, 64, 128, 256, 512):
        # Small sizes are drawn directly so lines stay crisp.
        (draw_icon(size) if size <= 64 else big.resize((size, size), Image.LANCZOS)).save(icons / f'{size}x{size}.png')
    big.resize((512, 512), Image.LANCZOS).save(ROOT.parent / 'resources' / 'icon.png')
    print('icons written')


if __name__ == '__main__':
    main()
