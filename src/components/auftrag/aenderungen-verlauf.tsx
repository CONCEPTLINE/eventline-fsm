"use client";

/**
 * Auftrag-Detail, Tab «Dokumente & Historie»: Abschnitt «Änderungen».
 *
 * Zeigt den Änderungsverlauf der Stammdaten (Migration 319, Tabelle
 * job_aenderungen — per Trigger auf jobs aufgezeichnet, egal über welchen
 * Weg geändert wurde), neueste zuerst. Wer auftraege:edit hat, kann die
 * jeweils LETZTE noch offene Änderung zurücknehmen (RPC
 * auftrag_aenderung_rueckgaengig — prüft Recht, Sichtbarkeit, «ist die
 * letzte» und «Werte unverändert» serverseitig).
 *
 * Daten kommen immer frisch aus der DB (kein JS-State als Quelle): neu
 * geladen beim Öffnen, wenn sich der Auftrag ändert (reloadKey) und nach
 * jedem Rückgängig.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { createClient } from "@/lib/supabase/client";
import { TOAST } from "@/lib/messages";
import { formatDateTimeFull } from "@/lib/format";
import {
  aenderungZeilen,
  idsZumAufloesen,
  kuerzen,
  LEERE_NAMEN,
  ruecknehmbareId,
  wiederherstellenText,
  type AenderungNamen,
  type AenderungZeile,
  type AuftragAenderung,
} from "@/lib/auftrag-aenderungen";

const MAX_EINTRAEGE = 200;
const KURZ = 80;

/** Verlauf eines Auftrags + aufgelöste Namen frisch aus der DB (RLS: nur
 *  sichtbare Aufträge, nur interne Konten). Fehler → Toast, leere Liste. */
async function verlaufLaden(jobId: string): Promise<{ eintraege: AuftragAenderung[]; namen: AenderungNamen }> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("job_aenderungen")
    .select("id, zeitpunkt, person_id, person_name, felder, art, bezug_id, rueckgaengig_at, rueckgaengig_von")
    .eq("job_id", jobId)
    .order("zeitpunkt", { ascending: false })
    .order("id", { ascending: false }) // gleiche Reihenfolge wie die RPC («letzte»)
    .limit(MAX_EINTRAEGE);
  if (error) {
    TOAST.supabaseError(error, "Änderungsverlauf konnte nicht geladen werden");
    return { eintraege: [], namen: LEERE_NAMEN };
  }
  const eintraege = (data ?? []) as AuftragAenderung[];

  // Verweise (Kunde, Location, Raum, Personen) in Namen auflösen.
  const ids = idsZumAufloesen(eintraege);
  const [kunden, locations, raeume, personen] = await Promise.all([
    ids.kunde.length ? supabase.from("customers").select("id, name").in("id", ids.kunde) : null,
    ids.location.length ? supabase.from("locations").select("id, name").in("id", ids.location) : null,
    ids.raum.length ? supabase.from("rooms").select("id, name").in("id", ids.raum) : null,
    ids.person.length ? supabase.from("profiles").select("id, full_name").in("id", ids.person) : null,
  ]);
  const fehler = kunden?.error ?? locations?.error ?? raeume?.error ?? personen?.error;
  if (fehler) TOAST.supabaseError(fehler, "Namen im Änderungsverlauf konnten nicht geladen werden");
  const map = (list: { id: string; name: string | null }[] | null | undefined) =>
    Object.fromEntries((list ?? []).filter((x) => x.name).map((x) => [x.id, x.name as string]));
  return {
    eintraege,
    namen: {
      kunde: map(kunden?.data),
      location: map(locations?.data),
      raum: map(raeume?.data),
      person: map((personen?.data ?? []).map((p) => ({ id: p.id, name: p.full_name }))),
    },
  };
}

