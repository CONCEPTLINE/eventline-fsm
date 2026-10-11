"use client";

/**
 * Uebertragungen-Sheet: zeigt, was noch nicht am Server ist — Stempel-
 * Aktionen (je Aktion Art, Uhrzeit, Kontext und Status) und wartende
 * Rapport-Entwuerfe (label, Statuswort, hinweis; Tipp fuehrt zur Rapport-
 * Seite, wo Konflikte geloest werden). Stempel-Konflikte und -Fehler werden
 * hier entschieden («Server-Eintrag behalten» / «Erneut versuchen» /
 * «Verwerfen»). Daten: useStempel() (queue), useWartendeRapporte()
 * (rapport-outbox), Auftrags-Kontext aus dem Offline-Cache «auftraege_aktiv».
 *
 * Am Handy Bottom-Sheet, ab md zentrierter Dialog (sidebar-stempel.tsx
 * oeffnet es am Desktop, wenn Aktionen aus einer frueheren schmalen Sitzung
 * noch warten).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeftRight, ChevronRight, CloudOff, FileText, Loader2, LogIn, LogOut, Send } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { useStempel } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { useIsMobile } from "@/lib/use-is-mobile";
import { cacheLesen, type StempelOp } from "@/lib/offline/db";
import { ladeWartendeRapporte, RAPPORT_OUTBOX_EVENT, type WartenderRapport } from "@/lib/offline/rapport-outbox";
import { TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import { formatTime } from "@/lib/format";
import { formatJobNumber } from "@/lib/nummern-format";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface AuftragKurz {
  id: string;
  job_number: number;
  title: string;
}

const STATUS_PILLE: Record<StempelOp["status"], { text: string; klasse: string }> = {
  wartet: { text: "wartet", klasse: "text-amber-700 dark:text-amber-300 bg-amber-500/15" },
  sendet: { text: "sendet", klasse: "text-blue-700 dark:text-blue-300 bg-blue-500/15" },
  fehler: { text: "Fehler", klasse: "text-red-700 dark:text-red-300 bg-red-500/15" },
  konflikt: { text: "Konflikt", klasse: "text-red-700 dark:text-red-300 bg-red-500/15" },
  abgelehnt: { text: "abgelehnt", klasse: "text-red-700 dark:text-red-300 bg-red-500/15" },
};

const KEINE_RAPPORTE: WartenderRapport[] = [];

/**
 * Wartende Rapport-Entwuerfe des Nutzers aus der rapport-outbox. Laedt bei
 * Mount, bei RAPPORT_OUTBOX_EVENT, bei online und wenn der Tab sichtbar wird
 * — nur solange `aktiv` (Streifen: immer; Sheet: nur offen). Der Stand ist an
 * die Nutzer-ID gebunden (abgeleiteter State statt Reset im Effekt).
 */
export function useWartendeRapporte(meId: string | null, aktiv: boolean): WartenderRapport[] {
  const [stand, setStand] = useState<{ fuer: string; liste: WartenderRapport[] } | null>(null);

  useEffect(() => {
    if (!aktiv || !meId) return;
    let cancelled = false;
    const laden = () => {
      ladeWartendeRapporte(meId)
        .then((liste) => { if (!cancelled) setStand({ fuer: meId, liste }); })
        .catch(() => { /* kein IndexedDB (privater Modus) → keine Rapporte anzeigen */ });
    };
    const sichtbar = () => { if (document.visibilityState === "visible") laden(); };
    laden();
    window.addEventListener(RAPPORT_OUTBOX_EVENT, laden);
    window.addEventListener("online", laden);
    document.addEventListener("visibilitychange", sichtbar);
    return () => {
      cancelled = true;
      window.removeEventListener(RAPPORT_OUTBOX_EVENT, laden);
      window.removeEventListener("online", laden);
      document.removeEventListener("visibilitychange", sichtbar);
    };
  }, [meId, aktiv]);

  return stand && stand.fuer === meId ? stand.liste : KEINE_RAPPORTE;
}

function artText(op: StempelOp): string {
  const zeit = formatTime(op.client_ts);
  if (op.kind === "clock_in") return `Eingestempelt ${zeit}`;
  if (op.kind === "clock_out") return `Ausgestempelt ${zeit}`;
  return `Tarif gewechselt ${zeit}`;
}

function ArtIcon({ kind }: { kind: StempelOp["kind"] }) {
  const cls = "h-5 w-5 shrink-0";
  if (kind === "clock_in") return <LogIn className={`${cls} text-teal-600 dark:text-teal-300`} />;
  if (kind === "clock_out") return <LogOut className={`${cls} text-teal-600 dark:text-teal-300`} />;
  return <ArrowLeftRight className={`${cls} text-muted-foreground`} />;
}

