"use client";

/**
 * Lohndokumente-Liste fuer den eingeloggten Mitarbeiter — zeigt
 * monatliche Lohnabrechnungen + jaehrliche Lohnausweise zum Download.
 *
 * Erst-Zugriff: Wahl der Zustellung (Lohn-Umbau Phase 4) — digital (Einwilligung
 * mit Datenschutz-Hinweis, wie bisher) oder auf Papier. Jede Wahl landet mit
 * Zeitpunkt in der Historie (lohn_zustellung_wahl, /api/hr/lohn-zustellung);
 * die Lohnverwaltung sieht sie unter Lohndokumente. Wechsel jederzeit hier.
 *
 * Download via Signed-URL (5min) — kein direkter Storage-Zugriff vom
 * Client, alles ueber /api/hr/wage-documents. Der Abruf zaehlt als «geoeffnet».
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { FileText, Download, ShieldCheck, Printer, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import { formatDateFull } from "@/lib/format";

interface WageDoc {
  id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  file_size: number | null;
  uploaded_at: string;
}

interface Wahl {
  wahl: "digital" | "papier";
  version: string | null;
  gewaehlt_at: string;
  quelle: "selbst" | "lohnverwaltung" | "uebernommen";
}

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

const datum = (iso: string) => formatDateFull(iso);

interface Stand {
  ansichtAls: boolean;
  wahl: Wahl | null;
  versionAktuell: string;
  docs: WageDoc[];
}

/** Dokumente + Zustell-Wahl laden. Fehler → Toast, Teil bleibt leer. */
async function holeStand(): Promise<Stand> {
  // «Ansicht als» zeigt keine Lohndaten der angesehenen Person (Lohn-
  // Umbau Phase 1) — der Server liefert dann ansicht_als statt Dokumenten.
  const stand: Stand = { ansichtAls: false, wahl: null, versionAktuell: "1.0", docs: [] };
  try {
    const [dRes, wRes] = await Promise.all([fetch("/api/hr/wage-documents"), fetch("/api/hr/lohn-zustellung", { cache: "no-store" })]);
    const [d, w] = await Promise.all([dRes.json().catch(() => ({})), wRes.json().catch(() => ({}))]);
    if (d.ansicht_als || w.ansicht_als) return { ...stand, ansichtAls: true };
    if (w.success) {
      stand.wahl = (w.wahl as Wahl | null) ?? null;
      if (typeof w.version_aktuell === "string") stand.versionAktuell = w.version_aktuell;
    } else {
      toast.error(w.error || "Zustellung konnte nicht geladen werden");
    }
    if (d.success) stand.docs = d.documents as WageDoc[];
    else toast.error(d.error || "Lohndokumente konnten nicht geladen werden");
  } catch (e) {
    toast.error(`Lohndokumente konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
  }
  return stand;
}

export function LohnausweiseList() {
  // null = lädt; version → neu laden nach einer Wahl.
  const [stand, setStand] = useState<Stand | null>(null);
  const [version, setVersion] = useState(0);
  // Einwilligung neu wählen (aus der Papier-Karte) — dann schliessbar.
  const [wahlOffen, setWahlOffen] = useState(false);
  const [speichert, setSpeichert] = useState<"digital" | "papier" | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    let aktiv = true;
    holeStand().then((s) => { if (aktiv) setStand(s); });
    return () => { aktiv = false; };
  }, [version]);

  const loading = stand === null;
  const ansichtAls = stand?.ansichtAls === true;
  const wahl = stand?.wahl ?? null;
  const versionAktuell = stand?.versionAktuell ?? "1.0";
  const docs = stand?.docs ?? [];

  // Noch keine Wahl (bzw. Einwilligung in alter Fassung) → zuerst wählen.
  const wahlNoetig = !loading && !ansichtAls && (wahl === null || (wahl.wahl === "digital" && wahl.version !== versionAktuell));

  async function waehle(neu: "digital" | "papier") {
    setSpeichert(neu);
    try {
      const res = neu === "digital"
        ? await fetch("/api/hr/wage-documents/accept-digital", { method: "POST" })
        : await fetch("/api/hr/lohn-zustellung", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wahl: "papier" }) });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { toast.error(j.error || "Speichern fehlgeschlagen"); return; }
      toast.success(neu === "digital" ? "Digitale Zustellung gespeichert" : "Zustellung auf Papier gespeichert");
      setWahlOffen(false);
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSpeichert(null);
    }
  }

  async function aufPapier() {
    const ok = await confirm({
      title: "Lohndokumente auf Papier?",
      message: "Du widerrufst die digitale Zustellung. Die Lohnverwaltung gibt dir deine Lohnabrechnungen und den Lohnausweis künftig auf Papier ab. In der App bleiben sie zusätzlich abrufbar. Zurückwechseln geht jederzeit.",
      confirmLabel: "Auf Papier wechseln",
      variant: "blue",
    });
    if (ok) await waehle("papier");
  }

  async function download(id: string) {
    const res = await fetch(`/api/hr/wage-documents/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!j.success) { toast.error(j.error || "Download fehlgeschlagen"); return; }
    const a = document.createElement("a");
    a.href = j.url; a.download = j.filename; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  const byYear = docs.reduce<Record<number, WageDoc[]>>((acc, d) => {
    (acc[d.year] ??= []).push(d);
    return acc;
  }, {});
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  return (
    <div className="space-y-3">
      {ConfirmModalElement}
      <div>
        <h2 className="text-sm font-semibold">Meine Lohndokumente</h2>
        <p className="text-xs text-muted-foreground">
          Monatliche Lohnabrechnungen + jährlicher Lohnausweis (für die Steuererklärung).
        </p>
      </div>

      {!loading && !ansichtAls && !wahlNoetig && wahl?.wahl === "digital" && (
        <DigitalConsentCard wahl={wahl} onPapier={() => void aufPapier()} busy={speichert === "papier"} />
      )}
      {!loading && !ansichtAls && !wahlNoetig && wahl?.wahl === "papier" && (
        <PapierCard wahl={wahl} onDigital={() => setWahlOffen(true)} />
      )}

      {ansichtAls ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            In «Ansicht als» werden keine Lohndaten der angesehenen Person angezeigt.
          </CardContent>
        </Card>
      ) : loading ? (
        <Card className="bg-card"><CardContent><Loading /></CardContent></Card>
      ) : wahlNoetig ? null : docs.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-10 text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-foreground/10 dark:bg-foreground/15 flex items-center justify-center">
              <FileText className="h-6 w-6 text-foreground/40" />
            </div>
            <p className="text-sm font-medium">Noch keine Dokumente</p>
            <p className="text-xs text-muted-foreground">
              Sobald deine Lohnabrechnung oder dein Lohnausweis verfügbar ist, erscheint sie hier.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {years.map((y) => (
            <Card key={y} className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">{y}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {byYear[y].sort(sortDocs).map((d) => (
                  <DocRow key={d.id} doc={d} onDownload={() => download(d.id)} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConsentModal
        open={wahlNoetig || wahlOffen}
        schliessbar={!wahlNoetig}
        onClose={() => setWahlOffen(false)}
        onDigital={() => void waehle("digital")}
        onPapier={() => void waehle("papier")}
        speichert={speichert}
        zeigePapier={wahlNoetig}
      />
    </div>
  );
}

function sortDocs(a: WageDoc, b: WageDoc): number {
  if (a.doc_type !== b.doc_type) return a.doc_type === "lohnausweis" ? -1 : 1;
  return (b.period_month ?? 0) - (a.period_month ?? 0);
}

function DocRow({ doc, onDownload }: { doc: WageDoc; onDownload: () => void }) {
  const label = doc.doc_type === "lohnausweis"
    ? `Lohnausweis ${doc.year}`
    : `Lohnabrechnung ${MONTH_NAMES[(doc.period_month ?? 1) - 1]} ${doc.year}`;
  const tag = doc.doc_type === "lohnausweis" ? "Jahres-Dokument" : "Monatsabrechnung";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <div className="min-w-0 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{label}</p>
          <p className="text-[10px] text-muted-foreground">{tag}</p>
        </div>
      </div>
      <button type="button" onClick={onDownload} className="kasten kasten-blue shrink-0">
        <Download className="h-3.5 w-3.5" /> PDF
      </button>
    </div>
  );
}

function DigitalConsentCard({ wahl, onPapier, busy }: { wahl: Wahl; onPapier: () => void; busy: boolean }) {
  return (
    <Card className="bg-card border-emerald-500/30">
      <CardContent className="py-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-sm font-medium">Einwilligung digitale Lohndokumente</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {wahl.quelle === "lohnverwaltung" ? "Auf deinen Wunsch hat die Lohnverwaltung am " : "Du hast am "}
              <span className="font-medium text-foreground">{datum(wahl.gewaehlt_at)}</span>
              {wahl.quelle === "lohnverwaltung" ? " eingetragen, dass du " : " zugestimmt, "}
              Lohnabrechnungen und Lohnausweise digital in dieser App {wahl.quelle === "lohnverwaltung" ? "erhältst." : "zu erhalten."}
              {wahl.version && <span className="text-muted-foreground/70"> (Version {wahl.version})</span>}
            </p>
            <button type="button" onClick={onPapier} disabled={busy} className="kasten kasten-muted text-[11px]">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Printer className="h-3 w-3" />}
              {busy ? "Speichert…" : "Auf Papier wechseln"}
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PapierCard({ wahl, onDigital }: { wahl: Wahl; onDigital: () => void }) {
  return (
    <Card className="bg-card border-blue-500/30">
      <CardContent className="py-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-blue-500/15 flex items-center justify-center shrink-0">
            <Printer className="h-4 w-4 text-blue-700 dark:text-blue-300" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-sm font-medium">Lohndokumente auf Papier</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Seit <span className="font-medium text-foreground">{datum(wahl.gewaehlt_at)}</span>
              {wahl.quelle === "lohnverwaltung" ? " (auf deinen Wunsch eingetragen)" : ""} erhältst du deine Lohnabrechnungen
              und den Lohnausweis auf Papier. Hier sind sie zusätzlich abrufbar.
            </p>
            <button type="button" onClick={onDigital} className="kasten kasten-muted text-[11px]">
              <ShieldCheck className="h-3 w-3" /> Digital erhalten
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConsentModal({ open, schliessbar, onClose, onDigital, onPapier, speichert, zeigePapier }: {
  open: boolean;
  schliessbar: boolean;
  onClose: () => void;
  onDigital: () => void;
  onPapier: () => void;
  speichert: "digital" | "papier" | null;
  zeigePapier: boolean;
}) {
  return (
    <Modal open={open} onClose={() => { if (schliessbar && !speichert) onClose(); }} title="Digitale Lohndokumente" closable={schliessbar && !speichert} size="md">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30">
          <ShieldCheck className="h-5 w-5 text-blue-700 dark:text-blue-300 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-900 dark:text-blue-100 space-y-1">
            <p className="font-semibold">Lohnabrechnungen + Lohnausweis digital</p>
            <p>
              EVENTLINE stellt dir deine Lohndokumente (monatliche Abrechnungen + jährlicher Lohnausweis)
              digital in dieser App zur Verfügung. Du kannst sie hier jederzeit als PDF herunterladen.
            </p>
          </div>
        </div>

        <div className="text-xs text-muted-foreground space-y-2">
          <p>
            <strong>Datenschutz:</strong> Deine Lohndokumente liegen verschlüsselt im Eventline-System.
            Nur du und die HR-Verantwortlichen können sie sehen. Download-Links sind 5 Minuten gültig.
            Benachrichtigungen per Mail enthalten nie Beträge.
          </p>
          <p>
            <strong>Alternative:</strong> Du kannst deine Lohndokumente stattdessen auf Papier erhalten.
            Deine Wahl kannst du jederzeit hier ändern.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={onDigital} disabled={!!speichert} className="kasten kasten-red w-full justify-center">
            {speichert === "digital" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {speichert === "digital" ? "Speichert…" : "Ich stimme der digitalen Bereitstellung zu"}
          </button>
          {zeigePapier && (
            <button type="button" onClick={onPapier} disabled={!!speichert} className="kasten kasten-muted w-full justify-center">
              {speichert === "papier" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              {speichert === "papier" ? "Speichert…" : "Stattdessen auf Papier erhalten"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
