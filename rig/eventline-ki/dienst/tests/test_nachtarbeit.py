"""Nachtarbeit E4.1 ohne Netz und ohne Datenbank: Kontext (Alter, Ablage, ungültig), Melde-Puffer (Pakete ≤ 200,
gemeldet_at für angenommen/doppelt/abgewiesen, Backoff 30 s → 15 min), Planer-Fenster, Vorrang, Selbsttest ab 05:30,
Grenze ZZ, Wiederaufnahme nach Unterbrechung, Trockenlauf ohne Meldung und ohne Schreiben.

  docker run --rm --network none -v <repo>/rig/eventline-ki/dienst:/t:ro -w /t eventline-ki/dienst:local python tests/test_nachtarbeit.py
"""

from __future__ import annotations

import dataclasses
import json
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import nachtarbeit as na  # noqa: E402
from app.config import laden  # noqa: E402
from app.fsm import FsmAbgelehnt, FsmFehler  # noqa: E402
from app.jobs import fristen as fj  # noqa: E402
from app.jobs import zz as zj  # noqa: E402
from app.llm import LlmFehler  # noqa: E402

CFG = dataclasses.replace(laden(), job_fristen=True, job_zz=True, job_selbsttest=True, job_zz_max=3,
                          nacht_start="19:00", tag_start="07:00", selbsttest_zeit="05:30")
KONTEXT = {"erzeugt_am": "2026-10-12T17:00:00Z", "heute": "2026-10-12", "ordner": ["00_ADMIN/02_Versicherungen"],
           "dok_typen": [], "mitarbeiter": [], "namen_alle": [],
           "vorschlaege_bekannt": [{"art": "zz", "pfad": "ZZ_Alt/bekannt.pdf", "status": "offen", "rezept": zj.REZEPT},
                                   {"art": "zz", "pfad": "ZZ_Alt/abgelehnt.pdf", "status": "abgelehnt"}],
           "fristen_bekannt": []}


def _uhr(h: int, m: int = 0, tag: int = 12) -> datetime:
    return datetime(2026, 10, tag, h, m)


class _Fsm:
    def __init__(self, *antworten: dict | Exception, kontext: dict | Exception | None = None) -> None:
        self.antworten = list(antworten)
        self.bodies: list[dict] = []
        self.kontext = KONTEXT if kontext is None else kontext
        self.kontext_abrufe = 0

    def hole_kontext(self) -> dict:
        self.kontext_abrufe += 1
        if isinstance(self.kontext, Exception):
            raise self.kontext
        return json.loads(json.dumps(self.kontext))

    def melde_nachtarbeit(self, body: dict) -> dict:
        self.bodies.append(body)
        a = self.antworten.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


class _Speicher:
    """Spielt die Tresor-Tabellen im Speicher."""

    trocken = False

    def __init__(self, texte: list[na.TextZeile] | None = None, vorschlaege: int = 0, fristen: int = 0) -> None:
        self._texte = texte or []
        self.karten_: dict[str, tuple[str, str, int]] = {}
        self.zz_: dict[tuple[str, str], tuple[str, int]] = {}
        self.vorschlaege = [{"id": i, "lauf_id": "2026-10-11-nacht", "eintrag": {"art": "zz", "pfad": f"ZZ/{i}.pdf"}}
                            for i in range(vorschlaege)]
        self.fristen = [{"id": 1000 + i, "lauf_id": None, "eintrag": {"pfad": f"a/{i}.pdf", "art": "ablauf"}}
                        for i in range(fristen)]
        self.markiert: dict[str, list[tuple[int, str]]] = {"zz_vorschlaege": [], "archiv_fristen": []}
        self.gespeichert_fristen = 0
        self.selbsttest: list = []
        self.puffer_n = 0

    def texte(self) -> list[na.TextZeile]:
        return list(self._texte)

    def text(self, pfad: str, sha256: str) -> str:
        return f"Text von {pfad}"

    def karten(self, rezept: str) -> dict:
        return dict(self.karten_)

    def speichere_karte(self, pfad, sha256, rezept, status, befund, modell) -> None:  # noqa: ANN001
        alt = self.karten_.get(pfad)
        self.karten_[pfad] = (sha256, status, (alt[2] + 1) if alt and status == "fehler" else 1)

    def speichere_fristen(self, pfad, sha256, befund, lauf_id) -> int:  # noqa: ANN001
        self.gespeichert_fristen += len(befund.fristen)
        return len(befund.fristen)

    def zz_stand(self, rezept: str) -> dict:
        return dict(self.zz_)

    def speichere_zz(self, pfad, sha256, rezept, status, befund, lauf_id, grund=None) -> None:  # noqa: ANN001
        alt = self.zz_.get((pfad, sha256))
        self.zz_[(pfad, sha256)] = (status, (alt[1] + 1) if alt and status == "fehler" else 1)

    def offene_meldungen(self, n: int, *, zz: bool, fristen: bool):  # noqa: ANN201
        v = [x for x in self.vorschlaege if not any(x["id"] == i for i, _ in self.markiert["zz_vorschlaege"])][:n] if zz else []
        f = [x for x in self.fristen if not any(x["id"] == i for i, _ in self.markiert["archiv_fristen"])][: n - len(v)] if fristen else []
        return v, f

    def markiere(self, tabelle: str, ergebnisse: list[tuple[int, str]]) -> None:
        self.markiert[tabelle] += ergebnisse

    def puffer(self) -> int:
        return self.puffer_n

    def archiv_dateien(self) -> list:
        return [("00_ADMIN/02_Versicherungen/p.pdf", "00_ADMIN/02_Versicherungen", "p.pdf", "b" * 64)]

    def speichere_selbsttest(self, fenster, seed, kennzahlen) -> None:  # noqa: ANN001
        self.selbsttest.append((fenster, seed, kennzahlen))

    def letzter_selbsttest(self):  # noqa: ANN201
        return None

    def zaehler(self) -> dict:
        return {}


