"use client";

// Auftrag → Reiter «Catering» — Getränke-Catering kalkulieren (Variante A Bestellung / Variante B Mindestumsatz) und
// Verträge + Getränkekarte als PDF erzeugen.
//
// Wer/wo (CLAUDE.md B3): nur Admins (Einkaufspreise, Personalkosten, Gewinn), nur Laptop (die Handy-Auftragsansicht hat keinen Reiter).
// Rechnen läuft live im Browser mit demselben Kern wie der Server (lib/catering/rechnen.ts); gespeichert und in
// Vertrag verwendet wird das beim Speichern serverseitig neu berechnete, eingefrorene Ergebnis.
// Karte und Einstellungen kommen aus catering_getraenke / catering_einstellungen (Migration 372).

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Save, FileText, Wine, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { formatChf } from "@/lib/format";
import { PAUSE_WARNUNG_AB, rechneCatering, snapshotVollstaendig, type CateringEingabe, type CateringErgebnis, type CateringParameter } from "@/lib/catering/rechnen";
import { bestellSummen, bestellungAlsText, erstelleBestellung } from "@/lib/catering/bestellung";
import { KATEGORIE_REIHENFOLGE, KATEGORIE_TITEL } from "@/lib/catering/kategorien";
import { formatStunden, minutenZuStunden, stundenZuMinuten } from "@/lib/catering/stunden";
import type { JobKontext, KartenZeile } from "@/lib/catering/daten";

interface Geladen {
  job: JobKontext;
  karte: KartenZeile[];
  parameter: CateringParameter;
  gespeichert: { eingabe: CateringEingabe; ausschankBeginn: string; anlass: string; ergebnis: Partial<CateringErgebnis>; updatedAt: string } | null;
}

type FeldKey = keyof CateringEingabe;
const FELDER: { key: FeldKey; label: string; einheit: string }[] = [
  { key: "gaeste", label: "Anzahl Gäste", einheit: "" },
  { key: "aufbauMin", label: "Aufbau", einheit: "Std." },
  { key: "gesamtMin", label: "Veranstaltung gesamt", einheit: "Std." },
  { key: "abbauMin", label: "Abbau", einheit: "Std." },
  { key: "vorzeitMin", label: "Vorzeit (Gäste kommen an)", einheit: "Std." },
  { key: "pauseMin", label: "Pause", einheit: "Std." },
  { key: "nachzeitMin", label: "Nachzeit (nach dem Programm)", einheit: "Std." },
];
// Zeitfelder sind Stunden (Dezimal, z. B. 0.75 = 45 Min.); gespeichert und gerechnet wird in Minuten.
const STANDARD: Record<FeldKey, string> = { gaeste: "", aufbauMin: "1", gesamtMin: "3", abbauMin: "0.5", vorzeitMin: "0.5", pauseMin: "0.25", nachzeitMin: "1" };

const chf = (n: number) => formatChf(n, { stellen: 0 });
const chfRappen = (n: number) => formatChf(n, { stellen: 2 });

