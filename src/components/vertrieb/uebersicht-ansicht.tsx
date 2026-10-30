"use client";

/**
 * Vertrieb › Übersicht (Leo 2026-10-30): der Grundsatz-Überblick über alle
 * Kampagnen — dieselben Inhalte und dieselbe Aufteilung wie die Vertriebs-
 * Ansicht des Büro-Bildschirms (docs/bildschirm/DESIGN-REGELN.md), aber in
 * den Karten des App-Dashboards (hell/dunkel) und anklickbar: Kampagnen und
 * offene Gespräche öffnen den Kampagnen-Tab bzw. den Kontakt.
 * Daten: /api/vertrieb/uebersicht (src/lib/vertrieb/uebersicht.ts — gleiche
 * Berechnung wie der Bildschirm). Wer: vertrieb:view. Laptop-Seite.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Bell, ChevronRight, History, Megaphone, MessagesSquare, PieChart } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Karte, RuheFlaeche, TON_KLASSEN, type Ton } from "@/components/dashboard/karte";
import { hochgezaehlt, useAuftakt } from "@/components/dashboard/use-auftakt";
import { plusTage } from "@/lib/swiss-time";
import type {
  BildschirmGespraech, BildschirmKampagne, BildschirmVertrieb, BildschirmVertriebArt,
} from "@/lib/bildschirm-typen";

const ZRH = "Europe/Zurich";
const NEU_LADEN_MS = 60_000;
const NAECHSTES_MAX = 4;
const ZULETZT_MAX = 6;
/** Ab so vielen Tagen ohne unsere Reaktion ist eine Antwort «dringend». */
const DRINGEND_TAGE = 2;

type Zahlen = Pick<BildschirmKampagne, "kontakte" | "geplant" | "angeschrieben" | "antworten" | "im_gespraech" | "kein_bedarf" | "unzustellbar">;

/** Segmente der Kreise (gleiche Bedeutung wie auf dem Bildschirm), im
 *  Uhrzeigersinn ab 12 Uhr; der leere Rest = noch nicht angeschrieben. */
const SEGMENTE: { key: string; label: string; farbe: string; wert: (z: Zahlen) => number }[] = [
  { key: "gespraech", label: "Im Gespräch", farbe: "#10b981", wert: (z) => z.im_gespraech },
  { key: "wartet", label: "Angeschrieben, wartet", farbe: "#3b82f6", wert: (z) => Math.max(0, z.angeschrieben - z.im_gespraech - z.kein_bedarf - z.unzustellbar) },
  { key: "kein", label: "Kein Bedarf", farbe: "#a1a1aa", wert: (z) => z.kein_bedarf },
  { key: "unz", label: "Unzustellbar", farbe: "#dc6b69", wert: (z) => z.unzustellbar },
  { key: "geplant", label: "Geplant", farbe: "#93c5fd", wert: (z) => z.geplant },
];

const STATUS_KURZ: Record<BildschirmGespraech["status"], { label: string; ton: Ton }> = {
  geantwortet: { label: "Antwort offen", ton: "amber" },
  anrufen: { label: "anrufen", ton: "amber" },
  termin: { label: "Termin", ton: "neutral" },
  offerte: { label: "Offerte", ton: "neutral" },
};

const ART: Record<BildschirmVertriebArt, { label: string; ton: Ton }> = {
  antwort: { label: "Antwort", ton: "gruen" },
  kein_bedarf: { label: "Kein Bedarf", ton: "neutral" },
  unzustellbar: { label: "Unzustellbar", ton: "neutral" },
  versand: { label: "Versendet", ton: "neutral" },
};

