"use client";

/**
 * Vertrieb › Kampagne (z. B. «Messe 2027»): Stand jeder Akquise auf einen
 * Blick, ersetzt die Excel-Listen.
 *
 * Kopf: Kennzahlen (server-seitig gezählt, Klick filtert) + Postfach-Abgleich.
 * Filter: Suche, Status, Gruppe (Messe/Welle) — alles in der URL (§10) und
 * in der DB gefiltert (§4). Liste: wo Leo handeln muss zuerst (Antwort
 * erhalten → Anrufen → Nachfassen fällig → Termin/Offerte → Rest →
 * Abgeschlossenes) über RPC vertrieb_kampagne_liste (Migration 366), mit
 * Keyset-Paginierung «Mehr laden». «Nachfassen fällig» ist zeitabhängig:
 * die Schwelle kommt aus src/lib/vertrieb/nachfassen.ts.
 * Klick auf eine Zeile öffnet das Detail mit der Mail (?k=<id>).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, RefreshCw, Search, Users, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { SearchableSelect } from "@/components/searchable-select";
import { KontaktDetail } from "@/components/vertrieb/kampagne-kontakt-detail";
import { usePermissions } from "@/lib/use-permissions";
import { faelligVor, NACHFASS_TAGE } from "@/lib/vertrieb/nachfassen";
import {
  KAMPAGNE_STATUS,
  KENNZAHLEN,
  NACHFASSEN_BADGE,
  datumKurz,
  datumZeit,
  filterFuerKennzahl,
  istStatusFilter,
  kennzahlWerte,
  nurNachfassen,
  statusFilterOptionen,
  statusMenge,
  type StatusFilter,
} from "@/lib/vertrieb/kampagnen";
import type {
  KampagneKontakt,
  KampagneKontaktZeile,
  KampagneStatus,
  MailSyncStand,
  VertriebKampagne,
} from "@/types/vertrieb";

const SEITE = 100;
const RASTER = "grid grid-cols-[52px_minmax(0,1fr)_150px_170px_128px_112px_76px] gap-3";

type Cursor = Pick<KampagneKontaktZeile, "rang" | "firma" | "id">;
type ListenZeile = KampagneKontaktZeile & { treffer: number };

export function KampagneAnsicht({ kampagne }: { kampagne: VertriebKampagne }) {
  const supabase = createClient();
  const { can } = usePermissions();
  const darfBearbeiten = can("vertrieb:edit");
  const searchParams = useSearchParams();

  // Filter + Auswahl aus der URL (§10).
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const s = searchParams.get("status");
    return istStatusFilter(s) ? s : "alle";
  });
  const [gruppe, setGruppe] = useState(() => searchParams.get("gruppe") ?? "");
  const [suche, setSuche] = useState(() => searchParams.get("q") ?? "");
  const [sucheAktiv, setSucheAktiv] = useState(suche);
  const [gewaehlt, setGewaehlt] = useState<string | null>(() => searchParams.get("k"));

  const [zeilen, setZeilen] = useState<KampagneKontaktZeile[]>([]);
  const [treffer, setTreffer] = useState<number | null>(null);
  const [mehr, setMehr] = useState(false);
  const [laden, setLaden] = useState(true);
  const [ladeMehr, setLadeMehr] = useState(false);
  const [jeStatus, setJeStatus] = useState<Partial<Record<KampagneStatus, number>>>({});
  const [gruppen, setGruppen] = useState<{ wert: string; anzahl: number }[]>([]);
  const [nachfassen, setNachfassen] = useState(0);
  const [sync, setSync] = useState<MailSyncStand | null>(null);
  const [syncLaeuft, setSyncLaeuft] = useState(false);
  const abfrageNr = useRef(0);
  // Fälligkeits-Schwelle der aktuellen Liste — «Mehr laden» braucht dieselbe.
  const schwelle = useRef(faelligVor());

  useEffect(() => {
    const t = setTimeout(() => setSucheAktiv(suche.trim()), 250);
    return () => clearTimeout(t);
  }, [suche]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const setze = (k: string, v: string | null) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    setze("status", statusFilter === "alle" ? null : statusFilter);
    setze("gruppe", gruppe || null);
    setze("q", sucheAktiv || null);
    setze("k", gewaehlt);
    window.history.replaceState({}, "", url.toString());
  }, [statusFilter, gruppe, sucheAktiv, gewaehlt]);

  const abfrage = useCallback((cursor: Cursor | null) => {
    const menge = statusMenge(statusFilter);
    return supabase.rpc("vertrieb_kampagne_liste", {
      p_kampagne: kampagne.id,
      p_faellig_vor: schwelle.current,
      p_status: menge ? [...menge] : null,
      p_nur_faellig: nurNachfassen(statusFilter),
      p_gruppe: gruppe || null,
      p_suche: sucheAktiv || null,
      p_nach_rang: cursor?.rang ?? null,
      p_nach_firma: cursor?.firma ?? null,
      p_nach_id: cursor?.id ?? null,
      p_limit: SEITE + 1,
    });
  }, [supabase, kampagne.id, statusFilter, gruppe, sucheAktiv]);

  const ladeZahlen = useCallback(async () => {
    const { data, error } = await supabase.rpc("vertrieb_kampagne_uebersicht", {
      p_kampagne: kampagne.id,
      p_faellig_vor: faelligVor(),
    });
    if (error) { toast.error(`Kennzahlen laden fehlgeschlagen: ${error.message}`); return; }
    const rows = (data ?? []) as { art: string; wert: string; anzahl: number }[];
    setNachfassen(rows.find((r) => r.art === "nachfassen")?.anzahl ?? 0);
    setJeStatus(Object.fromEntries(rows.filter((r) => r.art === "status").map((r) => [r.wert, r.anzahl])));
    setGruppen(rows.filter((r) => r.art === "gruppe").map((r) => ({ wert: r.wert, anzahl: r.anzahl }))
      .sort((a, b) => a.wert.localeCompare(b.wert, "de")));
  }, [supabase, kampagne.id]);

  const ladeListe = useCallback(async () => {
    const nr = ++abfrageNr.current;
    setLaden(true);
    schwelle.current = faelligVor();
    const { data, error } = await abfrage(null);
    if (nr !== abfrageNr.current) return; // überholt
    setLaden(false);
    if (error) { toast.error(`Kontakte laden fehlgeschlagen: ${error.message}`); return; }
    const rows = (data ?? []) as ListenZeile[];
    setMehr(rows.length > SEITE);
    setZeilen(rows.slice(0, SEITE));
    setTreffer(rows[0]?.treffer ?? 0);
  }, [abfrage]);

  // queueMicrotask: setState nicht synchron im Effekt (react-hooks/set-state-in-effect).
  useEffect(() => { queueMicrotask(() => void ladeListe()); }, [ladeListe]);
  useEffect(() => { queueMicrotask(() => void ladeZahlen()); }, [ladeZahlen]);
  useEffect(() => {
    let aktiv = true;
    fetch("/api/vertrieb/mail-sync", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (aktiv && j) setSync(j as MailSyncStand); })
      .catch(() => { /* Anzeige entfällt still — die Liste funktioniert ohne */ });
    return () => { aktiv = false; };
  }, []);

  async function ladeWeitere() {
    const letzte = zeilen[zeilen.length - 1];
    if (!letzte || ladeMehr) return;
    setLadeMehr(true);
    const nr = abfrageNr.current;
    const { data, error } = await abfrage(letzte);
    setLadeMehr(false);
    if (nr !== abfrageNr.current) return;
    if (error) { toast.error(`Laden fehlgeschlagen: ${error.message}`); return; }
    const rows = (data ?? []) as ListenZeile[];
    setMehr(rows.length > SEITE);
    setZeilen((prev) => {
      const da = new Set(prev.map((z) => z.id));
      return [...prev, ...rows.slice(0, SEITE).filter((z) => !da.has(z.id))];
    });
  }

  async function jetztAbgleichen() {
    setSyncLaeuft(true);
    try {
      const res = await fetch("/api/vertrieb/mail-sync", { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j) { toast.error(j?.error ?? "Abgleich fehlgeschlagen"); return; }
      if (j.stand) setSync(j.stand as MailSyncStand);
      if (j.uebersprungen) { toast.info(j.uebersprungen); return; }
      if (!j.ok) { toast.error(`Abgleich fehlgeschlagen: ${j.fehler ?? "unbekannt"}`); return; }
      const teile = [
        j.gesendet ? `${j.gesendet} angeschrieben` : null,
        j.antworten ? `${j.antworten} mit Antwort` : null,
        j.unzustellbar ? `${j.unzustellbar} nicht zustellbar` : null,
      ].filter(Boolean);
      toast.success(teile.length ? `Abgeglichen: ${teile.join(", ")}` : "Abgeglichen – nichts Neues");
      if (teile.length) { void ladeListe(); void ladeZahlen(); }
    } catch {
      toast.error("Abgleich fehlgeschlagen");
    } finally {
      setSyncLaeuft(false);
    }
  }

  // Detail hat Status/Notizen gespeichert → Zeile + Kennzahlen nachziehen.
  // Die Zeile bleibt stehen, auch wenn sie nicht mehr zum Filter passt —
  // sonst springt die Liste unter der Maus weg.
  function nachAenderung(id: string, patch: Partial<KampagneKontakt>) {
    const wegVomNachfassen = "nachfass_anzahl" in patch || ("status" in patch && patch.status !== "gesendet");
    setZeilen((prev) => prev.map((z) => (z.id === id
      ? { ...z, ...patch, nachfassen_faellig: wegVomNachfassen ? false : z.nachfassen_faellig }
      : z)));
    if ("status" in patch || "nachfass_anzahl" in patch) void ladeZahlen();
  }

  const werte = kennzahlWerte(jeStatus, nachfassen);
  const neueAntworten = jeStatus.geantwortet ?? 0;
  const hatFilter = statusFilter !== "alle" || !!gruppe || !!suche;
  const gruppeLabel = kampagne.gruppe_label?.trim() || "Gruppe";

  function zuruecksetzen() {
    setStatusFilter("alle");
    setGruppe("");
    setSuche("");
  }

  return (
    <div className="space-y-3">
      <StickyFilterBar className="space-y-2.5">
        {/* Kennzahlen — Klick filtert, nochmals Klick hebt auf */}
        <div className="flex flex-wrap items-center gap-1.5">
          {KENNZAHLEN.map((k) => {
            const n = werte[k.key];
            if ("nurWennDa" in k && k.nurWennDa && n === 0) return null;
            const aktiv = statusFilter === filterFuerKennzahl(k.key);
            const ton = aktiv ? "kasten-active"
              : k.key === "antworten" && neueAntworten > 0 ? "kasten kasten-green"
              : k.key === "anrufen" || k.key === "nachfassen" ? "kasten kasten-amber"
              : "kasten-toggle-off";
            return (
              <button
                key={k.key}
                type="button"
                onClick={() => setStatusFilter(aktiv ? "alle" : filterFuerKennzahl(k.key))}
                className={ton}
                aria-pressed={aktiv}
              >
                <span className="font-semibold tabular-nums">{n}</span>
                {k.label}
                {k.key === "antworten" && neueAntworten > 0 && <span className="font-semibold">· {neueAntworten} neu</span>}
              </button>
            );
          })}

          <div className="ml-auto flex items-center gap-2">
            {sync && (
              sync.letzter_sync_fehler ? (
                <span className="text-xs font-medium text-red-700 dark:text-red-300" data-tooltip={sync.letzter_sync_fehler} data-tooltip-align="end">
                  Abgleich fehlgeschlagen
                </span>
              ) : !sync.verbunden ? (
                <span className="text-xs text-muted-foreground">Postfach nicht verbunden</span>
              ) : sync.letzter_sync_am ? (
                <span className="text-xs text-muted-foreground">Zuletzt abgeglichen: {datumZeit(sync.letzter_sync_am)}</span>
              ) : null
            )}
            {darfBearbeiten && (
              <button type="button" onClick={() => void jetztAbgleichen()} disabled={syncLaeuft} className="kasten kasten-muted">
                {syncLaeuft
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird abgeglichen…</>
                  : <><RefreshCw className="h-3.5 w-3.5" />Jetzt abgleichen</>}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Firma, Person oder E-Mail suchen…"
              value={suche}
              onChange={(e) => setSuche(e.target.value)}
              className="h-9 pl-9"
              aria-label="Suche"
            />
          </div>
          <div className="w-full sm:w-52">
            <SearchableSelect
              value={statusFilter}
              onChange={(v) => setStatusFilter(istStatusFilter(v) ? v : "alle")}
              items={statusFilterOptionen()}
              searchable={false}
              clearable={false}
              active={statusFilter !== "alle"}
            />
          </div>
          {gruppen.length > 0 && (
            <div className="w-full sm:w-56">
              <SearchableSelect
                value={gruppe || "__alle"}
                onChange={(v) => setGruppe(v === "__alle" ? "" : v)}
                items={[
                  { id: "__alle", label: `${gruppeLabel}: alle` },
                  ...gruppen.map((g) => ({ id: g.wert, label: g.wert, sub: `${g.anzahl} Kontakte` })),
                ]}
                searchable={gruppen.length > 8}
                clearable={false}
                active={!!gruppe}
              />
            </div>
          )}
          {hatFilter && (
            <button
              type="button"
              onClick={zuruecksetzen}
              className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
              data-tooltip="Alle Filter zurücksetzen"
            >
              <X className="h-3.5 w-3.5" />
              Reset
            </button>
          )}
        </div>
      </StickyFilterBar>

      {laden && zeilen.length === 0 ? (
        <div className="divide-y rounded-xl border bg-card">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex h-10 items-center gap-4 px-4">
              <div className="h-3 w-8 animate-pulse rounded bg-muted" />
              <div className="h-3 w-56 animate-pulse rounded bg-muted" />
              <div className="ml-auto h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : zeilen.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState
            icon={Users}
            title={hatFilter ? "Keine Treffer" : "Noch keine Kontakte"}
            description={hatFilter ? "Andere Suche oder Filter zurücksetzen." : "Diese Kampagne hat noch keine Kontakte."}
            action={hatFilter ? (
              <button type="button" onClick={zuruecksetzen} className="kasten kasten-muted">Filter zurücksetzen</button>
            ) : undefined}
          />
        </div>
      ) : (
        <div className={`overflow-hidden rounded-xl border bg-card transition-opacity ${laden ? "opacity-60" : ""}`}>
          <div className={`${RASTER} border-b bg-muted/30 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground`}>
            <span>Nr.</span>
            <span>Firma</span>
            <span>{gruppeLabel}</span>
            <span>Ansprechperson</span>
            <span>Status</span>
            <span>Versand</span>
            <span>Antwort</span>
          </div>
          <div className="p-1.5">
            {zeilen.map((z) => (
              <Zeile key={z.id} z={z} aktiv={z.id === gewaehlt} onClick={() => setGewaehlt(z.id)} />
            ))}
          </div>
          <div className="flex items-center justify-between border-t px-4 py-2 text-[12px] text-muted-foreground">
            <span>
              {treffer !== null && (hatFilter
                ? `${treffer} von ${werte.alle} Kontakten`
                : `${treffer} ${treffer === 1 ? "Kontakt" : "Kontakte"}`)}
            </span>
            {mehr && (
              <button type="button" onClick={() => void ladeWeitere()} disabled={ladeMehr} className="kasten kasten-muted">
                {ladeMehr ? <Spinner size={14} /> : <ChevronDown className="h-3.5 w-3.5" />}
                {ladeMehr ? "Lade…" : "Mehr laden"}
              </button>
            )}
          </div>
        </div>
      )}

      {gewaehlt && (
        <KontaktDetail
          id={gewaehlt}
          gruppeLabel={gruppeLabel}
          darfBearbeiten={darfBearbeiten}
          postfach={sync?.postfach ?? null}
          onAenderung={(patch) => nachAenderung(gewaehlt, patch)}
          onSchliessen={() => setGewaehlt(null)}
        />
      )}
    </div>
  );
}

function Zeile({ z, aktiv, onClick }: { z: KampagneKontaktZeile; aktiv: boolean; onClick: () => void }) {
  const status = z.nachfassen_faellig ? NACHFASSEN_BADGE : KAMPAGNE_STATUS[z.status];
  const neu = z.status === "geantwortet";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`row-hover ${RASTER} w-full items-center rounded-md px-2.5 py-2 text-left text-sm [--row-hover-x:0.125rem] ${aktiv ? "bg-foreground/[0.06] dark:bg-foreground/[0.12]" : ""}`}
    >
      <span className="truncate font-mono text-xs text-muted-foreground">{z.nr}</span>
      <span className={`truncate ${neu ? "font-semibold" : "font-medium"}`}>{z.firma}</span>
      <span className="truncate text-xs text-muted-foreground">{z.gruppe ?? "—"}</span>
      <span className="truncate text-xs text-muted-foreground">{z.ansprechperson ?? "—"}</span>
      <span>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${status.farbe}`}
          data-tooltip={z.nachfassen_faellig ? `Angeschrieben, seit ${NACHFASS_TAGE} Tagen keine Antwort` : undefined}
        >
          {status.label}
        </span>
      </span>
      <span className="truncate text-xs tabular-nums text-muted-foreground">
        {z.mail_gesendet_am ? (
          <span data-tooltip="Gesendet">{datumZeit(z.mail_gesendet_am)}</span>
        ) : z.mail_geplant_am ? (
          <span className="text-blue-700 dark:text-blue-300" data-tooltip="Geplant">{datumZeit(z.mail_geplant_am)}</span>
        ) : "—"}
      </span>
      <span className={`truncate text-xs tabular-nums ${neu ? "font-semibold text-green-700 dark:text-green-300" : "text-muted-foreground"}`}>
        {z.letzte_antwort_am ? datumKurz(z.letzte_antwort_am) : "—"}
      </span>
    </button>
  );
}