def _zeile(pfad: str, zeichen: int = 100) -> na.TextZeile:
    return na.TextZeile(pfad, "a" * 64, pfad.rsplit("/", 1)[-1], False, 1, zeichen)


def _nacht(speicher: _Speicher, fsm: _Fsm, *, uhr: datetime, ruhig: bool = True, vorarbeit: bool = False,
           cfg=CFG, melder: bool = True, trocken: bool = False, speicher_ok: bool = True) -> na.Nachtarbeit:  # noqa: ANN001
    quelle = na.KontextQuelle(fsm, None, cfg.kontext_max_alter_s)
    return na.Nachtarbeit(
        cfg, object(), None, speicher, quelle,  # type: ignore[arg-type]
        melder=na.Melder(speicher, fsm, modell="gemma3:4b") if melder else None,  # type: ignore[arg-type]
        ruhig=lambda: ruhig, vorarbeit_laeuft=lambda: vorarbeit, uhr=lambda: uhr, trocken=trocken,
        speicher_ok=lambda: speicher_ok,
    )


NUR_NACHTS = dataclasses.replace(CFG, frei_aktiv=False)


def _zz_befund(**kw) -> zj.ZzBefund:  # noqa: ANN003
    return zj.ZzBefund(status="vorschlag", ordner_ist="ZZ_Alt", beschrieb={"typ": "vertrag"},
                       fakten=["Datum im Dateinamen: 2026-01-01"], kandidaten=["00_ADMIN/02_Versicherungen"], dauer_ms=3)


# --- Kontext ----------------------------------------------------------------------------------------------


def test_kontext_alter_und_ablage() -> None:
    with tempfile.TemporaryDirectory() as d:
        fsm = _Fsm()
        q = na.KontextQuelle(fsm, Path(d), 3600)
        k = q.aktuell()
        assert k is not None and k.ordner == ["00_ADMIN/02_Versicherungen"] and fsm.kontext_abrufe == 1
        assert q.aktuell() is k and fsm.kontext_abrufe == 1, "jung genug: kein neuer Abruf"
        gespeichert = json.loads((Path(d) / na.ORDNERLISTE_DATEI).read_text(encoding="utf-8"))
        assert gespeichert["ordner"] == ["00_ADMIN/02_Versicherungen"], "fsm-ordnerliste.json für den Probelauf"
        # Neustart: der abgelegte Kontext gilt weiter, solange er jung ist.
        q2 = na.KontextQuelle(_Fsm(kontext=FsmFehler("weg")), Path(d), 3600)
        assert q2.aktuell() is not None
        # Zu alt und FSM weg → kein Kontext, nichts wird geraten.
        q2._k.geholt -= 4000  # type: ignore[union-attr]
        assert q2.aktuell() is None and "weg" in (q2.letzter_fehler or "")
    leer = na.KontextQuelle(_Fsm(kontext={**KONTEXT, "ordner": []}), None, 3600)
    assert leer.aktuell() is None, "ohne Ordnerliste kein Lauf"
    assert na.Kontext(KONTEXT, 0).bekannt_zz() == {"ZZ_Alt/bekannt.pdf"}, "abgelehnte dürfen neu gerechnet werden"
    # zz/v3: ein offener Vorschlag eines älteren Rezepts wird neu gerechnet (das FSM ersetzt ihn), angenommene nie,
    # ein Beschrieb in der FSM-Warteschlange mit demselben Rezept auch nicht.
    k = na.Kontext({**KONTEXT, "vorschlaege_bekannt": [
        {"art": "zz", "pfad": "ZZ_Alt/alt.pdf", "status": "offen"},
        {"art": "zz", "pfad": "ZZ_Alt/v2.pdf", "status": "offen", "rezept": "zz/v2"},
        {"art": "zz", "pfad": "ZZ_Alt/v3.pdf", "status": "offen", "rezept": "zz/v3"},
        {"art": "zz", "pfad": "ZZ_Alt/v2.pdf", "status": "beschrieb_wartet", "rezept": "zz/v3"},
        {"art": "zz", "pfad": "ZZ_Alt/angenommen.pdf", "status": "angenommen", "rezept": None},
        {"art": "zz", "pfad": "ZZ_Alt/abgelehnt.pdf", "status": "abgelehnt", "rezept": "zz/v3"}]}, 0)
    assert k.bekannt_zz("zz/v3") == {"ZZ_Alt/v2.pdf", "ZZ_Alt/v3.pdf", "ZZ_Alt/angenommen.pdf"}


# --- Melden -----------------------------------------------------------------------------------------------


def test_melden_paket_und_markierung() -> None:
    s = _Speicher(vorschlaege=150, fristen=80)
    antwort = {"success": True, "angenommen": 190, "doppelt": 38,
               "abgewiesen": [{"liste": "vorschlaege", "index": 3, "grund": "pfad_bewegt"},
                              {"liste": "fristen", "index": 0, "grund": "frist_vergangen"}]}
    fsm = _Fsm(antwort, {"success": True, "angenommen": 30, "doppelt": 0, "abgewiesen": []})
    m = na.Melder(s, fsm, modell="gemma3:4b")
    assert m.runde(zz=True, fristen=True) == "gemeldet"
    body = fsm.bodies[0]
    assert len(body["vorschlaege"]) + len(body["fristen"]) == 200 and len(body["vorschlaege"]) == 150
    assert body["lauf_id"] == "2026-10-11-nacht" and body["modell"] == "gemma3:4b"
    assert all("id" not in e for e in body["vorschlaege"] + body["fristen"]), "keine Tresor-ids ans FSM"
    v = dict(s.markiert["zz_vorschlaege"])
    f = dict(s.markiert["archiv_fristen"])
    assert v[3] == "pfad_bewegt" and v[0] == "ok" and len(v) == 150
    assert f[1000] == "frist_vergangen" and len(f) == 50
    assert m.runde(zz=True, fristen=True) == "gemeldet" and len(fsm.bodies[1]["fristen"]) == 30
    assert m.runde(zz=True, fristen=True) == "leer"


