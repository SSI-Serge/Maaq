"""
Service interne de lecture des documents de contrat (US-136 RT1 et RT2, C-15).

Il reçoit les fichiers d'un document (un PDF, ou de 1 à 10 photos), en tire le texte page par page (texte du PDF, sinon lecture OCR) et repère les noms propres avec un modèle de
langue française. Il tourne chez nous, en Union européenne, et n'appelle aucun service extérieur. Il ne garde RIEN : ni fichier, ni texte, ni journal du contenu. Le masquage
lui-même est fait par l'application, qui reçoit ici le texte brut et les zones repérées.

Accès : Cloud Run sans accès public ; l'application s'authentifie avec un jeton d'identité de son compte de service.
"""

import io
import logging
import os
import re
import time

import fitz  # PyMuPDF
import pytesseract
import spacy
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, ImageOps

READER_VERSION = "1.0.0"
MAX_PAGES = int(os.environ.get("MAX_PAGES", "30"))
MAX_IMAGE_SIDE = 3600  # pixels : au-delà, l'image est réduite (la lecture n'y gagne rien et le temps explose)
PDF_DPI = 250
MIN_TEXT_CHARS = 40  # sous ce seuil, une page de PDF est considérée comme une image (scan) et passe par l'OCR
MAX_NER_CHARS = 100_000

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("reader")  # on ne journalise que des durées et des compteurs, jamais un contenu

app = FastAPI(title="MAAQ — lecture des documents", docs_url=None, redoc_url=None, openapi_url=None)
nlp = spacy.load("fr_core_news_md", disable=["lemmatizer"])
TESSERACT_VERSION = str(pytesseract.get_tesseract_version())
TOOL_VERSION = f"reader-{READER_VERSION}|tesseract-{TESSERACT_VERSION}|{nlp.meta['name']}-{nlp.meta['version']}"


def entities(text: str) -> list[dict]:
    """Noms de personnes, lieux et organisations repérés par le modèle (positions dans le texte de la page)."""
    if not text.strip():
        return []
    doc = nlp(text[:MAX_NER_CHARS])
    return [{"start": e.start_char, "end": e.end_char, "label": e.label_} for e in doc.ents if e.label_ in ("PER", "LOC", "ORG")]


WEAK_BELOW = 60  # un mot lu avec moins de confiance que cela est signalé « mal lu » (aperçu de l'administrateur, US-138)


def ocr(image: Image.Image) -> tuple[str, int, list[str]]:
    """Lecture d'une image : (texte, confiance 0 à 100, mots mal lus). La confiance est la moyenne des mots lus, pondérée par leur longueur."""
    image = ImageOps.exif_transpose(image).convert("L")
    image = ImageOps.autocontrast(image)
    if max(image.size) > MAX_IMAGE_SIDE:
        image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))

    def run(img: Image.Image) -> tuple[str, int, list[str]]:
        data = pytesseract.image_to_data(img, lang="fra", config="--oem 1 --psm 3", output_type=pytesseract.Output.DICT)
        lines: dict[tuple[int, int, int], list[str]] = {}
        weight = total = 0
        weak: list[str] = []
        for i, word in enumerate(data["text"]):
            word = word.strip()
            conf = float(data["conf"][i])
            if not word or conf < 0:
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            lines.setdefault(key, []).append(word)
            weight += len(word)
            total += conf * len(word)
            if conf < WEAK_BELOW and sum(c.isalpha() for c in word) >= 3:
                weak.append(word.lower())
        text = "\n".join(" ".join(words) for _, words in sorted(lines.items()))
        return text, (round(total / weight) if weight else 0), sorted(set(weak))[:200]

    text, confidence, weak = run(image)
    if confidence < 60:
        # Photo prise de travers : on laisse Tesseract estimer l'orientation et on garde la meilleure lecture.
        try:
            angle = int(re.search(r"Rotate: (\d+)", pytesseract.image_to_osd(image)).group(1))
        except Exception:  # noqa: BLE001 — l'orientation est un plus, jamais une raison d'échouer
            angle = 0
        if angle:
            better = run(image.rotate(-angle, expand=True))
            if better[1] > confidence:
                text, confidence, weak = better
    return text, confidence, weak


def read_pdf(content: bytes) -> list[dict]:
    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as error:  # noqa: BLE001
        raise HTTPException(422, "unreadable") from error
    if document.needs_pass:
        raise HTTPException(422, "password")
    if document.page_count > MAX_PAGES:
        raise HTTPException(422, "too_many_pages")
    pages = []
    for page in document:
        text = page.get_text("text").strip()
        if len(text) >= MIN_TEXT_CHARS:
            pages.append({"text": text, "confidence": 100, "method": "text"})
            continue
        pixmap = page.get_pixmap(dpi=PDF_DPI, alpha=False)
        text, confidence, weak = ocr(Image.open(io.BytesIO(pixmap.tobytes("png"))))
        pages.append({"text": text, "confidence": confidence, "method": "ocr", "weak": weak})
    return pages


def read_image(content: bytes) -> dict:
    try:
        image = Image.open(io.BytesIO(content))
        image.load()
    except Exception as error:  # noqa: BLE001
        raise HTTPException(422, "unreadable") from error
    text, confidence, weak = ocr(image)
    return {"text": text, "confidence": confidence, "method": "ocr", "weak": weak}


@app.get("/status")
def status():
    return {"ok": True, "tool": TOOL_VERSION}


@app.post("/read")
async def read(files: list[UploadFile] = File(...)):
    started = time.time()
    if not files or len(files) > MAX_PAGES:
        raise HTTPException(422, "too_many_pages")
    contents = [await f.read() for f in files]
    if len(contents) == 1 and contents[0][:5] == b"%PDF-":
        pages = read_pdf(contents[0])
    else:
        if any(c[:5] == b"%PDF-" for c in contents):
            raise HTTPException(422, "mixed")
        pages = [read_image(c) for c in contents]
    for page in pages:
        page["entities"] = entities(page["text"])
    log.info("lu : %d page(s), %d ms, %d lecture(s) OCR", len(pages), (time.time() - started) * 1000, sum(p["method"] == "ocr" for p in pages))
    return {"tool": TOOL_VERSION, "pages": pages}
