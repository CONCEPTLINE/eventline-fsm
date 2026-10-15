"use client";

/**
 * SyncKopf — Kopfzeile des Finanz-Dashboards in EINER Linie: links der
 * Titel (`links`), rechts der letzte Bexio-Abgleich mit Status und der Knopf
 * «Jetzt abgleichen» (POST /api/finanzen/sync, Body {} — «Alles neu laden»
 * (voll:true) gibt es bewusst nur per API/Skript). Hinweise (nicht
 * verbunden / Scopes fehlen / Lauf-Fehler) als schmale einzeilige Leiste
 * direkt darunter, nur wenn noetig.
 *
 * Zeitlogik (Vertrag types.ts): 'laeuft' juenger als SYNC_TOT_NACH_MS →
 * Spinner; aelter → «abgebrochen — naechster Versuch ab hh:mm» (Lambda nach
 * 5 min sicher tot, die 15-min-Sperre SYNC_SPERRE_MS laeuft aber weiter).
 * Keine Betraege in dieser Komponente.
 */

import { useState } from "react";
import { AlertCircle, Loader2, Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatDateTimeFull, formatTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { finanzenFetch } from "@/components/finanzen/finanzen-fetch";
import { AbschnittFehler, type Abschnitt } from "@/components/finanzen/uebersicht";
import {
  FINANZEN_FEHLER,
  SYNC_SPERRE_MS,
  SYNC_TOT_NACH_MS,
  type SyncEntitaet,
  type SyncLaufRow,
  type SyncStartAntwort,
  type SyncStatus,
  type SyncStatusAntwort,
} from "@/lib/finanzen/types";

const STATUS_LABEL: Record<SyncStatus, string> = {
  laeuft: "läuft",
  ok: "erfolgreich",
  teilweise: "teilweise",
  fehler: "fehlgeschlagen",
  abgebrochen: "abgebrochen",
};

const ENTITAET_LABEL: Record<SyncEntitaet, string> = {
  kontakte: "Kontakte",
  waehrungen: "Währungen",
  konten: "Konten",
  kontengruppen: "Kontengruppen",
  bankkonten: "Bankkonten",
  rechnungen: "Rechnungen",
  offerten: "Offerten",
  lieferantenrechnungen: "Lieferantenrechnungen",
  journal: "Journal",
};

/** Lauf-Fehlertext, bei dem Bexio neu verbunden werden muss (Kurztext des
 *  Spiegels, ohne Betraege). */
const NEU_VERBINDEN_TEXT = "Bexio-Verbindung ungültig — neu verbinden";

/** Schmale Hinweisleiste (eine Zeile; Langtext per Tooltip). */
function AmberLeiste({ text, rechts }: { text: string; rechts?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-200/70 dark:border-amber-500/30 px-2.5 py-1 min-w-0">
      <AlertCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
      <p className="text-xs text-amber-900 dark:text-amber-100 flex-1 min-w-0 truncate" data-tooltip={text}>{text}</p>
      {rechts}
    </div>
  );
}

function LaufStatus({ lauf, jetzt }: { lauf: SyncLaufRow | null; jetzt: number }) {
  if (!lauf) {
    return <span className="text-sm text-muted-foreground">Noch kein Abgleich</span>;
  }
  const gestartetMs = new Date(lauf.gestartet).getTime();
  const laeuftFrisch = lauf.status === "laeuft" && gestartetMs > jetzt - SYNC_TOT_NACH_MS;
  const laeuftTot = lauf.status === "laeuft" && !laeuftFrisch;
  // Sperre (SYNC_SPERRE_MS) bereits abgelaufen → der Knopf ist wieder frei;
  // keine Uhrzeit in der Vergangenheit anzeigen.
  const sperreVorbei = gestartetMs + SYNC_SPERRE_MS <= jetzt;
  // Entitaeten mit Fehler: eine Zeile als Tooltip am Status, nicht als Liste.
  const details = Object.values(lauf.ergebnis ?? {})
    .filter((e) => e && e.fehler)
    .map((e) => `${ENTITAET_LABEL[e.entitaet] ?? e.entitaet}: ${e.fehler}`)
    .join(" · ");

  return (
    <span className="text-sm flex items-center gap-1.5 min-w-0 whitespace-nowrap">
      <span className="text-muted-foreground">Abgleich</span>
      <span className="tabular-nums">{formatDateTimeFull(lauf.gestartet)}</span>
      <span className="text-muted-foreground">·</span>
      {laeuftFrisch ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> läuft
        </span>
      ) : laeuftTot ? (
        <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <AlertCircle className="h-3.5 w-3.5" />
          {sperreVorbei
            ? "abgebrochen — bitte erneut starten"
            : `abgebrochen — nächster Versuch ab ${formatTime(new Date(gestartetMs + SYNC_SPERRE_MS).toISOString())}`}
        </span>
      ) : lauf.status === "teilweise" || lauf.status === "fehler" ? (
        <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300" data-tooltip={details || undefined}>
          <AlertCircle className="h-3.5 w-3.5" />
          {STATUS_LABEL[lauf.status]}
        </span>
      ) : (
        <span>{STATUS_LABEL[lauf.status]}</span>
      )}
    </span>
  );
}

