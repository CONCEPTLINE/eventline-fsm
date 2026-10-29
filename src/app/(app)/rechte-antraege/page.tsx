"use client";

/**
 * Rechte-Anträge (/rechte-antraege[?id=…]) — Vier Augen bei Rechten,
 * Lohn-Umbau Phase 1 (Migration 361).
 *
 * Admin-Rolle, Lohnrecht (an Personen oder Rollen) und die Vertretung ändert
 * kein Admin allein: die Änderung wartet hier, bis der ANDERE Admin sie auf
 * einem vertrauten Gerät bestätigt (24 h). Wer darf, entscheidet der Server
 * (/api/admin/rechte-antraege → darf_bestaetigen / hinderungsgrund).
 * Ablehnen bzw. den eigenen Antrag zurückziehen darf jeder Admin.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, Info, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { formatDateTimeFull } from "@/lib/format";
import Loading from "./loading";

interface Antrag {
  id: string;
  art: "person" | "rolle_rechte" | "vertretung";
  beschreibung: string;
  gewaehrt: boolean;
  status: "offen" | "bestaetigt" | "abgelehnt";
  beantragt_von_name: string | null;
  beantragt_at: string;
  gueltig_bis: string;
  entschieden_von_name: string | null;
  entschieden_at: string | null;
  notweg_grund: string | null;
  abgelaufen: boolean;
  darf_bestaetigen: boolean;
  hinderungsgrund: string | null;
  eigener: boolean;
}

type Aktion = "bestaetigen" | "ablehnen";

const ART_LABEL: Record<Antrag["art"], string> = {
  person: "Person",
  rolle_rechte: "Rolle",
  vertretung: "Vertretung",
};

export default function RechteAntraegePage() {
  const markiert = useSearchParams().get("id");
  const [offen, setOffen] = useState<Antrag[] | null>(null);
  const [entschieden, setEntschieden] = useState<Antrag[]>([]);
  const [laeuft, setLaeuft] = useState<{ id: string; aktion: Aktion } | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  const laden = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/rechte-antraege", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Anträge konnten nicht geladen werden.");
        setOffen([]);
        return;
      }
      setOffen(json.offen as Antrag[]);
      setEntschieden(json.entschieden as Antrag[]);
    } catch (e) {
      toast.error(`Anträge konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
      setOffen([]);
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  async function entscheiden(a: Antrag, aktion: Aktion) {
    const ok = await confirm({
      title: aktion === "bestaetigen" ? "Antrag bestätigen?" : a.eigener ? "Eigenen Antrag zurückziehen?" : "Antrag ablehnen?",
      message: aktion === "bestaetigen"
        ? `${a.beschreibung}. Die Änderung gilt sofort und wird im Rechte-Protokoll festgehalten.`
        : `${a.beschreibung}. Es ändert sich nichts; für einen neuen Versuch braucht es einen neuen Antrag.`,
      confirmLabel: aktion === "bestaetigen" ? "Bestätigen" : a.eigener ? "Zurückziehen" : "Ablehnen",
      variant: aktion === "bestaetigen" ? "blue" : "red",
    });
    if (!ok) return;
    setLaeuft({ id: a.id, aktion });
    try {
      const res = await fetch("/api/admin/rechte-antraege", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, aktion }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entscheid fehlgeschlagen.");
      } else {
        toast.success(aktion === "bestaetigen" ? "Bestätigt — Änderung gilt" : "Abgelehnt");
        if (json.warnung) toast.error(json.warnung as string);
      }
      await laden();
    } catch (e) {
      toast.error(`Entscheid fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  if (offen === null) return <Loading />;

  return (
    <div className="space-y-6 max-w-3xl page-enter">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rechte-Anträge</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Admin-Rolle, Lohnrecht und Vertretung ändern sich erst, wenn der andere Admin bestätigt.
        </p>
      </div>

      <section className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Offen</p>
        {offen.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Keine offenen Anträge" />
        ) : (
          offen.map((a) => (
            <Card key={a.id} className={a.id === markiert ? "ring-2 ring-red-500/60" : undefined}>
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{a.beschreibung}</p>
                    <p className="text-xs text-muted-foreground">
                      {ART_LABEL[a.art]} · {a.gewaehrt ? "gewährt Zugang" : "entzieht Zugang"} · beantragt von {a.beantragt_von_name ?? "?"} am{" "}
                      {formatDateTimeFull(a.beantragt_at)} · gültig bis {formatDateTimeFull(a.gueltig_bis)}
                    </p>
                  </div>
                  <StatusBadge a={a} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {a.darf_bestaetigen && (
                    <button type="button" onClick={() => entscheiden(a, "bestaetigen")} disabled={laeuft !== null} className="kasten kasten-green">
                      {laeuft?.id === a.id && laeuft.aktion === "bestaetigen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      {laeuft?.id === a.id && laeuft.aktion === "bestaetigen" ? "Wird bestätigt …" : "Bestätigen"}
                    </button>
                  )}
                  {!a.abgelaufen && (
                    <button type="button" onClick={() => entscheiden(a, "ablehnen")} disabled={laeuft !== null} className="kasten kasten-red">
                      {laeuft?.id === a.id && laeuft.aktion === "ablehnen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                      {a.eigener ? "Zurückziehen" : "Ablehnen"}
                    </button>
                  )}
                  {!a.darf_bestaetigen && a.hinderungsgrund && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Info className="h-3.5 w-3.5 shrink-0" />
                      {a.hinderungsgrund}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {entschieden.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zuletzt entschieden</p>
          <Card>
            <CardContent className="p-0 divide-y">
              {entschieden.map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium text-sm">{a.beschreibung}</span>
                    <span className="block text-muted-foreground">
                      beantragt von {a.beantragt_von_name ?? "?"} · {a.status === "bestaetigt" ? "bestätigt" : "abgelehnt"} von {a.entschieden_von_name ?? "?"}
                      {a.entschieden_at ? ` am ${formatDateTimeFull(a.entschieden_at)}` : ""}
                      {a.notweg_grund ? ` · Notweg: ${a.notweg_grund}` : ""}
                    </span>
                  </span>
                  <StatusBadge a={a} />
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Bestätigen kann nur der andere Admin — nicht wer den Antrag gestellt hat und nie für die eigenen Rechte —, auf
        einem vertrauten Gerät, innerhalb von 24 Stunden. Jede Entscheidung steht im Rechte-Protokoll. Notweg ohne zweiten
        Admin: über Mischa.
      </p>
      {ConfirmModalElement}
    </div>
  );
}

function StatusBadge({ a }: { a: Antrag }) {
  const basis = "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full shrink-0";
  if (a.status === "bestaetigt") {
    return <span className={`${basis} bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300`}><CheckCircle2 className="h-3.5 w-3.5" />Bestätigt</span>;
  }
  if (a.status === "abgelehnt") {
    return <span className={`${basis} bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300`}><XCircle className="h-3.5 w-3.5" />Abgelehnt</span>;
  }
  if (a.abgelaufen) {
    return <span className={`${basis} bg-muted text-muted-foreground dark:bg-foreground/15`}><Clock className="h-3.5 w-3.5" />Abgelaufen</span>;
  }
  return <span className={`${basis} bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300`}><Clock className="h-3.5 w-3.5" />Wartet auf Bestätigung</span>;
}
