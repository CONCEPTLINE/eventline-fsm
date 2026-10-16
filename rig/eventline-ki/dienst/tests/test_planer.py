"""Planer des Hauptmodells (Masterplan §2.3, §2.4): Tag/Nacht-Grenzen, Tor am Stück, Hysterese, Leiter,
Ladeabstand (statt Tagesgrenze), Pause nach dem Wächter, OOM-Sperre, nur freigegebene Modelle. Reine Logik, ohne Rig.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_planer.py
"""

from __future__ import annotations

import dataclasses
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import laden, modell_leiter  # noqa: E402
from app.planer import NACHT, TAG, Planer  # noqa: E402
from app.speicher import GIB, Messung  # noqa: E402

ZH = ZoneInfo("Europe/Zurich")
GROSS, KLEIN = "gemma4:26b-a4b-it-qat", "gemma4:12b-it-qat"
LEITER = ((GROSS, 17.0), (KLEIN, 10.0))
BEIDE = [GROSS, KLEIN]
WAND = 1_800_000_000.0


def _zeit(h: int, m: int, tag: int = 12) -> datetime:
    return datetime(2026, 10, tag, h, m, tzinfo=ZH)


def _messung(belegt_gb: float, verfuegbar_gb: float = 30.0) -> Messung:
    return Messung(zeit=0.0, mem_available=int(verfuegbar_gb * GIB), slice_current=int(belegt_gb * GIB),
                   slice_inactive_file=0, slice_max=22 * GIB)


OFFEN = _messung(2.0)            # 2 + 17 ≤ 22 → beide offen
NUR_KLEIN = _messung(8.0)        # 8 + 17 > 22, 8 + 10 ≤ 22
ZU = _messung(15.0)              # beide zu


def _planer(**k) -> Planer:
    """Ohne Ladeabstand, wo er nicht das Thema ist (eigene Tests unten mit dem Standard 900 s)."""
    return Planer(**{"leiter": LEITER, "lade_abstand_s": 0.0, **k})


def _nacht(p: Planer, h: int = 21, m: int = 0, tag: int = 11):
    return p.lage(_zeit(h, m, tag))


def _bis(p: Planer, m: Messung, inst, lage, von: float, bis: float, wand: float = WAND, nur: tuple[str, ...] = ()):
    """Wie im Betrieb alle 10 s messen; vor «bis» darf nichts gewählt werden. Liefert die Wahl bei «bis»."""
    t = von
    while t < bis:
        w = p.waehle(m, inst, lage, jetzt_mono=t, jetzt_wand=wand, nur=nur)
        assert w.modell is None, f"zu früh gewählt bei t={t}: {w}"
        t += 10
    return p.waehle(m, inst, lage, jetzt_mono=bis, jetzt_wand=wand, nur=nur)


def test_modus_grenzen() -> None:
    p = _planer()
    assert p.modus(_zeit(6, 59)) == NACHT
    assert p.modus(_zeit(7, 0)) == TAG
    assert p.modus(_zeit(18, 59)) == TAG
    assert p.modus(_zeit(19, 0)) == NACHT
    assert p.modus(_zeit(0, 0)) == NACHT and p.modus(_zeit(12, 0)) == TAG


def test_fenster_und_threads() -> None:
    p = _planer(tag_aktiv=False)
    abend, morgen = p.lage(_zeit(19, 0, 11)), p.lage(_zeit(6, 0, 12))
    assert abend.fenster == morgen.fenster == "2026-10-11/nacht", "eine Nacht = ein Fenster über Mitternacht"
    assert abend.threads == 10 and abend.erlaubt
    tag = p.lage(_zeit(7, 0, 12))
    assert tag.modus == TAG and tag.fenster == "2026-10-12/tag" and tag.threads == 4, "tagsüber 4 Threads (Messung 16.10.)"
    assert not tag.erlaubt and tag.grund == "tag_aus", "KI_HG_TAG=0: tagsüber kein Hauptmodell"
    assert _planer(tag_aktiv=True).lage(_zeit(18, 59)).erlaubt