export function SyncKopf({
  links,
  abschnitt,
  onErneut,
  onAktualisiert,
}: {
  /** Titel-Block (H1 + Zusatz) links in der Zeile. */
  links: React.ReactNode;
  abschnitt: Abschnitt<SyncStatusAntwort>;
  onErneut: () => void;
  /** Nach erfolgreichem manuellem Abgleich: alle Abschnitte neu laden. */
  onAktualisiert: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const s = abschnitt.status === "daten" ? abschnitt.data : null;
  const jetzt = Date.now();
  const darfAbgleichen = !!s && s.verbunden && s.scopesOk && !s.laeuft && !busy;

  async function abgleichen() {
    setBusy(true);
    try {
      const r = await finanzenFetch<SyncStartAntwort>("/api/finanzen/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        // HTTP 200 heisst nur «Lauf beendet» — der fachliche Ausgang steht
        // im Lauf-Status (teilweise/fehler enden NICHT als HTTP-Fehler).
        const l = r.data.lauf;
        if (l.status === "ok") toast.success("Abgleich abgeschlossen");
        else if (l.status === "teilweise") toast.warning("Abgleich teilweise — Details im Kopf");
        else toast.error(l.fehler ?? "Abgleich fehlgeschlagen");
        onAktualisiert();
        return;
      }
      // finanzenFetch hat bereits (per id dedupliziert) getoastet — hier nur
      // der praezisere Text fuer den Doppelstart, gleiche id → ersetzt.
      if (r.slug === FINANZEN_FEHLER.SYNC_LAEUFT) {
        toast("Ein Abgleich läuft bereits", { id: FINANZEN_FEHLER.SYNC_LAEUFT });
        onErneut();
      }
    } finally {
      setBusy(false);
    }
  }

  const lauf = s?.letzterLauf ?? null;
  const laufFehler = lauf?.status === "fehler" && lauf.fehler ? lauf.fehler : null;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-3 min-w-0 flex-wrap">
        {links}
        {abschnitt.status === "laden" ? (
          <Skeleton className="h-8 w-72" />
        ) : abschnitt.status === "fehler" || !s ? (
          <AbschnittFehler onErneut={onErneut} inline />
        ) : (
          <div className="flex items-center gap-3 min-w-0">
            <LaufStatus lauf={lauf} jetzt={jetzt} />
            <button
              type="button"
              onClick={abgleichen}
              disabled={!darfAbgleichen}
              className="kasten kasten-bexio shrink-0"
              data-tooltip={!s.verbunden ? "Bexio ist nicht verbunden" : !s.scopesOk ? "Bexio muss neu verbunden werden" : s.laeuft ? "Ein Abgleich läuft" : undefined}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {busy ? "Gleicht ab…" : "Jetzt abgleichen"}
            </button>
          </div>
        )}
      </div>

      {s && !s.verbunden && (
        <AmberLeiste
          text="Bexio ist nicht verbunden."
          rechts={
            // Reine Navigation → Textlink, kein Kasten (Kasten nie für Navigation).
            <a href="/einstellungen?tab=integrationen" className="text-xs underline underline-offset-2 text-amber-900 dark:text-amber-100 shrink-0">
              Zu den Integrationen
            </a>
          }
        />
      )}

      {s && s.verbunden && !s.scopesOk && (
        <AmberLeiste
          text={`Bexio muss für Finanzen neu verbunden werden — fehlt: ${s.scopesFehlend.join(", ")}`}
          rechts={
            <a href="/api/bexio/connect" className="kasten kasten-bexio shrink-0">
              <Plug className="h-3.5 w-3.5" />
              Neu verbinden
            </a>
          }
        />
      )}

      {s && s.scopesOk && laufFehler && (
        <AmberLeiste
          text={laufFehler}
          rechts={
            laufFehler === NEU_VERBINDEN_TEXT ? (
              <a href="/api/bexio/connect" className="kasten kasten-bexio shrink-0">
                <Plug className="h-3.5 w-3.5" />
                Neu verbinden
              </a>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
