"""Speicher-Messung, Speicher-Tor und Wächter-Regeln für das Hauptmodell (Masterplan §2.4, §2.5).

Nur Zahlen, nie Inhalte. Quellen:
- /proc/meminfo (MemAvailable, SwapFree) — im Container der Host-Wert (kein lxcfs, geprüft in E2.0),
- /proc/pressure/memory (PSI «full avg10») und /proc/vmstat (pgmajfault) — systemweit,
- das Cgroup-Verzeichnis des KI-Slices system-eventlineki.slice, nur lesend eingebunden
  (docker-compose.yml → KI_HG_SLICE_DIR): memory.current, memory.max, memory.stat, memory.swap.current.

Tor: ein Modell darf laden, wenn
  nicht rückgewinnbarer Speicher des Slices + Bedarf + Puffer (KI_HG_PUFFER_GB) ≤ KI-Budget (memory.max des
  Slices, sonst 22 GB)
und MemAvailable ≥ Bedarf + 2 × KI_HG_NOT_GB (seit 16.10.2026; vorher Bedarf / 2 = «KI hat Vorrang, Trust one
weicht»). «Nicht rückgewinnbar» = was Prozesse wirklich halten: anon + shmem + Kernel + eingeblendete Dateien
(file_mapped) = memory.current − inactive_file − active_file + file_mapped. In cgroup v2 zählt memory.current auch den
Seitencache (GGUF-, OCR-, NAS-, DB-Dateien), den der Kernel beim Laden ohnehin verdrängt. Bis 16.10.2026 galt
memory.current − inactive_file — der AKTIVE Seitencache zählte als belegt: tagsüber (Suche, Ablage, Index) und nach
jedem Neustart des Dienstes (der Cache des alten Containers hängt am Slice) lag er bei 2,3 GB, das Tor des 26B (3 GB
Spielraum) blieb geschlossen, obwohl Prozesse nur 2,5 GB hielten (gemessen 16.10. 09:10: anon 0,56, shmem 0,78, Kernel
0,08, eingeblendet 1,04 GB). Eingeblendete Dateien (laufende Programme, Modelle per mmap) zählen weiter voll.
Fehlt active_file oder file_mapped in memory.stat: wie bis 16.10. Der Puffer ist
der Platz, den Ablage, Beleg und Diktat neben dem geladenen Hauptmodell im Slice brauchen. Wie lange das Tor am
Stück offen sein muss, entscheidet der Planer.

Wächter: schützt den Rig vor dem Stocken und die wartenden KI-Aufträge vor dem Hauptmodell. Auslöser einzeln:
- ganzer Rig: MemAvailable < KI_HG_NOT_GB, PSI full avg10 > 30, pgmajfault 10 s lang über 3000/s;
- KI-Slice: Budget − nicht rückgewinnbar < KI_HG_NOT_GB («ki_knapp»), oder Swap des Slices seit Beginn der
  Überwachung um mehr als SLICE_SWAP_ANSTIEG gewachsen («ki_swap»). Grund: das Hauptmodell darf nicht auslagern
  (memswap = mem); läuft der Slice voll, lagert der Kernel sonst Ablage, Diktat und DB aus, während der Rig als
  Ganzes (MemAvailable, PSI, Seitenfehler) ruhig aussieht.
- seit 16.10.2026 (zweiter Blick nachts mit dem 26B, Mischa: «Trust one darf nicht verdrängt werden, kein
  Auslagern»): Swap des ganzen Rigs (SwapTotal − SwapFree) seit Beginn der Überwachung um mehr als 256 MB gewachsen
  («rig_swap») — so wird auch ein Auslagern von Trust one bemerkt. Das Tor verlangt dafür vor dem Laden MemAvailable ≥
  Bedarf + 2 × KI_HG_NOT_GB (Planer, reserve_gb), statt wie bis dahin Bedarf/2.
memory.events «max» taugt nicht: der Seitencache füllt den Slice ohnehin bis an die Grenze (gemessen > 200 000
Ereignisse ohne Not).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

GIB = 1024 ** 3
# Budget der EVENTLINE-KI (Entscheid E2, Mischa 11.10.2026), falls memory.max des Slices nicht lesbar ist.
KI_BUDGET_GB = 22.0
PSI_FULL_MAX = 30.0
MAJFAULT_PRO_S = 3000.0
MAJFAULT_DAUER_S = 10.0
# Wächst der Swap des KI-Slices während der Überwachung um mehr als das, lagert der Kernel KI-Dienste aus.
SLICE_SWAP_ANSTIEG = 256 * 1024 ** 2


@dataclass(frozen=True)
class Quellen:
    meminfo: Path = Path("/proc/meminfo")
    vmstat: Path = Path("/proc/vmstat")
    psi: Path = Path("/proc/pressure/memory")
    slice_dir: Path = Path("/ki-slice")


@dataclass(frozen=True)
class Messung:
    """Ein Messpunkt in Byte (None = nicht lesbar). zeit = time.monotonic() der Messung."""

    zeit: float
    mem_available: int | None = None
    swap_free: int | None = None
    swap_total: int | None = None
    slice_current: int | None = None
    slice_max: int | None = None
    slice_anon: int | None = None
    slice_active_file: int | None = None
    slice_inactive_file: int | None = None
    slice_file_mapped: int | None = None
    slice_swap: int | None = None
    psi_full_avg10: float | None = None
    pgmajfault: int | None = None

    @property
    def nicht_rueckgewinnbar(self) -> int | None:
        """anon + shmem + Kernel + eingeblendete Dateien (Seitencache zählt nicht, ausser er ist eingeblendet)."""
        if self.slice_current is None or self.slice_inactive_file is None:
            return None
        ohne_inaktiv = max(0, self.slice_current - self.slice_inactive_file)
        if self.slice_active_file is None or self.slice_file_mapped is None:
            return ohne_inaktiv
        return min(ohne_inaktiv, max(0, ohne_inaktiv - self.slice_active_file + self.slice_file_mapped))

    @property
    def budget(self) -> int:
        if self.slice_max is not None and self.slice_max > 0:
            return self.slice_max
        return int(KI_BUDGET_GB * GIB)

    @property
    def swap_belegt(self) -> int | None:
        """Ausgelagerter Speicher des ganzen Rigs (SwapTotal − SwapFree) — Trust one eingeschlossen."""
        if self.swap_total is None or self.swap_free is None:
            return None
        return max(0, self.swap_total - self.swap_free)


def _lies(pfad: Path) -> str | None:
    try:
        return pfad.read_text(encoding="ascii", errors="replace")
    except OSError:
        return None


def _schluessel_werte(text: str | None) -> dict[str, int]:
    """«name wert» bzw. «Name: wert kB» je Zeile → {name: wert} (kB werden in Byte umgerechnet)."""
    werte: dict[str, int] = {}
    for zeile in (text or "").splitlines():
        teile = zeile.replace(":", " ").split()
        if len(teile) < 2:
            continue
        try:
            wert = int(teile[1])
        except ValueError:
            continue
        if len(teile) >= 3 and teile[2].lower() == "kb":
            wert *= 1024
        werte[teile[0]] = wert
    return werte


def _zahl(text: str | None) -> int | None:
    """Inhalt von memory.current/memory.max → Byte; «max» (unbegrenzt) und Unlesbares → None."""
    if text is None:
        return None
    wert = text.strip()
    try:
        return int(wert)
    except ValueError:
        return None


def psi_full_avg10(text: str | None) -> float | None:
    for zeile in (text or "").splitlines():
        if not zeile.startswith("full"):
            continue
        for teil in zeile.split():
            if teil.startswith("avg10="):
                try:
                    return float(teil[6:])
                except ValueError:
                    return None
    return None


def messen(q: Quellen, *, zeit: float | None = None) -> Messung:
    mem = _schluessel_werte(_lies(q.meminfo))
    vm = _schluessel_werte(_lies(q.vmstat))
    stat = _schluessel_werte(_lies(q.slice_dir / "memory.stat"))
    return Messung(
        zeit=time.monotonic() if zeit is None else zeit,
        mem_available=mem.get("MemAvailable"),
        swap_free=mem.get("SwapFree"),
        swap_total=mem.get("SwapTotal"),
        slice_current=_zahl(_lies(q.slice_dir / "memory.current")),
        slice_max=_zahl(_lies(q.slice_dir / "memory.max")),
        slice_anon=stat.get("anon"),
        slice_active_file=stat.get("active_file"),
        slice_inactive_file=stat.get("inactive_file"),
        slice_file_mapped=stat.get("file_mapped"),
        slice_swap=_zahl(_lies(q.slice_dir / "memory.swap.current")),
        psi_full_avg10=psi_full_avg10(_lies(q.psi)),
        pgmajfault=vm.get("pgmajfault"),
    )


@dataclass(frozen=True)
class TorBefund:
    offen: bool
    # «offen», «budget» (Slice + Bedarf + Puffer > Budget), «verfuegbar» (MemAvailable < Bedarf/2),
    # «unbekannt» (nicht lesbar)
    grund: str


def tor(m: Messung, bedarf_gb: float, puffer_gb: float = 0.0, reserve_gb: float | None = None) -> TorBefund:
    """Speicher-Tor für ein Modell mit diesem Bedarf (Momentaufnahme; «am Stück» prüft der Planer).
    puffer_gb: Platz, der neben dem geladenen Modell im Slice frei bleiben muss (KI_HG_PUFFER_GB).
    reserve_gb (Planer, seit 16.10.2026: 2 × KI_HG_NOT_GB): MemAvailable muss Bedarf + Reserve decken — das Laden nimmt
    sich dann nur freien Speicher und Seitencache, nie Trust one (kein Verdrängen, kein Auslagern). Ohne reserve_gb gilt
    die frühere Regel «MemAvailable ≥ Bedarf/2» (KI-Vorrang, Trust one durfte weichen).
    Nicht lesbare Werte schliessen das Tor — lieber nicht laden als blind."""
    bedarf = int(bedarf_gb * GIB)
    puffer = int(max(0.0, puffer_gb) * GIB)
    belegt = m.nicht_rueckgewinnbar
    if belegt is None or m.mem_available is None:
        return TorBefund(False, "unbekannt")
    if belegt + bedarf + puffer > m.budget:
        return TorBefund(False, "budget")
    noetig = bedarf / 2 if reserve_gb is None else bedarf + max(0.0, reserve_gb) * GIB
    if m.mem_available < noetig:
        return TorBefund(False, "verfuegbar")
    return TorBefund(True, "offen")


def leicht_frei(m: Messung, not_gb: float) -> bool:
    """«Arbeiten, wenn frei» (Nachtarbeit mit dem schnellen Modell, auch tagsüber): kein neuer Schritt, solange der Rig
    in Speichernot ist — dieselben Grenzen wie der Wächter, beim Rig als Ganzes mit doppeltem Abstand
    (MemAvailable < 2 × KI_HG_NOT_GB, PSI full avg10 > 30, KI-Slice mit weniger als KI_HG_NOT_GB Luft). Nicht lesbare
    Werte zählen NICHT als Not: die Nachtarbeit lief bis 15.10. ganz ohne Speicher-Prüfung, und ohne eingebundenes
    Slice-Verzeichnis (Entwicklung, Tests) soll sie nicht für immer stehen."""
    grenze = max(0.0, not_gb) * GIB
    if m.mem_available is not None and m.mem_available < 2 * grenze:
        return False
    if m.psi_full_avg10 is not None and m.psi_full_avg10 > PSI_FULL_MAX:
        return False
    belegt = m.nicht_rueckgewinnbar
    return not (belegt is not None and m.budget - belegt < grenze)


@dataclass
class WaechterRegel:
    """Auslöser des Wächters (§2.5). pruefe() bekommt alle ~2 s eine Messung und liefert den Grund oder None."""

    not_gb: float = 1.0
    psi_full_max: float = PSI_FULL_MAX
    majfault_pro_s: float = MAJFAULT_PRO_S
    majfault_dauer_s: float = MAJFAULT_DAUER_S
    slice_swap_anstieg: int = SLICE_SWAP_ANSTIEG
    # Seit 16.10.2026 (zweiter Blick, «Trust one darf nicht verdrängt werden, kein Auslagern»): wächst der Swap des
    # GANZEN Rigs (SwapTotal − SwapFree, Trust one eingeschlossen) seit Beginn der Überwachung um mehr als das → «rig_swap».
    rig_swap_anstieg: int = SLICE_SWAP_ANSTIEG
    _letzte: tuple[float, int] | None = field(default=None, init=False)
    _ueber_seit: float | None = field(default=None, init=False)
    # Kleinster Swap-Stand des Slices seit Beginn der Überwachung (Laden des Hauptmodells).
    _swap_basis: int | None = field(default=None, init=False)
    _rig_swap_basis: int | None = field(default=None, init=False)

    def zuruecksetzen(self) -> None:
        self._letzte = None
        self._ueber_seit = None
        self._swap_basis = None
        self._rig_swap_basis = None

    def pruefe(self, m: Messung) -> str | None:
        grund = None
        belegt = m.nicht_rueckgewinnbar
        if m.mem_available is not None and m.mem_available < self.not_gb * GIB:
            grund = "mem_available"
        elif m.psi_full_avg10 is not None and m.psi_full_avg10 > self.psi_full_max:
            grund = "psi"
        elif belegt is not None and m.budget - belegt < self.not_gb * GIB:
            grund = "ki_knapp"
        if self._slice_swap_waechst(m):
            grund = grund or "ki_swap"
        if self._rig_swap_waechst(m):
            grund = grund or "rig_swap"
        if self._majfault_dauerhaft(m):
            grund = grund or "pgmajfault"
        return grund

    def _slice_swap_waechst(self, m: Messung) -> bool:
        if m.slice_swap is None:
            return False
        if self._swap_basis is None or m.slice_swap < self._swap_basis:
            self._swap_basis = m.slice_swap
            return False
        return m.slice_swap - self._swap_basis > self.slice_swap_anstieg

    def _rig_swap_waechst(self, m: Messung) -> bool:
        belegt = m.swap_belegt
        if belegt is None:
            return False
        if self._rig_swap_basis is None or belegt < self._rig_swap_basis:
            self._rig_swap_basis = belegt
            return False
        return belegt - self._rig_swap_basis > self.rig_swap_anstieg

    def _majfault_dauerhaft(self, m: Messung) -> bool:
        if m.pgmajfault is None:
            # Nur den eigenen Stand zurücksetzen — die Swap-Ausgangswerte gelten weiter (16.10.2026).
            self._letzte = None
            self._ueber_seit = None
            return False
        vorher, self._letzte = self._letzte, (m.zeit, m.pgmajfault)
        if vorher is None:
            return False
        dt = m.zeit - vorher[0]
        delta = m.pgmajfault - vorher[1]
        if dt <= 0 or delta < 0:
            # Zähler zurückgesetzt oder Uhr unbrauchbar: neu anfangen.
            self._ueber_seit = None
            return False
        if delta / dt > self.majfault_pro_s:
            if self._ueber_seit is None:
                self._ueber_seit = vorher[0]
            return m.zeit - self._ueber_seit >= self.majfault_dauer_s
        self._ueber_seit = None
        return False


def bild(m: Messung) -> dict[str, float | None]:
    """Für /health: nur Zahlen in GB (eine Nachkommastelle) bzw. PSI."""

    def gb(wert: int | None) -> float | None:
        return None if wert is None else round(wert / GIB, 1)

    return {
        "verfuegbar_gb": gb(m.mem_available),
        "swap_frei_gb": gb(m.swap_free),
        "ki_slice_gb": gb(m.slice_current),
        "ki_nicht_rueckgewinnbar_gb": gb(m.nicht_rueckgewinnbar),
        "ki_anon_gb": gb(m.slice_anon),
        "ki_cache_aktiv_gb": gb(m.slice_active_file),
        "ki_budget_gb": gb(m.budget),
        "ki_swap_gb": gb(m.slice_swap),
        "psi_full_avg10": m.psi_full_avg10,
    }