def test_melden_nur_eingeschaltete_listen() -> None:
    s = _Speicher(vorschlaege=2, fristen=2)
    fsm = _Fsm({"success": True, "angenommen": 2, "doppelt": 0, "abgewiesen": []})
    m = na.Melder(s, fsm, modell="x")
    assert m.runde(zz=False, fristen=False) == "leer" and not fsm.bodies
    assert m.runde(zz=False, fristen=True) == "gemeldet" and fsm.bodies[0]["vorschlaege"] == []


class _SpeicherZb(_Speicher):
    """Dazu Ergebnisse des zweiten Blicks (Hauptmodell)."""

    def __init__(self, *a, zb: int = 0, **k) -> None:  # noqa: ANN002, ANN003
        super().__init__(*a, **k)
        self.markiert["zweiter_blick"] = []
        self.zb = [{"id": 5000 + i, "lauf_id": "2026-10-15-nacht-zb",
                    "eintrag": {"art": "zz", "pfad": f"ZZ/zb{i}.pdf", "rezept": "zz/v4+zb"}} for i in range(zb)]
        self.kandidaten_zeilen: list = []

    def offene_zb(self, n: int, rezept: str):  # noqa: ANN201
        assert rezept == "zz/v4+zb"
        offen = [x for x in self.zb if not any(x["id"] == i for i, _ in self.markiert["zweiter_blick"])][:n]
        return offen, ("gemma4:26b-a4b-it-qat" if offen else None)

    def zb_kandidaten_zeilen(self, rezept: str, rezept_zb: str) -> list:
        return list(self.kandidaten_zeilen)


def test_melden_zweiter_blick_nach_dem_schnellen_modell() -> None:
    s = _SpeicherZb(vorschlaege=2, fristen=1, zb=3)
    ok = {"success": True, "angenommen": 3, "doppelt": 0, "abgewiesen": []}
    fsm = _Fsm(ok, {**ok, "abgewiesen": [{"liste": "vorschlaege", "index": 1, "grund": "pfad_bewegt"}]})
    m = na.Melder(s, fsm, modell="gemma3:4b", zb_rezept="zz/v4+zb")
    assert m.runde(zz=True, fristen=True) == "gemeldet"
    assert fsm.bodies[0]["modell"] == "gemma3:4b" and len(fsm.bodies[0]["vorschlaege"]) == 2, "erst das schnelle Modell"
    assert m.runde(zz=True, fristen=True) == "gemeldet"
    b = fsm.bodies[1]
    assert b["modell"] == "gemma4:26b-a4b-it-qat" and [e["rezept"] for e in b["vorschlaege"]] == ["zz/v4+zb"] * 3
    assert dict(s.markiert["zweiter_blick"]) == {5000: "ok", 5001: "pfad_bewegt", 5002: "ok"}
    assert len(s.markiert["zz_vorschlaege"]) == 2 and m.zaehler["zweiter_blick"] == 3
    assert m.runde(zz=True, fristen=True) == "leer"
    # Ohne Schalter bleibt der zweite Blick liegen.
    s2 = _SpeicherZb(zb=1)
    assert na.Melder(s2, _Fsm(), modell="x").runde(zz=True, fristen=True) == "leer"


def test_zweiter_blick_einplanen_wenn_das_schnelle_modell_fertig_ist() -> None:
    class _Liste:
        def __init__(self) -> None:
            self.zeilen: list[tuple] = []

        def anlegen(self, art: str, schluessel: str, rezept: str) -> bool:
            neu = (art, schluessel, rezept) not in self.zeilen
            if neu:
                self.zeilen.append((art, schluessel, rezept))
            return neu

    kontext = {**KONTEXT, "vorschlaege_bekannt": [{"art": "zz", "pfad": "ZZ_Alt/a.pdf", "status": "offen"},
                                                  {"art": "zz", "pfad": "ZZ_Alt/b.pdf", "status": "beschrieb_wartet"},
                                                  {"art": "zz", "pfad": "ZZ_Alt/c.pdf", "status": "angenommen"}]}
    s = _SpeicherZb([_zeile("ZZ_Alt/a.pdf")])
    s.kandidaten_zeilen = [("ZZ_Alt/a.pdf", "a" * 64, 3, 30000), ("ZZ_Alt/b.pdf", "b" * 64, 1, 900),
                           ("ZZ_Alt/c.pdf", "c" * 64, 1, 10), ("ZZ_Alt/lang.pdf", "d" * 64, 9, 90000)]
    liste = _Liste()
    cfg = dataclasses.replace(CFG, job_zweiter_blick=True, hg_aktiv=True)
    n = na.Nachtarbeit(cfg, object(), None, s, na.KontextQuelle(_Fsm(kontext=kontext), None, 3600),  # type: ignore[arg-type]
                       melder=None, ruhig=lambda: True, uhr=lambda: _uhr(2, 30, 13), zb_liste=liste)
    n._fenster("2026-10-12/nacht")
    n.stand.update(zz_fertig=zj.REZEPT, fristen_fertig=fj.REZEPT)
    n._puffer_cache = (-1e9, None)
    assert n.runde() == "erledigt"
    assert [z[1][65:] for z in liste.zeilen] == ["ZZ_Alt/b.pdf", "ZZ_Alt/a.pdf"], "nur unentschiedene, kurze zuerst"
    assert all(z[0] == "zweiter_blick" and z[2] == "zz/v4+zb" for z in liste.zeilen)
    assert n.zb_stand["zu_lang"] == 0 and n.zb_stand["neu_eingeplant"] == 2
    assert n.runde() == "erledigt" and len(liste.zeilen) == 2, "höchstens alle 10 min, idempotent"
    # Das schnelle Modell hat noch Arbeit: nichts einplanen.
    n2 = na.Nachtarbeit(cfg, object(), None, s, na.KontextQuelle(_Fsm(kontext=kontext), None, 3600),  # type: ignore[arg-type]
                        melder=None, ruhig=lambda: True, uhr=lambda: _uhr(2, 30, 13), zb_liste=_Liste())
    n2._fenster("2026-10-12/nacht")
    n2.stand.update(zz_fertig=zj.REZEPT, fristen_fertig=fj.REZEPT)
    s.puffer_n = 1
    n2._puffer_cache = (-1e9, None)
    n2.runde()
    assert n2.zb_liste.zeilen == [], "Ungemeldetes des schnellen Modells zuerst"