def test_vor_tagesbeginn_entladen() -> None:
    p = _planer()
    assert p.lage(_zeit(6, 44)).erlaubt
    spaet = p.lage(_zeit(6, 45))
    assert not spaet.erlaubt and spaet.grund == "vor_tag" and spaet.modus == NACHT
    assert not p.lage(_zeit(6, 59)).erlaubt


def test_tor_zwei_minuten_am_stueck() -> None:
    p = _planer()
    lage = _nacht(p)
    w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND)
    assert w.modell is None and w.grund == "tor_warten"
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=60, jetzt_wand=WAND).modell is None
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=110, jetzt_wand=WAND).modell is None
    w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=120, jetzt_wand=WAND)
    assert w.modell == GROSS and w.bedarf_gb == 17.0 and w.grund == "tor_offen"


def test_tor_unterbrochen_beginnt_neu() -> None:
    p = _planer()
    lage = _nacht(p)
    p.waehle(OFFEN, BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND)
    p.waehle(OFFEN, BEIDE, lage, jetzt_mono=50, jetzt_wand=WAND)
    zu = p.waehle(ZU, BEIDE, lage, jetzt_mono=60, jetzt_wand=WAND)
    assert zu.modell is None and zu.grund == "tor_zu" and zu.tor == "budget"
    assert _bis(p, OFFEN, BEIDE, lage, 70, 190).modell == GROSS, "neu ab 70 s"


def test_tor_messluecke_zaehlt_nicht_als_am_stueck() -> None:
    p = _planer()
    lage = _nacht(p)
    p.waehle(OFFEN, BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND)
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=400, jetzt_wand=WAND).modell is None, "400 s ohne Messung"


def test_leiter_wartet_30_min_dann_rueckfall_fuer_die_nacht() -> None:
    p = _planer()
    lage = _nacht(p)
    t = 0.0
    while t < 1800:
        w = p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND)
        assert w.modell is None, f"in den ersten 30 min nur aufs 26B warten (t={t})"
        t += 10
    # Ab 30 min: Rückfall, 12B-Tor muss noch 2 min am Stück offen sein.
    assert p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=1800, jetzt_wand=WAND).modell is None
    assert p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=1860, jetzt_wand=WAND).modell is None
    w = p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=1920, jetzt_wand=WAND)
    assert w.modell == KLEIN and w.bedarf_gb == 10.0
    p.ladung_beginnt(KLEIN, 1920)
    # Später in derselben Nacht öffnet das 26B-Tor — es bleibt beim 12B («für diese Nacht»).
    for s in range(0, 200, 10):
        w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=2000 + s, jetzt_wand=WAND)
    assert w.modell == KLEIN
    assert p.status(2200, WAND)["rueckfall"] is True
    # Nächste Nacht: wieder zuerst das 26B.
    morgen = _nacht(p, tag=12)
    assert _bis(p, OFFEN, BEIDE, morgen, 90_000, 90_120).modell == GROSS


def test_leiter_kein_rueckfall_wenn_26b_einmal_lud() -> None:
    p = _planer()
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == GROSS
    p.ladung_beginnt(GROSS, 120)
    for t in range(200, 4000, 10):
        w = p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND)
        assert w.modell is None, "26B war offen — kein Wechsel auf 12B"


def test_leiter_ohne_installiertes_26b() -> None:
    p = _planer()
    lage = _nacht(p)
    w = _bis(p, OFFEN, [KLEIN + ":latest"], lage, 0, 120)
    assert w.modell == KLEIN, "fehlt das 26B, ist das 12B die erste Stufe"
    assert p.waehle(OFFEN, [], lage, jetzt_mono=130, jetzt_wand=WAND).grund == "kein_modell"