const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
function tagIso(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: ZRH });
}
function kurzDatum(tag: string): string {
  const [j, m, t] = tag.split("-").map(Number);
  const d = new Date(Date.UTC(j, m - 1, t));
  return `${WOCHENTAG[d.getUTCDay()]} ${t}.${m}.`;
}
function uhrzeit(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" });
}
function tageSeit(iso: string, heute: string): number {
  return Math.round((Date.parse(`${heute}T12:00:00Z`) - Date.parse(`${tagIso(iso)}T12:00:00Z`)) / 86_400_000);
}
function seitText(iso: string, heute: string): string {
  const n = tageSeit(iso, heute);
  if (n <= 0) return "heute";
  if (n === 1) return "gestern";
  if (n < 14) return `seit ${n} Tagen`;
  return `seit ${Math.round(n / 7)} Wo.`;
}
function wannText(tag: string, heute: string): string {
  if (tag === heute) return "heute";
  if (tag === plusTage(heute, 1)) return "morgen";
  if (tag === plusTage(heute, -1)) return "gestern";
  return kurzDatum(tag);
}
function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}
function summe(liste: BildschirmKampagne[]): Zahlen {
  const z: Zahlen = { kontakte: 0, geplant: 0, angeschrieben: 0, antworten: 0, im_gespraech: 0, kein_bedarf: 0, unzustellbar: 0 };
  for (const k of liste) for (const f of Object.keys(z) as (keyof Zahlen)[]) z[f] += k[f];
  return z;
}

/** Kreisdiagramm; `anteil` (0..1) zeichnet die Bögen beim Auftakt auf. */
function Kreis({ z, dicke, anteil, className, children }: { z: Zahlen; dicke: number; anteil: number; className?: string; children?: ReactNode }) {
  const R = 50 - dicke / 2 - 1;
  const U = 2 * Math.PI * R;
  const gesamt = Math.max(1, z.kontakte);
  const werte = SEGMENTE.map((s) => s.wert(z));
  const luecke = dicke > 8 ? 0.9 : 0.6;
  const boegen = SEGMENTE.map((s, i) => {
    const laenge = (werte[i] / gesamt) * U;
    const start = (werte.slice(0, i).reduce((x, y) => x + y, 0) / gesamt) * U;
    return { key: s.key, farbe: s.farbe, n: werte[i], start: start * anteil, laenge: Math.max(0.5, laenge - (laenge > luecke * 3 ? luecke : 0)) * anteil };
  }).filter((b) => b.n > 0);
  return (
    <div className={cn("relative aspect-square shrink-0", className)}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth={dicke} className="stroke-foreground/[0.07] dark:stroke-foreground/[0.12]" />
        {boegen.map((b) => (
          <circle
            key={b.key}
            cx="50" cy="50" r={R}
            fill="none"
            strokeWidth={dicke}
            stroke={b.farbe}
            strokeDasharray={`${b.laenge} ${U}`}
            strokeDashoffset={-b.start}
          />
        ))}
      </svg>
      {children && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>}
    </div>
  );
}

