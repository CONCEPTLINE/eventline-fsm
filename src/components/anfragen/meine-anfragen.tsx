"use client";

/**
 * «Meine Anfragen» (/anfragen) — alles, was die Person gemeldet hat, an EINEM
 * Ort: Belege, Stempel-Korrekturen, IT, Material (Tickets) und Abwesenheiten
 * inkl. Krankmeldungen. Laptop: Kopf mit Melden-Knoepfen + Karten-Liste; Handy:
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
import { FileText, Inbox, Loader2, Package, Plus, Trash2, Upload, HeartPulse, Wrench, type LucideIcon } from "lucide-react";
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
      {/* Kopf wie /tickets und /ferien: Titel links, Melden-Knoepfe rechts. */}
      {isMobile === false && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Meine Anfragen</h1>
            <p className="mt-1 text-sm text-muted-foreground">Alles, was du gemeldet hast, an einem Ort.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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

      {/* Offen | Erledigt = Filter derselben Liste (wie /tickets). */}
      <div className="flex items-center gap-1">
        {(["offen", "erledigt"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setzeStand(s)}
            aria-pressed={stand === s}
            className={`${stand === s ? "kasten-active" : "kasten-toggle-off"} max-md:h-[34px]`}
          >
            {s === "offen" ? `Offen${offenAnzahl !== null ? ` (${offenAnzahl})` : ""}` : "Erledigt"}
          </button>
        ))}
      </div>

      {fehler && !liste ? (
        <div className="rounded-xl border border-dashed border-border bg-card">
          <EmptyState icon={Inbox} title="Anfragen konnten nicht geladen werden" description={fehler}
            action={<button type="button" className="kasten" onClick={() => void laden()}>Erneut laden</button>} />
        </div>
      ) : liste === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[52px] rounded-xl" />)}
        </div>
      ) : liste.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card">
          <EmptyState
            icon={Inbox}
            title={stand === "offen" ? "Nichts offen" : "Noch nichts erledigt"}
            description={stand === "offen" ? "Was du meldest, siehst du hier mit seinem Stand." : undefined}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {liste.map((a) => (
            <Zeile key={a.key} a={a} mobil={isMobile === true} aktionen={aktionen(a)} />
          ))}
        </div>
      )}
      {ConfirmModalElement}
    </div>
  );
}

/** Farbige Art-Kachel — Farben wie die Typen auf /tickets bzw. /ferien. */
const ART_META: Record<Anfrage["art"], { icon: LucideIcon; farbe: string }> = {
  beleg:       { icon: MELDEN_ICONS.beleg,       farbe: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/15" },
  stempel:     { icon: MELDEN_ICONS.stempel,     farbe: "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-500/15" },
  it:          { icon: Wrench,                   farbe: "text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/15" },
  material:    { icon: Package,                  farbe: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/15" },
  abwesenheit: { icon: MELDEN_ICONS.abwesenheit, farbe: "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/15" },
  krank:       { icon: MELDEN_ICONS.krank,       farbe: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/15" },
};

/** Eine Anfrage als Karte wie die Ticket-Zeilen auf /tickets. Mit Link (Tickets)
 *  ist die ganze Karte klickbar; Krank/Abwesenheit tragen ihre Knoepfe —
 *  Laptop rechts in der Zeile, Handy darunter. */
function Zeile({ a, mobil, aktionen }: { a: Anfrage; mobil: boolean; aktionen: React.ReactNode }) {
  const meta = ART_META[a.art];
  const Icon = meta.icon;
  // Knoepfe gibt es nur bei Krank und offener Abwesenheit (siehe Aktionen).
  const hatAktionen = !!a.krank || a.zurueckziehbar;
  const kopf = (
    <div className="flex min-h-[34px] items-center gap-3">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${meta.farbe}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {a.link && hatAktionen ? <TextLink href={a.link}>{a.was}</TextLink> : a.was}
          </span>
          <StandPille ton={a.ton}>{a.stand}</StandPille>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {ART_LABEL[a.art]} · gemeldet {formatDate(a.gemeldet_at)}
        </div>
      </div>
      {!mobil && aktionen}
    </div>
  );
  const rahmen = "block rounded-xl border border-border bg-card px-3 py-[7px] md:px-4 md:py-1.5";
  if (a.link && !hatAktionen) {
    return (
      <PrefetchLink href={a.link} className={`card-hover ${rahmen}`}>
        {kopf}
      </PrefetchLink>
    );
  }
  return (
    <div className={rahmen}>
      {kopf}
      {mobil && aktionen}
    </div>
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
    <div className="mt-1.5 flex flex-wrap items-center gap-2 md:mt-0 md:shrink-0 md:justify-end">
      {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {k?.laeuft && (
        <button type="button" onClick={onGesund} disabled={busy} className="kasten h-[34px] text-[13px] md:h-auto md:text-xs">
          <HeartPulse className="h-3.5 w-3.5" />
          Wieder gesund
        </button>
      )}
      {k?.zeugnisStatus === "an_trust_flow" && (
        // Ans Backoffice (Trust flow) uebergeben und hier geloescht — kein
        // Ersetzen/Ansehen mehr, nur der Stand.
        <span className="text-[11px] text-muted-foreground">Arztzeugnis abgegeben</span>
      )}
      {k && k.zeugnisStatus !== "an_trust_flow" && (
        <>
          <button
            type="button"
            onClick={() => dateiRef.current?.click()}
            disabled={busy}
            className={`kasten h-[34px] text-[13px] md:h-auto md:text-xs ${k.zeugnisFehlt ? "kasten-red" : ""}`}
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
          {k.zeugnisAnsehbar && (
            <button type="button" onClick={onAnsehen} disabled={busy} className="kasten kasten-muted h-[34px] text-[13px] md:h-auto md:text-xs">
              <FileText className="h-3.5 w-3.5" />
              Ansehen
            </button>
          )}
        </>
      )}
      {a.zurueckziehbar && (
        <button type="button" onClick={onZurueck} disabled={busy} className="kasten kasten-muted h-[34px] text-[13px] md:h-auto md:text-xs">
          <Trash2 className="h-3.5 w-3.5" />
          Zurückziehen
        </button>
      )}
    </div>
  );
}
