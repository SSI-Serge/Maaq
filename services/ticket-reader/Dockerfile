FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_THREAD_LIMIT=2 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

# Tesseract : lecture de secours seulement (RapidOCR est le moteur, CR-36). libgl1 et libglib : demandés par OpenCV.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr curl ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Modèle français « best » de Tesseract, version figée (comme le service de lecture des contrats).
RUN mkdir -p "$TESSDATA_PREFIX" \
    && curl -fsSL -o "$TESSDATA_PREFIX/fra.traineddata" https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/fra.traineddata

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

EXPOSE 8080
# Un seul processus : les modèles sont chargés une fois ; la concurrence se règle sur Cloud Run.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --no-access-log"]