def test_ladeabstand_statt_tagesgrenze() -> None:
    """16.10.2026: statt höchstens 3 Ladungen je Fenster ein Mindestabstand (15 min) zwischen dem Beginn zweier
    Ladevorgänge — Arbeit wartet nie bis zum nächsten Fenster, Lade-Flattern bleibt ausgeschlossen."""
    p = Planer(leiter=LEITER, tag_aktiv=True)
    assert p.lade_abstand_s == 900.0 and p.lade_abstand() == 900.0
    tag = p.lage(_zeit(8, 0, 16))
    t = 0.0
    for i in range(6):   # sechs Ladungen im selben Tagesfenster — früher war nach der dritten bis 19:00 Schluss
        assert _bis(p, OFFEN, BEIDE, tag, t, t + 120).modell == GROSS, i
        p.ladung_beginnt(GROSS, t + 120, WAND + t + 120)
        p.schritt_fertig()
        for s in (1, 300, 899):   # innerhalb von 15 min nach dem Beginn der Ladung: nicht nochmals laden
            w = p.waehle(OFFEN, BEIDE, tag, jetzt_mono=t + 120 + s, jetzt_wand=WAND)
            assert w.modell is None and w.grund == "ladeabstand", (i, s, w)
        assert p.status(t + 120 + 300, WAND)["lade_rest_s"] == 600
        t += 120 + 900
    assert p.status(t, WAND)["ladungen"] == 6 and p.status(t, WAND)["lade_abstand_s"] == 900
    # Grundwert aus der env (KI_HG_LADE_ABSTAND_S), 0 = ohne Abstand.
    assert Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER, hg_lade_abstand_s=600)).lade_abstand_s == 600.0
    assert Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER)).lade_abstand_s == 900.0


def test_ladeabstand_verdoppelt_nach_fehlschlag() -> None:
    """Schutz gegen Flattern: jeder Fehlschlag (Laden gescheitert, Wächter, OOM) verdoppelt den Abstand bis 8× (2 h), ein
    fertiger Schritt setzt ihn zurück."""
    p = Planer(leiter=LEITER, pause_s=0.0)
    lage = _nacht(p)
    p.ladung_beginnt(GROSS, 0.0, WAND)
    p.fehlschlag()                                   # Laden gescheitert
    assert p.lade_abstand() == 1800.0
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1799, jetzt_wand=WAND).grund == "ladeabstand"
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1800, jetzt_wand=WAND).grund == "tor_warten"
    p.ladung_beginnt(GROSS, 2000.0, WAND)
    p.pausiere(2100.0, WAND)                         # Wächter
    assert p.lade_abstand() == 3600.0 and p.status(2100, WAND)["fehlschlaege"] == 2
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=2000 + 3599, jetzt_wand=WAND).grund == "ladeabstand"
    p.sperre(KLEIN, WAND)                            # OOM eines anderen Modells zählt ebenso
    for _ in range(6):
        p.fehlschlag()
    assert p.lade_abstand() == 900.0 * 8, "höchstens 2 h"
    p.schritt_fertig()
    assert p.lade_abstand() == 900.0 and p.status(0, WAND)["fehlschlaege"] == 0


