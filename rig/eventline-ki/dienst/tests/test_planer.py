"""Planer des Hauptmodells (Masterplan §2.3, §2.4): Tag/Nacht-Grenzen, Tor am Stück, Hysterese, Leiter,
Nachlade-Begrenzung, Pause nach dem Wächter, OOM-Sperre. Reine Logik, ohne Rig.

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
    return Planer(leiter=LEITER, **k)


def _nacht(p: Planer, h: int = 21, m: int = 0, tag: int = 11):
    return p.lage(_zeit(h, m, tag))


def _bis(p: Planer, m: Messung, inst, lage, von: float, bis: float, wand: float = WAND):
    """Wie im Betrieb alle 10 s messen; vor «bis» darf nichts gewählt werden. Liefert die Wahl bei «bis»."""
    t = von
    while t < bis:
        w = p.waehle(m, inst, lage, jetzt_mono=t, jetzt_wand=wand)
        assert w.modell is None, f"zu früh gewählt bei t={t}: {w}"
        t += 10
    return p.waehle(m, inst, lage, jetzt_mono=bis, jetzt_wand=wand)


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
    assert tag.modus == TAG and tag.fenster == "2026-10-12/tag" and tag.threads == 6
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
    p.ladung_beginnt(KLEIN)
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
    p.ladung_beginnt(GROSS)
    for t in range(200, 4000, 10):
        w = p.waehle(NUR_KLEIN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND)
        assert w.modell is None, "26B war offen — kein Wechsel auf 12B"


def test_leiter_ohne_installiertes_26b() -> None:
    p = _planer()
    lage = _nacht(p)
    w = _bis(p, OFFEN, [KLEIN + ":latest"], lage, 0, 120)
    assert w.modell == KLEIN, "fehlt das 26B, ist das 12B die erste Stufe"
    assert p.waehle(OFFEN, [], lage, jetzt_mono=130, jetzt_wand=WAND).grund == "kein_modell"


def test_nachlade_begrenzung() -> None:
    p = _planer(max_ladungen=3)
    lage = _nacht(p)
    t = 0.0
    for i in range(3):
        w = _bis(p, OFFEN, BEIDE, lage, t, t + 120)
        assert w.modell == GROSS, i
        p.ladung_beginnt(GROSS)
        t += 200
    w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND)
    assert w.modell is None and w.grund == "nachlade_grenze"
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t + 5000, jetzt_wand=WAND).grund == "nachlade_grenze"
    # Neues Fenster (Tag mit KI_HG_TAG=1): Zähler beginnt neu.
    p.tag_aktiv = True
    tag = p.lage(_zeit(9, 0, 12))
    assert _bis(p, OFFEN, BEIDE, tag, t + 6000, t + 6120).modell == GROSS


def test_pause_nach_waechter_und_5_min_tor() -> None:
    p = _planer(pause_s=600)
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == GROSS
    p.ladung_beginnt(GROSS)
    p.pausiere(1000)
    for t in range(1000, 1600, 10):
        assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND).grund == "pause", t
    # Ab 1600: Tor muss 5 min am Stück offen sein.
    assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1600, jetzt_wand=WAND).grund == "tor_warten"
    for t in range(1610, 1900, 10):
        assert p.waehle(OFFEN, BEIDE, lage, jetzt_mono=t, jetzt_wand=WAND).modell is None, t
    w = p.waehle(OFFEN, BEIDE, lage, jetzt_mono=1900, jetzt_wand=WAND)
    assert w.modell == GROSS
    p.ladung_beginnt(GROSS)
    assert p.status(1900, WAND)["ladungen"] == 2, "Wiederaufnahme zählt gegen die Begrenzung"


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
    assert cfg.hg_aktiv is False and cfg.hg_tag is False and cfg.hg_gpu_nacht is False, "Standard: alles aus"
    assert cfg.hg_num_ctx == 16384 and cfg.hg_max_ladungen == 3 and cfg.hg_pause_s == 600
    p = Planer.aus_cfg(dataclasses.replace(cfg, hg_modelle=LEITER, nacht_start="20:30", tag_start="kaputt"))
    assert p.nacht_start == (20, 30) and p.tag_start == (7, 0) and p.leiter == LEITER


def test_puffer_im_tor() -> None:
    # 2,4 GB belegt (Leerlauf heute): 2,4 + 17 + 3 > 22 → 26B-Tor zu, 12B offen; Puffer aus der env.
    p = _planer()
    assert p.puffer_gb == 3.0
    lage = _nacht(p)
    w = p.waehle(_messung(2.4), BEIDE, lage, jetzt_mono=0, jetzt_wand=WAND)
    assert w.grund == "tor_zu" and w.tor == "budget", w
    assert Planer.aus_cfg(dataclasses.replace(laden(), hg_modelle=LEITER, hg_puffer_gb=1.5)).puffer_gb == 1.5
    assert laden().hg_puffer_gb == 3.0


def test_zustand_ueberlebt_neustart() -> None:
    gespeichert: list[dict] = []
    p = _planer(pause_s=600, zustand_gespeichert=gespeichert.append)
    lage = _nacht(p)
    assert _bis(p, OFFEN, BEIDE, lage, 0, 120).modell == GROSS
    p.ladung_beginnt(GROSS)
    p.ladung_beginnt(GROSS)
    p.pausiere(200, WAND + 200)
    z = gespeichert[-1]
    assert z["fenster"] == lage.fenster and z["ladungen"] == 2 and z["pause_bis"] == WAND + 800, z
    # Neustart 100 s später (neue monotonic-Basis): gleiche Ladungen, Pause läuft weiter.
    p2 = _planer(pause_s=600)
    p2.wiederherstellen(json_rund(z), jetzt_mono=5.0, jetzt_wand=WAND + 300)
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=5.0, jetzt_wand=WAND + 300).grund == "pause"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=504.0, jetzt_wand=WAND + 799).grund == "pause"
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=506.0, jetzt_wand=WAND + 801).grund == "tor_warten"
    p2.ladung_beginnt(GROSS)
    assert p2.status(600, WAND)["ladungen"] == 3
    assert p2.waehle(OFFEN, BEIDE, lage, jetzt_mono=900, jetzt_wand=WAND + 1200).grund == "nachlade_grenze"
    # Gespeicherter Zustand einer früheren Nacht: neues Fenster beginnt bei 0.
    p3 = _planer()
    p3.wiederherstellen({**z, "pause_bis": 0, "nach_pause": False}, jetzt_mono=0, jetzt_wand=WAND)
    morgen = _nacht(p3, tag=12)
    assert _bis(p3, OFFEN, BEIDE, morgen, 0, 120).modell == GROSS and p3.status(120, WAND)["ladungen"] == 0
    # Kaputte Datei → nichts übernommen, kein Absturz.
    p4 = _planer()
    p4.wiederherstellen({"fenster": 5, "ladungen": "x"}, jetzt_mono=0, jetzt_wand=WAND)
    p4.wiederherstellen(None, jetzt_mono=0, jetzt_wand=WAND)
    assert p4.status(0, WAND)["ladungen"] == 0


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
