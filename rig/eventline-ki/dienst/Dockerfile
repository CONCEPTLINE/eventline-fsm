# EVENTLINE Lokale KI — Dienst-Image (Python 3.12, FastAPI, Port 8700)
#
# bookworm statt trixie: dort heissen die Pakete noch libmagic1 / ocrmypdf 14,
# beides erprobt. OCR (Tesseract deu+eng), PDF-Werkzeuge (poppler) und ffmpeg
# (Diktat-Aufnahmen aus der Warteschlange → 16 kHz WAV) kommen aus Debian. Läuft
# als uid 1500 ohne Shell-Login, passend zum Benutzer eventline-ki auf dem Rig.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
      ocrmypdf poppler-utils libmagic1 ffmpeg tzdata \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1500 eventline-ki \
 && useradd -u 1500 -g 1500 -m -d /home/eventline-ki -s /usr/sbin/nologin eventline-ki

WORKDIR /srv/app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
RUN python -m compileall -q app

ARG KI_BUILD=dev
ENV KI_BUILD=${KI_BUILD}

USER 1500:1500
EXPOSE 8700
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8700"]