def test_tag_nach_drei_ladungen_und_neustart_laedt_wieder() -> None:
    """Fall 16.10.2026: bis 09:33 drei Ladungen (12B-Rückfall 08:15, 26B 09:16 und 09:33 nach zwei Deploys). Mit der
    alten Grenze ruhte das 26B nach dem nächsten Neustart bis 19:00, obwohl der Speicher frei war — jetzt lädt es wieder,
    sobald der Abstand seit der letzten Ladung um ist."""
    gespeichert: list[dict] = []
    p = Planer(leiter=LEITER, tag_aktiv=True, zustand_gespeichert=gespeichert.append)
    tag = p.lage(_zeit(8, 0, 16))
    for uhr in (8 * 3600 + 900, 9 * 3600 + 960, 9 * 3600 + 1980):   # 08:15, 09:16, 09:33
        p.waehle(OFFEN, BEIDE, tag, jetzt_mono=float(uhr), jetzt_wand=WAND + uhr)
        p.ladung_beginnt(GROSS, float(uhr), WAND + uhr)
        p.schritt_fertig()
    assert p.status(0, WAND)["ladungen"] == 3
    # Neustart des Dienstes um 12:30 (neue monotonic-Basis): Zustand aus dem Tresor.
    p2 = Planer(leiter=LEITER, tag_aktiv=True)
    p2.wiederherstellen(json_rund(gespeichert[-1]), jetzt_mono=10.0, jetzt_wand=WAND + 12.5 * 3600)
    mittag = p2.lage(_zeit(12, 30, 16))
    w = _bis(p2, OFFEN, BEIDE, mittag, 10.0, 130.0, wand=WAND + 12.5 * 3600)
    assert w.modell == GROSS, w
    # Neustart 5 min nach einer Ladung: der Abstand gilt weiter (ein Neustart hebt ihn nicht auf).
    p3 = Planer(leiter=LEITER, tag_aktiv=True)
    p3.wiederherstellen(json_rund(gespeichert[-1]), jetzt_mono=50.0, jetzt_wand=WAND + 9 * 3600 + 1980 + 300)
    assert p3.waehle(OFFEN, BEIDE, tag, jetzt_mono=50.0, jetzt_wand=WAND).grund == "ladeabstand"
    assert p3.status(50.0, WAND)["lade_rest_s"] == 600
    assert p3.waehle(OFFEN, BEIDE, tag, jetzt_mono=650.0, jetzt_wand=WAND).grund == "tor_warten"


def test_pause_nach_waechter_und_5_min_tor() -> None:
    p = _planer(pause_s=600)
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == GROSS
    p.ladung_beginnt(GROSS, 120)
    p.pausiere(1000)
    for t in range(1000, 1600, 10):
        assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND).grund == "pause", t
    # Ab 1600: Tor muss 5 min am Stück offen sein.
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1600, jetzt_wand=WAND).grund == "tor_warten"
    for t in range(1610, 1900, 10):
        assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND).modell is None, t
    w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1900, jetzt_wand=WAND)
    assert w.modell == GROSS
    p.ladung_beginnt(GROSS, 1900)
    assert p.status(1900, WAND)["ladungen"] == 2, "Wiederaufnahme zählt als Ladung"
    assert p.status(1900, WAND)["fehlschlaege"] == 1, "der Wächter-Abbruch ist ein Fehlschlag (Ladeabstand)"


def test_oom_sperre_24h() -> None:
    gespeichert: list[dict] = []
    p = _planer(sperren_gespeichert=gespeichert.append)
    lage = _nacht(p)
    p.sperre(GROSS, WAND)
    assert gespeichert and GROSS in gespeichert[-1], "Sperre wird im Tresor gespeichert"
    assert p.gesperrt(GROSS, WAND + 3600) and not p.gesperrt(GROSS, WAND + 24 * 3600)
    w = _bis(p, OFFEN, BEIDE, lage, 0, 120, wand=WAND + 180)
    assert w.modell == KLEIN, "gesperrtes 26B → nächste Stufe sofort"
    assert GROSS in p.status(120, WAND + 180)["gesperrt"]
    # Nach 24 h ist das 26B wieder erste Wahl.
    p2 = _planer(sperren=dict(p.sperren))
    assert _bis(p2, OFFEN, BEIDE, lage, 0, 120, wand=WAND + 24 * 3600 + 1).modell == GROSS


def test_hysterese_nur_fensterende_entlaedt() -> None:
    p = _planer()
    nacht = _nacht(p)
    assert not p.soll_entladen(nacht, nacht.fenster), "volles Tor ist kein Grund zum Entladen"
    assert p.soll_entladen(p.lage(_zeit(6, 45)), nacht.fenster), "06:45: vor dem Tag entladen"
    assert p.soll_entladen(_nacht(p, tag=12), nacht.fenster), "nächste Nacht = neues Fenster"
    p.tag_aktiv = True
    assert p.soll_entladen(p.lage(_zeit(7, 0, 12)), nacht.fenster), "Moduswechsel Nacht → Tag"


