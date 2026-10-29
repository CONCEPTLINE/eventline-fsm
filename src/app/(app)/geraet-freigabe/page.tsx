"use client";

/**
 * Gerätefreigabe (/geraet-freigabe?id=<device_id>) — Lohn-Umbau Phase 1,
 * gilt für Finanzen und Löhne.
 *
 * Hierhin führen die Glocke und die Mail an die Admin-Mailbox. Das Öffnen
 * gibt nichts frei: Der ANDERE Admin oder die Vertretung entscheidet hier
 * angemeldet per Knopf, innerhalb von 24 h, selbst auf einem vertrauten
 * Gerät. Ob jemand darf, entscheidet allein der Server
 * (/api/trust/freigabe → darf_freigeben / hinderungsgrund).
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, Info, Loader2, ShieldCheck, ShieldX, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/use-confirm";
import { formatDateTimeFull } from "@/lib/format";
import Loading from "./loading";

interface Anfrage {
  id: string;
  person: string;
  email: string | null;
  geraet: string;
  browser: string | null;
  ip: string | null;
  status: "pending" | "approved" | "revoked";
  angefragt_at: string;
  gueltig_bis: string | null;
  abgelaufen: boolean;
  freigegeben_at: string | null;
  freigegeben_von: string | null;
}

interface FreigabeDaten {
  anfrage: Anfrage;
  darf_freigeben: boolean;
  hinderungsgrund: string | null;
}

type Aktion = "freigeben" | "ablehnen";

function zeit(iso: string | null): string {
  return iso ? formatDateTimeFull(iso) : "—";
}

export default function GeraetFreigabePage() {
  const id = useSearchParams().get("id") ?? "";
  const [daten, setDaten] = useState<FreigabeDaten | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<Aktion | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  const laden = useCallback(async () => {
    try {
      const res = await fetch(`/api/trust/freigabe?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const text = (json?.error as string | undefined) ?? "Anfrage konnte nicht geladen werden.";
        setFehler(text);
        toast.error(text);
        return;
      }
      setFehler(null);
      setDaten({ anfrage: json.anfrage, darf_freigeben: !!json.darf_freigeben, hinderungsgrund: json.hinderungsgrund ?? null });
    } catch (e) {
      const text = `Anfrage konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`;
      setFehler(text);
      toast.error(text);
    }
  }, [id]);

  useEffect(() => {
    if (id) void laden();
  }, [id, laden]);

  async function entscheiden(aktion: Aktion) {
    if (!daten) return;
    const a = daten.anfrage;
    if (aktion === "ablehnen") {
      const ok = await confirm({
        title: `Anfrage «${a.geraet}» ablehnen?`,
        message: `${a.person} bekommt mit diesem Gerät keinen Zugriff auf Finanzen und Löhne. Für einen neuen Versuch braucht es eine neue Anfrage.`,
        confirmLabel: "Ablehnen",
        variant: "red",
      });
      if (!ok) return;
    }
    setLaeuft(aktion);
    try {
      const res = await fetch("/api/trust/freigabe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, aktion }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entscheid fehlgeschlagen.");
      } else {
        toast.success(aktion === "freigeben" ? `Gerät «${a.geraet}» freigegeben` : `Anfrage «${a.geraet}» abgelehnt`);
      }
      // Immer neu laden: zeigt den aktuellen Stand, auch wenn jemand
      // anderes schneller war (409) oder die Frist ablief (410).
      await laden();
    } catch (e) {
      toast.error(`Entscheid fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  const kopf = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Gerät freigeben</h1>
      <p className="text-sm text-muted-foreground mt-1">Neues Gerät für Finanzen und Löhne prüfen und entscheiden.</p>
    </div>
  );

  if (!id || (fehler && !daten)) {
    return (
      <div className="space-y-6 max-w-2xl page-enter">
        {kopf}
        <Card>
          <CardContent className="p-5 flex items-start gap-3">
            <ShieldX className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-sm">{id ? fehler : "Der Link ist unvollständig — es ist keine Anfrage angegeben."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!daten) return <Loading />;

  const a = daten.anfrage;
  const zeilen: { label: string; wert: React.ReactNode }[] = [
    {
      label: "Person",
      wert: (
        <>
          <span className="font-medium">{a.person}</span>
          {a.email && <span className="text-muted-foreground"> · {a.email}</span>}
        </>
      ),
    },
    { label: "Gerät", wert: <span className="font-medium">{a.geraet}</span> },
    { label: "Browser", wert: <span className="text-xs text-muted-foreground break-words">{a.browser ?? "—"}</span> },
    { label: "IP", wert: <span className="font-mono text-xs">{a.ip ?? "—"}</span> },
    { label: "Angefragt am", wert: zeit(a.angefragt_at) },
  ];
  if (a.status === "pending") {
    zeilen.push({ label: "Gültig bis", wert: zeit(a.gueltig_bis) });
  }
  if (a.status === "approved") {
    zeilen.push({
      label: "Freigegeben",
      wert: `${zeit(a.freigegeben_at)}${a.freigegeben_von ? ` von ${a.freigegeben_von}` : ""}`,
    });
  }

  return (
    <div className="space-y-6 max-w-2xl page-enter">
      {kopf}
      <Card>
        <CardContent className="p-5 space-y-4">
          <StatusBadge status={a.status} abgelaufen={a.abgelaufen} />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {zeilen.map((z) => (
              <div key={z.label} className="contents">
                <dt className="text-xs text-muted-foreground pt-0.5">{z.label}</dt>
                <dd className="min-w-0">{z.wert}</dd>
              </div>
            ))}
          </dl>

          {daten.darf_freigeben ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => entscheiden("freigeben")}
                disabled={laeuft !== null}
                className="kasten kasten-green"
              >
                {laeuft === "freigeben" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {laeuft === "freigeben" ? "Wird freigegeben …" : "Freigeben"}
              </button>
              <button
                type="button"
                onClick={() => entscheiden("ablehnen")}
                disabled={laeuft !== null}
                className="kasten kasten-red"
              >
                {laeuft === "ablehnen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                {laeuft === "ablehnen" ? "Wird abgelehnt …" : "Ablehnen"}
              </button>
            </div>
          ) : daten.hinderungsgrund ? (
            <div className="flex items-start gap-2 text-sm p-3 rounded-lg bg-muted/60">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{daten.hinderungsgrund}</span>
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground border-t pt-3">
            Ein neues Gerät gibt nur der andere Admin oder die Vertretung frei — angemeldet, per Knopf,
            innerhalb von 24 Stunden und selbst auf einem vertrauten Gerät. Der Link in der Mail gibt
            nicht schon beim Öffnen frei.
          </p>
        </CardContent>
      </Card>
      {ConfirmModalElement}
    </div>
  );
}

function StatusBadge({ status, abgelaufen }: { status: Anfrage["status"]; abgelaufen: boolean }) {
  const basis = "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full";
  if (status === "approved") {
    return (
      <span className={`${basis} bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300`}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        Freigegeben
      </span>
    );
  }
  if (status === "revoked") {
    return (
      <span className={`${basis} bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300`}>
        <XCircle className="h-3.5 w-3.5" />
        Abgelehnt bzw. widerrufen
      </span>
    );
  }
  if (abgelaufen) {
    return (
      <span className={`${basis} bg-muted text-muted-foreground dark:bg-foreground/15`}>
        <Clock className="h-3.5 w-3.5" />
        Abgelaufen — neue Anfrage nötig
      </span>
    );
  }
  return (
    <span className={`${basis} bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300`}>
      <Clock className="h-3.5 w-3.5" />
      Wartet auf Freigabe
    </span>
  );
}
