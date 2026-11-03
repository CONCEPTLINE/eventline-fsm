"use client";

/**
 * Lohn (/lohn) — für alle dieselbe Seite: je Monat des gewählten Jahres die
 * gestempelten Stunden und die Lohnabrechnung (PDF aus Trust flow/Bexio), darunter
 * der Lohnausweis des Jahres und die Zustellung (digital / Papier).
 *
 * Daten: GET /api/hr/mein-lohn?jahr= (nur eigene; in «Ansicht als» keine Lohndaten).
 * Jahr in der URL (?jahr=, überlebt Reload, CLAUDE.md §10).
 * Herunterladen: /api/hr/wage-documents/[id] (Signed-URL 5 min, zählt als «geöffnet»).
 *
 * Zustellung: unveränderte Logik aus dem früheren «Meine Lohndokumente» — beim
 * ersten Besuch (bzw. Einwilligung in alter Fassung) Wahl digital/Papier im Dialog
 * (accept-digital bzw. /api/hr/lohn-zustellung), danach «ändern» jederzeit.
 *
 * Laptop: Tabelle; Handy (< md): Karten (Masse «Dicht», docs/mobile/HANDY-WISSEN.md).
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileText, Loader2, Printer, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { formatDateFull } from "@/lib/format";
import { useIsMobile } from "@/lib/use-is-mobile";

interface Dokument {
  id: string;
  erhalten_at: string;
  neu: boolean;
}

interface MonatZeile {
  monat: number;
  minuten: number;
  laufend: boolean;
  abrechnung: Dokument | null;
}

interface Wahl {
  wahl: "digital" | "papier";
  version: string | null;
  gewaehlt_at: string;
  quelle: "selbst" | "lohnverwaltung" | "uebernommen";
}

interface Stand {
  jahr: number;
  jahre: number[];
  heute_monat: string;
  monate: MonatZeile[];
  lohnausweis: Dokument | null;
  wahl: Wahl | null;
  version_aktuell: string;
}

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const GRID = "180px 150px minmax(0, 1fr) 150px";

/** «14.10.» — Tag und Monat, Zürich-Kalender. */
const tagMonat = (iso: string) => formatDateFull(iso).slice(0, 6);
const stunden = (min: number) => `${(Math.round(min / 6) / 10).toFixed(1)} h`;
const monatParam = (jahr: number, monat: number) => `${jahr}-${String(monat).padStart(2, "0")}`;

function NeuMarke() {
  return (
    <span className="inline-flex items-center px-1.5 py-px text-[10px] font-bold tracking-wide bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200">
      NEU
    </span>
  );
}

function jahrAusUrl(roh: string | null): number | null {
  return roh && /^\d{4}$/.test(roh) ? Number(roh) : null;
}

/** Skelett im Layout der Seite (auch loading.tsx). */
export function MeinLohnSkelett() {
  return (
    <div className="space-y-4 max-w-[880px]">
      <div className="border border-border bg-card">
        <div className="px-5 py-2.5 border-b border-border"><Skeleton className="h-3 w-48" /></div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="px-5 py-3.5 border-b border-border last:border-b-0 flex items-center gap-6">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-40 max-w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-4 w-56" />
    </div>
  );
}

