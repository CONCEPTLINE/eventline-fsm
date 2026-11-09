"use client";

/**
 * Vertrieb › Auswertung (Leo 09.11.2026) — einmal pro Woche ansehen, nicht
 * täglich: vier Kennzahlen, Prüftermine des Plans bis Dezember 2027,
 * Erstmails an Häuser pro Woche (Obergrenze 10), Häuser nach Gebiet und
 * der Rücklauf der Kampagnen (gleiche Zahlen wie der Büro-Bildschirm).
 */

import { BarChart3, Flag, MapPin, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Karte, TON_KLASSEN, type Ton } from "@/components/dashboard/karte";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import {
  MAILS_PRO_WOCHE_MAX,
  PRUEFTERMINE,
  ZIEL_AUFTRAEGE_2027,
  erstmailsProWoche,
  isoWoche,
  istAngeschrieben,
  stufeInfo,
  tageZwischen,
  verteilungNachGebiet,
  wochenMontag,
} from "@/lib/vertrieb/haeuser";
import type { BildschirmVertrieb } from "@/lib/bildschirm-typen";
import type { VertriebRaum, WochenpaketMail } from "@/types/vertrieb";
import type { MailEintrag } from "@/components/vertrieb/use-vertrieb-daten";

/** Wochen im Takt-Diagramm: eine zurück, die laufende, sechs voraus. */
const WOCHEN = 8;

interface Props {
  haeuser: VertriebRaum[] | null;
  mails: MailEintrag[];
  pakete: WochenpaketMail[];
  uebersicht: BildschirmVertrieb | null;
}

function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}

