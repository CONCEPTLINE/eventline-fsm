"use client";

/**
 * Ferien / Abwesenheit am Handy (< md), less is more:
 *
 *   Zeile 56 px «Abwesenheit beantragen …» → Sheet: Typ-Chips (5 wie Desktop),
 *               Von/Bis (type=date, nebeneinander 48 px), Tage, Notiz,
 *               «Beantragen» 52 px → POST /api/time-off wie Desktop.
 *   Liste       eigene Antraege (user_id = meId serverseitig): Zeile 68 px
 *               Typ · Zeitraum · Tage · Status-Wort (Beantragt amber,
 *               Genehmigt gruen, Abgelehnt rot). Tipp → Sheet mit Details;
 *               offene eigene lassen sich zurueckziehen (wie Desktop).
 *   ferien:approve  Segment «Meine | Team» (?sicht=team, Reload-sicher).
 *               Team: «Zu genehmigen» (alle offenen) + «Entschieden»; Tipp →
 *               Sheet Genehmigen / Ablehnen (Begruendung Pflicht) ueber
 *               POST /api/time-off/[id]/decide wie Desktop.
 *
 * Keine Admin-Kennzahlen (Konzept §3). meId IMMER aus usePermissions().
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Loader2, Palmtree, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { heuteTag, plusTage } from "@/lib/einsaetze";
import { ZRH_TZ } from "@/lib/swiss-time";
import { TOAST } from "@/lib/messages";
import type { TimeOff, TimeOffStatus, TimeOffType } from "@/types";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";

interface Antrag extends TimeOff {
  user: { full_name: string } | null;
}

const SELECT = "*, user:profiles!time_off_user_id_fkey(full_name)";
const SEITE = 50;
/** Entschiedene Team-Antraege: nur was in den letzten 90 Tagen endete oder noch kommt. */
const TEAM_RUECKBLICK_TAGE = 90;

const TYP_LABEL: Record<TimeOffType, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};
const TYPEN = Object.keys(TYP_LABEL) as TimeOffType[];

const STATUS_WORT: Record<TimeOffStatus, { text: string; klasse: string }> = {
  beantragt: { text: "Beantragt", klasse: "text-amber-700 dark:text-amber-300" },
  genehmigt: { text: "Genehmigt", klasse: "text-green-700 dark:text-green-300" },
  abgelehnt: { text: "Abgelehnt", klasse: "text-red-600 dark:text-red-400" },
};

type Sicht = "meine" | "team";

// ---------------------------------------------------------------------------
// Datum (Spalten sind DATE → Mittag UTC, Anzeige Europe/Zurich)
// ---------------------------------------------------------------------------

const datumFormat = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "numeric",
});

