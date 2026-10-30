"use client";

/**
 * Jahresliste (Lohn-Umbau Phase 2) — kleine Karte in Lohn › Lohndokumente.
 *
 * Je Person und Lohnmonat AHV-Lohn (davon beitragsfrei bis CHF 2'500), ALV-,
 * UVG-Lohn (nur BU bzw. BU+NBU), Quellensteuer — Grundlage für
 * Lohnbescheinigung und Lohnausweis. Basis: Auszahlungsjahr (Standard, AHV
 * und Lohnausweis) oder Arbeitsjahr.
 *
 * GET /api/hr/jahresliste?jahr=YYYY&basis=auszahlung|arbeit[&format=xlsx]
 * Excel = Blob-Download (wie das Timesheet der Monatsstunden), Vorschau =
 * Summen je Person aus der JSON-Variante. Jahr, Basis und Vorschau im
 * localStorage (§10).
 *
 * Phase 4: Lohnausweis (offizielles ESTV-Formular 11, je Person oder alle)
 * und Lohnbescheinigung AK 40 (CSV) — immer nach AUSZAHLUNGSjahr.
 * Personalien (AHV-Nr., Adresse) liegen nicht im ERP: CSV-Vorlage
 * herunterladen, im Backoffice ausfüllen und hier laden — die Datei bleibt
 * NUR im Browser-Speicher dieser Seite (bewusst nicht gemerkt, nicht
 * gespeichert) und wird mit jedem Druck mitgeschickt. Ohne sie: rote
 * Platzhalter. Erzeugte Lohnausweise werden nur heruntergeladen.
 *   GET  /api/hr/lohnausweis?jahr&vorlage=1  POST /api/hr/lohnausweis  POST /api/hr/ak-export
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, FileSpreadsheet, FileText, Loader2, Sheet, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Loading } from "@/components/ui/spinner";
import { formatChf, formatDateFull } from "@/lib/format";
import { JahrWahl, useGemerkt, useGemerktesJahr } from "@/components/hr/lohn/jahr-wahl";

type Basis = "auszahlung" | "arbeit";

interface Summe {
  profile_id: string;
  name: string;
  von: string | null;
  bis: string | null;
  ahv_lohn: number;
  ahv_beitragsfrei: number;
  alv_lohn: number;
  uvg_lohn_nur_bu: number;
  uvg_lohn_bu_nbu: number;
  quellensteuer: number;
  brutto: number;
  netto: number;
  spesen: number;
}

const BASIS_WERTE = ["auszahlung", "arbeit"] as const;

const BETRAGS_SPALTEN: { key: keyof Summe; label: string; tip?: string }[] = [
  { key: "ahv_lohn", label: "AHV-Lohn" },
  { key: "ahv_beitragsfrei", label: "davon frei", tip: "Beitragsfrei bis CHF 2'500 im Jahr (Art. 34d AHVV), sofern die Person die Beiträge nicht verlangt" },
  { key: "alv_lohn", label: "ALV-Lohn", tip: "Bis zur ALV-Höchstgrenze" },
  { key: "uvg_lohn_nur_bu", label: "UVG nur BU" },
  { key: "uvg_lohn_bu_nbu", label: "UVG BU+NBU" },
  { key: "quellensteuer", label: "Quellenst." },
  { key: "brutto", label: "Brutto" },
  { key: "netto", label: "Netto" },
  { key: "spesen", label: "Spesen", tip: "Spesen-Zusatzposten (nicht im Brutto) — Lohnausweis Ziffer 13" },
];

/** Datei aus einer Antwort herunterladen (Blob). */
async function herunterladen(res: Response, fallbackName: string) {
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

async function fehlerText(res: Response): Promise<string> {
  const j = await res.json().catch(() => null);
  return j?.error || j?.message || `Fehler ${res.status}`;
}

export function JahreslisteKarte() {
  const [jahr, setJahr] = useGemerktesJahr("lohn-jahresliste-jahr");
  const [basis, setBasis] = useGemerkt<Basis>("lohn-jahresliste-basis", "auszahlung", BASIS_WERTE);
  const [vorschau, setVorschau] = useGemerkt<"0" | "1">("lohn-jahresliste-vorschau", "0", ["0", "1"]);
  const [summen, setSummen] = useState<{ key: string; liste: Summe[] } | null>(null);
  const [laedtExcel, setLaedtExcel] = useState(false);
  // Personalien-CSV: nur im Speicher dieser Seite (nie gemerkt/gespeichert).
  const [personalien, setPersonalien] = useState<File | null>(null);
  // "alle" | "ak40" | "vorlage" | profile_id
  const [laedt, setLaedt] = useState<string | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);
  const schluessel = `${jahr}|${basis}`;

  useEffect(() => {
    if (vorschau !== "1") return;
    let aktiv = true;
    const key = `${jahr}|${basis}`;
    fetch(`/api/hr/jahresliste?jahr=${jahr}&basis=${basis}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) {
          toast.error(`Jahresliste: ${j.error ?? "konnte nicht geladen werden"}`);
          setSummen({ key, liste: [] });
          return;
        }
        setSummen({ key, liste: (j.summen ?? []) as Summe[] });
      })
      .catch((e) => {
        if (!aktiv) return;
        toast.error(`Jahresliste: ${e instanceof Error ? e.message : String(e)}`);
        setSummen({ key, liste: [] });
      });
    return () => { aktiv = false; };
  }, [vorschau, jahr, basis]);

  async function excel() {
    if (laedtExcel) return;
    setLaedtExcel(true);
    try {
      const res = await fetch(`/api/hr/jahresliste?jahr=${jahr}&basis=${basis}&format=xlsx`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error || "Export fehlgeschlagen");
        return;
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `eventline-jahresliste_${jahr}_${basis}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (e) {
      toast.error(`Export fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaedtExcel(false);
    }
  }

  async function vorlage() {
    if (laedt) return;
    setLaedt("vorlage");
    try {
      const res = await fetch(`/api/hr/lohnausweis?jahr=${jahr}&vorlage=1`);
      if (!res.ok) { toast.error(`CSV-Vorlage: ${await fehlerText(res)}`); return; }
      await herunterladen(res, `eventline-personalien_${jahr}.csv`);
    } catch (e) {
      toast.error(`CSV-Vorlage: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaedt(null);
    }
  }

  /** Lohnausweis (eine Person oder alle) bzw. AK 40 — immer nach Auszahlungsjahr. */
  async function erzeuge(was: string) {
    if (laedt) return;
    setLaedt(was);
    try {
      const fd = new FormData();
      fd.set("jahr", String(jahr));
      if (was !== "alle" && was !== "ak40") fd.set("profile_id", was);
      if (personalien) fd.set("personalien", personalien);
      const res = await fetch(was === "ak40" ? "/api/hr/ak-export" : "/api/hr/lohnausweis", { method: "POST", body: fd });
      if (!res.ok) { toast.error(`${was === "ak40" ? "AK 40" : "Lohnausweis"}: ${await fehlerText(res)}`); return; }
      await herunterladen(res, was === "ak40" ? `eventline-lohnbescheinigung-ak40_${jahr}.csv` : `lohnausweis_${jahr}.pdf`);
      let hinweise: string[] = [];
      try {
        hinweise = JSON.parse(decodeURIComponent(res.headers.get("X-Lohnausweis-Hinweise") ?? "%5B%5D")) as string[];
      } catch {
        hinweise = [];
      }
      if (hinweise.length > 0) {
        toast.warning("Lohnausweis mit Platzhaltern", {
          description: `${hinweise.slice(0, 4).join(" · ")}${hinweise.length > 4 ? ` · und ${hinweise.length - 4} weitere` : ""}${personalien ? "" : " — Personalien-CSV laden"}`,
          duration: 12000,
        });
      } else if (was === "ak40" && !personalien) {
        toast.info("AK 40 ohne AHV-Nummern", { description: "Spalte AHV-Nr. ist leer — Personalien-CSV laden." });
      }
    } catch (e) {
      toast.error(`Download fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaedt(null);
    }
  }

  const vorschauLaedt = vorschau === "1" && summen?.key !== schluessel;
  const liste = summen && summen.key === schluessel ? summen.liste : [];

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sheet className="h-4 w-4" /> Jahresliste
            </h3>
            <p className="text-xs text-muted-foreground">
              AHV-, ALV-, UVG-Löhne und Quellensteuer je Person und Monat — Grundlage für Lohnbescheinigung und Lohnausweis.
            </p>
          </div>
          <JahrWahl jahr={jahr} onChange={setJahr} />
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setBasis("auszahlung")}
              className={basis === "auszahlung" ? "kasten-active" : "kasten-toggle-off"}
              data-tooltip="Monate nach Auszahlungsdatum — massgebend für AHV und Lohnausweis"
            >
              Auszahlungsjahr
            </button>
            <button
              type="button"
              onClick={() => setBasis("arbeit")}
              className={basis === "arbeit" ? "kasten-active" : "kasten-toggle-off"}
              data-tooltip="Monate nach dem Jahr, in dem gearbeitet wurde"
            >
              Arbeitsjahr
            </button>
          </div>
          <button type="button" onClick={() => void excel()} disabled={laedtExcel} className="kasten kasten-muted">
            {laedtExcel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {laedtExcel ? "Wird erstellt…" : "Excel herunterladen"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1" data-tooltip="Immer nach Auszahlungsjahr (Lohnausweis, AHV)">
            Lohnausweis &amp; AK 40 · Auszahlung {jahr}
          </p>
          <button type="button" onClick={() => void erzeuge("alle")} disabled={!!laedt} className="kasten kasten-muted" data-tooltip="Offizielles ESTV-Formular 11, alle Personen in einer PDF (nur Download, nicht gespeichert)">
            {laedt === "alle" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            {laedt === "alle" ? "Wird erstellt…" : "Lohnausweise (PDF)"}
          </button>
          <button type="button" onClick={() => void erzeuge("ak40")} disabled={!!laedt} className="kasten kasten-muted" data-tooltip="Lohnbescheinigung Ausgleichskasse: AHV-Lohn, davon beitragsfrei, ALV-Lohn, Zeitraum — CSV für Excel">
            {laedt === "ak40" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            {laedt === "ak40" ? "Wird erstellt…" : "AK 40 (CSV)"}
          </button>
          <span className="flex-1" />
          <button type="button" onClick={() => void vorlage()} disabled={!!laedt} className="kasten kasten-muted text-xs" data-tooltip="Je Person eine Zeile: AHV-Nr. und Adresse im Backoffice ergänzen, dann hier laden">
            {laedt === "vorlage" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} CSV-Vorlage
          </button>
          {personalien ? (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border bg-muted/40" data-tooltip="Nur im Speicher dieser Seite — wird nicht gespeichert und beim Neuladen verworfen">
              <FileSpreadsheet className="h-3 w-3" /> {personalien.name}
              <button type="button" onClick={() => setPersonalien(null)} className="text-muted-foreground hover:text-foreground" aria-label="Personalien entfernen">
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => dateiRef.current?.click()} disabled={!!laedt} className="kasten kasten-muted text-xs" data-tooltip="Ausgefüllte Personalien-CSV — bleibt nur im Speicher dieser Seite">
              <Upload className="h-3 w-3" /> Personalien laden
            </button>
          )}
          <input
            ref={dateiRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(ev) => {
              const f = ev.target.files?.[0] ?? null;
              ev.target.value = "";
              if (f && f.size > 1024 * 1024) { toast.error("Personalien-CSV über 1 MB"); return; }
              setPersonalien(f);
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setVorschau(vorschau === "1" ? "0" : "1")}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Vorschau: Summen je Person
          {vorschau === "1" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {vorschau === "1" && (
          vorschauLaedt ? (
            <Loading />
          ) : liste.length === 0 ? (
            <EmptyState
              icon={Sheet}
              title={`Keine Abrechnungen ${jahr}`}
              description="Die Liste stützt sich auf erzeugte Lohnabrechnungen (von Hand hochgeladene PDFs ohne Daten fehlen)."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="text-left font-normal px-2 py-1.5">Person</th>
                    <th className="text-left font-normal px-2 py-1.5">Lohnperiode</th>
                    {BETRAGS_SPALTEN.map((s) => (
                      <th key={s.key} className="text-right font-normal px-2 py-1.5 whitespace-nowrap" data-tooltip={s.tip}>
                        {s.label}
                      </th>
                    ))}
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {liste.map((s) => (
                    <tr key={s.profile_id}>
                      <td className="px-2 py-1.5 font-medium whitespace-nowrap">{s.name}</td>
                      <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                        {s.von || s.bis ? `${s.von ? formatDateFull(s.von) : "—"} – ${s.bis ? formatDateFull(s.bis) : "—"}` : "—"}
                      </td>
                      {BETRAGS_SPALTEN.map((c) => (
                        <td key={c.key} className="px-2 py-1.5 text-right whitespace-nowrap">
                          {formatChf(s[c.key] as number, { ohnePrefix: true })}
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right">
                        {basis === "auszahlung" && (
                          <button
                            type="button"
                            onClick={() => void erzeuge(s.profile_id)}
                            disabled={!!laedt}
                            className="kasten kasten-muted text-xs"
                            data-tooltip={`Lohnausweis ${jahr} von ${s.name} (PDF)`}
                            aria-label={`Lohnausweis ${s.name}`}
                          >
                            {laedt === s.profile_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
