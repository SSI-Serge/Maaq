"""
Service interne de lecture des tickets de caisse (US-161 RF2 et RT1, CR-05, CR-36).

Il reçoit de 1 à 3 photos d'un ticket et rend le texte lu, ligne par ligne, avec la confiance moyenne de la lecture. Moteur : RapidOCR (modèles ONNX, licence Apache-2.0) ;
Tesseract ne sert qu'en secours quand RapidOCR ne lit presque rien. Il tourne chez nous, en Union européenne, et n'appelle aucun service extérieur. Il ne garde RIEN :
ni photo, ni texte, ni journal du contenu (on ne journalise que des durées et des compteurs).

Le masquage du nom, de la carte de fidélité et du prénom du caissier est fait par l'application (`maskTicketText`), qui reçoit ici le texte brut : ce service ne sait pas
à quel foyer appartient une photo.

Accès : Cloud Run sans accès public ; l'application s'authentifie avec un jeton d'identité de son compte de service.
"""

import io
import logging
import os
import time

import numpy as np
import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR

READER_VERSION = "1.0.0"
MAX_FILES = 3
MAX_BYTES = 10 * 1024 * 1024
MAX_SIDE = 3000  # pixels : au-delà, la lecture n'y gagne rien et le temps explose
MIN_CHARS = 20  # sous ce seuil, RapidOCR n'a presque rien lu : Tesseract prend le relais

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("ticket-reader")  # durées et compteurs seulement, jamais un contenu

app = FastAPI(title="MAAQ — lecture des tickets", docs_url=None, redoc_url=None, openapi_url=None)
engine = RapidOCR()
TOOL = f"ticket-reader-{READER_VERSION}|rapidocr-onnxruntime|tesseract-{pytesseract.get_tesseract_version()}"


def prepare(raw: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(raw))
    image = ImageOps.exif_transpose(image).convert("RGB")
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE))
    return image


def rapid_lines(image: Image.Image) -> tuple[list[str], list[float]]:
    """Les lignes de texte lues par RapidOCR : les boîtes sont regroupées par hauteur puis classées de gauche à droite."""
    result, _ = engine(np.array(image))
    if not result:
        return [], []
    boxes = []
    for box, text, score in result:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        boxes.append({"y": sum(ys) / 4, "h": max(ys) - min(ys), "x": min(xs), "text": str(text).strip(), "score": float(score)})
    boxes = [b for b in boxes if b["text"]]
    boxes.sort(key=lambda b: b["y"])
    lines: list[list[dict]] = []
    for b in boxes:
        if lines and abs(b["y"] - lines[-1][0]["y"]) <= max(b["h"], lines[-1][0]["h"]) * 0.6:
            lines[-1].append(b)
        else:
            lines.append([b])
    texts = ["   ".join(b["text"] for b in sorted(line, key=lambda b: b["x"])) for line in lines]
    return texts, [b["score"] for b in boxes]


def tesseract_lines(image: Image.Image) -> list[str]:
    gray = ImageOps.autocontrast(image.convert("L"))
    text = pytesseract.image_to_string(gray, lang="fra", config="--oem 1 --psm 6")
    return [line.rstrip() for line in text.splitlines() if line.strip()]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "tool": TOOL}


@app.post("/read")
async def read(files: list[UploadFile] = File(...)) -> dict:
    started = time.time()
    if not files or len(files) > MAX_FILES:
        raise HTTPException(status_code=422, detail="Envoyez de 1 à 3 photos")
    all_lines: list[str] = []
    scores: list[float] = []
    fallback = 0
    for upload in files:
        raw = await upload.read()
        if not raw or len(raw) > MAX_BYTES:
            raise HTTPException(status_code=422, detail="Photo illisible")
        try:
            image = prepare(raw)
        except Exception:  # noqa: BLE001 - fichier qui n'est pas une image
            raise HTTPException(status_code=422, detail="Photo illisible") from None
        lines, page_scores = rapid_lines(image)
        if sum(len(line) for line in lines) < MIN_CHARS:
            lines, page_scores = tesseract_lines(image), []
            fallback += 1
        all_lines.extend(lines)
        scores.extend(page_scores)
    text = "\n".join(all_lines)
    if sum(len(line.strip()) for line in all_lines) < MIN_CHARS:
        raise HTTPException(status_code=422, detail="Ticket illisible")
    confidence = round(100 * sum(scores) / len(scores)) if scores else 50
    log.info("lecture : %d photo(s), %d ligne(s), confiance %d, secours %d, %.1f s", len(files), len(all_lines), confidence, fallback, time.time() - started)
    return {"text": text, "confidence": confidence, "tool": TOOL}
