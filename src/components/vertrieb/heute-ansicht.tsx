"use client";

/**
 * Vertrieb › Heute (Leo 09.11.2026): was heute zu tun ist — höchstens eine
 * kurze Liste, keine Diagramme.
 *   - Wochenpakete mit offenen Mails → Freigabe-Seite
 *   - Häuser, deren nächster Schritt heute oder überfällig ist → Profil
 *   - offene Antworten / Anrufe der Kampagnen → Kampagnen-Liste
 * Rechts: nächste Termine der Häuser und neue Antworten von Häusern.
 */

import { CalendarDays, ChevronRight, ListChecks, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Karte, RuheFlaeche, TON_KLASSEN, type Ton } from "@/components/dashboard/karte";
import { datumKurz } from "@/lib/vertrieb-datum";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { istAktiv } from "@/lib/vertrieb/haeuser";
import type { BildschirmVertrieb } from "@/lib/bildschirm-typen";
import type { VertriebRaum, WochenpaketMail } from "@/types/vertrieb";
import type { AntwortEintrag } from "@/components/vertrieb/use-vertrieb-daten";

const FAELLIG_MAX = 8;
const TERMINE_MAX = 8;
/** So weit voraus zeigt «Nächste Termine». */
const TERMINE_TAGE = 21;

interface Aufgabe {
  key: string;
  titel: string;
  detail: string;
  knopf: string;
  primaer?: boolean;
  onKlick: () => void;
}

interface Props {
  haeuser: VertriebRaum[] | null;
  pakete: WochenpaketMail[];
  antworten: AntwortEintrag[];
  uebersicht: BildschirmVertrieb | null;
  onHaus: (id: string) => void;
  onPaket: (kw: string) => void;
  onKampagne: (id: string, status?: string) => void;
}

