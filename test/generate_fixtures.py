"""Regenerates the large synthetic test fixtures used by
test/compression-e2e.mjs (kept out of git to avoid bloating the repo with
multi-MB binaries — run this once if you need them locally).

Requires: pip install pillow reportlab
Usage: python3 test/generate_fixtures.py
"""
import random
import os

from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

random.seed(42)
HERE = os.path.dirname(os.path.abspath(__file__))


def make_big_photo():
    # A large, noisy "photo-like" JPEG simulating a high-res phone photo of a
    # handwritten answer sheet, saved at high quality so it starts out big
    # (a flat white image would trivially compress to near-nothing and
    # wouldn't meaningfully test the downscale+recompress path).
    img = Image.new("RGB", (4000, 3000), "white")
    draw = ImageDraw.Draw(img)
    for _ in range(200000):
        x, y = random.randint(0, 3999), random.randint(0, 2999)
        c = random.randint(180, 255)
        draw.point((x, y), fill=(c, c, c))
    for i in range(40):
        y = 100 + i * 70
        draw.line([(150, y), (3800, y)], fill=(120, 120, 140), width=3)
    draw.text((150, 50), "BIG TEST ANSWER SHEET PHOTO", fill="black")
    path = os.path.join(HERE, "big-photo.jpg")
    img.save(path, quality=95)
    print("wrote", path, os.path.getsize(path), "bytes")


def make_big_multipage_pdf():
    path = os.path.join(HERE, "big-multipage.pdf")
    c = canvas.Canvas(path, pagesize=letter)
    w, h = letter
    for i in range(1, 7):
        c.setFont("Helvetica-Bold", 40)
        c.drawString(72, h - 150, f"PAGE {i} OF 6 - QUESTION PAPER TEST")
        c.setFont("Helvetica", 14)
        for line in range(30):
            c.drawString(
                72, h - 200 - line * 18, f"Filler line {line} on page {i} " + "lorem ipsum " * 4
            )
        c.showPage()
    c.save()
    print("wrote", path, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    make_big_photo()
    make_big_multipage_pdf()
