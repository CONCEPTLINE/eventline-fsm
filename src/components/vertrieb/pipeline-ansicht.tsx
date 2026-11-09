"use client";

/**
 * Vertrieb › Pipeline (Leo 09.11.2026): alle aktiven Häuser nach Stufe.
 * Oben die Liste (Häuser oder eine Kampagne), dann Suche, Gebiet und
 * Liste/Tafel, darunter die Stufen-Kacheln (zählen Suche + Gebiet mit).
 * Die Kampagnen (Schulen, Messe, Firmen & GV) laufen unverändert über die
 * bestehende KampagneAnsicht.
 *
 * Filter in der URL (§10): ?liste, ?stufe, ?gebiet, ?hq (Suche), ?ansicht.
 * «q», «status», «gruppe», «k» gehören der KampagneAnsicht — darum hier
 * eigene Namen.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { usePrompt } from "@/components/ui/use-prompt";
import { Karte, TON_KLASSEN } from "@/components/dashboard/karte";
import { KampagneAnsicht } from "@/components/vertrieb/kampagne-ansicht";
import { HAUS_SPALTEN } from "@/components/vertrieb/use-vertrieb-daten";
import { usePermissions } from "@/lib/use-permissions";
import { datumKurz, faelligkeit } from "@/lib/vertrieb-datum";
import { TOAST } from "@/lib/messages";
import {
  GEBIET_FILTER,
  STUFEN,
  TAFEL_SPALTEN,
  filtereHaeuser,
  istGebietFilter,
  istStufeFilter,
  sortiereHaeuser,
  stufeInfo,
  zaehleStufen,
  type GebietFilter,
  type StufeFilter,
} from "@/lib/vertrieb/haeuser";
import type { VertriebKampagne, VertriebRaum } from "@/types/vertrieb";

const TAFEL_RECHERCHE_MAX = 4;
const RASTER = "grid grid-cols-[34px_minmax(0,2.3fr)_minmax(0,1.3fr)_124px_minmax(0,2.4fr)_96px_16px] items-center gap-3";

interface Props {
  haeuser: VertriebRaum[] | null;
  kampagnen: VertriebKampagne[];
  liste: string;
  onListe: (liste: string) => void;
  onHaus: (id: string) => void;
  onAngelegt: (h: VertriebRaum) => void;
}

export function PipelineAnsicht({ haeuser, kampagnen, liste, onListe, onHaus, onAngelegt }: Props) {
  const kampagne = kampagnen.find((k) => k.id === liste) ?? null;
  const listen = [{ key: "haeuser", label: "Häuser" }, ...kampagnen.map((k) => ({ key: k.id, label: k.name }))];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Liste">
        {listen.map((l) => (
          <button key={l.key} type="button" onClick={() => onListe(l.key)}
                  className={cn("kasten", (liste === l.key || (l.key === "haeuser" && !kampagne)) ? "kasten-active" : "kasten-toggle-off")}>
            {l.label}
          </button>
        ))}
      </div>
      {kampagne ? <KampagneAnsicht key={kampagne.id} kampagne={kampagne} /> : (
        <HaeuserPipeline haeuser={haeuser} onHaus={onHaus} onAngelegt={onAngelegt} />
      )}
    </div>
  );
}

function HaeuserPipeline({ haeuser, onHaus, onAngelegt }: Pick<Props, "haeuser" | "onHaus" | "onAngelegt">) {
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const { prompt, PromptModalElement } = usePrompt();
  const [stufe, setStufe] = useState<StufeFilter>(() => {
    const s = searchParams.get("stufe");
    return istStufeFilter(s) ? s : "alle";
  });
  const [gebiet, setGebiet] = useState<GebietFilter>(() => {
    const g = searchParams.get("gebiet");
    return istGebietFilter(g) ? g : "alle";
  });
  const [suche, setSuche] = useState(() => searchParams.get("hq") ?? "");
  const [ansicht, setAnsicht] = useState<"liste" | "tafel">(() => (searchParams.get("ansicht") === "tafel" ? "tafel" : "liste"));
  const [legtAn, setLegtAn] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const setze = (k: string, v: string | null) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    setze("stufe", stufe === "alle" ? null : stufe);
    setze("gebiet", gebiet === "alle" ? null : gebiet);
    setze("hq", suche.trim() || null);
    setze("ansicht", ansicht === "tafel" ? "tafel" : null);
    window.history.replaceState({}, "", url.toString());
  }, [stufe, gebiet, suche, ansicht]);

  const gefiltert = useMemo(() => filtereHaeuser(haeuser ?? [], gebiet, suche), [haeuser, gebiet, suche]);
  const zahlen = useMemo(() => zaehleStufen(gefiltert), [gefiltert]);
  const sichtbar = useMemo(
    () => sortiereHaeuser(stufe === "alle" ? gefiltert : gefiltert.filter((h) => h.stufe === stufe)),
    [gefiltert, stufe],
  );

  async function anlegen() {
    const name = await prompt({
      title: "Neues Haus",
      label: "Name des Hauses",
      placeholder: "z. B. Volkshaus Basel",
      confirmLabel: "Anlegen",
      variant: "blue",
      maxLength: 120,
    });
    if (!name?.trim()) return;
    setLegtAn(true);
    const { data, error } = await createClient()
      .from("vertrieb_raeume").insert({ name: name.trim(), stufe: "recherche" }).select(HAUS_SPALTEN).single();
    setLegtAn(false);
    if (error || !data) { TOAST.createError(error?.message); return; }
    onAngelegt(data as unknown as VertriebRaum);
  }

  const kacheln: { key: StufeFilter; label: string }[] = [{ key: "alle", label: "Alle aktiven" }, ...STUFEN];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">Haus oder Ort suchen</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Haus, Ort oder Gruppe suchen …" className="h-10 pl-9" />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Gebiet">
          {GEBIET_FILTER.map((g) => (
            <button key={g.key} type="button" onClick={() => setGebiet(g.key)}
                    className={cn("kasten", gebiet === g.key ? "kasten-active" : "kasten-toggle-off")}>{g.label}</button>
          ))}
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Ansicht">
          {(["liste", "tafel"] as const).map((a) => (
            <button key={a} type="button" onClick={() => setAnsicht(a)}
                    className={cn("kasten", ansicht === a ? "kasten-active" : "kasten-toggle-off")}>{a === "liste" ? "Liste" : "Tafel"}</button>
          ))}
        </div>
        {can("vertrieb:create") && (
          <button type="button" onClick={() => void anlegen()} disabled={legtAn} className="kasten kasten-blue">
            {legtAn ? <><Loader2 className="h-4 w-4 animate-spin" />Wird angelegt…</> : <><Plus className="h-4 w-4" />Neues Haus</>}
          </button>
        )}
      </div>

      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))" }}>
        {kacheln.map((k) => {
          const aktiv = stufe === k.key;
          const n = zahlen[k.key] ?? 0;
          return (
            <button key={k.key} type="button" onClick={() => setStufe(aktiv && k.key !== "alle" ? "alle" : k.key)}
                    className={cn("kasten flex-col !items-start gap-1 px-3.5 py-3 text-left", aktiv ? "kasten-active" : n === 0 ? "kasten-toggle-off opacity-60" : "kasten-toggle-off")}>
              <span className={cn("font-heading text-2xl font-bold leading-none tabular-nums",
                                  !aktiv && k.key === "angeschrieben" && n > 0 && "text-red-700 dark:text-red-300")}>
                {haeuser ? n : "–"}
              </span>
              <span className="text-xs font-semibold">{k.label}</span>
            </button>
          );
        })}
      </div>

      {!haeuser ? (
        <Skeleton className="h-[360px] rounded-xl" />
      ) : ansicht === "liste" ? (
        <Karte titel={`${stufe === "alle" ? "Alle aktiven Häuser" : stufeInfo(stufe).label} · ${sichtbar.length}`} icon={Building2}
               rechts={<span className="text-sm text-muted-foreground">Weiteste Stufe zuerst</span>}>
          {sichtbar.length === 0 ? (
            <EmptyState icon={Building2} title="Kein Haus gefunden" description="Kein Haus passt zu Stufe, Gebiet und Suche." />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[820px]">
                <div className={cn(RASTER, "px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground")}>
                  <span>Prio</span><span>Haus</span><span>Ort · Gebiet</span><span>Stufe</span><span>Nächster Schritt</span><span>Fällig</span><span />
                </div>
                <div className="flex flex-col divide-y border-t">
                  {sichtbar.map((h) => (
                    <button key={h.id} type="button" onClick={() => onHaus(h.id)} className={cn(RASTER, "row-hover px-2 py-3 text-left text-sm")}>
                      <Prio prio={h.prio} />
                      <span className="min-w-0">
                        <b className="block truncate font-semibold">{h.name}</b>
                        {h.gruppe && <span className="block truncate text-xs text-muted-foreground">{h.gruppe}</span>}
                      </span>
                      <span className="min-w-0 truncate">{h.ort ?? "—"}<span className="text-muted-foreground"> · {h.gebiet ?? "—"}</span></span>
                      <span><StufePille stufe={h.stufe} /></span>
                      <span className="min-w-0 truncate text-foreground/80">{h.aufgabe ?? "—"}</span>
                      <span><Faellig datum={h.datum} /></span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Karte>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[1180px] grid-cols-6 items-start gap-3">
            {TAFEL_SPALTEN.map((s) => {
              const alle = sortiereHaeuser(gefiltert.filter((h) => s.stufen.includes(h.stufe)));
              const zeige = s.key === "recherche" ? alle.slice(0, TAFEL_RECHERCHE_MAX) : alle;
              return (
                <div key={s.key} className="flex flex-col gap-2 rounded-xl bg-foreground/[0.04] p-2.5 dark:bg-foreground/[0.08]">
                  <div className="flex items-center justify-between px-1.5 pb-1 pt-1">
                    <span className="flex items-center gap-2 text-[13px] font-bold">
                      <span className={cn("h-2 w-2 rounded-full", stufeInfo(s.stufen[0]).farbe)} />{s.label}
                    </span>
                    <span className="rounded-full bg-card px-2 text-[11px] font-bold text-muted-foreground">{alle.length}</span>
                  </div>
                  {zeige.map((h) => (
                    <button key={h.id} type="button" onClick={() => onHaus(h.id)}
                            className="card-hover flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-left text-[13px]">
                      <span className="flex items-start justify-between gap-2">
                        <b className="text-sm leading-snug">{h.name}</b>
                        <Prio prio={h.prio} />
                      </span>
                      <span className="text-xs text-muted-foreground">{h.ort ?? "—"} · {h.gebiet ?? "—"}</span>
                      {h.aufgabe && <span className="text-foreground/80">{h.aufgabe}</span>}
                      {h.datum && <span className="flex justify-end"><Faellig datum={h.datum} /></span>}
                    </button>
                  ))}
                  {alle.length > zeige.length && (
                    <button type="button" onClick={() => setStufe("recherche")} className="px-1.5 text-left text-xs text-muted-foreground">
                      + {alle.length - zeige.length} weitere in Recherche
                    </button>
                  )}
                  {alle.length === 0 && (
                    <div className="rounded-xl border-2 border-dashed px-2.5 py-4 text-center text-xs text-muted-foreground">Noch leer</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Pausierte und abgesagte Häuser sind ausgeblendet und nicht gezählt; sie bleiben über die Suche im Profil erreichbar.
      </p>
      {PromptModalElement}
    </div>
  );
}

function Prio({ prio }: { prio: "A" | "B" }) {
  return (
    <span className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold",
                        prio === "A" ? "bg-foreground text-background" : TON_KLASSEN.neutral)}
          data-tooltip={prio === "A" ? "Priorität A" : "Priorität B"}>
      {prio}
    </span>
  );
}

export function StufePille({ stufe }: { stufe: VertriebRaum["stufe"] }) {
  const s = stufeInfo(stufe);
  return <span className={cn("whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN[s.ton])}>{s.label}</span>;
}

function Faellig({ datum }: { datum: string | null }) {
  if (!datum) return <span className="text-muted-foreground/60">–</span>;
  const f = faelligkeit(datum);
  const ton = f === "ueberfaellig" ? "rot" : f === "heute" ? "amber" : "neutral";
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", TON_KLASSEN[ton])}>
      {f === "heute" ? "Heute" : datumKurz(datum)}
    </span>
  );
}