type Props = {
  jobId: string;
  /** auftraege:edit (Admin immer) — zeigt den Rückgängig-Knopf. */
  canEdit: boolean;
  /** Ändert sich, wenn der Auftrag neu geladen wurde (z.B. updated_at) →
   *  Verlauf neu laden (auch nach Änderungen über andere Wege). */
  reloadKey?: string | null;
  /** Nach erfolgreichem Rückgängig: Auftrag neu laden. */
  onUndone?: () => void | Promise<void>;
};

export function AenderungenVerlauf({ jobId, canEdit, reloadKey, onUndone }: Props) {
  const { confirm, ConfirmModalElement } = useConfirm();
  const [eintraege, setEintraege] = useState<AuftragAenderung[] | null>(null);
  const [namen, setNamen] = useState<AenderungNamen>(LEERE_NAMEN);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Lade-Nummern: eine Antwort wird nur uebernommen, wenn kein JUENGER
  // gestartetes Laden schon angezeigt wird — eine ueberholte (langsamere)
  // Antwort ueberschreibt nie den neueren Stand. Gilt fuer das Laden im
  // Effekt und das Neuladen nach Rueckgaengig.
  const ladeNr = useRef(0);
  const angezeigtNr = useRef(0);

  useEffect(() => {
    const nr = ++ladeNr.current;
    verlaufLaden(jobId).then((res) => {
      if (nr <= angezeigtNr.current) return;
      angezeigtNr.current = nr;
      setNamen(res.namen);
      setEintraege(res.eintraege);
    });
  }, [jobId, reloadKey]);

  async function neuLaden() {
    const nr = ++ladeNr.current;
    const res = await verlaufLaden(jobId);
    if (nr <= angezeigtNr.current) return;
    angezeigtNr.current = nr;
    setNamen(res.namen);
    setEintraege(res.eintraege);
  }

  const ruecknehmbar = useMemo(() => (eintraege ? ruecknehmbareId(eintraege) : null), [eintraege]);

  async function rueckgaengig(e: AuftragAenderung) {
    if (busyId) return;
    const ok = await confirm({
      title: "Letzte Änderung rückgängig machen?",
      message: wiederherstellenText(aenderungZeilen(e.felder, namen)),
      confirmLabel: "Rückgängig machen",
      variant: "blue",
    });
    if (!ok) return;
    setBusyId(e.id);
    try {
      const { error } = await createClient().rpc("auftrag_aenderung_rueckgaengig", { p_id: e.id });
      if (error) {
        TOAST.supabaseError(error, "Rückgängig fehlgeschlagen");
        await neuLaden(); // Stand zeigen, der den Fehler erklaert (z.B. neuere Aenderung)
        return;
      }
      toast.success("Änderung rückgängig gemacht");
      window.dispatchEvent(new Event("jobs:invalidate"));
      await Promise.all([neuLaden(), onUndone?.()]);
    } finally {
      // Erst nach dem Neuladen freigeben — sonst stuende der Knopf kurz
      // wieder am schon zurueckgenommenen Eintrag.
      setBusyId(null);
    }
  }

  // Name als Momentaufnahme zuerst (bleibt auch, wenn das Profil geloescht
  // wurde und person_id dadurch NULL ist); ohne Person = System/Server.
  function personName(id: string | null, snapshot: string | null): string {
    if (snapshot) return snapshot;
    if (!id) return "System";
    return namen.person[id] ?? "Unbekannt";
  }

  function zurueckVon(e: AuftragAenderung): string {
    const gegen = eintraege?.find((x) => x.bezug_id === e.id);
    if (e.rueckgaengig_von) return namen.person[e.rueckgaengig_von] ?? gegen?.person_name ?? "Unbekannt";
    return gegen?.person_name ?? "System";
  }

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <History className="h-3.5 w-3.5" />
          Änderungen{eintraege && eintraege.length > 0 ? ` (${eintraege.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {eintraege === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : eintraege.length === 0 ? (
          <EmptyState
            icon={History}
            title="Noch keine Änderungen"
            description="Der Verlauf beginnt ab jetzt."
          />
        ) : (
          <ol className="space-y-2">
            {eintraege.map((e) => {
              const zurueck = e.art === "aenderung" && !!e.rueckgaengig_at;
              const zeigeKnopf = canEdit && e.id === ruecknehmbar;
              const laeuft = busyId === e.id;
              return (
                <li
                  key={e.id}
                  className={`rounded-xl border border-foreground/10 dark:border-foreground/15 bg-foreground/[0.03] dark:bg-foreground/[0.06] p-3 ${
                    zurueck ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                      <span className="tabular-nums">{formatDateTimeFull(e.zeitpunkt)}</span>
                      <span aria-hidden>·</span>
                      <span className="font-medium text-foreground truncate">{personName(e.person_id, e.person_name)}</span>
                      {e.art === "rueckgaengig" && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-foreground/[0.06] dark:bg-foreground/[0.14] text-muted-foreground">
                          <Undo2 className="h-3 w-3" />
                          Rückgängig gemacht
                        </span>
                      )}
                    </p>
                    {zeigeKnopf && (
                      <button
                        type="button"
                        onClick={() => rueckgaengig(e)}
                        disabled={!!busyId}
                        className="kasten kasten-blue shrink-0 disabled:opacity-60"
                        data-tooltip="Diese Änderung zurücknehmen"
                        data-tooltip-align="end"
                      >
                        {laeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                        {laeuft ? "Wird zurückgenommen…" : "Rückgängig"}
                      </button>
                    )}
                  </div>
                  <dl className="mt-2 space-y-1">
                    {aenderungZeilen(e.felder, namen).map((z) => (
                      <FeldZeile key={z.key} zeile={z} />
                    ))}
                  </dl>
                  {zurueck && e.rueckgaengig_at && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Zurückgenommen von {zurueckVon(e)} am {formatDateTimeFull(e.rueckgaengig_at)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {eintraege && eintraege.length >= MAX_EINTRAEGE && (
          <p className="mt-2 text-[11px] text-muted-foreground">Es werden die letzten {MAX_EINTRAEGE} Änderungen gezeigt.</p>
        )}
      </CardContent>
      {/* Modal rendert per Portal in body — Card-overflow stoert nicht. */}
      {ConfirmModalElement}
    </Card>
  );
}

/** Eine Zeile «Feld: alt → neu»; lange Texte gekürzt mit Aufklappen. */
function FeldZeile({ zeile }: { zeile: AenderungZeile }) {
  const [offen, setOffen] = useState(false);
  const [hover, setHover] = useState(false);
  const gekuerzt =
    zeile.lang && (kuerzen(zeile.alt, KURZ) !== zeile.alt || kuerzen(zeile.neu, KURZ) !== zeile.neu);

  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 text-sm">
      <dt className="text-xs text-muted-foreground pt-0.5">{zeile.label}</dt>
      <dd className="min-w-0 break-words">
        {offen ? (
          <div className="space-y-1.5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vorher</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{zeile.alt}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Nachher</p>
              <p className="whitespace-pre-wrap">{zeile.neu}</p>
            </div>
          </div>
        ) : (
          <>
            <span className="text-muted-foreground">{gekuerzt ? kuerzen(zeile.alt, KURZ) : zeile.alt}</span>
            <span className="mx-1.5 text-muted-foreground" aria-label="geändert zu">→</span>
            <span className="font-medium">{gekuerzt ? kuerzen(zeile.neu, KURZ) : zeile.neu}</span>
          </>
        )}
        {gekuerzt && (
          <button
            type="button"
            onClick={() => setOffen((o) => !o)}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            className={`block mt-0.5 text-[11px] underline-offset-2 transition-colors ${
              hover ? "text-foreground underline" : "text-muted-foreground"
            }`}
          >
            {offen ? "Weniger zeigen" : "Ganzen Text zeigen"}
          </button>
        )}
      </dd>
    </div>
  );
}