def test_nicht_erlaubt_waehlt_nichts() -> None:
    p = _planer()
    tag = p.lage(_zeit(12, 0))
    assert p.waehle(OFFEN, BEIDE, tag, jetzt_mono=0, jetzt_wand=WAND).grund == "nicht_erlaubt"


def test_modell_leiter_aus_env() -> None:
    assert modell_leiter("gemma4:26b-a4b-it-qat@17,gemma4:12b-it-qat@10") == LEITER
    assert modell_leiter(" a@1.5 , kaputt, b@x, @3, c@0, d@9 ") == (("a", 1.5), ("d", 9.0))
    assert modell_leiter("") == ()
    cfg = laden()
    assert cfg.hg_aktiv is False and cfg.hg_gpu_nacht is False, "Standard: Hauptmodell aus"
    # Seit 16.10.2026 («die KI arbeitet, wenn sie etwas zu tun hat»): ist das Hauptmodell an, rechnet es auch tagsüber —
    # mit 4 Threads (gemessen 16.10.) und erst nach 2 min Ruhe; Indexe tagsüber alle 30 min.
    assert cfg.hg_tag is True and cfg.hg_threads_tag == 4 and cfg.hg_ruhe_tag_s == 120 and cfg.index_tag_abstand_s == 1800
    assert Planer.aus_cfg(dataclasses.replace(cfg, hg_modelle=LEITER)).tag_aktiv is True
    assert cfg.hg_num_ctx == 16384 and cfg.hg_lade_abstand_s == 900 and cfg.hg_pause_s == 600
    assert not hasattr(cfg, "hg_max_ladungen"), "die feste Grenze je Fenster ist weg (16.10.2026)"
    p = Planer.aus_cfg(dataclasses.replace(cfg, hg_modelle=LEITER, nacht_start="20:30", tag_start="kaputt"))
    assert p.nacht_start == (20, 30) and p.tag_start == (7, 0) and p.leiter == LEITER


def test_nur_freigegebene_kein_rueckfall() -> None:
    """16.10.2026: verlangt die Arbeit bestimmte Modelle (zweiter Blick: nur das gemessene 26B), gibt es keinen Rückfall —
    auch nicht nach 30 min geschlossenem Tor; ist das freigegebene gesperrt, wird nichts geladen."""
    p = _planer()
    lage = _nacht(p)
    zu = _messung(4.0)   # 26B: zu, 12B: offen
    assert p.waehle(zu, BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND, nur=(GROSS,)).grund == "tor_zu"
    w = p.waehle(zu, BEIDE, lage, jetzt_mono=p.rueckfall_nach_s + 1, jetzt_wand=WAND, nur=(GROSS,))
    assert w.modell is None and w.grund == "tor_zu" and p.status(0, WAND)["rueckfall"] is False
    p.sperre(GROSS, WAND)
    assert p.waehle(_messung(1.0), BEIDE, lage, jetzt_mono=p.rueckfall_nach_s + 2, jetzt_wand=WAND,
                    nur=(GROSS,)).grund == "freigegeben_fehlt"
    # Andere Arbeit fällt weiter auf das 12B zurück.
    assert p.waehle(_messung(1.0), BEIDE, lage, jetzt_mono=p.rueckfall_nach_s + 3, jetzt_wand=WAND).grund in ("tor_offen", "tor_warten")