def test_melden_backoff() -> None:
    t = [1000.0]
    s = _Speicher(vorschlaege=1)
    fsm = _Fsm(*[FsmFehler("weg")] * 8, {"success": True, "angenommen": 1, "doppelt": 0, "abgewiesen": []})
    m = na.Melder(s, fsm, modell="x", uhr=lambda: t[0])
    abstaende = []
    for _ in range(7):
        assert m.runde(zz=True, fristen=True) == "fehler"
        abstaende.append(m.backoff_rest_s())
        assert m.runde(zz=True, fristen=True) == "warten"
        t[0] += abstaende[-1] + 1
    assert abstaende == [30, 60, 120, 240, 480, 900, 900], abstaende
    assert not s.markiert["zz_vorschlaege"], "Puffer bleibt bei Fehlern"
    assert m.runde(zz=True, fristen=True) == "fehler"
    t[0] += 901
    assert m.runde(zz=True, fristen=True) == "gemeldet" and m.backoff_rest_s() == 0
    assert m._backoff == na.BACKOFF_MIN_S


def test_melden_abgelehnt_400() -> None:
    s = _Speicher(vorschlaege=2)
    m = na.Melder(s, _Fsm(FsmAbgelehnt("HTTP 400")), modell="x")
    assert m.runde(zz=True, fristen=True) == "abgelehnt"
    assert s.markiert["zz_vorschlaege"] == [(0, "http_4xx"), (1, "http_4xx")], "nicht endlos neu senden"


def _echter_client(status: int):  # noqa: ANN202
    """Der echte FsmClient, nur das Netz ist ersetzt: jede Antwort hat den gegebenen HTTP-Status."""
    import httpx

    from app.fsm import FsmClient

    c = FsmClient(CFG)
    c._sync = httpx.Client(base_url="http://fsm.test", transport=httpx.MockTransport(
        lambda req: httpx.Response(status, json={"success": False, "error": "x"})))
    return c


def test_melden_404_puffer_bleibt() -> None:
    # Route nach einem Rollback kurz weg: nicht verwerfen, sondern mit Backoff wiederholen (gemeldet_at bleibt NULL).
    s = _Speicher(vorschlaege=2, fristen=1)
    m = na.Melder(s, _echter_client(404), modell="x", uhr=lambda: 1000.0)
    assert m.runde(zz=True, fristen=True) == "fehler"
    assert not s.markiert["zz_vorschlaege"] and not s.markiert["archiv_fristen"], "Puffer bleibt bei 404"
    assert m.zaehler["http_4xx"] == 0 and m.backoff_rest_s() == 30
    assert m.runde(zz=True, fristen=True) == "warten"


def test_melden_4xx_einteilung() -> None:
    for status in (400, 413, 422):
        try:
            _echter_client(status).melde_nachtarbeit({"vorschlaege": [], "fristen": []})
        except FsmAbgelehnt:
            pass
        else:
            raise AssertionError(f"HTTP {status} ist endgültig (Form/Grösse)")
    for status in (401, 403, 404, 405, 408, 409, 418, 429, 451, 500, 503):
        try:
            _echter_client(status).melde_nachtarbeit({"vorschlaege": [], "fristen": []})
        except FsmAbgelehnt as e:
            raise AssertionError(f"HTTP {status} darf nicht endgültig sein") from e
        except FsmFehler:
            pass
        else:
            raise AssertionError(f"HTTP {status} muss ein Fehler sein")


# --- Planer-Fenster, Vorrang, Reihenfolge ------------------------------------------------------------------


def test_runde_fenster_und_vorrang() -> None:
    s = _Speicher([_zeile("a/x.pdf")])
    # KI_FREI_AKTIV=0: wie bis 15.10. nur im Nachtfenster.
    assert _nacht(s, _Fsm(), uhr=_uhr(12), cfg=NUR_NACHTS).runde() == "tag"
    assert _nacht(s, _Fsm(), uhr=_uhr(6, 50, 13), cfg=NUR_NACHTS).runde() == "vor_tag"
    assert _nacht(s, _Fsm(), uhr=_uhr(20), vorarbeit=True).runde() == "vorarbeit"
    assert _nacht(s, _Fsm(), uhr=_uhr(12), vorarbeit=True).runde() == "vorarbeit", "auch tagsüber: Index/Hauptmodell zuerst"
    assert _nacht(s, _Fsm(), uhr=_uhr(12), speicher_ok=False).runde() == "speicher"
    assert _nacht(s, _Fsm(), uhr=_uhr(20), ruhig=False).runde() == "vorrang"
    assert _nacht(s, _Fsm(kontext=FsmFehler("weg")), uhr=_uhr(20)).runde() == "kein_kontext"
    s.puffer_n = na.PUFFER_MAX
    assert _nacht(s, _Fsm(), uhr=_uhr(20)).runde() == "puffer_voll"
    aus = dataclasses.replace(CFG, job_fristen=False, job_zz=False, job_selbsttest=False)
    assert _nacht(s, _Fsm(), uhr=_uhr(20), cfg=aus).runde() == "erledigt"


