"use client";

/**
 * Tickets & Belege am Handy (< md). Oben die Zeile «Beleg oder Stempel-
 * Änderung melden …» → Sheet mit zwei Kacheln (Beleg / Stempel-Änderung,
 * Begriff wie Desktop + NewTicketModal) → das bestehende NewTicketModal als
 * Bottom-Sheet. IT/Material bleiben Buero.
 *
 * Segmente «Offen · n | Erledigt» (localStorage-Key wie der Desktop:
 * tickets-status). Segmentwechsel zeigt das Skeleton und beginnt das Paging
 * neu. Mit tickets:manage steht oben die Gruppe «Zu genehmigen» (offene
 * Tickets anderer). Anders als die Desktop-Liste zeigt diese Seite auch
 * Belege — am Handy ist sie die eine Stelle fuer «meine Meldungen».
 *
 * Realtime: Window-Event "realtime:tickets" (Layout-Channel) → gebuendelt
 * neu laden. Ladefehler ohne Daten → EmptyState «Erneut versuchen» statt
 * «Keine Tickets»; online-Event laedt nach. Ganze Zeile tippbar →
 * /tickets/[id] (Detail bleibt bestehend).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Camera, ChevronDown, Clock, Loader2, Package, Plus, Receipt,
  Ticket as TicketIcon, Wrench,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { LadeFehler } from "@/components/mobile/lade-fehler";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { formatDate } from "@/lib/format";
import type { TicketPriority, TicketStatus, TicketType } from "@/types";

type Segment = "offen" | "erledigt";
type NeuTyp = Extract<TicketType, "beleg" | "stempel_aenderung">;

/** Felder, die die Handy-Zeile braucht. data bleibt jsonb (Betrag). */
interface TicketZeile {
  id: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  created_by: string;
  assigned_to: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

const SELECT = "id, type, status, priority, title, created_by, assigned_to, data, created_at";
const SEITE = 50;
// Gleicher Key wie tickets-view.tsx — ein Zustand fuer beide Geraete.
const LS_STATUS = "tickets-status";

const TYP: Record<TicketType, { wort: string; icon: React.ComponentType<{ className?: string }>; farbe: string }> = {
  beleg:             { wort: "Beleg",             icon: Receipt, farbe: "text-amber-700 dark:text-amber-300 bg-amber-500/15 dark:bg-amber-500/25" },
  stempel_aenderung: { wort: "Stempel-Änderung",  icon: Clock,   farbe: "text-green-700 dark:text-green-300 bg-green-500/15 dark:bg-green-500/25" },
  it:                { wort: "IT",                icon: Wrench,  farbe: "text-purple-700 dark:text-purple-300 bg-purple-500/15 dark:bg-purple-500/25" },
  material:          { wort: "Material",          icon: Package, farbe: "text-red-700 dark:text-red-300 bg-red-500/15 dark:bg-red-500/25" },
};

/** Status als Wort + Farbe. «offen» heisst fuer Beleg/Stempel/Material
 *  «Wartet auf Freigabe»; ist das Ticket jemandem zugeteilt oder ein
 *  IT-Problem (keine Freigabe noetig), «In Bearbeitung». */
function statusWort(t: TicketZeile): { wort: string; farbe: string } {
  if (t.status === "erledigt") return { wort: "Erledigt", farbe: "text-green-700 dark:text-green-300" };
  if (t.status === "abgelehnt") return { wort: "Abgelehnt", farbe: "text-red-700 dark:text-red-300" };
  if (t.assigned_to || t.type === "it") return { wort: "In Bearbeitung", farbe: "text-blue-700 dark:text-blue-300" };
  return { wort: "Wartet auf Freigabe", farbe: "text-amber-700 dark:text-amber-300" };
}

/** Betrag aus data (Beleg: betrag_chf; Material: Summe der Positionen). */
function betragChf(t: TicketZeile): number | null {
  const d = t.data ?? {};
  if (t.type === "beleg" && typeof d.betrag_chf === "number") return d.betrag_chf;
  if (t.type === "material" && Array.isArray(d.items)) {
    let summe = 0;
    let gefunden = false;
    for (const it of d.items as Array<{ menge?: unknown; betrag_chf?: unknown }>) {
      if (typeof it.betrag_chf !== "number") continue;
      gefunden = true;
      summe += it.betrag_chf * (typeof it.menge === "number" ? it.menge : 1);
    }
    return gefunden ? summe : null;
  }
  return null;
}

const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatChf(n: number): string {
  return "CHF " + CHF.format(n);
}

function lsSegment(): Segment {
  if (typeof window === "undefined") return "offen";
  try { return localStorage.getItem(LS_STATUS) === "erledigt" ? "erledigt" : "offen"; } catch { return "offen"; }
}

export function TicketsMobil() {
  const supabase = createClient();
  const { can, meId } = usePermissions();
  const canCreate = can("tickets:create");
  const canManage = can("tickets:manage");

  const [segment, setSegment] = useState<Segment>(lsSegment);
  const [meine, setMeine] = useState<TicketZeile[]>([]);
  const [meineLimit, setMeineLimit] = useState(SEITE);
  const [meineMehr, setMeineMehr] = useState(false);
  const [offenAnzahl, setOffenAnzahl] = useState<number | null>(null);
  const [queue, setQueue] = useState<TicketZeile[]>([]);
  const [queueLimit, setQueueLimit] = useState(SEITE);
  const [queueMehr, setQueueMehr] = useState(false);
  const [laedt, setLaedt] = useState(true);
  const [mehrLaedt, setMehrLaedt] = useState(false);
  /** Fehlertext des letzten Ladens (meine bzw. Genehmigungen; null = ok).
   *  Ohne geladene Daten zeigt die Seite den Fehler statt «Keine Tickets». */
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [neuLaedt, setNeuLaedt] = useState(false);
  const abfrageId = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(LS_STATUS, segment); } catch {}
  }, [segment]);

  /** Segmentwechsel: Skeleton statt der alten Liste des anderen Segments,
   *  Paging beginnt neu. laden() (neue Deps → Effekt) setzt laedt zurueck;
   *  veraltete Antworten faengt abfrageId ab. */
  function wechsleSegment(s: Segment) {
    if (s === segment) return;
    setSegment(s);
    setLaedt(true);
    setLadeFehler(null);
    setMeine([]);
    setMeineMehr(false);
    setMeineLimit(SEITE);
    setQueue([]);
    setQueueMehr(false);
    setQueueLimit(SEITE);
  }

  /* --- Laden ------------------------------------------------------------ */

  const laden = useCallback(async () => {
    if (!meId) return;
    const id = ++abfrageId.current;
    const basis = () => supabase.from("tickets").select(SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    const meineQ = segment === "offen"
      ? basis().eq("created_by", meId).eq("status", "offen")
      : basis().eq("created_by", meId).in("status", ["erledigt", "abgelehnt"]);
    const [meineRes, zaehlRes, queueRes] = await Promise.all([
      meineQ.limit(meineLimit + 1),
      supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("created_by", meId).eq("status", "offen"),
      canManage && segment === "offen"
        ? basis().neq("created_by", meId).eq("status", "offen").limit(queueLimit + 1)
        : Promise.resolve(null),
    ]);
    if (id !== abfrageId.current) return;
    let fehler: string | null = null;
    if (meineRes.error) {
      toast.error("Tickets konnten nicht geladen werden: " + meineRes.error.message);
      fehler = meineRes.error.message;
    } else {
      const zeilen = (meineRes.data ?? []) as TicketZeile[];
      setMeineMehr(zeilen.length > meineLimit);
      setMeine(zeilen.slice(0, meineLimit));
    }
    if (zaehlRes.error) {
      toast.error("Offene konnten nicht gezählt werden: " + zaehlRes.error.message);
    } else {
      setOffenAnzahl(zaehlRes.count ?? 0);
    }
    if (queueRes) {
      if (queueRes.error) {
        toast.error("Genehmigungen konnten nicht geladen werden: " + queueRes.error.message);
        fehler = fehler ?? queueRes.error.message;
      } else {
        const zeilen = (queueRes.data ?? []) as TicketZeile[];
        setQueueMehr(zeilen.length > queueLimit);
        setQueue(zeilen.slice(0, queueLimit));
      }
    } else {
      setQueue([]);
      setQueueMehr(false);
    }
    setLadeFehler(fehler);
    setLaedt(false);
    setMehrLaedt(false);
  }, [supabase, meId, segment, meineLimit, queueLimit, canManage]);

  async function erneutLaden() {
    setNeuLaedt(true);
    await laden();
    setNeuLaedt(false);
  }

  // Erstes Laden als Callback (nicht synchron im Effekt-Body).
  useEffect(() => {
    const t = setTimeout(() => { void laden(); }, 0);
    return () => clearTimeout(t);
  }, [laden]);

  // Realtime (Layout-Channel auf tickets) → gebuendelt neu laden. Zurueck im
  // Netz (online-Event) laeuft durch dieselbe Schleuse.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void laden(); }, 400);
    };
    window.addEventListener("realtime:tickets", handler);
    window.addEventListener("online", handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:tickets", handler);
      window.removeEventListener("online", handler);
    };
  }, [laden]);

  /* --- Neu --------------------------------------------------------------- */

  const [wahlOffen, setWahlOffen] = useState(false);
  // Zwei Schritte: erst mit open=false mounten (NewTicketModal setzt Typ +
  // Default-Titel nur im !open-Effekt), im naechsten Tick oeffnen. Nicht
  // gemountet, solange niemand «Neu» tippt — keine Formular-Queries umsonst.
  const [neuTyp, setNeuTyp] = useState<NeuTyp | null>(null);
  const [neuOffen, setNeuOffen] = useState(false);

  function waehle(typ: NeuTyp) {
    setWahlOffen(false);
    setNeuTyp(typ);
    setTimeout(() => setNeuOffen(true), 0);
  }

  function neuSchliessen() {
    setNeuOffen(false);
    setNeuTyp(null);
  }

  /* --- Rendering -------------------------------------------------------- */

  const zeigeQueue = canManage && segment === "offen";
  const leer = meine.length === 0 && queue.length === 0;

  return (
    <div className="page-enter space-y-4">
      {canCreate && (
        <button
          type="button"
          onClick={() => setWahlOffen(true)}
          className="flex h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 text-left text-base text-muted-foreground active:bg-foreground/10"
        >
          <Plus className="h-5 w-5 shrink-0" />
          Beleg oder Stempel-Änderung melden …
        </button>
      )}

      {/* Segmente */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => wechsleSegment("offen")}
          aria-pressed={segment === "offen"}
          className={`${segment === "offen" ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center text-[15px]`}
        >
          Offen{offenAnzahl !== null && offenAnzahl > 0 ? ` · ${offenAnzahl}` : ""}
        </button>
        <button
          type="button"
          onClick={() => wechsleSegment("erledigt")}
          aria-pressed={segment === "erledigt"}
          className={`${segment === "erledigt" ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center text-[15px]`}
        >
          Erledigt
        </button>
      </div>

      {laedt ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="shimmer h-[76px] rounded-xl" />)}
        </div>
      ) : ladeFehler !== null && leer ? (
        // Fehler nur ohne Daten — scheitert ein spaeteres Neuladen, bleibt
        // die alte Liste stehen und der Toast reicht.
        <LadeFehler
          titel="Tickets konnten nicht geladen werden"
          fehler={ladeFehler}
          laedt={neuLaedt}
          onRetry={() => { void erneutLaden(); }}
        />
      ) : leer ? (
        <EmptyState
          icon={TicketIcon}
          title={segment === "offen" ? "Keine offenen Tickets" : "Keine erledigten Tickets"}
          description={
            segment === "offen"
              ? (canCreate ? "Beleg oder Stempel-Änderung über die Zeile oben melden." : undefined)
              : "Sobald Tickets abgeschlossen sind, stehen sie hier."
          }
        />
      ) : (
        <div className="space-y-5">
          {zeigeQueue && queue.length > 0 && (
            <Gruppe label={`Zu genehmigen · ${queue.length}${queueMehr ? "+" : ""}`}>
              {queue.map((t) => <Zeile key={t.id} ticket={t} />)}
              {queueMehr && (
                <MehrKnopf laedt={mehrLaedt} onClick={() => { setMehrLaedt(true); setQueueLimit((n) => n + SEITE); }} />
              )}
            </Gruppe>
          )}
          {meine.length > 0 && (
            <Gruppe label={zeigeQueue && queue.length > 0 ? "Meine" : null}>
              {meine.map((t) => <Zeile key={t.id} ticket={t} />)}
              {meineMehr && (
                <MehrKnopf laedt={mehrLaedt} onClick={() => { setMehrLaedt(true); setMeineLimit((n) => n + SEITE); }} />
              )}
            </Gruppe>
          )}
        </div>
      )}

      {/* Schritt 1: Was melden? */}
      <Modal open={wahlOffen} onClose={() => setWahlOffen(false)} title="Was möchtest du melden?" sheet size="md" bodyClassName="p-4">
        <div className="grid grid-cols-2 gap-3">
          <Kachel
            icon={Camera}
            titel="Beleg"
            text="Quittung fotografieren"
            farbe={TYP.beleg.farbe}
            onClick={() => waehle("beleg")}
          />
          <Kachel
            icon={Clock}
            titel="Stempel-Änderung"
            text="Zeit falsch oder vergessen"
            farbe={TYP.stempel_aenderung.farbe}
            onClick={() => waehle("stempel_aenderung")}
          />
        </div>
      </Modal>

      {/* Schritt 2: bestehendes Formular als Sheet. */}
      {neuTyp && (
        <NewTicketModal
          key={neuTyp}
          open={neuOffen}
          sheet
          initialType={neuTyp}
          onClose={neuSchliessen}
          onCreated={() => { void laden(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Gruppe({ label, children }: { label: string | null; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      {label && (
        <p className="px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

function MehrKnopf({ laedt, onClick }: { laedt: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={laedt}
      onClick={onClick}
      className="flex h-12 w-full items-center justify-center gap-2 border-t border-border text-[15px] font-medium text-muted-foreground active:bg-foreground/10"
    >
      {laedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
      Mehr laden
    </button>
  );
}

/** Zeile 76 px: Typ-Kachel 44 · Titel (2 Zeilen) + Nebentext · Status rechts. */
function Zeile({ ticket: t }: { ticket: TicketZeile }) {
  const typ = TYP[t.type];
  const Icon = typ.icon;
  const status = statusWort(t);
  const betrag = betragChf(t);
  const neben = [typ.wort, betrag !== null ? formatChf(betrag) : null, formatDate(t.created_at)]
    .filter((s): s is string => !!s)
    .join(" · ");

  return (
    <Link
      href={`/tickets/${t.id}`}
      className="flex min-h-[76px] items-center gap-3 border-t border-border px-3 py-2 first:border-t-0 active:bg-foreground/10"
    >
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${typ.farbe}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-base font-medium leading-snug">
          {t.priority === "dringend" && <span className="text-red-600 dark:text-red-400">Dringend · </span>}
          {t.title}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground tabular-nums">{neben}</p>
      </div>
      <span className={`w-[76px] shrink-0 text-right text-[13px] font-medium leading-tight ${status.farbe}`}>
        {status.wort}
      </span>
    </Link>
  );
}

function Kachel({
  icon: Icon, titel, text, farbe, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>; titel: string; text: string; farbe: string; onClick: () => void;
}) {
  // min-h statt h: bricht der Titel bei 390 px am Bindestrich um
  // («Stempel-Änderung»), waechst die Kachel mit statt zu ueberlaufen.
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[120px] flex-col items-start justify-between gap-2 rounded-xl border border-border bg-background p-3 text-left active:bg-foreground/10"
    >
      <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${farbe}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="block text-base font-semibold leading-tight">{titel}</span>
        <span className="block text-[13px] text-muted-foreground">{text}</span>
      </span>
    </button>
  );
}