export function MeinLohn() {
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const urlJahr = jahrAusUrl(searchParams.get("jahr"));
  const [gewaehlt, setGewaehlt] = useState<number | null>(urlJahr);
  // Von aussen geänderte URL (Link auf dieselbe Seite) gewinnt wieder (Abgleich beim Rendern, kein Effekt).
  const [gesehenUrl, setGesehenUrl] = useState<number | null>(urlJahr);
  if (urlJahr !== gesehenUrl) {
    setGesehenUrl(urlJahr);
    setGewaehlt(urlJahr);
  }

  const [stand, setStand] = useState<Stand | null>(null);
  const [ansichtAls, setAnsichtAls] = useState(false);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [version, setVersion] = useState(0);
  const [oeffnet, setOeffnet] = useState<string | null>(null);
  const [wahlOffen, setWahlOffen] = useState(false);
  const [speichert, setSpeichert] = useState<"digital" | "papier" | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    let aktiv = true;
    const q = gewaehlt ? `?jahr=${gewaehlt}` : "";
    fetch(`/api/hr/mein-lohn${q}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        if (!aktiv) return;
        if (j.ansicht_als) { setAnsichtAls(true); setLadeFehler(false); return; }
        if (!j.success) {
          toast.error(j.error || j.message || "Lohn konnte nicht geladen werden");
          setLadeFehler(true);
          return;
        }
        setAnsichtAls(false);
        setLadeFehler(false);
        setStand(j as Stand);
      })
      .catch((e) => {
        if (!aktiv) return;
        toast.error(`Lohn konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
        setLadeFehler(true);
      });
    return () => { aktiv = false; };
  }, [gewaehlt, version]);

  function waehleJahr(j: number) {
    setGewaehlt(j);
    const url = new URL(window.location.href);
    url.searchParams.set("jahr", String(j));
    window.history.replaceState(window.history.state, "", url.toString());
  }

  async function oeffne(id: string) {
    if (oeffnet) return;
    setOeffnet(id);
    try {
      const res = await fetch(`/api/hr/wage-documents/${id}`);
      const j = await res.json().catch(() => ({}));
      if (!j.success) { toast.error(j.error || "PDF konnte nicht geöffnet werden"); return; }
      const a = document.createElement("a");
      a.href = j.url; a.download = j.filename; a.target = "_blank";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setVersion((v) => v + 1); // «NEU» fällt weg
    } catch (e) {
      toast.error(`PDF konnte nicht geöffnet werden: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOeffnet(null);
    }
  }

  async function speichereWahl(neu: "digital" | "papier") {
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
    if (ok) await speichereWahl("papier");
  }

  if (ansichtAls) {
    return (
      <Card className="max-w-[880px] border-dashed">
        <EmptyState icon={Wallet} title="Keine Lohndaten in «Ansicht als»" description="In «Ansicht als» werden keine Lohndaten der angesehenen Person angezeigt." />
      </Card>
    );
  }
  if (!stand || isMobile === null || (gewaehlt !== null && stand.jahr !== gewaehlt)) {
    if (ladeFehler) {
      return (
        <Card className="max-w-[880px]">
          <EmptyState
            icon={Wallet}
            title="Lohn konnte nicht geladen werden"
            action={<button type="button" className="kasten" onClick={() => setVersion((v) => v + 1)}>Erneut laden</button>}
          />
        </Card>
      );
    }
    return <MeinLohnSkelett />;
  }

  const wahl = stand.wahl;
  // Noch keine Wahl (bzw. Einwilligung in alter Fassung) → zuerst wählen.
  const wahlNoetig = wahl === null || (wahl.wahl === "digital" && wahl.version !== stand.version_aktuell);
  const heuteJahr = Number(stand.heute_monat.slice(0, 4));
  const ausweisFrist = `Ende Januar ${stand.jahr + 1}`;
  const ausweisKommtNoch = stand.heute_monat < `${stand.jahr + 1}-02`;
  const jahrAuswahl = (
    <div className="w-[104px] shrink-0" aria-label="Jahr">
      <SearchableSelect
        value={String(stand.jahr)}
        onChange={(id) => { if (id) waehleJahr(Number(id)); }}
        items={stand.jahre.map((j) => ({ id: String(j), label: String(j) }))}
        searchable={false}
        clearable={false}
      />
    </div>
  );

  const zustellZeile = !wahlNoetig && wahl && (
    <p className="text-[13px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        Zustellung: <strong className="font-semibold text-foreground">{wahl.wahl === "digital" ? "digital" : "auf Papier"}</strong>
        {" "}seit {formatDateFull(wahl.gewaehlt_at)}
        {wahl.quelle === "lohnverwaltung" ? " (auf deinen Wunsch eingetragen)" : ""}
      </span>
      <span aria-hidden>·</span>
      <ZustellKnopf
        busy={speichert !== null}
        onClick={() => { if (wahl.wahl === "digital") void aufPapier(); else setWahlOffen(true); }}
      />
    </p>
  );

  return (
    <div className="space-y-4 max-w-[880px]">
      {ConfirmModalElement}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Lohnabrechnungen {stand.jahr}</p>
        {jahrAuswahl}
      </div>

      {stand.monate.length === 0 ? (
        <Card>
          <EmptyState icon={FileText} title={`Keine Einsätze ${stand.jahr}`} description="Für dieses Jahr gibt es weder Stunden noch Lohnabrechnungen." />
        </Card>
      ) : isMobile ? (
        <div className="border border-border bg-card">
          {stand.monate.map((m) => (
            <MonatKarte key={m.monat} jahr={stand.jahr} m={m} oeffnet={oeffnet} onOeffne={oeffne} />
          ))}
        </div>
      ) : (
        <div className="border border-border bg-card">
          <div className="grid px-5 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border" style={{ gridTemplateColumns: GRID }}>
            <div>Monat</div>
            <div>Stunden</div>
            <div>Lohnabrechnung</div>
            <div />
          </div>
          {stand.monate.map((m) => (
            <MonatZeileDesktop key={m.monat} jahr={stand.jahr} m={m} oeffnet={oeffnet} onOeffne={oeffne} />
          ))}
        </div>
      )}

      <div className="border border-border bg-card">
        {!isMobile && (
          <div className="px-5 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">Lohnausweis</div>
        )}
        <div className={`flex items-center justify-between gap-3 ${isMobile ? "px-[14px] py-3 min-h-[48px]" : "px-5 py-3.5"} text-sm`}>
          <div className="min-w-0 flex items-center gap-2">
            <span className="font-semibold">{isMobile ? `Lohnausweis ${stand.jahr}` : stand.jahr}</span>
            {!isMobile && <span className="text-muted-foreground">für die Steuererklärung</span>}
            {stand.lohnausweis?.neu && <NeuMarke />}
          </div>
          {stand.lohnausweis ? (
            <PdfKnopf id={stand.lohnausweis.id} oeffnet={oeffnet} onOeffne={oeffne} />
          ) : (
            <span className="text-[13px] text-muted-foreground text-right">
              {ausweisKommtNoch ? (isMobile ? `bis ${ausweisFrist}` : `kommt bis ${ausweisFrist}`) : stand.jahr < heuteJahr ? "nicht vorhanden" : "–"}
            </span>
          )}
        </div>
      </div>

      {zustellZeile}

      <ZustellDialog
        open={wahlNoetig || wahlOffen}
        schliessbar={!wahlNoetig}
        onClose={() => setWahlOffen(false)}
        onDigital={() => void speichereWahl("digital")}
        onPapier={() => void speichereWahl("papier")}
        speichert={speichert}
        zeigePapier={wahlNoetig}
      />
    </div>
  );
}

function StundenLink({ jahr, m, mobil }: { jahr: number; m: MonatZeile; mobil?: boolean }) {
  const [hover, setHover] = useState(false);
  if (m.minuten === 0 && !m.laufend) return <span className="text-muted-foreground">0 h</span>;
  return (
    <span onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <PrefetchLink
        href={`/stempelzeiten?monat=${monatParam(jahr, m.monat)}`}
        className="tabular-nums underline-offset-2"
        style={{ textDecoration: hover ? "underline" : "none", color: hover ? "var(--accent)" : undefined }}
        data-tooltip={mobil ? undefined : "Stempelzeiten dieses Monats"}
      >
        {stunden(m.minuten)}
        {m.laufend && <span className="ml-1 text-xs text-muted-foreground">bisher</span>}
      </PrefetchLink>
    </span>
  );
}

function PdfKnopf({ id, oeffnet, onOeffne, klein }: { id: string; oeffnet: string | null; onOeffne: (id: string) => void; klein?: boolean }) {
  const laeuft = oeffnet === id;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOeffne(id); }}
      disabled={!!oeffnet}
      className={`kasten kasten-blue shrink-0 ${klein ? "h-[34px]" : ""}`}
    >
      {laeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {laeuft ? "Öffnet…" : klein ? "PDF" : "PDF öffnen"}
    </button>
  );
}

function statusText(m: MonatZeile): string {
  if (m.laufend) return "läuft noch";
  return m.minuten > 0 ? "–" : "kein Einsatz";
}

function MonatZeileDesktop({ jahr, m, oeffnet, onOeffne }: { jahr: number; m: MonatZeile; oeffnet: string | null; onOeffne: (id: string) => void }) {
  const leer = !m.laufend && !m.abrechnung && m.minuten === 0;
  return (
    <div
      className={`row-hover grid items-center px-5 py-3 text-sm border-b border-border last:border-b-0 ${m.laufend ? "bg-foreground/[0.02] dark:bg-foreground/[0.05]" : ""}`}
      style={{ gridTemplateColumns: GRID }}
    >
      <div className={`font-semibold ${leer ? "text-muted-foreground" : ""}`}>{MONATE[m.monat - 1]}</div>
      <div><StundenLink jahr={jahr} m={m} /></div>
      <div className="min-w-0 flex items-center gap-2">
        {m.abrechnung ? (
          <>
            {m.abrechnung.neu && <NeuMarke />}
            <span className="text-muted-foreground">erhalten {tagMonat(m.abrechnung.erhalten_at)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{statusText(m)}</span>
        )}
      </div>
      <div className="flex justify-end">
        {m.abrechnung && <PdfKnopf id={m.abrechnung.id} oeffnet={oeffnet} onOeffne={onOeffne} />}
      </div>
    </div>
  );
}

function MonatKarte({ jahr, m, oeffnet, onOeffne }: { jahr: number; m: MonatZeile; oeffnet: string | null; onOeffne: (id: string) => void }) {
  const leer = !m.laufend && !m.abrechnung && m.minuten === 0;
  return (
    <div className={`px-[14px] py-[10px] min-h-[52px] border-b border-border last:border-b-0 ${m.laufend ? "bg-foreground/[0.02] dark:bg-foreground/[0.05]" : ""}`}>
      <div className="flex items-baseline justify-between gap-3 text-[15px]">
        <span className={leer ? "text-muted-foreground" : "font-semibold"}>{MONATE[m.monat - 1]}</span>
        <StundenLink jahr={jahr} m={m} mobil />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[13px] min-h-[34px]">
        {m.abrechnung ? (
          <>
            <span className="flex items-center gap-1.5 min-w-0">
              {m.abrechnung.neu && <NeuMarke />}
              <span className="text-muted-foreground">erhalten {tagMonat(m.abrechnung.erhalten_at)}</span>
            </span>
            <PdfKnopf id={m.abrechnung.id} oeffnet={oeffnet} onOeffne={onOeffne} klein />
          </>
        ) : (
          <span className="text-muted-foreground">{statusText(m)}</span>
        )}
      </div>
    </div>
  );
}

function ZustellKnopf({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 disabled:opacity-60 max-md:min-h-[34px]"
      style={{ color: hover ? "var(--accent)" : undefined }}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      ändern
    </button>
  );
}

/** Wahl digital/Papier — Text und Ablauf wie bisher unter «Meine Lohndokumente». */
function ZustellDialog({ open, schliessbar, onClose, onDigital, onPapier, speichert, zeigePapier }: {
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
            <strong>Datenschutz:</strong> Deine Lohndokumente liegen verschlüsselt im EVENTLINE-System.
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