def _befund_frist() -> fj.FristBefund:
    f = fj.Frist("ablauf", {"beginn": None, "ende": "2027-01-31", "faellig": None, "laufzeit_monate": None,
                            "verlaengerung_monate": None, "kuendigungsfrist": None}, 1, "hoch")
    return fj.FristBefund(status="fertig", fristen=[f], zaehler=Counter(angenommen=1), modell="gemma3:4b", dauer_ms=5)


def test_zz_dann_fristen_mit_grenze_und_wiederaufnahme() -> None:
    texte = [_zeile("a/1.pdf"), _zeile("a/2.pdf"), _zeile("a/leer.pdf", 0), _zeile("ZZ_Alt/1.pdf"),
             _zeile("a/ZZ_heisst_nur_die_Datei.pdf", 0),
             _zeile("ZZ_Alt/2.pdf"), _zeile("ZZ_Alt/3.pdf"), _zeile("ZZ_Alt/4.pdf"), _zeile("ZZ_Alt/bekannt.pdf")]
    s = _Speicher(texte)
    aufrufe: list[str] = []
    alt_f, alt_z = fj.fristen_pruefen, zj.zz_beschreiben

    def fristen(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("f:" + kw["pfad"])
        if kw["pfad"] == "a/2.pdf":
            raise LlmFehler("weg")
        return _befund_frist()

    def zz(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("z:" + kw["pfad"])
        return _zz_befund()

    fj.fristen_pruefen, zj.zz_beschreiben = fristen, zz  # type: ignore[assignment]
    try:
        n = _nacht(s, _Fsm(), uhr=_uhr(20))
        # Seit 15.10. zuerst der Rückstau ZZ (die Einsortier-Liste wartet), dann die Fristen.
        assert n.runde() == "zz:zz_grenze", "höchstens KI_JOB_ZZ_MAX (3) je Fenster"
        assert aufrufe == ["z:ZZ_Alt/1.pdf", "z:ZZ_Alt/2.pdf", "z:ZZ_Alt/3.pdf"]
        assert "z:ZZ_Alt/bekannt.pdf" not in aufrufe
        aufrufe.clear()
        assert n.runde() == "fristen:fertig"
        assert aufrufe == ["f:a/1.pdf", "f:a/2.pdf", "f:ZZ_Alt/1.pdf", "f:ZZ_Alt/2.pdf", "f:ZZ_Alt/3.pdf",
                           "f:ZZ_Alt/4.pdf", "f:ZZ_Alt/bekannt.pdf"], "Datei ohne Text: keine Fristen"
        assert s.karten_["a/2.pdf"][1] == "fehler" and s.gespeichert_fristen == 6
        assert n.runde() == "erledigt" and n.stand["zz"] == 3
        # Nächstes Fenster: der Rest der ZZ läuft, Bekanntes nie, der Fristen-Fehler wird wiederholt.
        aufrufe.clear()
        n.uhr = lambda: _uhr(20, 0, 13)
        assert n.runde() == "zz:fertig" and aufrufe == ["z:ZZ_Alt/4.pdf"]
        aufrufe.clear()
        assert n.runde() == "fristen:fertig" and aufrufe == ["f:a/2.pdf"]
    finally:
        fj.fristen_pruefen, zj.zz_beschreiben = alt_f, alt_z


def test_rezeptwechsel_im_fenster_rechnet_sofort() -> None:
    """16.10. 02:13: zz/v4 und fristen/v3 kamen mitten in einem Fenster, dessen Durchgänge (zz/v3, fristen/v2) schon
    «fertig» waren — bis dahin warteten sie bis zum nächsten Fenster. Jetzt trägt «fertig» das Rezept."""
    s = _Speicher([_zeile("ZZ_Alt/1.pdf"), _zeile("a/v.pdf")])
    n = _nacht(s, _Fsm(), uhr=_uhr(2, 30, 13))
    n._fenster("2026-10-12/nacht")
    n.stand.update(zz_fertig=True, fristen_fertig=True)  # Stand-Datei vor dem 16.10. (ohne Rezept)
    assert n._naechster_job(_uhr(2, 30, 13)) == "zz" and n.hat_arbeit()
    n.stand["zz_fertig"] = "zz/v3"
    assert n._naechster_job(_uhr(2, 30, 13)) == "zz", "älteres Rezept: neu rechnen"
    n.stand["zz_fertig"] = zj.REZEPT
    assert n._naechster_job(_uhr(2, 30, 13)) == "fristen"
    n.stand["fristen_fertig"] = fj.REZEPT
    assert n._naechster_job(_uhr(2, 30, 13)) is None and not n.hat_arbeit()
    s.puffer_n = 3
    n._puffer_cache = (-1e9, None)
    assert n.hat_arbeit(), "Ungemeldetes im Puffer: das FSM soll den Vorschlag des schnellen Modells zuerst sehen"
    s.puffer_n = 0
    n._puffer_cache = (-1e9, None)
    n.uhr = lambda: _uhr(5, 35, 13)
    assert n.hat_arbeit(), "Selbsttest fällig (05:30): das Hauptmodell wartet"
    # Ein fertiger Durchgang schreibt das Rezept in den Stand.
    alt_z, alt_f = zj.zz_beschreiben, fj.fristen_pruefen
    zj.zz_beschreiben = lambda **kw: _zz_befund()  # type: ignore[assignment]
    fj.fristen_pruefen = lambda **kw: _befund_frist()  # type: ignore[assignment]
    try:
        n2 = _nacht(_Speicher([_zeile("ZZ_Alt/2.pdf")]), _Fsm(), uhr=_uhr(20))
        assert n2.runde() == "zz:fertig" and n2.stand["zz_fertig"] == zj.REZEPT
        assert n2.runde() == "fristen:fertig" and n2.stand["fristen_fertig"] == fj.REZEPT
    finally:
        zj.zz_beschreiben, fj.fristen_pruefen = alt_z, alt_f


def test_frei_tagsueber_laeuft_pausiert_und_setzt_fort() -> None:
    """Arbeiten, wenn frei: tagsüber läuft der Rückstau ZZ; ein Wartender stoppt nach dem laufenden Schritt; danach geht
    es mit den übrigen Dateien weiter (nichts doppelt); erst dann die Fristen."""
    s = _Speicher([_zeile(f"ZZ_Alt/{i}.pdf") for i in range(5)] + [_zeile("a/vertrag.pdf")])
    ruhe = {"ok": True}
    aufrufe: list[str] = []
    alt_f, alt_z = fj.fristen_pruefen, zj.zz_beschreiben

    def zz(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("z:" + kw["pfad"])
        if kw["pfad"] == "ZZ_Alt/1.pdf":
            ruhe["ok"] = False  # Suche/Beleg/Ablage kommt herein, während Datei 2 rechnet
        return _zz_befund()

    def fristen(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("f:" + kw["pfad"])
        return fj.FristBefund(status="ohne_treffer")

    fj.fristen_pruefen, zj.zz_beschreiben = fristen, zz  # type: ignore[assignment]
    try:
        cfg = dataclasses.replace(CFG, job_zz_max=50, job_selbsttest=False)
        n = _nacht(s, _Fsm(), uhr=_uhr(10, 30), cfg=cfg)
        n.ruhig = lambda: ruhe["ok"]
        assert n.runde() == "zz:vorrang" and aufrufe == ["z:ZZ_Alt/0.pdf", "z:ZZ_Alt/1.pdf"], aufrufe
        assert n.stand["fenster"] == "2026-10-12/tag", "Zähler je Fenster, auch am Tag"
        assert n.runde() == "vorrang" and len(aufrufe) == 2, "solange jemand wartet: kein neuer Schritt"
        ruhe["ok"] = True
        aufrufe.clear()
        assert n.runde() == "zz:fertig" and aufrufe == ["z:ZZ_Alt/2.pdf", "z:ZZ_Alt/3.pdf", "z:ZZ_Alt/4.pdf"]
        aufrufe.clear()
        assert n.runde() == "fristen:fertig" and aufrufe[0] == "f:ZZ_Alt/0.pdf" and "f:a/vertrag.pdf" in aufrufe
        assert n.runde() == "erledigt"
        # 19:00: neues Fenster (Nacht) — der Durchgang beginnt neu, Erledigtes bleibt erledigt.
        aufrufe.clear()
        n.uhr = lambda: _uhr(19, 0)
        assert n.runde() == "zz:fertig" and aufrufe == []
    finally:
        fj.fristen_pruefen, zj.zz_beschreiben = alt_f, alt_z


def test_frei_fensterwechsel_und_speicher_im_durchgang() -> None:
    s = _Speicher([_zeile(f"ZZ_Alt/{i}.pdf") for i in range(4)])
    uhr = {"t": _uhr(18, 59)}
    speicher = {"ok": True}
    aufrufe: list[str] = []
    alt_z = zj.zz_beschreiben

    def zz(**kw):  # noqa: ANN003, ANN202
        aufrufe.append(kw["pfad"])
        uhr["t"] = _uhr(19, 0)  # während der ersten Datei beginnt die Nacht
        return _zz_befund()

    zj.zz_beschreiben = zz  # type: ignore[assignment]
    try:
        cfg = dataclasses.replace(CFG, job_zz_max=50, job_selbsttest=False, job_fristen=False)
        n = na.Nachtarbeit(cfg, object(), None, s, na.KontextQuelle(_Fsm(), None, 3600),  # type: ignore[arg-type]
                           melder=None, ruhig=lambda: True, uhr=lambda: uhr["t"], speicher_ok=lambda: speicher["ok"])
        assert n.runde() == "zz:fenster" and aufrufe == ["ZZ_Alt/0.pdf"], "Fensterwechsel beendet den Durchgang"
        assert n.runde() == "zz:fertig" and n.stand["fenster"] == "2026-10-12/nacht" and len(aufrufe) == 4
        # Speichernot mitten im Durchgang: nach dem laufenden Schritt Pause.
        s2 = _Speicher([_zeile(f"ZZ_Alt/{i}.pdf") for i in range(3)])
        aufrufe.clear()

        def zz_knapp(**kw):  # noqa: ANN003, ANN202
            aufrufe.append(kw["pfad"])
            speicher["ok"] = False
            return _zz_befund()

        zj.zz_beschreiben = zz_knapp  # type: ignore[assignment]
        n2 = na.Nachtarbeit(cfg, object(), None, s2, na.KontextQuelle(_Fsm(), None, 3600),  # type: ignore[arg-type]
                            melder=None, ruhig=lambda: True, uhr=lambda: _uhr(11), speicher_ok=lambda: speicher["ok"])
        speicher["ok"] = True
        assert n2.runde() == "zz:speicher" and aufrufe == ["ZZ_Alt/0.pdf"]
        assert n2.runde() == "speicher"
    finally:
        zj.zz_beschreiben = alt_z


def test_zz_protokoll_mit_kennzahlen() -> None:
    # Leistung (15.10.): je ZZ-Schritt Seiten, Zeichen, gescannt und Teile ins Protokoll; ohne Ziel (nichts gelesen)
    # keine Dokument-Zahlen, beim Modellfehler die Teile aus dem Text.
    class Prot:
        def __init__(self) -> None:
            self.e: list[dict] = []

        def schreibe(self, art, quelle, dauer_ms, modell, ok, fehler=None, **kz) -> None:  # noqa: ANN001
            self.e.append({"art": art, "quelle": quelle, "ok": ok, **kz})

    gross = na.TextZeile("ZZ_Alt/lang.pdf", "a" * 64, "lang.pdf", True, 12, 25_000)
    s = _Speicher([gross, _zeile("ZZ_Alt/ohne_ziel.pdf"), _zeile("ZZ_Alt/kaputt.pdf")])
    alt_z = zj.zz_beschreiben

    def zz(**kw):  # noqa: ANN003, ANN202
        if kw["pfad"] == "ZZ_Alt/kaputt.pdf":
            raise LlmFehler("weg")
        if kw["pfad"] == "ZZ_Alt/ohne_ziel.pdf":
            return zj.ZzBefund(status="kein_ziel", grund="keine_kandidaten", dauer_ms=1)
        return zj.ZzBefund(status="vorschlag", ordner_ist="ZZ_Alt", beschrieb={"typ": "vertrag", "teile": 3}, dauer_ms=9000,
                           belege={"datum": {"angegeben": 2, "belegt": 1}}, zaehler=Counter({"prompt_kopie": 1}))

    zj.zz_beschreiben = zz  # type: ignore[assignment]
    try:
        cfg = dataclasses.replace(CFG, job_zz_max=50, job_selbsttest=False, job_fristen=False)
        prot = Prot()
        n = na.Nachtarbeit(cfg, object(), None, s, na.KontextQuelle(_Fsm(), None, 3600),  # type: ignore[arg-type]
                           melder=None, ruhig=lambda: True, uhr=lambda: _uhr(11), speicher_ok=lambda: True,
                           protokoll=prot)
        assert n.runde() == "zz:fertig"
    finally:
        zj.zz_beschreiben = alt_z
    assert len(prot.e) == 3, prot.e
    assert prot.e[0] == {"art": "nacht_zz", "quelle": "nacht", "ok": True, "seiten": 12, "zeichen": 25_000,
                         "gescannt": True, "teile": 3, "belege": {"datum": {"angegeben": 2, "belegt": 1}}}, prot.e[0]
    zz_z = n.zaehler["zz"]
    assert (zz_z["belege_angegeben"], zz_z["belege_belegt"], zz_z["prompt_kopie"]) == (2, 1, 1), "Belegquote im /health"
    ohne = next(x for x in prot.e if x["ok"] and "seiten" not in x)
    assert set(ohne) == {"art", "quelle", "ok"}, "kein Ziel: das Modell hat nichts gelesen"
    kaputt = next(x for x in prot.e if not x["ok"])
    assert kaputt["teile"] == 1 and kaputt["zeichen"] == 100 and kaputt["seiten"] == 1


class _MeldeSpeicher(_Speicher):
    """Wie _Speicher, aber jedes ZZ-Ergebnis landet im Melde-Puffer (wie zz_vorschlaege ohne gemeldet_at)."""

    def speichere_zz(self, pfad, sha256, rezept, status, befund, lauf_id, grund=None) -> None:  # noqa: ANN001
        super().speichere_zz(pfad, sha256, rezept, status, befund, lauf_id, grund)
        self.vorschlaege.append({"id": len(self.vorschlaege), "lauf_id": lauf_id, "eintrag": {"art": "zz", "pfad": pfad}})


def test_zwischenmeldung_alle_25_schritte() -> None:
    s = _MeldeSpeicher([_zeile(f"ZZ_Alt/{i:02d}.pdf") for i in range(30)])
    fsm = _Fsm(*[{"success": True, "angenommen": 25, "doppelt": 0, "abgewiesen": []}] * 3)
    alt_z = zj.zz_beschreiben
    zj.zz_beschreiben = lambda **kw: _zz_befund()  # type: ignore[assignment]
    try:
        cfg = dataclasses.replace(CFG, job_zz_max=100, job_selbsttest=False, job_fristen=False)
        n = _nacht(s, fsm, uhr=_uhr(14), cfg=cfg)
        assert n.runde() == "zz:fertig"
        assert len(fsm.bodies) == 1 and len(fsm.bodies[0]["vorschlaege"]) == 25, "nach 25 Schritten gemeldet"
        assert fsm.bodies[0]["lauf_id"] == "2026-10-12-tag"
        assert n.runde() == "erledigt" and len(fsm.bodies) == 2 and len(fsm.bodies[1]["vorschlaege"]) == 5
        assert len({e["pfad"] for b in fsm.bodies for e in b["vorschlaege"]}) == 30, "jede Datei genau einmal gemeldet"
    finally:
        zj.zz_beschreiben = alt_z


def test_selbsttest_nur_nachts_auch_mit_frei() -> None:
    s = _Speicher([_zeile("a/1.pdf")])
    n = _nacht(s, _Fsm(), uhr=_uhr(12))
    assert n._naechster_job(_uhr(5, 40, 13), nachts=True) == "selbsttest"
    assert n._naechster_job(_uhr(6, 50, 13), nachts=False) == "zz", "vor_tag: kein Selbsttest, leichte Jobs schon"
    n.uhr = lambda: _uhr(6, 50, 13)
    assert n.runde() == "zz:fertig", "06:45–07:00 (vor_tag) arbeiten die leichten Jobs weiter"
    assert n.stand["selbsttest"] is False


def test_speicher_leicht_frei() -> None:
    from app.speicher import GIB, Messung, leicht_frei

    assert leicht_frei(Messung(zeit=0.0), 1.0), "nicht lesbar = keine Not (lief bis 15.10. ohne Prüfung)"
    assert leicht_frei(Messung(zeit=0.0, mem_available=8 * GIB, psi_full_avg10=0.0), 1.0)
    assert not leicht_frei(Messung(zeit=0.0, mem_available=int(1.5 * GIB)), 1.0), "Rig knapp (< 2 × Not-Grenze)"
    assert not leicht_frei(Messung(zeit=0.0, mem_available=8 * GIB, psi_full_avg10=45.0), 1.0), "Druck (PSI)"
    knapp = Messung(zeit=0.0, mem_available=8 * GIB, slice_current=22 * GIB, slice_inactive_file=int(0.5 * GIB),
                    slice_max=22 * GIB)
    assert not leicht_frei(knapp, 1.0), "KI-Slice fast voll"
    luft = Messung(zeit=0.0, mem_available=8 * GIB, slice_current=12 * GIB, slice_inactive_file=2 * GIB,
                   slice_max=22 * GIB)
    assert leicht_frei(luft, 1.0)


def test_unterbrechung_durch_auftrag() -> None:
    s = _Speicher([_zeile(f"a/{i}.pdf") for i in range(5)])
    ruhe = {"ok": True}
    alt = fj.fristen_pruefen
    zaehler = [0]

    def fristen(**kw):  # noqa: ANN003, ANN202
        zaehler[0] += 1
        if zaehler[0] == 2:
            ruhe["ok"] = False  # ein FSM-Auftrag kommt herein
        return fj.FristBefund(status="ohne_treffer")

    fj.fristen_pruefen = fristen  # type: ignore[assignment]
    try:
        n = _nacht(s, _Fsm(), uhr=_uhr(22), cfg=dataclasses.replace(CFG, job_zz=False))
        n.ruhig = lambda: ruhe["ok"]
        assert n.runde() == "fristen:vorrang" and zaehler[0] == 2
        ruhe["ok"] = True
        assert n.runde() == "fristen:fertig" and zaehler[0] == 5, "nur die übrigen Dateien"
    finally:
        fj.fristen_pruefen = alt


def test_selbsttest_ab_0530_vorrang_und_einmal() -> None:
    s = _Speicher([_zeile("a/1.pdf")])
    alt_eine, alt_egress = na.sj.pruefe_eine, na.sj.egress_test
    na.sj.pruefe_eine = lambda probe, variante, **kw: {"variante": variante, "top1": True, "top3": True,  # type: ignore[assignment]
                                                      "kategorie": True, "leer": False, "ms": 7}
    na.sj.egress_test = lambda cfg: {"ok": True}  # type: ignore[assignment]
    try:
        n = _nacht(s, _Fsm(), uhr=_uhr(5, 29, 13))
        assert n._naechster_job(_uhr(5, 29, 13)) == "zz"
        n.uhr = lambda: _uhr(5, 31, 13)
        assert n.runde() == "selbsttest:fertig"
        fenster, seed, k = s.selbsttest[0]
        assert fenster == "2026-10-12/nacht" and seed == 20261012
        assert k["ordnerwahl"]["einsortiert"]["top1"] == 1.0 and k["ordnerwahl"]["neutral"]["dateien"] == 1
        assert k["egress"] == {"ok": True}
        assert n._naechster_job(_uhr(5, 40, 13)) == "zz", "einmal je Nacht"
    finally:
        na.sj.pruefe_eine, na.sj.egress_test = alt_eine, alt_egress


def test_runde_meldet_vor_der_arbeit_und_tagsueber() -> None:
    s = _Speicher(vorschlaege=1)
    fsm = _Fsm({"success": True, "angenommen": 1, "doppelt": 0, "abgewiesen": []})
    assert _nacht(s, fsm, uhr=_uhr(12), cfg=NUR_NACHTS).runde() == "tag"
    assert len(fsm.bodies) == 1, "der Puffer wird auch tagsüber geleert"


# --- Trockenlauf --------------------------------------------------------------------------------------------


def test_trockenlauf_meldet_nie() -> None:
    s = _Speicher([_zeile("a/1.pdf"), _zeile("ZZ_Alt/1.pdf")], vorschlaege=5)
    fsm = _Fsm()
    nur = na.NurKontext(fsm)
    assert not hasattr(nur, "melde_nachtarbeit"), "im Trockenlauf ist Melden unmöglich"
    alt_f, alt_z = fj.fristen_pruefen, zj.zz_beschreiben
    fj.fristen_pruefen = lambda **kw: _befund_frist()  # type: ignore[assignment]
    zj.zz_beschreiben = lambda **kw: zj.ZzBefund(status="kein_ziel", grund="keiner", dauer_ms=2)  # type: ignore[assignment]
    try:
        n = na.Nachtarbeit(dataclasses.replace(CFG, job_selbsttest=False), object(), None, s,  # type: ignore[arg-type]
                           na.KontextQuelle(nur, None, 3600), melder=None, ruhig=lambda: True, uhr=lambda: _uhr(11),
                           trocken=True)
        aus = n.trockenlauf(fristen_max=None, zz_max=10, selbsttest=False)
        assert aus["ok"] and aus["fristen"]["ende"] == "fertig" and aus["zz"]["zaehler"]["kein_ziel_keiner"] == 1
        assert aus["fristen"]["zaehler"]["fristen_angenommen"] == 2
        assert not fsm.bodies and fsm.kontext_abrufe == 1
        text = json.dumps(aus, ensure_ascii=False)
        assert "a/1.pdf" not in text and "ZZ_Alt" not in text, "nur Kennzahlen, keine Pfade"
    finally:
        fj.fristen_pruefen, zj.zz_beschreiben = alt_f, alt_z


def test_trocken_speicher_schreibt_nicht() -> None:
    s = na.NachtSpeicher(None, trocken=True)
    s.speichere_karte("a", "b" * 64, "r", "fehler", None, None)
    s.speichere_karte("a", "b" * 64, "r", "fehler", None, None)
    assert s.karten("r") == {"a": ("b" * 64, "fehler", 2)}
    assert s.speichere_fristen("a", "b" * 64, _befund_frist(), "x") == 1
    assert s.speichere_fristen("a", "b" * 64, _befund_frist(), "x") == 0, "idempotent"
    s.speichere_zz("z", "c" * 64, "r", "kein_ziel", None, "x", grund="keiner")
    assert s.zz_stand("r") == {("z", "c" * 64): ("kein_ziel", 1)}
    assert s.offene_meldungen(200, zz=True, fristen=True) == ([], []) and s.puffer() == 0


def test_lauf_id() -> None:
    assert na.lauf_id_fuer("2026-10-12/nacht") == "2026-10-12-nacht"
    assert na.lauf_id_fuer("2026-10-12/nacht", trocken=True) == "2026-10-12-nacht-trocken"


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
