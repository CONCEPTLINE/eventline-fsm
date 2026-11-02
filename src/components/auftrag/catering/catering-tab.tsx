"use client";

// Auftrag → Reiter «Catering» — Getränke-Catering kalkulieren (Mindestumsatz / Fixpreis) und
// Verträge + Getränkekarte als PDF erzeugen.
//
// Wer/wo (CLAUDE.md B3): nur Admins (Einkaufspreise, Personalkosten, Gewinn), nur Laptop (die Handy-Auftragsansicht hat keinen Reiter).
// Rechnen läuft live im Browser mit demselben Kern wie der Server (lib/catering/rechnen.ts); gespeichert und in
// Vertrag/Mail verwendet wird das beim Speichern serverseitig neu berechnete, eingefrorene Ergebnis.
// Karte und Einstellungen kommen aus catering_getraenke / catering_einstellungen (Migration 372).

import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, FileText, Wine, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { formatChf } from "@/lib/format";
import { rechneCatering, type CateringEingabe, type CateringErgebnis, type CateringParameter } from "@/lib/catering/rechnen";
import { mailtext } from "@/lib/catering/mailtext";
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
  { key: "aufbauMin", label: "Aufbau", einheit: "Min." },
  { key: "gesamtMin", label: "Veranstaltung gesamt", einheit: "Min." },
  { key: "abbauMin", label: "Abbau", einheit: "Min." },
  { key: "vorzeitMin", label: "Vorzeit (Gäste kommen an)", einheit: "Min." },
  { key: "pauseMin", label: "Pause", einheit: "Min." },
  { key: "nachzeitMin", label: "Nachzeit (nach dem Programm)", einheit: "Min." },
];
const STANDARD: Record<FeldKey, string> = { gaeste: "", aufbauMin: "60", gesamtMin: "180", abbauMin: "30", vorzeitMin: "30", pauseMin: "15", nachzeitMin: "60" };

const chf = (n: number) => formatChf(n, { stellen: 0 });
const chfRappen = (n: number) => formatChf(n, { stellen: 2 });