export function UebersichtAnsicht({ onOeffnen }: { onOeffnen: (kampagneId: string, kontaktId?: string) => void }) {
  const [v, setV] = useState<BildschirmVertrieb | null>(null);
  const [fehler, setFehler] = useState(false);
  const gemeldet = useRef(false);

  useEffect(() => {
    let aktiv = true;
    const laden = () =>
      fetch("/api/vertrieb/uebersicht", { cache: "no-store" })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok || !json?.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
          return json as BildschirmVertrieb;
        })
        .then((daten) => {
          if (!aktiv) return;
          setV(daten);
          setFehler(false);
          gemeldet.current = false;
        })
        .catch((e: unknown) => {
          if (!aktiv) return;
          setFehler(true);
          // Nur einmal melden, nicht bei jedem stillen Nachladen.
          if (!gemeldet.current) toast.error(`Übersicht laden fehlgeschlagen: ${e instanceof Error ? e.message : "Verbindung unterbrochen"}`);
          gemeldet.current = true;
        });
    void laden();
    const id = setInterval(() => void laden(), NEU_LADEN_MS);
    return () => {
      aktiv = false;
      clearInterval(id);
    };
  }, []);

  const { anteil, haken } = useAuftakt(v !== null, true);

  if (!v) {
    if (fehler) return <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Die Übersicht konnte nicht geladen werden.</div>;
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
        <div className="flex flex-col gap-4"><Skeleton className="h-[380px] rounded-xl" /><Skeleton className="h-[150px] rounded-xl" /></div>
        <div className="flex flex-col gap-4"><Skeleton className="h-[200px] rounded-xl" /><Skeleton className="h-[330px] rounded-xl" /></div>
      </div>
    );
  }

  const heute = tagIso(v.jetzt);
  const z = summe(v.kampagnen);
  const offen = Math.max(0, z.kontakte - z.angeschrieben - z.geplant);
  const punkte = [
    { key: "antworten", label: "Antworten warten auf uns", n: v.achtung.antworten_offen, ton: "rot" as Ton },
    { key: "anrufen", label: "Kontakte anrufen", n: v.achtung.anrufen, ton: "amber" as Ton },
    { key: "nachfassen", label: "Nachfassen fällig", n: v.achtung.nachfassen, ton: "amber" as Ton },
    { key: "unzustellbar", label: "Adressen unzustellbar", n: v.achtung.unzustellbar, ton: "neutral" as Ton },
  ].filter((x) => x.n > 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        {/* Gesamtbild */}
        <Karte titel="Stand aller Kampagnen" icon={PieChart} rechts={<span className="text-sm text-muted-foreground">{z.kontakte} Kontakte</span>}>
          <div className="flex flex-wrap items-center gap-x-10 gap-y-6 px-1 py-2">
            <Kreis z={z} dicke={11} anteil={anteil} className="mx-auto w-full max-w-[290px] sm:w-[290px]">
              <span className="font-heading text-6xl font-bold tabular-nums">{hochgezaehlt(z.angeschrieben, anteil)}</span>
              <span className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">von {z.kontakte} angeschrieben</span>
            </Kreis>
            <div className="flex min-w-[260px] flex-1 flex-col gap-5">
              <div className="grid grid-cols-3 gap-3">
                <Zahl n={String(hochgezaehlt(z.antworten, anteil))} label="Antworten" />
                <Zahl n={prozent(z.antworten, z.angeschrieben)} label="Rücklauf" gruen />
                <Zahl n={String(hochgezaehlt(z.im_gespraech, anteil))} label="im Gespräch" />
              </div>
              <div className="flex flex-col divide-y">
                {SEGMENTE.map((s) => {
                  const w = s.wert(z);
                  if (w === 0) return null;
                  return <Legende key={s.key} farbe={s.farbe} label={s.label} n={w} anteil={prozent(w, z.kontakte)} />;
                })}
                {offen > 0 && <Legende leise label="Noch nicht angeschrieben" n={offen} anteil={prozent(offen, z.kontakte)} />}
              </div>
              {v.naechstes.length > 0 && (
                <div className="flex flex-col">
                  <span className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Als Nächstes</span>
                  <div className="flex flex-col divide-y">
                    {v.naechstes.slice(0, NAECHSTES_MAX).map((s) => (
                      <div key={s.id} className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm">
                        <span className={cn("font-semibold tabular-nums", s.tag === heute && "text-amber-700 dark:text-amber-300")}>{wannText(s.tag, heute)}</span>
                        <span className="truncate font-semibold">
                          {s.art === "versand" ? `${s.anzahl} ${s.anzahl === 1 ? "Mail" : "Mails"} raus` : `${s.anzahl} nachfassen`}
                        </span>
                        <span className="truncate text-muted-foreground">{s.kampagne}{s.zeit ? ` · ${uhrzeit(s.zeit)}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Karte>

        {/* Kampagnen */}
        <Karte titel="Kampagnen" icon={Megaphone} rechts={<span className="text-sm text-muted-foreground">{v.kampagnen.length} laufend</span>}>
          {v.kampagnen.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine laufenden Kampagnen.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {v.kampagnen.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => onOeffnen(k.id)}
                  className="row-hover flex min-w-0 items-center gap-3.5 rounded-xl p-2.5 text-left"
                >
                  <Kreis z={k} dicke={14} anteil={anteil} className="w-[72px]">
                    <span className="text-xs font-bold tabular-nums">
                      {k.angeschrieben > 0 ? prozent(k.angeschrieben, k.kontakte) : k.geplant > 0 ? prozent(k.geplant, k.kontakte) : "0 %"}
                    </span>
                  </Kreis>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <b className="truncate font-semibold">{k.name}</b>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {k.angeschrieben > 0
                        ? `${k.angeschrieben} / ${k.kontakte} angeschrieben`
                        : k.geplant > 0
                          ? `${k.geplant} / ${k.kontakte} geplant`
                          : `${k.kontakte} Kontakte bereit`}
                    </span>
                    {k.angeschrieben > 0 && (
                      <span className="truncate text-[13px] text-muted-foreground">
                        <b className="font-semibold text-emerald-700 dark:text-emerald-300">{k.antworten} {k.antworten === 1 ? "Antwort" : "Antworten"}</b>
                        {" · "}{prozent(k.antworten, k.angeschrieben)}
                      </span>
                    )}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </Karte>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {/* Zuletzt im Vertrieb */}
        <Karte titel="Zuletzt im Vertrieb" icon={History} rechts={<span className="text-sm text-muted-foreground">{v.zuletzt.anzahl_7_tage} in 7 Tagen</span>}>
          {v.zuletzt.liste.length === 0 ? (
            <p className="text-sm text-muted-foreground">Seit 30 Tagen nichts Neues.</p>
          ) : (
            <div className="flex flex-col divide-y">
              {v.zuletzt.liste.slice(0, ZULETZT_MAX).map((e) => (
                <div key={e.id} className="grid grid-cols-[64px_auto_minmax(0,1fr)] items-center gap-3 py-2 text-sm">
                  <span className="tabular-nums text-muted-foreground">{e.tag === heute ? uhrzeit(e.zeit) : wannText(e.tag, heute)}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TON_KLASSEN[ART[e.art].ton])}>{ART[e.art].label}</span>
                  <span className="min-w-0 truncate">
                    <b className="font-semibold">{e.titel}</b>
                    <span className="text-muted-foreground"> · {e.kampagne}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Karte>

        {/* Offene Gespraeche */}
        <Karte titel="Offene Gespräche" icon={MessagesSquare} rechts={<span className="text-sm text-muted-foreground">{v.gespraeche.length} im Gespräch</span>}>
          {v.gespraeche.length === 0 ? (
            <p className="text-sm text-muted-foreground">Gerade keine offenen Gespräche.</p>
          ) : (
            <div className="flex flex-col divide-y">
              {v.gespraeche.map((g) => {
                const dringend = g.status === "geantwortet" && tageSeit(g.seit, heute) >= DRINGEND_TAGE;
                const st = STATUS_KURZ[g.status];
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => onOeffnen(g.kampagne_id, g.id)}
                    className="row-hover grid grid-cols-[minmax(0,1fr)_auto_auto_16px] items-center gap-3 px-0.5 py-2.5 text-left"
                  >
                    <span className="flex min-w-0 flex-col">
                      <b className="truncate font-semibold">{g.firma}</b>
                      <span className="truncate text-[13px] text-muted-foreground">{[g.kampagne, g.ort].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TON_KLASSEN[dringend ? "rot" : st.ton])}>{dringend ? "dringend" : st.label}</span>
                    <span className="w-[86px] text-right text-[13px] tabular-nums text-muted-foreground">{seitText(g.seit, heute)}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </button>
                );
              })}
            </div>
          )}
        </Karte>

        {/* Aufmerksamkeit */}
        <Karte titel="Braucht Aufmerksamkeit" icon={Bell} className="pb-3.5">
          {punkte.length === 0 ? (
            <RuheFlaeche titel="Alles erledigt" haken={haken} className="mb-1.5">
              Keine offenen Antworten, nichts zu anrufen, kein Nachfassen fällig.
            </RuheFlaeche>
          ) : (
            <div className="flex flex-col divide-y">
              {punkte.map((p) => (
                <div key={p.key} className="flex items-center gap-3 px-0.5 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-[15px]">{p.label}</span>
                  <span className={cn("min-w-[34px] shrink-0 rounded-full px-2.5 py-0.5 text-center font-heading text-sm font-bold tabular-nums", TON_KLASSEN[p.ton])}>
                    {hochgezaehlt(p.n, anteil)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Karte>
      </div>
    </div>
  );
}

function Zahl({ n, label, gruen }: { n: string; label: string; gruen?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={cn("font-heading text-3xl font-bold tabular-nums", gruen && "text-emerald-700 dark:text-emerald-300")}>{n}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
    </div>
  );
}

function Legende({ farbe, label, n, anteil, leise }: { farbe?: string; label: string; n: number; anteil: string; leise?: boolean }) {
  return (
    <div className={cn("grid grid-cols-[12px_minmax(0,1fr)_auto_52px] items-center gap-3 py-1.5 text-sm", leise && "text-muted-foreground")}>
      <i className={cn("block h-3 w-3 rounded-[3px]", leise && "bg-foreground/10")} style={farbe ? { background: farbe } : undefined} />
      <span className="truncate">{label}</span>
      <b className={cn("tabular-nums", leise ? "font-normal" : "font-bold")}>{n}</b>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{anteil}</span>
    </div>
  );
}
