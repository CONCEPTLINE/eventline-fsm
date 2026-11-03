"use client";

/**
 * «Meine Anfragen» (/anfragen) — alles, was die Person gemeldet hat, an EINEM
 * Ort: Belege, Stempel-Korrekturen, IT, Material (Tickets) und Abwesenheiten
 * inkl. Krankmeldungen. Laptop: Kopf mit Melden-Knoepfen + Tabelle; Handy:
 * Liste (Melden-Kacheln liegen am Handy in Mein Konto).
 *
 *   Offen (n) | Erledigt   Filter derselben Liste (?stand=erledigt, Reload-sicher)
 *   Krank                  «Wieder gesund» (Ende = heute), «Arztzeugnis
 *                          nachreichen» (ab Tag 3 «Arztzeugnis fehlt»), ansehen
 *   Abwesenheit offen      «Zurückziehen» (wie bisher auf /ferien)
 *   Tickets                Zeile oeffnet die Detailseite; zurueckziehen geht
 *                          nicht (RLS erlaubt Mitarbeitern kein Schliessen)
 *
 * Belege: es gibt keinen Auszahlungs-Stand in den Daten — gezeigt wird der
 * Ticket-Stand (wird geprüft / erledigt / abgelehnt).
 *
 * Daten: /api/anfragen. Neu laden nach eigener Meldung, bei Ticket-
 * Aenderungen (realtime:tickets) und wenn der Tab zurueckkommt.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { FileText, Inbox, Loader2, Plus, Trash2, Upload, HeartPulse } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { StandPille } from "@/components/mein-konto/konto-hub";
import { TextLink } from "@/components/ui/text-knopf";
import { MELDEN_ICONS } from "@/components/melden/melden-kacheln";
import { ANDERES_LABEL, ANFRAGEN_GEAENDERT_EVENT, MELDEN_KACHELN, anfragenGeaendert, darfMelden, oeffneMelden } from "@/lib/melden";
import { ART_LABEL, type Anfrage } from "@/lib/anfragen";
import { ARZTZEUGNIS_AB_TAG } from "@/lib/krank";
import { formatDate } from "@/lib/format";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { useIsMobile } from "@/lib/use-is-mobile";

type Stand = "offen" | "erledigt";

export function MeineAnfragen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const stand: Stand = searchParams.get("stand") === "erledigt" ? "erledigt" : "offen";
  const isMobile = useIsMobile();
  const { can } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const supabase = createClient();

  const [liste, setListe] = useState<Anfrage[] | null>(null);
  const [offenAnzahl, setOffenAnzahl] = useState<number | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const laden = useCallback(async () => {
    try {
      const res = await fetch(`/api/anfragen?stand=${stand}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!json.success) throw new Error(json.error ?? "Anfragen konnten nicht geladen werden");
      setListe(json.anfragen as Anfrage[]);
      setOffenAnzahl(json.offen as number);
      setFehler(null);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : "Anfragen konnten nicht geladen werden");
    }
  }, [stand]);

  useEffect(() => {
    const erst = setTimeout(() => { void laden(); }, 0);
    return () => clearTimeout(erst);
  }, [laden]);

  useEffect(() => {
    const neu = () => { void laden(); };
    const sichtbar = () => { if (document.visibilityState === "visible") void laden(); };
    window.addEventListener(ANFRAGEN_GEAENDERT_EVENT, neu);
    window.addEventListener("realtime:tickets", neu);
    document.addEventListener("visibilitychange", sichtbar);
    return () => {
      window.removeEventListener(ANFRAGEN_GEAENDERT_EVENT, neu);
      window.removeEventListener("realtime:tickets", neu);
      document.removeEventListener("visibilitychange", sichtbar);
    };
  }, [laden]);

  function setzeStand(s: Stand) {
    if (s === stand) return;
    setListe(null);
    router.replace(s === "erledigt" ? "/anfragen?stand=erledigt" : "/anfragen", { scroll: false });
  }

  async function wiederGesund(a: Anfrage) {
    const ok = await confirm({
      title: "Wieder gesund?",
      message: "Die Krankmeldung endet heute. Bitte melde dich auch bei deiner vorgesetzten Person zurück.",
      confirmLabel: "Wieder gesund",
    });
    if (!ok) return;
    setBusy(a.key);
    try {
      const res = await fetch(`/api/krank/${a.id}/gesund`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!json.success) { TOAST.errorOr(json.error, "Speichern fehlgeschlagen"); return; }
      toast.success("Schön, dass du wieder gesund bist");
      anfragenGeaendert();
    } finally {
      setBusy(null);
    }
  }

  async function zeugnisHochladen(a: Anfrage, datei: File) {
    setBusy(a.key);
    try {
      const fd = new FormData();
      fd.append("datei", datei);
      const res = await fetch(`/api/krank/${a.id}/arztzeugnis`, { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!json.success) { TOAST.errorOr(json.error, "Hochladen fehlgeschlagen"); return; }
      toast.success("Arztzeugnis gesendet");
      anfragenGeaendert();
    } finally {
      setBusy(null);
    }
  }

  async function zeugnisAnsehen(a: Anfrage) {
    setBusy(a.key);
    try {
      const res = await fetch(`/api/krank/${a.id}/arztzeugnis`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!json.success) { TOAST.errorOr(json.error, "Arztzeugnis konnte nicht geöffnet werden"); return; }
      window.open(json.url as string, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }

  async function zurueckziehen(a: Anfrage) {
    const ok = await confirm({
      title: "Abwesenheit zurückziehen?",
      message: `${a.was} wird gelöscht.`,
      confirmLabel: "Zurückziehen",
      variant: "red",
    });
    if (!ok) return;
    setBusy(a.key);
    try {
      const { error, count } = await supabase
        .from("time_off")
        .delete({ count: "exact" })
        .eq("id", a.id)
        .eq("status", "beantragt");
      if (error) { TOAST.supabaseError(error, "Zurückziehen fehlgeschlagen"); return; }
      if (!count) { TOAST.error("Konnte nicht zurückgezogen werden — schon entschieden?"); return; }
      toast.success("Zurückgezogen");
      window.dispatchEvent(new Event("time_off:invalidate"));
      anfragenGeaendert();
    } finally {
      setBusy(null);
    }
  }

  const aktionen = (a: Anfrage) => (
    <Aktionen
      a={a}
      busy={busy === a.key}
      onGesund={() => void wiederGesund(a)}
      onZeugnis={(f) => void zeugnisHochladen(a, f)}
      onAnsehen={() => void zeugnisAnsehen(a)}
      onZurueck={() => void zurueckziehen(a)}
    />
  );

  const meldenArten = MELDEN_KACHELN.filter((k) => darfMelden(k.art, can));

  return (
    <div className="page-enter space-y-4 md:space-y-5">
      {isMobile === false && (
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Meine Anfragen</h1>
            <p className="mt-1 text-sm text-muted-foreground">Alles, was du gemeldet hast, an einem Ort.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {meldenArten.map((k) => {
              const Icon = MELDEN_ICONS[k.art];
              return (
                <button key={k.art} type="button" onClick={() => oeffneMelden(k.art)} className="kasten">
                  <Icon className="h-3.5 w-3.5" />
                  {k.label}
                </button>
              );
            })}
            {darfMelden("anderes", can) && (
              <button type="button" onClick={() => oeffneMelden("anderes")} className="kasten kasten-muted">
                <Plus className="h-3.5 w-3.5" />
                {ANDERES_LABEL}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid h-[34px] max-w-xs grid-cols-2 gap-2">
        {(["offen", "erledigt"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setzeStand(s)}
            aria-pressed={stand === s}
            className={`${stand === s ? "kasten-active" : "kasten-toggle-off"} h-[34px] justify-center text-[13px]`}
          >
            {s === "offen" ? `Offen${offenAnzahl !== null ? ` (${offenAnzahl})` : ""}` : "Erledigt"}
          </button>
        ))}
      </div>

      {fehler && !liste ? (
        <EmptyState icon={Inbox} title="Anfragen konnten nicht geladen werden" description={fehler}
          action={<button type="button" className="kasten" onClick={() => void laden()}>Erneut laden</button>} />
      ) : liste === null ? (
        <div className="space-y-px overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[46px] rounded-none" />)}
        </div>
      ) : liste.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={stand === "offen" ? "Nichts offen" : "Noch nichts erledigt"}
          description={stand === "offen" ? "Was du meldest, siehst du hier mit seinem Stand." : undefined}
        />
      ) : isMobile ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {liste.map((a) => (
            <div key={a.key} className="border-t border-border px-3 py-[7px] first:border-t-0">
              <ZeileKopf a={a} />
              {aktionen(a)}
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-medium">Art</th>
                <th className="px-4 py-2 font-medium">Was</th>
                <th className="px-4 py-2 font-medium">Gemeldet</th>
                <th className="px-4 py-2 font-medium">Stand</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {liste.map((a) => (
                <tr key={a.key} className="border-t border-border first:border-t-0 align-middle">
                  <td className="px-4 py-2.5 font-medium">{ART_LABEL[a.art]}</td>
                  <td className="px-4 py-2.5">
                    {a.link ? <TextLink href={a.link}>{a.was}</TextLink> : a.was}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{formatDate(a.gemeldet_at)}</td>
                  <td className="px-4 py-2.5"><StandPille ton={a.ton}>{a.stand}</StandPille></td>
                  <td className="px-4 py-2.5 text-right">{aktionen(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ConfirmModalElement}
    </div>
  );
}

function ZeileKopf({ a }: { a: Anfrage }) {
  const inhalt = (
    <div className="flex min-h-[34px] items-center gap-2 text-[14px]">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{ART_LABEL[a.art]}</span>
        <span className="text-muted-foreground"> · {a.was}</span>
      </span>
      <StandPille ton={a.ton}>{a.stand}</StandPille>
    </div>
  );
  return (
    <>
      {a.link ? <PrefetchLink href={a.link}>{inhalt}</PrefetchLink> : inhalt}
      <p className="text-[12px] text-muted-foreground">gemeldet {formatDate(a.gemeldet_at)}</p>
    </>
  );
}

function Aktionen({ a, busy, onGesund, onZeugnis, onAnsehen, onZurueck }: {
  a: Anfrage;
  busy: boolean;
  onGesund: () => void;
  onZeugnis: (f: File) => void;
  onAnsehen: () => void;
  onZurueck: () => void;
}) {
  const dateiRef = useRef<HTMLInputElement>(null);
  const k = a.krank;
  if (!k && !a.zurueckziehbar) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 md:mt-0 md:justify-end">
      {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {k?.laeuft && (
        <button type="button" onClick={onGesund} disabled={busy} className="kasten h-[34px] text-[13px] md:h-auto">
          <HeartPulse className="h-3.5 w-3.5" />
          Wieder gesund
        </button>
      )}
      {k && (
        <>
          <button
            type="button"
            onClick={() => dateiRef.current?.click()}
            disabled={busy}
            className={`kasten h-[34px] text-[13px] md:h-auto ${k.zeugnisFehlt ? "kasten-red" : ""}`}
            data-tooltip={k.hatZeugnis ? "Neues Arztzeugnis ersetzt das bisherige" : `Arztzeugnis ab dem ${ARZTZEUGNIS_AB_TAG}. Tag`}
          >
            <Upload className="h-3.5 w-3.5" />
            {k.hatZeugnis ? "Zeugnis ersetzen" : "Arztzeugnis nachreichen"}
          </button>
          <input
            ref={dateiRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onZeugnis(f);
            }}
          />
          {k.hatZeugnis && (
            <button type="button" onClick={onAnsehen} disabled={busy} className="kasten kasten-muted h-[34px] text-[13px] md:h-auto">
              <FileText className="h-3.5 w-3.5" />
              Ansehen
            </button>
          )}
        </>
      )}
      {a.zurueckziehbar && (
        <button type="button" onClick={onZurueck} disabled={busy} className="kasten kasten-muted h-[34px] text-[13px] md:h-auto">
          <Trash2 className="h-3.5 w-3.5" />
          Zurückziehen
        </button>
      )}
    </div>
  );
}