function alsGanzzahl(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

export function CateringTab({ jobId, canEdit }: { jobId: string; canEdit: boolean }) {
  const [daten, setDaten] = useState<Geladen | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [werte, setWerte] = useState<Record<FeldKey, string>>(STANDARD);
  const [beginn, setBeginn] = useState("");
  const [anlass, setAnlass] = useState("");
  const [saving, setSaving] = useState(false);
  const [geaendert, setGeaendert] = useState(false);

  const [neuLaden, setNeuLaden] = useState(0);

  useEffect(() => {
    let aktiv = true;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/catering`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? "Laden fehlgeschlagen");
        if (!aktiv) return;
        const g = json as Geladen;
        setDaten(g);
        setAnlass(g.gespeichert?.anlass || g.job.titel);
        if (g.gespeichert) {
          const e = g.gespeichert.eingabe;
          setWerte({
            gaeste: String(e.gaeste), aufbauMin: minutenZuStunden(e.aufbauMin), gesamtMin: minutenZuStunden(e.gesamtMin), abbauMin: minutenZuStunden(e.abbauMin),
            vorzeitMin: minutenZuStunden(e.vorzeitMin), pauseMin: minutenZuStunden(e.pauseMin), nachzeitMin: minutenZuStunden(e.nachzeitMin),
          });
          setBeginn(g.gespeichert.ausschankBeginn);
        }
        setFehler(null);
      } catch (e) {
        if (!aktiv) return;
        const msg = e instanceof Error ? e.message : "Laden fehlgeschlagen";
        setFehler(msg);
        toast.error(msg);
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [jobId, neuLaden]);

  const eingabe = useMemo<CateringEingabe | null>(() => {
    const m = (k: FeldKey) => stundenZuMinuten(werte[k]);
    const g = alsGanzzahl(werte.gaeste), a = m("aufbauMin"), ges = m("gesamtMin"), ab = m("abbauMin"), v = m("vorzeitMin"), p = m("pauseMin"), n = m("nachzeitMin");
    if (g == null || g < 1 || a == null || ges == null || ges < 1 || ab == null || v == null || p == null || n == null) return null;
    return { gaeste: g, aufbauMin: a, gesamtMin: ges, abbauMin: ab, vorzeitMin: v, pauseMin: p, nachzeitMin: n };
  }, [werte]);

  const zuLang = eingabe != null && eingabe.vorzeitMin + eingabe.pauseMin + eingabe.nachzeitMin > eingabe.gesamtMin;

  const rechnung = useMemo<{ r: CateringErgebnis | null; fehler: string | null }>(() => {
    if (!daten || !eingabe || zuLang) return { r: null, fehler: null };
    try {
      return { r: rechneCatering(eingabe, daten.parameter, daten.karte), fehler: null };
    } catch (e) {
      return { r: null, fehler: e instanceof Error ? e.message : "Berechnung nicht möglich" };
    }
  }, [daten, eingabe, zuLang]);

  // Reserve für die Bestellung (persönliche Einstellung, überlebt den Reload, §10)
  const [reserveProzent, setReserveProzent] = useState(() => {
    try { return typeof window === "undefined" ? "10" : window.localStorage.getItem("catering-reserve") ?? "10"; } catch { return "10"; }
  });
  const setzeReserve = (v: string) => {
    setReserveProzent(v);
    try { window.localStorage.setItem("catering-reserve", v); } catch { /* Speicher nicht verfügbar: egal */ }
  };
  // Auf-/Zuklappen der Bestellung (persönliche Vorliebe, überlebt den Reload, §10); Standard: zugeklappt
  const [bestellOffen, setBestellOffenState] = useState(() => {
    try { return typeof window === "undefined" ? false : window.localStorage.getItem("catering-bestellung-offen") === "1"; } catch { return false; }
  });
  const setBestellOffen = (v: boolean) => {
    setBestellOffenState(v);
    try { window.localStorage.setItem("catering-bestellung-offen", v ? "1" : "0"); } catch { /* Speicher nicht verfügbar: egal */ }
  };
  const bestellung = useMemo(() => {
    if (!daten || !rechnung.r) return [];
    const reserve = Number(reserveProzent);
    return erstelleBestellung(daten.karte, rechnung.r.getraenke, Number.isFinite(reserve) && reserve >= 0 ? reserve / 100 : 0);
  }, [daten, rechnung.r, reserveProzent]);
  const summen = useMemo(() => bestellSummen(bestellung), [bestellung]);

  async function speichern() {
    if (!eingabe || zuLang || !daten?.job.auftraggeber) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/catering`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...eingabe, ausschankBeginn: beginn, anlass }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Speichern fehlgeschlagen");
      if (json.dokumente === false) {
        toast.warning("Kalkulation gespeichert, aber Verträge und Karte konnten nicht im Auftrag abgelegt werden. Bitte noch einmal speichern.");
      } else {
        toast.success("Gespeichert. Vertrag A, Vertrag B und Getränkekarte liegen jetzt im Auftrag unter «Dokumente & Historie» (Ordner «Catering»).");
      }
      setGeaendert(false);
      setNeuLaden((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  function setze(k: FeldKey, v: string) {
    setWerte((w) => ({ ...w, [k]: v }));
    setGeaendert(true);
  }

  if (fehler && !daten) {
    return (
      <Card className="bg-card">
        <CardContent className="p-5 text-sm">
          <p className="text-red-500">{fehler}</p>
          <button type="button" onClick={() => setNeuLaden((n) => n + 1)} className="kasten kasten-muted mt-3">Erneut laden</button>
        </CardContent>
      </Card>
    );
  }
  if (!daten) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Wird geladen …
      </div>
    );
  }

  const r = rechnung.r;
  const g = daten.gespeichert;
  const gespeichertA = g?.ergebnis.richtpreisA;
  const gespeichertB = g?.ergebnis.mindestumsatz;
  const abweichung = r != null && g != null && !geaendert && (gespeichertA !== r.richtpreisA || gespeichertB !== r.mindestumsatz);
  // Älter gespeicherte Kalkulationen (vor der Umstellung von Variante A auf «Bestellung») kennen die neuen Felder nicht:
  // ohne Neuspeichern gäbe es «NaN» im Vertrag.
  const veraltet = g != null && !snapshotVollstaendig(g.ergebnis);
  const pdfBereit = g != null && !geaendert && !veraltet;
  const pdfUrl = (art: string) => `/api/jobs/${jobId}/catering/pdf?art=${art}`;

  return (
    <div className="space-y-4">
      <Card className="bg-card">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium"><Wine className="h-4 w-4" /> Getränke-Catering</div>
            <p className="text-xs text-muted-foreground">
              {daten.job.datumText ?? "kein Datum"}{daten.job.ort ? ` · ${daten.job.ort}` : ""}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="text-xs text-muted-foreground">
              Auftraggeber/in (aus dem Auftrag, kommt in den Vertrag)
              {daten.job.auftraggeber ? (
                <p className="mt-1 text-sm font-medium text-foreground">
                  {daten.job.auftraggeber}
                  <span className="font-normal text-muted-foreground">
                    {daten.job.auftraggeberAdresse ? ` · ${daten.job.auftraggeberAdresse}` : " · keine Adresse im Auftrag (der Vertrag nennt nur den Namen)"}
                  </span>
                </p>
              ) : (
                <p className="mt-1 text-sm font-medium text-red-500">Im Auftrag fehlt die Kontaktperson. Bitte dort eintragen, sonst kein Vertrag.</p>
              )}
              <PrefetchLink href={`/auftraege/${jobId}/bearbeiten`} className="mt-1 inline-block underline">Im Auftrag ändern</PrefetchLink>
            </div>
            <label className="block text-xs text-muted-foreground">
              Anlass (Vertrag, Karte)
              <input
                value={anlass} disabled={!canEdit} placeholder="z. B. CD-Taufe"
                onChange={(e) => { setAnlass(e.target.value); setGeaendert(true); }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-60"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {FELDER.map((f) => (
              <label key={f.key} className="block text-xs text-muted-foreground">
                {f.label}
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="number" inputMode="decimal" min={0} step={f.key === "gaeste" ? 1 : "any"} value={werte[f.key]} disabled={!canEdit}
                    onChange={(e) => setze(f.key, e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-60"
                  />
                  {f.einheit && <span className="text-xs">{f.einheit}</span>}
                </div>
              </label>
            ))}
            <label className="block text-xs text-muted-foreground">
              Beginn Ausschank (Uhr)
              <input
                type="time" value={beginn} disabled={!canEdit}
                onChange={(e) => { setBeginn(e.target.value); setGeaendert(true); }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-60"
              />
            </label>
          </div>
          {eingabe && (
            <p className="text-xs text-muted-foreground">
              Programm ohne Ausschank: {formatStunden(eingabe.gesamtMin - eingabe.vorzeitMin - eingabe.pauseMin - eingabe.nachzeitMin)}
              {zuLang && <span className="ml-2 text-red-500">Vorzeit, Pause und Nachzeit sind zusammen länger als die Veranstaltung.</span>}
            </p>
          )}
          {rechnung.fehler && <p className="text-xs text-red-500">{rechnung.fehler}</p>}
        </CardContent>
      </Card>

      {r && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="bg-card">
              <CardContent className="p-4">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Variante A · Bestellung und Service</p>
                <p className="mt-1 text-3xl font-bold text-emerald-600">{chf(r.richtpreisA)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Richtwert: {r.bestellmengeA} bestellte Getränke zu Kartenpreisen ({chf(r.getraenkeA)}) plus {r.kraefte} Kräfte × {r.stundenProKraft.toFixed(1)} Std × CHF {r.stundensatzA} ({chf(r.serviceA)}). Abgerechnet wird nach Bestellung und Stunden.</p>
              </CardContent>
            </Card>
            <Card className="bg-card">
              <CardContent className="p-4">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Variante B · Mindestumsatz</p>
                <p className="mt-1 text-3xl font-bold text-emerald-600">{chf(r.mindestumsatz)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Mindestumsatz. Kauft kein Gast etwas, zahlt der/die Auftraggeber/in den ganzen Betrag ({chf(r.mindestumsatz)}). Bei halber Menge: {chf(r.differenzBeiHalberMenge)}</p>
              </CardContent>
            </Card>
          </div>

          <Card className="bg-card">
            <CardContent className="grid gap-x-8 gap-y-1 p-4 text-sm md:grid-cols-2">
              <div>
                <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-red-500">Kosten</p>
                <Zeile l="Getränke insgesamt" v={`${Math.round(r.getraenke)} (${r.getraenkeProGast.toFixed(1)} pro Gast)`} />
                <Zeile l={`Personal: ${r.kraefte} Kräfte × ${r.stundenProKraft.toFixed(1)} Std × ${chfRappen(daten.parameter.lohnProStunde)}`} v={chf(r.personal)} rot />
                <Zeile l="Einkauf Getränke" v={chf(r.einkauf)} rot />
                <Zeile l="Kosten (Einkauf + Personal)" v={chf(r.kosten)} rot fett />
                <Zeile l="Puffer (Schwund, Anlieferung, Kühlung)" v={chf(r.puffer)} rot />
                <Zeile l="Kosten inkl. Puffer" v={chf(r.kostenInklPuffer)} rot fett />
              </div>
              <div>
                <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-emerald-600">Deckungsbeitrag (kein Reingewinn)</p>
                <Zeile l="Umsatz der Gäste bei normalem Konsum (Karte)" v={chf(r.erwarteterUmsatz)} gruen />
                <Zeile l="Variante A: Richtwert minus Kosten" v={chf(r.deckungsbeitragA)} gruen={r.deckungsbeitragA >= 0} rot={r.deckungsbeitragA < 0} fett />
                <Zeile l="Variante B: mindestens (auch wenn niemand trinkt)" v={chf(r.deckungsbeitragBMin)} gruen={r.deckungsbeitragBMin >= 0} rot={r.deckungsbeitragBMin < 0} fett />
                {Math.abs(r.deckungsbeitragBHalb - r.deckungsbeitragBMin) > 1 && (
                  <Zeile l="Variante B: bei halber Menge" v={chf(r.deckungsbeitragBHalb)} gruen={r.deckungsbeitragBHalb >= 0} rot={r.deckungsbeitragBHalb < 0} />
                )}
                <Zeile l="Variante B: bei normalem Konsum" v={chf(r.deckungsbeitragBNormal)} gruen={r.deckungsbeitragBNormal >= 0} rot={r.deckungsbeitragBNormal < 0} fett />
                <p className="mt-1 text-[0.6875rem] text-muted-foreground">Vor Zahlungsgebühren, Transport, Material und Schwund über den Puffer hinaus. Der Umsatz bei B stützt sich auf geschätzten Konsum.</p>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {r && r.pauseProKraftStunde > PAUSE_WARNUNG_AB && (
        <p className="text-xs text-amber-600">
          Pausen-Spitze: In der Pause sind es etwa {Math.round(r.pauseProKraftStunde)} Getränke pro Servicekraft und Stunde bei {r.kraefte} Kräften. Das ist knapp (ab {PAUSE_WARNUNG_AB} wird es eng). Vorbestellen oder eine zusätzliche Kraft für die Pause einplanen.
        </p>
      )}

      {r && (
        <Card className="bg-card">
          <CardContent className="space-y-3 p-4">
            <button
              type="button" onClick={() => setBestellOffen(!bestellOffen)} aria-expanded={bestellOffen}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span>
                <span className="block text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Bestellung bei Rupp</span>
                <span className="block text-xs text-muted-foreground">
                  {bestellOffen
                    ? `Für ${Math.round(r.getraenke)} erwartete Getränke, gerundet auf ganze Gebinde`
                    : `${bestellung.length} Positionen · Bestellwert ${chfRappen(summen.bestellWert)} · zum Aufklappen tippen`}
                </span>
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${bestellOffen ? "rotate-180" : ""}`} />
            </button>
            {bestellOffen && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Reserve
                <input
                  type="number" min={0} max={100} step={5} value={reserveProzent}
                  onChange={(e) => setzeReserve(e.target.value)}
                  className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
                %
              </label>
            )}
            {bestellOffen && (
              <>
            {KATEGORIE_REIHENFOLGE.map((kat) => {
              const zeilenKat = bestellung.filter((z) => z.kategorie === kat);
              if (zeilenKat.length === 0) return null;
              return (
                <div key={kat} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{KATEGORIE_TITEL[kat]}</p>
                  {zeilenKat.map((z) => (
                    <div key={`${z.kategorie}-${z.name}-${z.einheit}`} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 rounded-lg border border-border/60 px-3 py-2 sm:grid-cols-[1fr_auto_auto]">
                      <div>
                        <p className="text-sm font-medium">{z.name} <span className="text-xs font-normal text-muted-foreground">{z.einheit}</span></p>
                        <p className="text-xs text-muted-foreground">
                          erwartet {Math.round(z.erwartet)} {z.zaehleinheit}
                          {z.gebindeAnzahl != null && z.ueberschuss > 0 ? ` · ${Math.round(z.ueberschuss)} davon Reserve, ungeöffnet retour` : ""}
                          {z.hinweis ? ` · ${z.hinweis}` : ""}
                        </p>
                      </div>
                      <p className="text-right text-base font-semibold tabular-nums">
                        {z.gebindeAnzahl != null ? `${z.gebindeAnzahl} ${z.gebindeName}` : `${z.mengeMitReserve} ${z.zaehleinheit}`}
                        {z.gebindeAnzahl != null && <span className="block text-xs font-normal text-muted-foreground">{z.bestellStueck} {z.zaehleinheit}</span>}
                      </p>
                      <p className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
                        {chfRappen(z.bestellWert)}
                        <span className="block text-xs">à {chfRappen(z.einzelpreis)}</span>
                      </p>
                    </div>
                  ))}
                </div>
              );
            })}
            <div className="space-y-0.5 rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <Zeile l="Bestellwert zum Einkaufspreis (ohne Depot)" v={chfRappen(summen.bestellWert)} fett />
              <Zeile l="davon erwarteter Verbrauch (= Einkauf der Kalkulation)" v={chfRappen(summen.verbrauchWert)} />
              <Zeile l="davon Reserve und Rest im Gebinde, ungeöffnet retour" v={chfRappen(summen.retour)} />
              <Zeile l="Einkauf laut Kalkulation" v={chfRappen(r.einkauf)} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button" className="kasten kasten-muted"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(bestellungAlsText(bestellung, true));
                    toast.success("Bestellliste kopiert");
                  } catch {
                    toast.error("Kopieren nicht möglich");
                  }
                }}
              >
                <Copy className="h-4 w-4" /> Bestellliste kopieren
              </button>
              <span className="text-xs text-muted-foreground">Mehrweg-Harasse haben Depot (Moretti CHF 12.20), das bei Rückgabe zurückkommt. Anteile und Gebinde änderst du in Einstellungen → Catering.</span>
            </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button type="button" onClick={() => void speichern()} disabled={saving || !eingabe || zuLang || !r || !daten.job.auftraggeber} className="kasten kasten-blue">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Wird gespeichert …" : "Kalkulation speichern"}
          </button>
        )}
        <PdfKnopf href={pdfUrl("vertrag-a")} label="Vertrag A (Bestellung)" bereit={pdfBereit} />
        <PdfKnopf href={pdfUrl("vertrag-b")} label="Vertrag B (Mindestumsatz)" bereit={pdfBereit} />
        <PdfKnopf href={pdfUrl("karte")} label="Getränkekarte" bereit />
      </div>
      <p className="text-xs text-muted-foreground">
        Beim Speichern werden Vertrag A, Vertrag B und die Getränkekarte als PDF im Auftrag abgelegt («Dokumente &amp; Historie», Ordner «Catering»). Ein erneutes Speichern ersetzt sie.
      </p>
      {(geaendert || veraltet || abweichung) && (
        <p className="text-xs text-amber-600">
          {geaendert
            ? "Neu speichern nötig: Verträge zeigen erst nach dem Speichern die neuen Zahlen."
            : veraltet
              ? "Neu speichern nötig: Diese Kalkulation wurde mit der früheren Berechnung gespeichert."
              : `Neu speichern nötig: Gespeichert sind ${chf(gespeichertA ?? 0)} (A) und ${chf(gespeichertB ?? 0)} (B), nach den aktuellen Einstellungen und der Karte wären es ${chf(r?.richtpreisA ?? 0)} und ${chf(r?.mindestumsatz ?? 0)}.`}
        </p>
      )}
    </div>
  );
}

function Zeile({ l, v, rot, gruen, fett }: { l: string; v: string; rot?: boolean; gruen?: boolean; fett?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1">
      <span className={fett ? "font-medium" : "text-muted-foreground"}>{l}</span>
      <span className={`tabular-nums ${fett ? "font-semibold" : ""} ${rot ? "text-red-500" : gruen ? "text-emerald-600" : ""}`}>{v}</span>
    </div>
  );
}

function PdfKnopf({ href, label, bereit }: { href: string; label: string; bereit: boolean }) {
  if (!bereit) {
    return (
      <span className="kasten kasten-muted cursor-not-allowed opacity-50" data-tooltip="Zuerst die Kalkulation speichern">
        <FileText className="h-4 w-4" /> {label}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="kasten kasten-muted">
      <FileText className="h-4 w-4" /> {label}
    </a>
  );
}
