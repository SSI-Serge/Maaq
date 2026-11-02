"""
Fabrique des « photos » de documents ENTIÈREMENT FICTIFS pour le banc de lecture (scripts/contract-ocr-bench.ts) : le texte vient de scripts/lib/contract-corpus.ts,
l'image est rendue ici avec plusieurs défauts de prise de vue (page propre, photo penchée et floue, photo sombre et bruitée).

Usage : python render.py <dossier>   (le dossier contient pages.json : {"nom": ["texte page 1", ...]} ; il reçoit nom--variante--page.jpg)
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

FONTS = [
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def page_image(text: str, size=(1240, 1754), pt=30) -> Image.Image:
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    f = font(pt)
    y = 90
    for raw in text.split("\n"):
        # retour à la ligne simple pour que le texte tienne dans la page
        words, line = raw.split(" "), ""
        for w in words:
            candidate = (line + " " + w).strip()
            if draw.textlength(candidate, font=f) > size[0] - 180 and line:
                draw.text((90, y), line, fill="black", font=f)
                y += pt + 14
                line = w
            else:
                line = candidate
        draw.text((90, y), line, fill="black", font=f)
        y += pt + 14
    return img


def photo(img: Image.Image, seed: int, angle: float, blur: float, dark: float, noise: int) -> Image.Image:
    random.seed(seed)
    out = img.rotate(angle, expand=True, fillcolor=(232, 230, 224)).filter(ImageFilter.GaussianBlur(blur))
    out = ImageEnhance.Brightness(out).enhance(dark)
    px = out.load()
    for _ in range(noise):
        x, y = random.randrange(out.width), random.randrange(out.height)
        v = random.randrange(110, 255)
        px[x, y] = (v, v, v)
    return out


VARIANTS = {
    "propre": lambda img, i: img,
    "penchee": lambda img, i: photo(img, 100 + i, 3.0, 1.0, 0.95, 50_000),
    "sombre": lambda img, i: photo(img, 200 + i, -2.0, 1.3, 0.72, 90_000),
}


def main(folder: str) -> None:
    with open(os.path.join(folder, "pages.json"), encoding="utf-8") as fh:
        docs = json.load(fh)
    for name, pages in docs.items():
        for i, text in enumerate(pages):
            base = page_image(text)
            for variant, make in VARIANTS.items():
                make(base, i).convert("RGB").save(os.path.join(folder, f"{name}--{variant}--{i + 1}.jpg"), quality=72)
    print("ok")


if __name__ == "__main__":
    main(sys.argv[1])