function datum(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return datumFormat.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function zeitraum(start: string, ende: string): string {
  return start === ende ? datum(start) : `${datum(start)} – ${datum(ende)}`;
}

/** Kalendertage eines inklusiven Bereichs. */
function tage(start: string, ende: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = ende.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1;
}

function tageText(n: number): string {
  return `${n} ${n === 1 ? "Tag" : "Tage"}`;
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

interface Geladen {
  schluessel: string;
  /** Team: offene Antraege (alle). Meine: leer. */
  offen: Antrag[];
  /** Meine: alle eigenen; Team: entschiedene im Rueckblick. */
  liste: Antrag[];
  mehr: boolean;
}

export function FerienMobil() {
  const supabase = createClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { meId, can, ready } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();

  const canApprove = can("ferien:approve");
  const sicht: Sicht = canApprove && searchParams.get("sicht") === "team" ? "team" : "meine";

  const [limit, setLimit] = useState(SEITE);
  const [mehrLaedt, setMehrLaedt] = useState(false);
  const schluessel = `${meId ?? ""}:${sicht}`;
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const daten = geladen?.schluessel === schluessel ? geladen : null;

  const load = useCallback(async () => {
    if (!meId) return;
    const heute = heuteTag();
    try {
      if (sicht === "team") {
        const [offenRes, listeRes] = await Promise.all([
          supabase.from("time_off").select(SELECT).eq("status", "beantragt").order("start_date", { ascending: true }),
          supabase.from("time_off").select(SELECT).neq("status", "beantragt")
            .gte("end_date", plusTage(heute, -TEAM_RUECKBLICK_TAGE))
            .order("start_date", { ascending: false })
            .limit(limit + 1),
        ]);
        if (offenRes.error) throw new Error(offenRes.error.message);
        if (listeRes.error) throw new Error(listeRes.error.message);
        const liste = (listeRes.data as unknown as Antrag[]) ?? [];
        setGeladen({
          schluessel: `${meId}:team`,
          offen: (offenRes.data as unknown as Antrag[]) ?? [],
          liste: liste.slice(0, limit),
          mehr: liste.length > limit,
        });
      } else {
        const { data, error } = await supabase.from("time_off").select(SELECT)
          .eq("user_id", meId)
          .order("start_date", { ascending: false })
          .limit(limit + 1);
        if (error) throw new Error(error.message);
        const liste = (data as unknown as Antrag[]) ?? [];
        setGeladen({ schluessel: `${meId}:meine`, offen: [], liste: liste.slice(0, limit), mehr: liste.length > limit });
      }
    } catch (e) {
      toast.error("Anträge konnten nicht geladen werden: " + (e instanceof Error ? e.message : "Netzwerk-Fehler"));
    } finally {
      setMehrLaedt(false);
    }
  }, [supabase, meId, sicht, limit]);

  // Erstes Laden als Callback (nicht synchron im Effekt-Body).
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  function setzeSicht(neu: Sicht) {
    const params = new URLSearchParams(searchParams.toString());
    if (neu === "team") params.set("sicht", "team");
    else params.delete("sicht");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  /* --- Neu beantragen ----------------------------------------------------- */

  const [neuOffen, setNeuOffen] = useState(false);
  const [neuTyp, setNeuTyp] = useState<TimeOffType>("ferien");
  const [neuStart, setNeuStart] = useState("");
  const [neuEnde, setNeuEnde] = useState("");
  const [neuNotiz, setNeuNotiz] = useState("");
  const [sendet, setSendet] = useState(false);

  function neuAufmachen() {
    const heute = heuteTag();
    setNeuTyp("ferien");
    setNeuStart(heute);
    setNeuEnde(heute);
    setNeuNotiz("");
    setNeuOffen(true);
  }

  const neuGueltig = !!neuStart && !!neuEnde && neuStart <= neuEnde;

  async function beantragen() {
    if (!neuGueltig || sendet) return;
    setSendet(true);
    try {
      const res = await fetch("/api/time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: neuStart, end_date: neuEnde, type: neuTyp, note: neuNotiz.trim() || null }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error, "Anlegen fehlgeschlagen");
        return;
      }
      toast.success("Antrag eingereicht");
      setNeuOffen(false);
      void load();
    } catch (e) {
      TOAST.error(e instanceof Error ? e.message : "Netzwerk-Fehler");
    } finally {
      setSendet(false);
    }
  }

  /* --- Detail-Sheet: Zurueckziehen / Genehmigen / Ablehnen --------------- */

  const [offen, setOffen] = useState<Antrag | null>(null);
  const [ablehnen, setAblehnen] = useState(false);
  const [begruendung, setBegruendung] = useState("");
  const [busy, setBusy] = useState<"zurueck" | "genehmigen" | "ablehnen" | null>(null);

  function detailAufmachen(a: Antrag) {
    setAblehnen(false);
    setBegruendung("");
    setOffen(a);
  }

  async function zurueckziehen(a: Antrag) {
    if (!meId) return;
    const ok = await confirm({
      title: "Antrag zurückziehen?",
      message: `${TYP_LABEL[a.type]} vom ${zeitraum(a.start_date, a.end_date)} wird gelöscht.`,
      confirmLabel: "Zurückziehen",
      variant: "red",
    });
    if (!ok) return;
    setBusy("zurueck");
    const { error, count } = await supabase
      .from("time_off")
      .delete({ count: "exact" })
      .eq("id", a.id)
      .eq("user_id", meId)
      .eq("status", "beantragt");
    setBusy(null);
    if (error) {
      TOAST.supabaseError(error, "Zurückziehen fehlgeschlagen");
      return;
    }
    if (!count) {
      TOAST.error("Antrag konnte nicht zurückgezogen werden");
      return;
    }
    toast.success("Antrag zurückgezogen");
    setOffen(null);
    void load();
  }

  async function entscheiden(a: Antrag, decision: "genehmigen" | "ablehnen") {
    const note = begruendung.trim();
    if (decision === "ablehnen" && !note) {
      TOAST.error("Begründung beim Ablehnen ist Pflicht");
      return;
    }
    setBusy(decision);
    try {
      const res = await fetch(`/api/time-off/${a.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || null }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error, "Speichern fehlgeschlagen");
        return;
      }
      toast.success(decision === "ablehnen" ? "Antrag abgelehnt" : "Antrag genehmigt");
      setOffen(null);
      void load();
    } catch (e) {
      TOAST.error(e instanceof Error ? e.message : "Netzwerk-Fehler");
    } finally {
      setBusy(null);
    }
  }

  /* --- Rendering ------------------------------------------------------------ */

  const laedt = !ready || (!!meId && !daten);
  const leer = daten && daten.offen.length === 0 && daten.liste.length === 0;
  const istTeam = sicht === "team";
  const istEigener = (a: Antrag) => a.user_id === meId;

  return (
    <div className="page-enter space-y-4">
      <button
        type="button"
        onClick={neuAufmachen}
        className="flex h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 text-left text-base text-muted-foreground active:bg-foreground/10"
      >
        <Plus className="h-5 w-5 shrink-0" />
        Abwesenheit beantragen …
      </button>

      {canApprove && (
        <div className="grid h-11 grid-cols-2 gap-2">
          {(["meine", "team"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setzeSicht(s)}
              aria-pressed={sicht === s}
              className={`${sicht === s ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center text-[15px]`}
            >
              {s === "meine" ? "Meine" : "Team"}
            </button>
          ))}
        </div>
      )}

      {laedt ? (
        <ListeSkeleton />
      ) : ready && !meId ? (
        <EmptyState icon={Palmtree} title="Profil konnte nicht geladen werden" />
      ) : leer ? (
        <EmptyState
          icon={Palmtree}
          title={istTeam ? "Keine Anträge im Team" : "Noch keine Anträge"}
          description={istTeam ? undefined : "Nutze die Zeile oben, um Ferien, Krankheit, Kompensation oder Frei-Tage zu beantragen."}
        />
      ) : daten && (
        <div className="space-y-5">
          {istTeam && daten.offen.length > 0 && (
            <Abschnitt titel={`Zu genehmigen · ${daten.offen.length}`} ton="amber">
              {daten.offen.map((a) => <AntragZeile key={a.id} a={a} zeigePerson onTap={() => detailAufmachen(a)} />)}
            </Abschnitt>
          )}
          {daten.liste.length > 0 && (
            <Abschnitt titel={istTeam ? "Entschieden" : "Meine Anträge"}>
              {daten.liste.map((a) => <AntragZeile key={a.id} a={a} zeigePerson={istTeam} onTap={() => detailAufmachen(a)} />)}
            </Abschnitt>
          )}
          {daten.mehr && (
            <button
              type="button"
              disabled={mehrLaedt}
              onClick={() => { setMehrLaedt(true); setLimit((n) => n + SEITE); }}
              className="kasten kasten-muted h-11 w-full text-[15px]"
            >
              {mehrLaedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
              Mehr laden
            </button>
          )}
        </div>
      )}

      {/* Neu-Sheet */}
      <Modal open={neuOffen} onClose={() => !sendet && setNeuOffen(false)} title="Abwesenheit beantragen" sheet size="md" closable={!sendet} bodyClassName="p-4 space-y-4">
        <div className="space-y-2">
          <p className="px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Typ</p>
          <div className="grid grid-cols-3 gap-2">
            {TYPEN.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setNeuTyp(t)}
                aria-pressed={neuTyp === t}
                disabled={sendet}
                className={`${neuTyp === t ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center px-2 text-[14px]`}
              >
                {TYP_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Von</span>
            <input
              type="date"
              value={neuStart}
              onChange={(e) => setNeuStart(e.target.value)}
              disabled={sendet}
              className="h-12 w-full rounded-xl border border-border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>
          <label className="space-y-1">
            <span className="px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Bis</span>
            <input
              type="date"
              value={neuEnde}
              min={neuStart || undefined}
              onChange={(e) => setNeuEnde(e.target.value)}
              disabled={sendet}
              className="h-12 w-full rounded-xl border border-border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>
        </div>
        <p className={`px-1 text-[14px] ${neuGueltig ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
          {neuGueltig ? tageText(tage(neuStart, neuEnde)) : "Start muss vor dem Ende liegen"}
        </p>

        <textarea
          value={neuNotiz}
          onChange={(e) => setNeuNotiz(e.target.value.slice(0, 500))}
          placeholder="Notiz (optional)"
          rows={2}
          maxLength={500}
          disabled={sendet}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-3 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />

        <button
          type="button"
          onClick={() => void beantragen()}
          disabled={sendet || !neuGueltig}
          className="kasten kasten-red h-[52px] w-full text-base"
        >
          {sendet && <Loader2 className="h-4 w-4 animate-spin" />}
          {sendet ? "Wird eingereicht …" : "Beantragen"}
        </button>
      </Modal>

      {/* Detail-Sheet */}
      <Modal open={offen !== null} onClose={() => !busy && setOffen(null)} title={offen ? TYP_LABEL[offen.type] : undefined} sheet size="md" closable={!busy} bodyClassName="p-4 space-y-4">
        {offen && (
          <>
            <dl className="overflow-hidden rounded-xl border border-border">
              {istTeam && <Detail label="Person" wert={offen.user?.full_name ?? "Unbekannt"} />}
              <Detail label="Zeitraum" wert={zeitraum(offen.start_date, offen.end_date)} />
              <Detail label="Dauer" wert={tageText(tage(offen.start_date, offen.end_date))} />
              <Detail label="Status" wert={<span className={`font-semibold ${STATUS_WORT[offen.status].klasse}`}>{STATUS_WORT[offen.status].text}</span>} />
              {offen.note && <Detail label="Notiz" wert={offen.note} />}
              {offen.decision_note && <Detail label="Entscheid" wert={offen.decision_note} />}
            </dl>

            {istTeam && canApprove && offen.status === "beantragt" && (
              ablehnen ? (
                <div className="space-y-3">
                  <textarea
                    value={begruendung}
                    onChange={(e) => setBegruendung(e.target.value.slice(0, 500))}
                    placeholder="Begründung (Pflicht)"
                    rows={3}
                    maxLength={500}
                    autoFocus
                    disabled={busy !== null}
                    className="w-full resize-none rounded-xl border border-border bg-background px-3 py-3 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAblehnen(false)} disabled={busy !== null} className="kasten kasten-muted h-12 flex-1 text-[15px]">
                      Zurück
                    </button>
                    <button
                      type="button"
                      onClick={() => void entscheiden(offen, "ablehnen")}
                      disabled={busy !== null || !begruendung.trim()}
                      className="kasten kasten-red h-12 flex-1 text-[15px]"
                    >
                      {busy === "ablehnen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      Ablehnen
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAblehnen(true)} disabled={busy !== null} className="kasten kasten-red h-[52px] flex-1 text-base">
                    <X className="h-4 w-4" />
                    Ablehnen
                  </button>
                  <button
                    type="button"
                    onClick={() => void entscheiden(offen, "genehmigen")}
                    disabled={busy !== null}
                    className="kasten kasten-green h-[52px] flex-1 text-base"
                  >
                    {busy === "genehmigen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Genehmigen
                  </button>
                </div>
              )
            )}

            {!istTeam && istEigener(offen) && offen.status === "beantragt" && (
              <button
                type="button"
                onClick={() => void zurueckziehen(offen)}
                disabled={busy !== null}
                className="kasten kasten-muted h-12 w-full text-[15px]"
              >
                {busy === "zurueck" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Zurückziehen
              </button>
            )}
          </>
        )}
      </Modal>

      {ConfirmModalElement}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function Abschnitt({ titel, ton, children }: { titel: string; ton?: "amber"; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className={`px-1 text-[12px] font-bold uppercase tracking-wider ${ton === "amber" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
        {titel}
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

/** Zeile 68 px: Typ (Team: Name · Typ) + Zeitraum links, Tage + Status rechts. */
function AntragZeile({ a, zeigePerson, onTap }: { a: Antrag; zeigePerson: boolean; onTap: () => void }) {
  const status = STATUS_WORT[a.status];
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex min-h-[68px] w-full items-center gap-3 border-t border-border px-4 py-2 text-left first:border-t-0 active:bg-foreground/10"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-semibold leading-5">
          {zeigePerson ? `${a.user?.full_name ?? "Unbekannt"} · ${TYP_LABEL[a.type]}` : TYP_LABEL[a.type]}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground tabular-nums">{zeitraum(a.start_date, a.end_date)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-[15px] font-semibold leading-5 tabular-nums">{tageText(tage(a.start_date, a.end_date))}</span>
        <span className={`text-[13px] font-semibold leading-5 ${status.klasse}`}>{status.text}</span>
      </div>
    </button>
  );
}

function Detail({ label, wert }: { label: string; wert: React.ReactNode }) {
  return (
    <div className="flex min-h-[48px] items-center gap-3 border-t border-border px-3 py-2 first:border-t-0">
      <dt className="w-20 shrink-0 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-[16px] leading-5">{wert}</dd>
    </div>
  );
}

function ListeSkeleton() {
  return (
    <div className="space-y-2" aria-busy>
      <Skeleton className="h-3.5 w-28" />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex min-h-[68px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-3.5 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
