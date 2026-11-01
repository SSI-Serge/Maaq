FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_THREAD_LIMIT=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Modèle français « best » de Tesseract (plus précis que le modèle rapide du paquet Debian), version figée.
RUN mkdir -p "$TESSDATA_PREFIX" \
    && curl -fsSL -o "$TESSDATA_PREFIX/fra.traineddata" https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/fra.traineddata \
    && curl -fsSL -o "$TESSDATA_PREFIX/osd.traineddata" https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/osd.traineddata

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

EXPOSE 8080
# Un seul processus : le modèle de langue est chargé une fois ; la concurrence se règle sur Cloud Run (2 requêtes par instance).
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --no-access-log"]