function StatusPille({ status }: { status: StempelOp["status"] }) {
  const pille = STATUS_PILLE[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${pille.klasse}`}>
      {status === "sendet" ? (
        <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />{pille.text}</span>
      ) : pille.text}
    </span>
  );
}

/** Satz zu mitverworfenen Folgeaktionen; leer, wenn keine haengen. */
function folgeSatz(folge: number): string {
  if (folge === 0) return "";
  return folge === 1
    ? " Auch 1 spätere Aktion dazu (z. B. Ausstempeln) wird verworfen."
    : ` Auch ${folge} spätere Aktionen dazu (z. B. Tarifwechsel, Ausstempeln) werden verworfen.`;
}

export function UebertragungenSheet({ open, onClose }: Props) {
  const { queue, online, loading, jetztSenden, verwerfen, serverKonfliktBehalten, erneutVersuchen } = useStempel();
  const { meId } = usePermissions();
  const isMobile = useIsMobile();
  const rapporte = useWartendeRapporte(meId, open);
  const { confirm, ConfirmModalElement } = useConfirm();
  const [auftraege, setAuftraege] = useState<Map<string, AuftragKurz>>(new Map());
  const [sendet, setSendet] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);

  // Auftrags-Kontext aus dem Cache (beim letzten Online-Laden im Stempel-
  // Modal geschrieben). Ohne Cache bleibt nur die Nummer weg — kein Fehler.
  useEffect(() => {
    if (!open || !meId) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await cacheLesen<AuftragKurz[]>(meId, "auftraege_aktiv");
        if (cancelled || !c) return;
        setAuftraege(new Map(c.data.map((a) => [a.id, a])));
      } catch {
        /* kein Cache → Kontext ohne Auftragstitel */
      }
    })();
    return () => { cancelled = true; };
  }, [open, meId]);

  function kontext(op: StempelOp): string {
    const p = op.payload;
    if (p.job_id) {
      const a = auftraege.get(p.job_id);
      return a ? `${formatJobNumber(a.job_number)} · ${a.title}` : "Auftrag";
    }
    if (p.project_id) return p.description ? `Projekt · ${p.description}` : "Projekt";
    return p.description || "Andere Arbeit";
  }

  /** Zahl der Folgeaktionen, die mit op verworfen wuerden — gleiche Regel
   *  wie verwerfeOp in stempel-outbox.ts (Kette ueber entry_id bzw.
   *  prev_entry_id, transitiv ueber Tarifwechsel; queue ist nach seq). */
  function folgeAktionen(op: StempelOp): number {
    const betroffen = new Set<string>([op.entry_id]);
    let n = 0;
    for (const o of queue) {
      if (o.seq <= op.seq) continue;
      const haengt = betroffen.has(o.entry_id) || (o.payload.prev_entry_id ? betroffen.has(o.payload.prev_entry_id) : false);
      if (!haengt) continue;
      betroffen.add(o.entry_id);
      n++;
    }
    return n;
  }

  async function senden() {
    setSendet(true);
    try {
      await jetztSenden();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Senden fehlgeschlagen");
    } finally {
      setSendet(false);
    }
  }

  async function mitBusy(opId: string, fn: () => Promise<void>) {
    setBusyOp(opId);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusyOp(null);
    }
  }

  async function verwerfenMitFrage(op: StempelOp) {
    const ok = await confirm({
      title: "Aktion verwerfen?",
      message: `«${artText(op)}» wird nicht an den Server gesendet.${folgeSatz(folgeAktionen(op))} Deine Stempelzeit ist dann weg.`,
      confirmLabel: "Verwerfen",
      variant: "red",
    });
    if (!ok) return;
    await mitBusy(op.op_id, () => verwerfen(op.op_id));
  }

  // Verwirft die eigene Aktion samt Kette genauso endgueltig wie «Verwerfen»
  // — darum dieselbe Rueckfrage, kein Ein-Tipp-Verlust von Stempelzeit.
  async function serverBehaltenMitFrage(op: StempelOp) {
    const ok = await confirm({
      title: "Server-Eintrag behalten?",
      message: `«${artText(op)}» wird verworfen, es gilt der Eintrag am Server.${folgeSatz(folgeAktionen(op))} Deine Stempelzeit von diesem Gerät ist dann weg.`,
      confirmLabel: "Server-Eintrag behalten",
      variant: "red",
    });
    if (!ok) return;
    await mitBusy(op.op_id, () => serverKonfliktBehalten(op.op_id));
  }

  const blockiert = queue.some((o) => o.status === "konflikt" || o.status === "abgelehnt");
  const titel = online ? "Übertragungen" : "Wartet auf Netz";
  const leer = queue.length === 0 && rapporte.length === 0;

  return (
    <>
      <Modal open={open} onClose={onClose} sheet={isMobile !== false} size="md" title={titel} icon={<CloudOff className="h-5 w-5 text-amber-500" />}>
        <p className="text-sm text-muted-foreground">
          {online
            ? "Das hier ist noch nicht am Server und wird der Reihe nach gesendet."
            : "Du bist ohne Netz. Alles ist auf diesem Gerät gespeichert und wird gesendet, sobald Netz da ist."}
        </p>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-[72px] w-full" />
            <Skeleton className="h-[72px] w-full" />
          </div>
        ) : leer ? (
          <EmptyState icon={CloudOff} title="Alles übertragen" description="Keine wartenden Aktionen." />
        ) : (
          <>
            {queue.length > 0 && (
              <div>
                {rapporte.length > 0 && <Abschnitt>Stempeln</Abschnitt>}
                <ul className="divide-y divide-border -mx-1">
                  {queue.map((op) => {
                    const busy = busyOp === op.op_id;
                    return (
                      <li key={op.op_id} className="flex gap-3 px-1 py-3">
                        <div className="mt-0.5"><ArtIcon kind={op.kind} /></div>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-base font-medium leading-snug">{artText(op)}</p>
                            <StatusPille status={op.status} />
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2">{kontext(op)}</p>

                          {op.status === "fehler" && op.last_error && (
                            <p className="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-300">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                              <span>{op.last_error}</span>
                            </p>
                          )}
                          {op.status === "wartet" && op.last_error && op.attempts > 0 && (
                            <p className="text-sm text-muted-foreground">{op.last_error}</p>
                          )}
                          {op.status === "konflikt" && (
                            <p className="text-sm text-red-700 dark:text-red-300">
                              {op.last_error || "Am Server ist ein anderer Eintrag offen."}
                            </p>
                          )}
                          {op.status === "abgelehnt" && (
                            <p className="text-sm text-red-700 dark:text-red-300">
                              {op.last_error === TIME_ENTRY_LOCK_MESSAGE
                                ? "Zeitraum abgerechnet — kann nicht mehr nachgetragen werden. Korrektur über ein Ticket «Stempel-Änderung»."
                                : (op.last_error || "Vom Server abgelehnt.")}
                            </p>
                          )}

                          {op.status === "konflikt" && (
                            <div className="flex gap-2 pt-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => serverBehaltenMitFrage(op)}
                                className="kasten kasten-muted flex-1 min-h-[44px] text-sm"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Server-Eintrag behalten"}
                              </button>
                              <button
                                type="button"
                                disabled={busy || !online}
                                onClick={() => mitBusy(op.op_id, () => erneutVersuchen(op.op_id))}
                                className="kasten kasten-red flex-1 min-h-[44px] text-sm"
                              >
                                Erneut versuchen
                              </button>
                            </div>
                          )}
                          {op.status === "fehler" && (
                            <div className="flex gap-2 pt-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => verwerfenMitFrage(op)}
                                className="kasten kasten-muted flex-1 min-h-[44px] text-sm"
                              >
                                Verwerfen
                              </button>
                              <button
                                type="button"
                                disabled={busy || !online}
                                onClick={() => mitBusy(op.op_id, () => erneutVersuchen(op.op_id))}
                                className="kasten kasten-red flex-1 min-h-[44px] text-sm"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Erneut versuchen"}
                              </button>
                            </div>
                          )}
                          {op.status === "abgelehnt" && (
                            <div className="pt-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => verwerfenMitFrage(op)}
                                className="kasten kasten-muted w-full min-h-[44px] text-sm"
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Entfernen"}
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Rapport-Entwuerfe: Konflikte werden auf der Rapport-Seite
                geloest, darum fuehrt die Zeile dorthin (Navigation, kein kasten). */}
            {rapporte.length > 0 && (
              <div>
                <Abschnitt>Rapporte</Abschnitt>
                <ul className="divide-y divide-border -mx-1">
                  {rapporte.map((r) => (
                    <li key={r.jobId}>
                      <Link
                        href={`/auftraege/${r.jobId}/rapport`}
                        onClick={onClose}
                        className="row-hover flex min-h-[56px] items-center gap-3 px-1 py-2"
                      >
                        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-base font-medium leading-snug">{r.label}</p>
                          {r.hinweis && (
                            <p className={`line-clamp-2 text-sm ${r.status === "konflikt" || r.status === "fehler" ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>
                              {r.hinweis}
                            </p>
                          )}
                        </div>
                        <StatusPille status={r.status} />
                        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {queue.length > 0 && (
          <button
            type="button"
            onClick={senden}
            disabled={sendet || !online || blockiert}
            className="kasten kasten-red w-full min-h-[52px] text-base"
          >
            {sendet ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-4 w-4" />}
            {sendet ? "Wird gesendet…" : !online ? "Kein Netz" : blockiert ? "Zuerst entscheiden" : "Jetzt senden"}
          </button>
        )}
      </Modal>
      {ConfirmModalElement}
    </>
  );
}

function Abschnitt({ children }: { children: React.ReactNode }) {
  return <p className="pb-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{children}</p>;
}