def test_nur_freigegebene_auch_wenn_das_12b_oben_in_der_leiter_steht() -> None:
    """Falsch konfigurierte Leiter (12B zuoberst): der zweite Blick nimmt trotzdem nie das 12B, sondern das freigegebene
    26B — die Freigabe hängt nicht an der Reihenfolge in KI_HG_MODELLE."""
    p = _planer(leiter=((KLEIN, 10.0), (GROSS, 17.0)))
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == KLEIN, "ohne Vorgabe: oberstes der Leiter"
    p2 = _planer(leiter=((KLEIN, 10.0), (GROSS, 17.0)))
    w = _bis(p2, OFFEN, BEIDE, lage, 0, 120, nur=(GROSS,))
    assert w.modell == GROSS and w.bedarf_gb == 17.0, w
    nur_12b_installiert = p2.waehle(OFFEN, [KLEIN], lage, jetzt_mono=130, jetzt_wand=WAND, nur=(GROSS,))
    assert nur_12b_installiert.modell is None and nur_12b_installiert.grund == "freigegeben_fehlt"
    # 26B-Tor zu, 12B-Tor offen: es wird gewartet, nie das 12B genommen (auch nach 30 min nicht).
    p3 = _planer(leiter=((KLEIN, 10.0), (GROSS, 17.0)))
    for t in range(0, int(p3.rueckfall_nach_s) + 300, 10):
        assert p3.waehle(_messung(4.0), BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND, nur=(GROSS,)).modell is None, t


def test_puffer_im_tor() -> None:
    # Kalibriert 16.10.2026: Puffer 2 (vorher 3). 2,4 GB belegt (Median nach einem Entladen) → 26B lädt wieder;
    # 3,5 GB → zu. Puffer aus der env.
    p = _planer()
    assert p.puffer_gb == 2.0 and p.reserve_gb == 2.0
    lage = _nacht(p)
    assert p.waehle(_messung(2.4), BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND).grund == "tor_warten"
    w = p.waehle(_messung(3.5), BEIDE, lage, jetzt_mono=10, jetzt_wand=WAND)
    assert w.grund == "tor_zu" and w.tor == "budget", w
    assert Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER, hg_puffer_gb=1.5)).puffer_gb == 1.5
    assert laden().hg_puffer_gb == 2.0
    # Reserve für Trust one: MemAvailable < Bedarf + 2 × KI_HG_NOT_GB → zu.
    w = _planer().waehle(_messung(1.3, verfuegbar_gb=18.0), [GROSS], lage, jetzt_mono=0, jetzt_wand=WAND)
    assert w.grund == "tor_zu" and w.tor == "verfuegbar", w
    assert Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER, hg_not_gb=1.5)).reserve_gb == 3.0


def test_sperre_selbsttest() -> None:
    from app.planer import sperrfenster

    assert sperrfenster("05:25-05:50") == ((5, 25), (5, 50)) and sperrfenster("") is None
    assert sperrfenster("kaputt") is None and sperrfenster("05:25-05:25") is None and sperrfenster("25:00-05:50") is None
    p = Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER))
    assert p.sperrzeit == ((5, 25), (5, 50)), "Standard KI_HG_SPERRE"
    assert not p.in_sperre(_zeit(5, 24)) and p.in_sperre(_zeit(5, 25)) and p.in_sperre(_zeit(5, 49))
    assert not p.in_sperre(_zeit(5, 50))
    assert p.lage(_zeit(5, 30)).erlaubt, "die Lage (Nachtarbeit, Selbsttest) bleibt erlaubt — sperren tut nur der Hintergrund"
    ueber = _planer(sperrzeit=((23, 50), (0, 10)))
    assert ueber.in_sperre(_zeit(23, 55)) and ueber.in_sperre(_zeit(0, 5)) and not ueber.in_sperre(_zeit(0, 10))
    assert not _planer().in_sperre(_zeit(5, 30)), "ohne Sperre nie gesperrt"