export function HeuteAnsicht({ haeuser, pakete, antworten, uebersicht, onHaus, onPaket, onKampagne }: Props) {
  if (!haeuser) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
        <Skeleton className="h-[320px] rounded-xl" />
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    );
  }
  const heute = todayLocalIso();
  const hausName = new Map(haeuser.map((h) => [h.id, h.name]));
  const aufgaben: Aufgabe[] = [];

  // 1. Wochenpakete mit offenen Mails
  const proKw = new Map<string, WochenpaketMail[]>();
  for (const p of pakete) if (p.status === "offen") proKw.set(p.kw, [...(proKw.get(p.kw) ?? []), p]);
  for (const [kw, liste] of proKw) {
    const namen = liste.map((m) => (m.haus_id && hausName.get(m.haus_id)) || m.an).join(", ");
    aufgaben.push({
      key: `paket-${kw}`,
      titel: `Wochenpaket ${kw.replace("KW", "KW ")} freigeben`,
      detail: `${liste.length} ${liste.length === 1 ? "Mail" : "Mails"} · ${namen}`,
      knopf: "Ansehen",
      primaer: true,
      onKlick: () => onPaket(kw),
    });
  }

  // 2. Kampagnen: offene Antworten und Anrufe (Zahlen wie Büro-Bildschirm)
  if (uebersicht) {
    const proKampagne = (status: string) => {
      const z = new Map<string, { name: string; n: number }>();
      for (const g of uebersicht.gespraeche) {
        if (g.status !== status) continue;
        const alt = z.get(g.kampagne_id);
        z.set(g.kampagne_id, { name: g.kampagne, n: (alt?.n ?? 0) + 1 });
      }
      return [...z.entries()].sort((a, b) => b[1].n - a[1].n);
    };
    const a = uebersicht.achtung;
    if (a.antworten_offen > 0) {
      const k = proKampagne("geantwortet");
      aufgaben.push({
        key: "antworten",
        titel: `${a.antworten_offen} ${a.antworten_offen === 1 ? "Antwort wartet" : "Antworten warten"} auf dich`,
        detail: k.map(([, v]) => `${v.n} ${v.name}`).join(", ") || "Kampagnen",
        knopf: "Öffnen",
        onKlick: () => (k[0] ? onKampagne(k[0][0], "geantwortet") : undefined),
      });
    }
    if (a.anrufen > 0) {
      const k = proKampagne("anrufen");
      aufgaben.push({
        key: "anrufen",
        titel: `${a.anrufen} ${a.anrufen === 1 ? "Kontakt" : "Kontakte"} anrufen`,
        detail: k.map(([, v]) => `${v.n} ${v.name}`).join(", ") || "Kampagnen",
        knopf: "Liste",
        onKlick: () => (k[0] ? onKampagne(k[0][0], "anrufen") : undefined),
      });
    }
  }

  // 3. Häuser: nächster Schritt heute oder überfällig
  const faellig = haeuser
    .filter((h) => istAktiv(h) && h.datum && h.datum <= heute)
    .sort((x, y) => (x.datum ?? "").localeCompare(y.datum ?? "") || x.name.localeCompare(y.name, "de-CH"));
  for (const h of faellig.slice(0, FAELLIG_MAX)) {
    aufgaben.push({
      key: `haus-${h.id}`,
      titel: `${h.name}: ${h.aufgabe || "nächster Schritt"}`,
      detail: h.datum === heute ? "Heute fällig" : `Fällig seit ${datumKurz(h.datum!)}`,
      knopf: "Öffnen",
      onKlick: () => onHaus(h.id),
    });
  }
  const mehrFaellig = faellig.length - FAELLIG_MAX;

  const bis = plusTage(heute, TERMINE_TAGE);
  const termine = haeuser
    .filter((h) => istAktiv(h) && h.datum && h.datum > heute && h.datum <= bis)
    .sort((x, y) => (x.datum ?? "").localeCompare(y.datum ?? ""))
    .slice(0, TERMINE_MAX);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
      <Karte titel="Heute zu tun" icon={ListChecks}
             rechts={<span className="text-sm text-muted-foreground">{aufgaben.length === 0 ? "Alles erledigt" : `${aufgaben.length} offen`}</span>}>
        {aufgaben.length === 0 ? (
          <RuheFlaeche titel="Alles erledigt" haken>Kein Wochenpaket offen, nichts fällig, keine Antwort wartet.</RuheFlaeche>
        ) : (
          <div className="flex flex-col divide-y">
            {aufgaben.map((a, i) => (
              <div key={a.key} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3.5 py-3">
                <span className={cn("flex h-[30px] w-[30px] items-center justify-center rounded-lg text-[13px] font-bold tabular-nums",
                                    a.primaer ? TON_KLASSEN.rot : TON_KLASSEN.neutral)}>{i + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-bold">{a.titel}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{a.detail}</span>
                </span>
                <button type="button" onClick={a.onKlick} className={cn("kasten", a.primaer ? "kasten-blue" : "kasten-muted")}>
                  {a.knopf}
                </button>
              </div>
            ))}
            {mehrFaellig > 0 && (
              <p className="pt-2.5 text-[13px] text-muted-foreground">und {mehrFaellig} weitere fällige Häuser in der Pipeline</p>
            )}
          </div>
        )}
      </Karte>

      <div className="flex min-w-0 flex-col gap-4">
        <Karte titel="Nächste Termine" icon={CalendarDays}
               rechts={<span className="text-sm text-muted-foreground">{TERMINE_TAGE} Tage</span>}>
          {termine.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Termine in den nächsten {TERMINE_TAGE} Tagen.</p>
          ) : (
            <div className="flex flex-col divide-y">
              {termine.map((h) => (
                <button key={h.id} type="button" onClick={() => onHaus(h.id)}
                        className="row-hover grid grid-cols-[86px_minmax(0,1fr)_16px] items-center gap-3 py-2.5 text-left">
                  <span className={cn("rounded-full px-2 py-0.5 text-center text-xs font-semibold tabular-nums", TON_KLASSEN[ton(h.datum!, heute)])}>
                    {datumKurz(h.datum!)}
                  </span>
                  <span className="min-w-0">
                    <b className="block truncate font-semibold">{h.name}</b>
                    <span className="block truncate text-[13px] text-muted-foreground">{h.aufgabe || "Nächster Schritt"}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </Karte>

        <Karte titel="Antworten von Häusern" icon={Mail}
               rechts={<span className="text-sm text-muted-foreground">14 Tage</span>}>
          {antworten.length === 0 ? (
            <RuheFlaeche titel="Nichts offen" haken>Keine neue Antwort von einem Haus. Der Abgleich läuft um 08:00 und 14:00.</RuheFlaeche>
          ) : (
            <div className="flex flex-col divide-y">
              {antworten.map((a) => (
                <button key={a.id} type="button" onClick={() => onHaus(a.haus_id)}
                        className="row-hover grid grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 py-2.5 text-left">
                  <span className="min-w-0">
                    <b className="block truncate font-semibold">{hausName.get(a.haus_id) ?? "Haus"}</b>
                    <span className="block truncate text-[13px] text-muted-foreground">{a.titel}</span>
                  </span>
                  <span className="text-[13px] tabular-nums text-muted-foreground">{datumKurz(a.datum)}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </Karte>
      </div>
    </div>
  );
}

/** Termin innerhalb von 7 Tagen = amber, sonst neutral. */
function ton(datum: string, heute: string): Ton {
  return datum <= plusTage(heute, 7) ? "amber" : "neutral";
}
