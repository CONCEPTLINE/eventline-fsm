"use client";

/**
 * Uebertragungen-Sheet (Handy): zeigt die Stempel-Aktionen, die noch nicht
 * am Server sind — je Aktion Art, Uhrzeit, Kontext und Status. Konflikte und
 * Fehler werden hier entschieden («Server-Eintrag behalten» / «Erneut
 * versuchen» / «Verwerfen»). Daten kommen aus useStempel() (queue), der
 * Auftrags-Kontext aus dem Offline-Cache «auftraege_aktiv».
 */

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeftRight, CloudOff, Loader2, LogIn, LogOut, Send } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { useStempel } from "@/lib/use-stempel";
import { usePermissions } from "@/lib/use-permissions";
import { cacheLesen, type StempelOp } from "@/lib/offline/db";
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

export function UebertragungenSheet({ open, onClose }: Props) {
  const { queue, online, loading, jetztSenden, verwerfen, serverKonfliktBehalten, erneutVersuchen } = useStempel();
  const { meId } = usePermissions();
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
      message: `«${artText(op)}» wird nicht an den Server gesendet. Deine Stempelzeit ist dann weg.`,
      confirmLabel: "Verwerfen",
      variant: "red",
    });
    if (!ok) return;
    await mitBusy(op.op_id, () => verwerfen(op.op_id));
  }

  const blockiert = queue.some((o) => o.status === "konflikt" || o.status === "abgelehnt");
  const titel = online ? "Übertragungen" : "Wartet auf Netz";

  return (
    <>
      <Modal open={open} onClose={onClose} sheet size="md" title={titel} icon={<CloudOff className="h-5 w-5 text-amber-500" />}>
        <p className="text-sm text-muted-foreground">
          {online
            ? "Diese Stempel-Aktionen sind noch nicht am Server. Sie werden der Reihe nach gesendet."
            : "Du bist ohne Netz. Deine Stempel-Aktionen sind auf dem Handy gespeichert und werden gesendet, sobald Netz da ist."}
        </p>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-[72px] w-full" />
            <Skeleton className="h-[72px] w-full" />
          </div>
        ) : queue.length === 0 ? (
          <EmptyState icon={CloudOff} title="Alles übertragen" description="Keine wartenden Aktionen." />
        ) : (
          <ul className="divide-y divide-border -mx-1">
            {queue.map((op) => {
              const pille = STATUS_PILLE[op.status];
              const busy = busyOp === op.op_id;
              return (
                <li key={op.op_id} className="flex gap-3 px-1 py-3">
                  <div className="mt-0.5"><ArtIcon kind={op.kind} /></div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-base font-medium leading-snug">{artText(op)}</p>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${pille.klasse}`}>
                        {op.status === "sendet" ? (
                          <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />{pille.text}</span>
                        ) : pille.text}
                      </span>
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
                        {op.last_error || "Vom Server abgelehnt."} Der Zeitraum ist abgerechnet und kann nicht mehr nachgetragen werden. Korrektur über ein Ticket «Stempel-Änderung».
                      </p>
                    )}

                    {op.status === "konflikt" && (
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => mitBusy(op.op_id, () => serverKonfliktBehalten(op.op_id))}
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
