"use client";

/**
 * SyncKopf — eine Zeile ueber den Finanzdaten: letzter Bexio-Abgleich,
 * Status, Hinweise (nicht verbunden / Scopes fehlen / teilweise) und der
 * Knopf «Jetzt abgleichen» (POST /api/finanzen/sync, Body {} — «Alles neu
 * laden» (voll:true) gibt es bewusst nur per API/Skript).
 *
 * Zeitlogik (Vertrag types.ts): 'laeuft' juenger als SYNC_TOT_NACH_MS →
 * Spinner; aelter → «Abgleich abgebrochen — naechster Versuch ab hh:mm»
 * (Lambda nach 5 min sicher tot, die 15-min-Sperre SYNC_SPERRE_MS laeuft
 * aber weiter). Keine Betraege in dieser Komponente.
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

function AmberBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-200/70 dark:border-amber-500/30 px-2.5 py-1.5">
      <AlertCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
      {children}
    </div>
  );
}

function LaufStatus({ lauf, jetzt }: { lauf: SyncLaufRow | null; jetzt: number }) {
  if (!lauf) {
    return <p className="text-sm text-muted-foreground">Noch kein Abgleich mit Bexio.</p>;
  }
  const gestartetMs = new Date(lauf.gestartet).getTime();
  const laeuftFrisch = lauf.status === "laeuft" && gestartetMs > jetzt - SYNC_TOT_NACH_MS;
  const laeuftTot = lauf.status === "laeuft" && !laeuftFrisch;
  // Sperre (SYNC_SPERRE_MS) bereits abgelaufen → der Knopf ist wieder frei;
  // keine Uhrzeit in der Vergangenheit anzeigen.
  const sperreVorbei = gestartetMs + SYNC_SPERRE_MS <= jetzt;
  const entitaetenMitFehler = Object.values(lauf.ergebnis ?? {}).filter((e) => e && e.fehler);

  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground">Letzter Abgleich:</span>
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
              ? "Abgleich abgebrochen — bitte erneut starten"
              : `Abgleich abgebrochen — nächster Versuch ab ${formatTime(new Date(gestartetMs + SYNC_SPERRE_MS).toISOString())}`}
          </span>
        ) : lauf.status === "teilweise" || lauf.status === "fehler" ? (
          <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-3.5 w-3.5" />
            {STATUS_LABEL[lauf.status]}
          </span>
        ) : (
          <span>{STATUS_LABEL[lauf.status]}</span>
        )}
      </p>
      {lauf.status === "fehler" && lauf.fehler && (
        <p className="text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2 flex-wrap">
          <span>{lauf.fehler}</span>
          {lauf.fehler === NEU_VERBINDEN_TEXT && (
            <a href="/api/bexio/connect" className="kasten kasten-bexio">
              <Plug className="h-3.5 w-3.5" />
              Neu verbinden
            </a>
          )}
        </p>
      )}
      {(lauf.status === "teilweise" || lauf.status === "fehler") && entitaetenMitFehler.length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {entitaetenMitFehler.map((e) => (
            <li key={e.entitaet}>
              <span className="font-medium text-foreground/80">{ENTITAET_LABEL[e.entitaet] ?? e.entitaet}:</span> {e.fehler}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SyncKopf({
  abschnitt,
  onErneut,
  onAktualisiert,
}: {
  abschnitt: Abschnitt<SyncStatusAntwort>;
  onErneut: () => void;
  /** Nach erfolgreichem manuellem Abgleich: alle Abschnitte neu laden. */
  onAktualisiert: () => void;
}) {
  const [busy, setBusy] = useState(false);

  if (abschnitt.status === "laden") return <Skeleton className="h-10" />;
  if (abschnitt.status === "fehler") return <AbschnittFehler onErneut={onErneut} />;

  const s = abschnitt.data;
  const jetzt = Date.now();
  const darfAbgleichen = s.verbunden && s.scopesOk && !s.laeuft && !busy;

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
        else if (l.status === "teilweise") toast.warning("Abgleich teilweise — Details oben im Kopf");
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

  return (
    <div className="rounded-xl border bg-card px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LaufStatus lauf={s.letzterLauf} jetzt={jetzt} />
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

      {!s.verbunden && (
        <AmberBox>
          <p className="text-xs text-amber-900 dark:text-amber-100 flex-1 min-w-0">Bexio ist nicht verbunden.</p>
          {/* Reine Navigation → Textlink, kein Kasten (Kasten nie für Navigation). */}
          <a href="/einstellungen?tab=integrationen" className="text-xs underline underline-offset-2 text-amber-900 dark:text-amber-100 shrink-0">
            Zu den Integrationen
          </a>
        </AmberBox>
      )}

      {s.verbunden && !s.scopesOk && (
        <AmberBox>
          <p className="text-xs text-amber-900 dark:text-amber-100 flex-1 min-w-0">
            Bexio muss für Finanzen neu verbunden werden — fehlt: {s.scopesFehlend.join(", ")}
          </p>
          <a href="/api/bexio/connect" className="kasten kasten-bexio shrink-0">
            <Plug className="h-3.5 w-3.5" />
            Neu verbinden
          </a>
        </AmberBox>
      )}
    </div>
  );
}