def test_zustand_ueberlebt_neustart() -> None:
    gespeichert: list[dict] = []
    p = _planer(pause_s=600, lade_abstand_s=150.0, zustand_gespeichert=gespeichert.append)
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == GROSS
    p.ladung_beginnt(GROSS, 100, WAND + 100)
    p.ladung_beginnt(GROSS, 120, WAND + 120)
    p.pausiere(200, WAND + 200)
    z = gespeichert[-1]
    assert z["fenster"] == lage.fenster and z["ladungen"] == 2 and z["pause_bis"] == WAND + 800, z
    assert z["letzte_ladung"] == WAND + 120 and z["fehlschlaege"] == 1, z
    # Neustart 100 s später (neue monotonic-Basis): gleiche Ladungen, Pause, Fehlschlag und Ladeabstand laufen weiter.
    p2 = _planer(pause_s=600, lade_abstand_s=150.0)
    p2.wiederherstellen(json_rund(z), jetzt_mono=5.0, jetzt_wand=WAND + 300)
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=5.0, jetzt_wand=WAND + 300).grund == "pause"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=504.0, jetzt_wand=WAND + 799).grund == "pause"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=506.0, jetzt_wand=WAND + 801).grund == "tor_warten"
    assert p2.status(506, WAND)["fehlschlaege"] == 1 and p2.lade_abstand() == 300.0
    p2.ladung_beginnt(GROSS, 600, WAND + 895)
    assert p2.status(600, WAND)["ladungen"] == 3, "keine feste Grenze mehr — weiter gezählt, nicht gesperrt"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=899, jetzt_wand=WAND + 1194).grund == "ladeabstand"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=900, jetzt_wand=WAND + 1195).grund == "tor_warten"
    # Gespeicherter Zustand einer früheren Nacht: neues Fenster beginnt bei 0.
    p3 = _planer()
    p3.wiederherstellen({**z, "pause_bis": 0, "nach_pause": False}, jetzt_mono=0, jetzt_wand=WAND)
    morgen = _nacht(p3, tag=12)
    assert _bis(p3, OFFEN, BEIDE, morgen, 0, 120).modell == GROSS and p3.status(120, WAND)["ladungen"] == 0
    # Datei eines älteren Builds (ohne letzte Ladung/Fehlschläge): kein Abstand, kein Absturz.
    p5 = Planer(leiter=LEITER)
    p5.wiederherstellen({"fenster": lage.fenster, "ladungen": 3, "pause_bis": 0}, jetzt_mono=0, jetzt_wand=WAND)
    assert p5.lade_rest_s(0) == 0 and p5.status(0, WAND)["fehlschlaege"] == 0
    # Kaputte Datei → nichts übernommen, kein Absturz.
    p4 = _planer()
    p4.wiederherstellen({"fenster": 5, "ladungen": "x"}, jetzt_mono=0, jetzt_wand=WAND)
    p4.wiederherstellen({"fenster": "f", "letzte_ladung": "kaputt"}, jetzt_mono=0, jetzt_wand=WAND)
    p4.wiederherstellen(None, jetzt_mono=0, jetzt_wand=WAND)
    assert p4.status(0, WAND)["ladungen"] == 0 and p4.lade_rest_s(0) == 0


def test_rueckfall_ueberlebt_neustart() -> None:
    gespeichert: list[dict] = []
    p = _planer(zustand_gespeichert=gespeichert.append)
    lage = _nacht(p)
    for t in range(0, 1810, 10):
        p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND + t)
    assert gespeichert[-1]["rueckfall"] is True
    p2 = _planer()
    p2.wiederherstellen(json_rund(gespeichert[-1]), jetzt_mono=0, jetzt_wand=WAND + 1900)
    assert _bis(p2, OFFEN, BEIDE, lage, 0, 120, wand=WAND + 1900).modell == KLEIN, "Rückfall gilt weiter"


def json_rund(d: dict) -> dict:
    import json

    return json.loads(json.dumps(d))


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    fehler = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok      {name}")
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"FEHLER  {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - fehler}/{len(tests)} bestanden")
    sys.exit(1 if fehler else 0)
