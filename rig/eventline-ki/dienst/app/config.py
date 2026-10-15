"""Konfiguration aus der Umgebung.

Werte kommen aus /etc/eventline-ki/env (SPEC §4) und den festen Variablen in
docker-compose.yml. Secrets werden hier nur gelesen — nie geloggt, nie
ausgegeben. Alles Weitere hat sinnvolle Standardwerte, damit der Dienst auch
mit einer minimalen env-Datei startet.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _text(name: str, standard: str = "") -> str:
    wert = os.environ.get(name)
    if wert is None:
        return standard
    wert = wert.strip()
    # env-Dateien enthalten gelegentlich Anführungszeichen um den Wert.
    if len(wert) >= 2 and wert[0] == wert[-1] and wert[0] in ("'", '"'):
        wert = wert[1:-1]
    return wert


def _zahl(name: str, standard: int) -> int:
    try:
        return int(_text(name, str(standard)))
    except ValueError:
        return standard


def _kommazahl(name: str, standard: float) -> float:
    try:
        return float(_text(name, str(standard)))
    except ValueError:
        return standard


def _liste(name: str, standard: str = "") -> tuple[str, ...]:
    return tuple(t.strip() for t in _text(name, standard).split(",") if t.strip())


def _schalter(name: str) -> bool:
    """Schalter aus /etc/eventline-ki/env: nur «1»/«true»/«ja»/«on» schaltet ein, alles andere ist aus."""
    return _text(name, "0").lower() in ("1", "true", "ja", "on")


def modell_leiter(wert: str) -> tuple[tuple[str, float], ...]:
    """«name@GB,name@GB» → ((name, GB), …) in dieser Reihenfolge. Ungültige Einträge fallen weg
    (ohne Name, ohne/mit ungültigem Bedarf) — lieber eine kürzere Leiter als ein geratener Bedarf."""
    leiter: list[tuple[str, float]] = []
    for teil in (wert or "").split(","):
        name, _, bedarf = teil.strip().rpartition("@")
        name = name.strip()
        try:
            gb = float(bedarf.strip())
        except ValueError:
            continue
        if name and 0 < gb < 1024:
            leiter.append((name, gb))
    return tuple(leiter)


@dataclass(frozen=True)
class Einstellungen:
    fsm_url: str
    sync_token: str
    ticket_secret: str
    cors_origins: tuple[str, ...]
    # Einziger Weg nach draussen (Squid mit Erlaubnisliste); None = direkt (nur Probelauf/Entwicklung).
    proxy: str | None
    ollama_url: str
    whisper_url: str
    modell_text: str
    modell_bild: str
    modell_embed: str
    modell_whisper: str
    keep_alive: str
    # Kontextfenster je Aufgabe (Tokens). Muss mit Modell, KV-Cache und Rechenpuffer in den
    # freien VRAM passen, sonst lagert llama.cpp Schichten auf die CPU aus (Faktor 10–20 langsamer).
    # Ablage: Systemregeln + Ordnerliste + Dokumenttext; Bild: Beleg/Warenkorb (Bild ≈ 1000–1600 Tokens).
    llm_num_ctx: int
    bild_num_ctx: int
    llm_timeout_s: int
    # Obergrenze Dokumenttext fürs Sprachmodell (Kopf + Schwanz); die Ablage kürzt zusätzlich
    # so, dass der ganze Prompt ins Kontextfenster passt.
    llm_max_zeichen: int
    bild_max_px: int
    pg_host: str
    pg_port: int
    pg_user: str
    pg_db: str
    pg_password: str
    data_dir: Path
    tmp_dir: Path
    poll_intervall_s: float
    max_datei_mb: int
    max_text_zeichen: int
    pdf_max_seiten: int
    ocr_max_seiten: int
    ocr_timeout_s: int
    diktat_max_mb: int
    diktat_timeout_s: int
    # Unter diesem freien VRAM wird das Sprachmodell vor einem Diktat entladen (8-GB-Karte).
    whisper_min_frei_mb: int
    # Unter diesem freien VRAM wird das Sprachmodell vor der Einbettung (Ordnerwahl) entladen: sonst legt
    # Ollama das Einbettungsmodell fast ganz in den Hauptspeicher (gemessen 2026-10-11 bei geladenem
    # Whisper: 74 von 1204 MiB in der GPU, Laden 24 s statt 2 s).
    embed_min_frei_mb: int
    # Whisper-Segmente mit höherer «kein Sprechen»-Wahrscheinlichkeit werden verworfen
    # (Stille/Rauschen erzeugt sonst erfundene Sätze).
    whisper_no_speech_max: float
    # Archiv-Index (Vorbilder für die Ordnerwahl): NAS-Wurzel (read-only), erster Lauf so viele
    # Sekunden nach dem Start, nächtlicher Lauf ab dieser Uhrzeit (Europe/Zurich), OCR je Datei
    # höchstens so viele Seiten (für den Textanfang reicht der Kopf des Dokuments).
    nas_wurzel: Path
    index_start_s: int
    index_nacht: str
    index_ocr_seiten: int
    # Hauptmodell (Masterplan §2.2–§2.6): Planer, Speicher-Tor, Wächter, Hintergrund-Thread. Alles aus,
    # solange KI_HG_AKTIV nicht 1 ist. hg_url = Instanz «ollama-gruendlich» (nur Prozessor, Stufe A).
    hg_aktiv: bool
    hg_tag: bool
    hg_gpu_nacht: bool
    hg_url: str
    hg_modelle: tuple[tuple[str, float], ...]
    hg_not_gb: float
    # Platz, der neben dem geladenen Hauptmodell im KI-Slice frei bleiben muss (Ablage, Beleg, Diktat) — Tor (§2.4).
    hg_puffer_gb: float
    hg_max_ladungen: int
    hg_pause_s: int
    hg_neu_pruefen_s: int
    hg_schritt_max_s: int
    hg_threads_nacht: int
    hg_threads_tag: int
    hg_num_ctx: int
    nacht_start: str
    tag_start: str
    # Cgroup-Verzeichnis des KI-Slices, nur lesend in den Dienst eingebunden (docker-compose.yml).
    hg_slice_dir: Path
    # Tiefen-Index (Masterplan §2.7, E2.5): Volltext + Abschnitte aller Freigaben im Tresor, nachts höchstens
    # KI_TIEFE_MAX_H Stunden, OCR höchstens KI_TIEFE_OCR_SEITEN Seiten je Datei.
    tiefe_aktiv: bool
    tiefe_max_h: float
    tiefe_ocr_seiten: int
    tiefe_max_zeichen: int
    # Arten ohne Datei (MP-1, MP-3, MP-4): nur angenommen und im Herzschlag gemeldet, wenn eingeschaltet.
    suche_aktiv: bool
    archiv_frage_aktiv: bool
    # Live-Trefferquote (E2.7): Vorschläge der Ablage im Tresor merken (nur Pfade), nachts auswerten.
    lernen_aktiv: bool
    build: str
    # Nachtarbeit (Masterplan Etappe 4, nachtarbeit.py): je Job ein Schalter (Standard aus). Läuft mit dem schnellen
    # Modell (KI_MODELL_TEXT) auf der GPU-Instanz — Entscheid nach der Messung E2.4; das Hauptmodell bleibt aus.
    job_fristen: bool = False
    job_zz: bool = False
    job_selbsttest: bool = False
    job_zz_max: int = 200
    selbsttest_zeit: str = "05:30"
    selbsttest_n: int = 40
    kontext_max_alter_s: int = 3600
    # Technik-Dashboard (docs/technik-dashboard/VERTRAG.md §1.2): jede Minute Messwerte ans FSM (Standard an).
    technik_aktiv: bool = True
    technik_datei: Path = Path("/data/technik/stand.json")
    # Lüfterprofil aus der FSM-Antwort (steuerung.luefter_profil) → nur der Profilname in diese Datei; der Host-Dienst
    # eventline-kuehlung liest sie als /srv/eventline-ki/data/dienst/steuerung/luefter_profil (README «Kühlung & LEDs»).
    kuehlung_wunsch: Path = Path("/data/steuerung/luefter_profil")
    # Sicherheits-Rapport (SPEC §2.2): Klartext zum täglichen Sicherheits-Check des FSM (Standard an).
    sicherheit_aktiv: bool = True

    @property
    def nachtarbeit_aktiv(self) -> bool:
        return self.job_fristen or self.job_zz or self.job_selbsttest

    @property
    def pg_dsn(self) -> str | None:
        if not self.pg_password:
            return None
        return (
            f"host={self.pg_host} port={self.pg_port} dbname={self.pg_db} "
            f"user={self.pg_user} password={self.pg_password} connect_timeout=5 "
            f"application_name=eventline-ki"
        )

    def uebersicht(self) -> dict[str, object]:
        """Für das Start-Log: zeigt, WAS gesetzt ist — nie die Werte der Geheimnisse."""
        return {
            "fsm_url": self.fsm_url,
            "sync_token": bool(self.sync_token),
            "ticket_secret": bool(self.ticket_secret),
            "proxy": self.proxy,
            "ollama_url": self.ollama_url,
            "whisper_url": self.whisper_url,
            "modell_text": self.modell_text,
            "modell_bild": self.modell_bild,
            "modell_whisper": self.modell_whisper,
            "modell_embed": self.modell_embed,
            "num_ctx": {"ablage": self.llm_num_ctx, "bild": self.bild_num_ctx},
            "archiv": {"nas": str(self.nas_wurzel), "nacht": self.index_nacht, "ocr_seiten": self.index_ocr_seiten},
            "hauptmodell": {
                "aktiv": self.hg_aktiv, "tag": self.hg_tag, "gpu_nacht": self.hg_gpu_nacht, "url": self.hg_url,
                "leiter": [f"{n}@{gb:g}" for n, gb in self.hg_modelle], "puffer_gb": self.hg_puffer_gb,
                "nacht": f"{self.nacht_start}–{self.tag_start}",
            },
            "tiefe": {"aktiv": self.tiefe_aktiv, "max_h": self.tiefe_max_h, "ocr_seiten": self.tiefe_ocr_seiten},
            "arten_ohne_datei": {"nas_suche": self.suche_aktiv, "archiv_frage": self.archiv_frage_aktiv},
            "lernen": self.lernen_aktiv,
            "nachtarbeit": {
                "fristen": self.job_fristen, "zz": self.job_zz, "selbsttest": self.job_selbsttest,
                "zz_max": self.job_zz_max, "selbsttest_plan": f"{self.selbsttest_zeit}/{self.selbsttest_n}",
            },
            "technik": self.technik_aktiv,
            "sicherheit": self.sicherheit_aktiv,
            "protokoll_db": bool(self.pg_password),
            "tmp_dir": str(self.tmp_dir),
            "build": self.build,
        }


def laden() -> Einstellungen:
    data_dir = Path(_text("KI_DATA_DIR", "/data"))
    tmp_dir = Path(_text("TMPDIR", str(data_dir / "tmp")))
    return Einstellungen(
        fsm_url=_text("FSM_URL", "https://eventline-fsm-usyk.vercel.app").rstrip("/"),
        sync_token=_text("KI_SYNC_TOKEN"),
        ticket_secret=_text("KI_TICKET_SECRET"),
        cors_origins=_liste("KI_CORS_ORIGINS"),
        proxy=_text("HTTPS_PROXY") or None,
        ollama_url=_text("OLLAMA_URL", "http://ollama:11434").rstrip("/"),
        whisper_url=_text("WHISPER_URL", "http://whisper:8000").rstrip("/"),
        # Entscheid 2026-10-03 (SPEC §2.1): ein Modell für Text und Bild — einziges, das Belege
        # und Ablage ganz in der GPU rechnet. Massgeblich bleibt /etc/eventline-ki/env.
        modell_text=_text("KI_MODELL_TEXT", "gemma3:4b"),
        modell_bild=_text("KI_MODELL_BILD", "gemma3:4b"),
        modell_embed=_text("KI_MODELL_EMBED", "bge-m3"),
        modell_whisper=_text("KI_MODELL_WHISPER", "Systran/faster-whisper-medium"),
        keep_alive=_text("KI_KEEP_ALIVE", "5m"),
        llm_num_ctx=_zahl("KI_LLM_NUM_CTX", 8192),
        bild_num_ctx=_zahl("KI_BILD_NUM_CTX", 4096),
        llm_timeout_s=_zahl("KI_LLM_TIMEOUT_S", 300),
        llm_max_zeichen=_zahl("KI_LLM_MAX_ZEICHEN", 24_000),
        bild_max_px=_zahl("KI_BILD_MAX_PX", 1280),
        pg_host=_text("PG_HOST", "db"),
        pg_port=_zahl("PG_PORT", 5432),
        pg_user=_text("PG_USER", "eventline"),
        pg_db=_text("PG_DB", "eventline_ki"),
        pg_password=_text("PG_PASSWORD"),
        data_dir=data_dir,
        tmp_dir=tmp_dir,
        poll_intervall_s=max(0.5, _zahl("KI_POLL_MS", 2000) / 1000.0),
        max_datei_mb=_zahl("KI_MAX_DATEI_MB", 50),
        max_text_zeichen=_zahl("KI_MAX_TEXT_ZEICHEN", 60_000),
        pdf_max_seiten=_zahl("KI_PDF_MAX_SEITEN", 300),
        ocr_max_seiten=_zahl("KI_OCR_MAX_SEITEN", 30),
        ocr_timeout_s=_zahl("KI_OCR_TIMEOUT_S", 600),
        # Wie im FSM (POST /api/ki/diktat nimmt höchstens 10 MB an).
        diktat_max_mb=_zahl("KI_DIKTAT_MAX_MB", 10),
        diktat_timeout_s=_zahl("KI_DIKTAT_TIMEOUT_S", 120),
        whisper_min_frei_mb=_zahl("KI_WHISPER_MIN_FREI_MB", 2000),
        embed_min_frei_mb=_zahl("KI_EMBED_MIN_FREI_MB", 2000),
        whisper_no_speech_max=_kommazahl("KI_WHISPER_NO_SPEECH_MAX", 0.6),
        nas_wurzel=Path(_text("KI_NAS_WURZEL", "/mnt/eventline-nas")),
        index_start_s=max(0, _zahl("KI_INDEX_START_S", 120)),
        # Masterplan §2.3: 19:05, damit die Ablage des Tages Vorbild ist, bevor Tiefen-Index und Hauptmodell rechnen.
        index_nacht=_text("KI_INDEX_NACHT", "19:05"),
        index_ocr_seiten=max(1, _zahl("KI_INDEX_OCR_SEITEN", 3)),
        hg_aktiv=_schalter("KI_HG_AKTIV"),
        hg_tag=_schalter("KI_HG_TAG"),
        hg_gpu_nacht=_schalter("KI_HG_GPU_NACHT"),
        hg_url=_text("OLLAMA_GRUENDLICH_URL", "http://ollama-gruendlich:11434").rstrip("/"),
        hg_modelle=modell_leiter(_text("KI_HG_MODELLE", "gemma4:26b-a4b-it-qat@17,gemma4:12b-it-qat@10")),
        hg_not_gb=_kommazahl("KI_HG_NOT_GB", 1.0),
        hg_puffer_gb=max(0.0, _kommazahl("KI_HG_PUFFER_GB", 3.0)),
        hg_max_ladungen=max(1, _zahl("KI_HG_MAX_LADUNGEN", 3)),
        hg_pause_s=max(0, _zahl("KI_HG_PAUSE_S", 600)),
        hg_neu_pruefen_s=max(10, _zahl("KI_HG_NEU_PRUEFEN_S", 300)),
        hg_schritt_max_s=max(30, _zahl("KI_HG_SCHRITT_MAX_S", 600)),
        hg_threads_nacht=max(1, _zahl("KI_HG_THREADS_NACHT", 10)),
        hg_threads_tag=max(1, _zahl("KI_HG_THREADS_TAG", 6)),
        hg_num_ctx=max(2048, _zahl("KI_HG_NUM_CTX", 16384)),
        nacht_start=_text("KI_NACHT_START", "19:00"),
        tag_start=_text("KI_TAG_START", "07:00"),
        hg_slice_dir=Path(_text("KI_HG_SLICE_DIR", "/ki-slice")),
        tiefe_aktiv=_schalter("KI_TIEFE_AKTIV"),
        tiefe_max_h=max(0.1, _kommazahl("KI_TIEFE_MAX_H", 3.0)),
        tiefe_ocr_seiten=max(1, _zahl("KI_TIEFE_OCR_SEITEN", 30)),
        tiefe_max_zeichen=max(10_000, _zahl("KI_TIEFE_MAX_ZEICHEN", 300_000)),
        suche_aktiv=_schalter("KI_SUCHE_AKTIV"),
        archiv_frage_aktiv=_schalter("KI_ARCHIV_FRAGE_AKTIV"),
        lernen_aktiv=_schalter("KI_LERNEN_AKTIV"),
        build=_text("KI_BUILD", "dev"),
        job_fristen=_schalter("KI_JOB_FRISTEN"),
        job_zz=_schalter("KI_JOB_ZZ"),
        job_selbsttest=_schalter("KI_JOB_SELBSTTEST"),
        job_zz_max=max(0, _zahl("KI_JOB_ZZ_MAX", 200)),
        selbsttest_zeit=_text("KI_SELBSTTEST_ZEIT", "05:30"),
        selbsttest_n=max(1, _zahl("KI_SELBSTTEST_N", 40)),
        kontext_max_alter_s=max(60, _zahl("KI_KONTEXT_MAX_ALTER_S", 3600)),
        technik_aktiv=_text("KI_TECHNIK_AKTIV", "1").lower() in ("1", "true", "ja", "on"),
        technik_datei=Path(_text("KI_TECHNIK_DATEI", str(data_dir / "technik" / "stand.json"))),
        kuehlung_wunsch=Path(_text("KI_KUEHLUNG_WUNSCH", str(data_dir / "steuerung" / "luefter_profil"))),
        sicherheit_aktiv=_text("KI_SICHERHEIT_AKTIV", "1").lower() in ("1", "true", "ja", "on"),
    )


EINSTELLUNGEN = laden()