function alsZahl(v: string): number | null {
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
  const [anrede, setAnrede] = useState("");
  const [du, setDu] = useState(true);

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
            gaeste: String(e.gaeste), aufbauMin: String(e.aufbauMin), gesamtMin: String(e.gesamtMin), abbauMin: String(e.abbauMin),
            vorzeitMin: String(e.vorzeitMin), pauseMin: String(e.pauseMin), nachzeitMin: String(e.nachzeitMin),
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
    const z = (k: FeldKey) => alsZahl(werte[k]);
    const g = z("gaeste"), a = z("aufbauMin"), ges = z("gesamtMin"), ab = z("abbauMin"), v = z("vorzeitMin"), p = z("pauseMin"), n = z("nachzeitMin");
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
      toast.success("Kalkulation gespeichert");
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
  const gespeichertA = g?.ergebnis.fixpreis;
  const gespeichertB = g?.ergebnis.mindestumsatz;
  const abweichung = r != null && g != null && !geaendert && (gespeichertA !== r.fixpreis || gespeichertB !== r.mindestumsatz);
  const pdfBereit = g != null && !geaendert;
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
              Anlass (Vertrag, Karte, Mail)
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
                    type="number" inputMode="numeric" min={0} step={1} value={werte[f.key]} disabled={!canEdit}
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
                type="text" value={beginn} disabled={!canEdit} placeholder="z. B. 18:30"
                onChange={(e) => { setBeginn(e.target.value); setGeaendert(true); }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-60"
              />
            </label>
          </div>
          {eingabe && (
            <p className="text-xs text-muted-foreground">
              Programm ohne Ausschank: {eingabe.gesamtMin - eingabe.vorzeitMin - eingabe.pauseMin - eingabe.nachzeitMin} Min.
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
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Variante A · Kundschaft zahlt alles</p>
                <p className="mt-1 text-3xl font-bold text-emerald-600">{chf(r.fixpreis)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Fixpreis inkl. {r.inbegriffen} Getränke, Mehrverbrauch zum Kartenpreis</p>
              </CardContent>
            </Card>
            <Card className="bg-card">
              <CardContent className="p-4">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Variante B · Gäste zahlen selbst</p>
                <p className="mt-1 text-3xl font-bold text-emerald-600">{chf(r.mindestumsatz)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Mindestumsatz. Kauft kein Gast etwas, zahlt die Kundschaft den ganzen Betrag ({chf(r.mindestumsatz)}). Bei halber Menge: {chf(r.differenzBeiHalberMenge)}</p>
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
                <Zeile l="Puffer" v={chf(r.puffer)} rot />
                <Zeile l="Kosten total" v={chf(r.kosten)} rot fett />
              </div>
              <div>
                <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-emerald-600">Einnahmen und Gewinn</p>
                <Zeile l="Umsatz der Gäste (Karte)" v={chf(r.erwarteterUmsatz)} gruen />
                <Zeile l="Gewinn bei Variante A" v={chf(r.gewinnA)} gruen={r.gewinnA >= 0} rot={r.gewinnA < 0} fett />
                <Zeile l="Gewinn bei Variante B" v={chf(r.gewinnB)} gruen={r.gewinnB >= 0} rot={r.gewinnB < 0} fett />
                <Zeile l="Ersparnis der Kundschaft bei A" v={`${Math.round((1 - r.fixpreis / r.erwarteterUmsatz) * 100)} %`} />
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button type="button" onClick={() => void speichern()} disabled={saving || !eingabe || zuLang || !r || !daten.job.auftraggeber} className="kasten kasten-blue">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Wird gespeichert …" : "Kalkulation speichern"}
          </button>
        )}
        <PdfKnopf href={pdfUrl("vertrag-a")} label="Vertrag A (Fixpreis)" bereit={pdfBereit} />
        <PdfKnopf href={pdfUrl("vertrag-b")} label="Vertrag B (Mindestumsatz)" bereit={pdfBereit} />
        <PdfKnopf href={pdfUrl("karte")} label="Getränkekarte" bereit />
      </div>
      {geaendert && <p className="text-xs text-amber-600">Ungespeicherte Änderungen: Die Verträge zeigen erst nach dem Speichern die neuen Zahlen.</p>}
      {abweichung && (
        <p className="text-xs text-amber-600">
          Gespeichert sind {chf(gespeichertA ?? 0)} (A) und {chf(gespeichertB ?? 0)} (B). Die Einstellungen oder die Karte haben sich seither geändert, jetzt wären es {chf(r.fixpreis)} und {chf(r.mindestumsatz)}. Zum Übernehmen speichern.
        </p>
      )}

      {pdfBereit && g && (
        <Card className="bg-card">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Mail an die Kundschaft (Vorschlag, wird nicht gesendet)</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setDu(true)} className={du ? "kasten kasten-active" : "kasten kasten-muted"}>Du</button>
                <button type="button" onClick={() => setDu(false)} className={!du ? "kasten kasten-active" : "kasten kasten-muted"}>Sie</button>
              </div>
            </div>
            <label className="block text-xs text-muted-foreground">
              Anrede (von Hand, Herr/Frau nie raten)
              <input
                value={anrede} onChange={(e) => setAnrede(e.target.value)} placeholder="z. B. Hallo Vorname oder Guten Tag Herr/Frau Nachname"
                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
            </label>
            <textarea
              readOnly rows={12} value={mailtext({
                anrede, anlass: anlass.trim() || daten.job.titel, datumText: daten.job.datumText ?? "", gaeste: g.eingabe.gaeste,
                fixpreis: Number(g.ergebnis.fixpreis), mindestumsatz: Number(g.ergebnis.mindestumsatz), inbegriffen: Number(g.ergebnis.inbegriffen),
                getraenkeProGast: Number(g.ergebnis.getraenkeProGast), erwarteterUmsatz: Number(g.ergebnis.erwarteterUmsatz), du,
              })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button" className="kasten kasten-muted"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(mailtext({
                      anrede, anlass: anlass.trim() || daten.job.titel, datumText: daten.job.datumText ?? "", gaeste: g.eingabe.gaeste,
                      fixpreis: Number(g.ergebnis.fixpreis), mindestumsatz: Number(g.ergebnis.mindestumsatz), inbegriffen: Number(g.ergebnis.inbegriffen),
                      getraenkeProGast: Number(g.ergebnis.getraenkeProGast), erwarteterUmsatz: Number(g.ergebnis.erwarteterUmsatz), du,
                    }));
                    toast.success("Mailtext kopiert");
                  } catch {
                    toast.error("Kopieren nicht möglich");
                  }
                }}
              >
                <Copy className="h-4 w-4" /> Text kopieren
              </button>
              <span className="text-xs text-muted-foreground">Text prüfen, aus deinem Postfach (leo@) senden und die PDFs oben anhängen. Grussformel und Signatur kommen vom Mailprogramm.</span>
            </div>
          </CardContent>
        </Card>
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