export function AuswertungAnsicht({ haeuser, mails, pakete, uebersicht }: Props) {
  if (!haeuser) return <Skeleton className="h-[520px] rounded-xl" />;
  const heute = todayLocalIso();

  const angeschrieben = haeuser.filter(istAngeschrieben).length;
  const gespraech = haeuser.filter((h) => stufeInfo(h.stufe).rang >= stufeInfo("gespraech").rang).length;
  const partner = haeuser.filter((h) => h.stufe === "partner").length;
  const naechsterTermin = PRUEFTERMINE.find((p) => p.datum >= heute);
  const kennzahlen = [
    { label: "Partnerhäuser", n: String(partner), ziel: naechsterTermin ? `Nächste Prüfung: ${naechsterTermin.titel}` : "Plan abgeschlossen" },
    { label: "Im Gespräch", n: String(gespraech), ziel: "Termin, Pilot oder Partner" },
    { label: "Angeschrieben", n: String(angeschrieben), ziel: `bis ${MAILS_PRO_WOCHE_MAX} Häuser pro Woche`, rot: true },
    // Aufträge haben (noch) kein Feld «über welches Haus» — darum keine Zahl.
    { label: "Aufträge über neue Häuser", n: "–", ziel: `Ziel 2027: ${ZIEL_AUFTRAEGE_2027} · Zählung folgt` },
  ];

  // Takt: Erstmails je Woche; die laufende Woche zeigt zusätzlich, was im
  // Wochenpaket noch offen, freigegeben oder eingeplant ist (heller Teil).
  const start = plusTage(wochenMontag(heute), -7);
  const wochen = erstmailsProWoche(mails, start, WOCHEN);
  const laufendeKw = `KW${isoWoche(heute).woche}`;
  const imPaket = pakete.filter((p) => p.kw === laufendeKw && p.status !== "gestrichen").length;
  const montagHeute = wochenMontag(heute);

  const ende = PRUEFTERMINE[PRUEFTERMINE.length - 1].datum;
  const spanne = Math.max(1, tageZwischen(heute, ende));
  const termine = [{ titel: "Heute", datum: heute, heute: true, hart: false }, ...PRUEFTERMINE.filter((p) => p.datum >= heute).map((p) => ({ ...p, heute: false, hart: !!p.hart }))];

  const gebiete = verteilungNachGebiet(haeuser);
  const gebietMax = Math.max(1, ...gebiete.map((g) => g.gesamt));

  const hausZeile = { name: "Häuser", kontakte: haeuser.filter((h) => h.stufe !== "pause").length, raus: angeschrieben, antw: null as number | null, hinweis: "Antworten zählt der Verlauf je Haus" };
  const kampagnen = (uebersicht?.kampagnen ?? []).map((k) => ({ name: k.name, kontakte: k.kontakte, raus: k.angeschrieben, antw: k.antworten, hinweis: "" }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {kennzahlen.map((k) => (
          <section key={k.label} className="rounded-xl border bg-card p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{k.label}</div>
            <div className={cn("mt-2 font-heading text-4xl font-bold leading-tight tabular-nums", k.rot && "text-red-700 dark:text-red-300")}>{k.n}</div>
            <div className="mt-1 text-xs text-muted-foreground">{k.ziel}</div>
          </section>
        ))}
      </div>

      <Karte titel="Prüftermine bis Dezember 2027" icon={Flag} rechts={<span className="text-sm text-muted-foreground">Plan bis Dezember 2027</span>}>
        <div className="overflow-x-auto">
          <div className="relative h-[116px] min-w-[760px]">
            <div className="absolute inset-x-0 top-[40px] h-1 rounded-full bg-foreground/10 dark:bg-foreground/15" />
            {termine.map((t) => {
              const links = (tageZwischen(heute, t.datum) / spanne) * 90;
              return (
                <div key={t.titel} className="absolute top-0 flex flex-col items-start" style={{ left: `${links}%` }}>
                  <span className={cn("mb-1.5 rounded-full px-2 py-px text-[11px] font-bold", t.heute ? "bg-red-600 text-white" : TON_KLASSEN.neutral)}>
                    {t.heute ? "jetzt" : `in ${tageZwischen(heute, t.datum)} T.`}
                  </span>
                  <span className={cn("mt-0.5 h-3.5 w-3.5 rounded-full",
                    t.heute ? "bg-red-600" : t.hart ? "bg-foreground" : "border-[3px] border-foreground bg-card")} />
                  <b className="mt-2 whitespace-nowrap text-[13px]">{t.titel}</b>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{datumLang(t.datum)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </Karte>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Karte titel="Häuser angeschrieben pro Woche" icon={BarChart3}
               rechts={<span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="inline-block w-3.5 border-t-2 border-dashed border-red-500" />Obergrenze {MAILS_PRO_WOCHE_MAX}</span>}>
          <div className="relative mt-1 grid h-[180px] items-end gap-2.5 border-b" style={{ gridTemplateColumns: `repeat(${WOCHEN}, minmax(0, 1fr))` }}>
            <div className="absolute inset-x-0 top-0 border-t-2 border-dashed border-red-500/50" />
            {wochen.map((w) => {
              const extra = w.montag === montagHeute ? imPaket : 0;
              const gesamt = Math.min(MAILS_PRO_WOCHE_MAX, w.anzahl + extra);
              return (
                <div key={w.montag} className="flex h-full flex-col items-center justify-end">
                  <span className="mb-1 text-xs font-bold tabular-nums">{w.anzahl + extra || ""}</span>
                  <span className="flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t-md" style={{ height: `${Math.max(3, (gesamt / MAILS_PRO_WOCHE_MAX) * 150)}px` }}>
                    {gesamt === 0 ? <span className="h-full bg-foreground/10 dark:bg-foreground/15" /> : <>
                      <span className="bg-red-600 dark:bg-red-500" style={{ height: `${(w.anzahl / gesamt) * 100}%` }} />
                      <span className="bg-red-600/30 dark:bg-red-500/35" style={{ height: `${(extra / gesamt) * 100}%` }} />
                    </>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${WOCHEN}, minmax(0, 1fr))` }}>
            {wochen.map((w) => (
              <span key={w.montag} className={cn("text-center text-[11px]", w.montag === montagHeute ? "font-bold" : "text-muted-foreground")}>KW {w.kw}</span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Gezählt wird je Haus nur die erste Mail. Heller Teil: Wochenpaket der laufenden Woche, noch nicht gesendet.</p>
        </Karte>

        <Karte titel="Häuser nach Gebiet" icon={MapPin}>
          <div className="flex flex-col gap-3.5">
            {gebiete.map((g) => (
              <div key={g.label}>
                <div className="flex justify-between text-[13px]">
                  <b>{g.label}</b>
                  <span className="text-muted-foreground">{g.gesamt} Häuser · {g.angeschrieben} angeschrieben</span>
                </div>
                <div className="mt-1.5 flex h-3 overflow-hidden rounded-full bg-foreground/[0.06] dark:bg-foreground/[0.12]">
                  <span className="bg-red-600 dark:bg-red-500" style={{ width: `${(g.angeschrieben / gebietMax) * 100}%` }} />
                  <span className="bg-foreground/70" style={{ width: `${(g.vorbereitet / gebietMax) * 100}%` }} />
                  <span className="bg-foreground/25" style={{ width: `${(g.recherche / gebietMax) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
            <Legende klasse="bg-red-600 dark:bg-red-500" text="Angeschrieben oder weiter" />
            <Legende klasse="bg-foreground/70" text="Vorbereitet (Bedarf, Anruf)" />
            <Legende klasse="bg-foreground/25" text="Recherche" />
          </div>
          <p className="text-xs text-muted-foreground">Fricktal erst nach G1, Oberbaselbiet erst nach G2.</p>
        </Karte>
      </div>

      <Karte titel="Kampagnen · Rücklauf" icon={Megaphone}>
        <div className="overflow-x-auto">
          <div className="min-w-[520px]">
            <div className="grid grid-cols-[minmax(0,1.4fr)_80px_80px_80px_80px] gap-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <span /><span className="text-right">Kontakte</span><span className="text-right">Raus</span><span className="text-right">Antw.</span><span className="text-right">Quote</span>
            </div>
            <div className="flex flex-col divide-y border-t">
              {[hausZeile, ...kampagnen].map((c) => {
                const ton: Ton = c.antw === null || c.raus === 0 ? "neutral" : c.antw / c.raus >= 0.2 ? "gruen" : "amber";
                return (
                  <div key={c.name} className="grid grid-cols-[minmax(0,1.4fr)_80px_80px_80px_80px] items-center gap-2.5 py-2.5 tabular-nums">
                    <span className="min-w-0">
                      <b className="block truncate">{c.name}</b>
                      {c.hinweis && <span className="block truncate text-xs text-muted-foreground">{c.hinweis}</span>}
                    </span>
                    <span className="text-right">{c.kontakte}</span>
                    <span className="text-right">{c.raus}</span>
                    <span className="text-right">{c.antw ?? "–"}</span>
                    <span className="text-right">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TON_KLASSEN[ton])}>{c.antw === null ? "–" : prozent(c.antw, c.raus)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Antworten = Kontakte mit mindestens einer Antwort (gleiche Zahl wie der Büro-Bildschirm).</p>
      </Karte>
    </div>
  );
}

function Legende({ klasse, text }: { klasse: string; text: string }) {
  return <span className="flex items-center gap-1.5"><span className={cn("inline-block h-2.5 w-2.5 rounded-[3px]", klasse)} />{text}</span>;
}

/** «4.12.2026» — Date-Only, Mittag UTC: kein Tag kippt (§4). */
function datumLang(datum: string): string {
  const [y, m, d] = datum.split("-").map(Number);
  return new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "numeric", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
