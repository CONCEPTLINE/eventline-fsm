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
           "vorschlaege_bekannt": [{"art": "zz", "pfad": "ZZ_Alt/bekannt.pdf", "status": "offen"},
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
           cfg=CFG, melder: bool = True, trocken: bool = False) -> na.Nachtarbeit:  # noqa: ANN001
    quelle = na.KontextQuelle(fsm, None, cfg.kontext_max_alter_s)
    return na.Nachtarbeit(
        cfg, object(), None, speicher, quelle,  # type: ignore[arg-type]
        melder=na.Melder(speicher, fsm, modell="gemma3:4b") if melder else None,  # type: ignore[arg-type]
        ruhig=lambda: ruhig, vorarbeit_laeuft=lambda: vorarbeit, uhr=lambda: uhr, trocken=trocken,
    )


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
    assert _nacht(s, _Fsm(), uhr=_uhr(12)).runde() == "tag"
    assert _nacht(s, _Fsm(), uhr=_uhr(6, 50, 13)).runde() == "vor_tag"
    assert _nacht(s, _Fsm(), uhr=_uhr(20), vorarbeit=True).runde() == "vorarbeit"
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


def test_fristen_dann_zz_mit_grenze_und_wiederaufnahme() -> None:
    texte = [_zeile("a/1.pdf"), _zeile("a/2.pdf"), _zeile("a/leer.pdf", 0), _zeile("ZZ_Alt/1.pdf"),
             _zeile("a/ZZ_heisst_nur_die_Datei.pdf", 0),
             _zeile("ZZ_Alt/2.pdf"), _zeile("ZZ_Alt/3.pdf"), _zeile("ZZ_Alt/4.pdf"), _zeile("ZZ_Alt/bekannt.pdf")]
    s = _Speicher(texte)
    aufrufe: list[str] = []
    alt_f, alt_z = fj.fristen_pruefen, zj.zz_einordnen

    def fristen(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("f:" + kw["pfad"])
        if kw["pfad"] == "a/2.pdf":
            raise LlmFehler("weg")
        return _befund_frist()

    def zz(**kw):  # noqa: ANN003, ANN202
        aufrufe.append("z:" + kw["pfad"])
        return zj.ZzBefund(status="vorschlag", ordner_ist="ZZ_Alt", ziel="00_ADMIN/02_Versicherungen",
                           sicherheit="mittel", quelle="modell", dauer_ms=3)

    fj.fristen_pruefen, zj.zz_einordnen = fristen, zz  # type: ignore[assignment]
    try:
        n = _nacht(s, _Fsm(), uhr=_uhr(20))
        assert n.runde() == "fristen:fertig"
        assert aufrufe == ["f:a/1.pdf", "f:a/2.pdf", "f:ZZ_Alt/1.pdf", "f:ZZ_Alt/2.pdf", "f:ZZ_Alt/3.pdf",
                           "f:ZZ_Alt/4.pdf", "f:ZZ_Alt/bekannt.pdf"], "Datei ohne Text: keine Fristen"
        assert s.karten_["a/2.pdf"][1] == "fehler" and s.gespeichert_fristen == 6
        aufrufe.clear()
        assert n.runde() == "zz:zz_grenze", "höchstens KI_JOB_ZZ_MAX (3) je Nacht"
        assert aufrufe == ["z:ZZ_Alt/1.pdf", "z:ZZ_Alt/2.pdf", "z:ZZ_Alt/3.pdf"]
        assert n.zaehler["zz"]["bekannt"] == 0 or "z:ZZ_Alt/bekannt.pdf" not in aufrufe
        assert n.runde() == "erledigt" and n.stand["zz"] == 3
        # Nächste Nacht: Fristen-Fehler wird wiederholt, der Rest der ZZ läuft, Bekanntes nie.
        aufrufe.clear()
        n.uhr = lambda: _uhr(20, 0, 13)
        assert n.runde() == "fristen:fertig" and aufrufe == ["f:a/2.pdf"]
        aufrufe.clear()
        assert n.runde() == "zz:fertig" and aufrufe == ["z:ZZ_Alt/4.pdf"]
    finally:
        fj.fristen_pruefen, zj.zz_einordnen = alt_f, alt_z


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
        n = _nacht(s, _Fsm(), uhr=_uhr(22))
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
        assert n._naechster_job(_uhr(5, 29, 13)) == "fristen"
        n.uhr = lambda: _uhr(5, 31, 13)
        assert n.runde() == "selbsttest:fertig"
        fenster, seed, k = s.selbsttest[0]
        assert fenster == "2026-10-12/nacht" and seed == 20261012
        assert k["ordnerwahl"]["einsortiert"]["top1"] == 1.0 and k["ordnerwahl"]["neutral"]["dateien"] == 1
        assert k["egress"] == {"ok": True}
        assert n._naechster_job(_uhr(5, 40, 13)) == "fristen", "einmal je Nacht"
    finally:
        na.sj.pruefe_eine, na.sj.egress_test = alt_eine, alt_egress


def test_runde_meldet_vor_der_arbeit_und_tagsueber() -> None:
    s = _Speicher(vorschlaege=1)
    fsm = _Fsm({"success": True, "angenommen": 1, "doppelt": 0, "abgewiesen": []})
    assert _nacht(s, fsm, uhr=_uhr(12)).runde() == "tag"
    assert len(fsm.bodies) == 1, "der Puffer wird auch tagsüber geleert"


# --- Trockenlauf --------------------------------------------------------------------------------------------


def test_trockenlauf_meldet_nie() -> None:
    s = _Speicher([_zeile("a/1.pdf"), _zeile("ZZ_Alt/1.pdf")], vorschlaege=5)
    fsm = _Fsm()
    nur = na.NurKontext(fsm)
    assert not hasattr(nur, "melde_nachtarbeit"), "im Trockenlauf ist Melden unmöglich"
    alt_f, alt_z = fj.fristen_pruefen, zj.zz_einordnen
    fj.fristen_pruefen = lambda **kw: _befund_frist()  # type: ignore[assignment]
    zj.zz_einordnen = lambda **kw: zj.ZzBefund(status="kein_ziel", grund="keiner", dauer_ms=2)  # type: ignore[assignment]
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
        fj.fristen_pruefen, zj.zz_einordnen = alt_f, alt_z


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
