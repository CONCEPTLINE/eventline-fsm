"use client";

// Bereich «Braucht Aufmerksamkeit»: nur was wirklich ansteht — eine Zeile je
// Thema mit Anzahl > 0. Zeilen, die die API fuer die Rolle nicht liefert
// (null = fehlendes Recht der Zielseite, z. B. Abwesenheits-Antraege ohne
// ferien:approve), gibt es hier gar nicht. Ist nichts offen, zeigt die Karte
// den Ruhe-Zustand mit gezeichnetem Haken. Ueberfaellige Auftraege listen die
// 5 aeltesten.

import { useState } from "react";
import Link from "next/link";
import {
  Banknote, Bell, ChevronRight, CircleAlert, Inbox, Plane, Receipt, Ticket,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AufmerksamkeitDaten } from "@/components/dashboard/typen";
import { Karte, RuheFlaeche, TON_KLASSEN, type Ton } from "@/components/dashboard/karte";
import { hochgezaehlt } from "@/components/dashboard/use-auftakt";
import { ueberfaelligSeit } from "@/components/dashboard/format";

// `ueberfaellig` ist null, wenn die Rolle die Zeile nicht sieht — der
// Eintrags-Typ gilt fuer die gelieferte Zeile.
type OverdueEintrag = NonNullable<AufmerksamkeitDaten["ueberfaellig"]>["eintraege"][number];

export interface AufmerksamkeitZeile {
  key: "ueberfaellig" | "partner" | "abwesenheit" | "abrechnen" | "belege" | "tickets";
  n: number;
  label: string;
  ton: Ton;
  icon: LucideIcon;
  href: string;
}

/** Gelieferte Zeilen mit Anzahl > 0, in fester Reihenfolge (dringendes
 *  zuerst). null-Zaehler (Recht fehlt) kommen nicht vor — auch nicht im
 *  Kopf-Satz, der diese Liste zaehlt. */
export function aufmerksamkeitZeilen(a: AufmerksamkeitDaten): AufmerksamkeitZeile[] {
  const defs: (Omit<AufmerksamkeitZeile, "label" | "n"> & { n: number | null; eins: string; mehr: string })[] = [
    { key: "ueberfaellig", n: a.ueberfaellig?.anzahl ?? null, eins: "Überfälliger Auftrag", mehr: "Überfällige Aufträge", ton: "rot", icon: CircleAlert, href: "/auftraege?segment=aktiv&from=dashboard" },
    { key: "partner", n: a.partner_anfragen, eins: "Partner-Anfrage", mehr: "Partner-Anfragen", ton: "amber", icon: Inbox, href: "/auftraege?segment=aktiv&from=dashboard" },
    { key: "abwesenheit", n: a.abwesenheits_antraege, eins: "Abwesenheits-Antrag", mehr: "Abwesenheits-Anträge", ton: "amber", icon: Plane, href: "/hr?tab=anfragen&from=dashboard" },
    { key: "abrechnen", n: a.nicht_abgerechnet, eins: "Auftrag nicht abgerechnet", mehr: "Aufträge nicht abgerechnet", ton: "neutral", icon: Banknote, href: "/abrechnung?from=dashboard" },
    { key: "belege", n: a.neue_belege, eins: "Neuer Beleg", mehr: "Neue Belege", ton: "neutral", icon: Receipt, href: "/abrechnung?from=dashboard" },
    { key: "tickets", n: a.offene_tickets, eins: "Offenes Ticket", mehr: "Offene Tickets", ton: "neutral", icon: Ticket, href: "/tickets?from=dashboard" },
  ];
  return defs
    .filter((d): d is typeof d & { n: number } => d.n != null && d.n > 0)
    .map(({ eins, mehr, ...d }) => ({ ...d, label: d.n === 1 ? eins : mehr }));
}

export function AufmerksamkeitKarte({
  daten,
  anteil,
  haken,
}: {
  daten: AufmerksamkeitDaten;
  /** Hochzaehl-Fortschritt (0..1, ease-out). */
  anteil: number;
  /** Ruhe-Haken gezeichnet. */
  haken: boolean;
}) {
  const zeilen = aufmerksamkeitZeilen(daten);
  return (
    <Karte titel="Braucht Aufmerksamkeit" icon={Bell} className="pb-3.5">
      {zeilen.length === 0 ? (
        // mb-1.5: gleicht das knappere pb-3.5 der Karte aus (gemacht fuer die Liste).
        <RuheFlaeche titel="Alles erledigt" haken={haken} className="mb-1.5">
          Keine überfälligen Aufträge, keine offenen Anfragen, keine neuen Belege.
        </RuheFlaeche>
      ) : (
        <div className="flex flex-col divide-y">
          {zeilen.map((z) => (
            <div key={z.key}>
              <Link href={z.href} className="row-hover flex items-center gap-3 px-0.5 py-2.5">
                <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]", TON_KLASSEN[z.ton])}>
                  <z.icon className="h-[17px] w-[17px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px]">{z.label}</span>
                <span
                  className={cn(
                    "min-w-[34px] shrink-0 rounded-full px-2.5 py-0.5 text-center font-heading text-sm font-bold tabular-nums",
                    TON_KLASSEN[z.ton],
                  )}
                >
                  {hochgezaehlt(z.n, anteil)}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
              {z.key === "ueberfaellig" && daten.ueberfaellig && daten.ueberfaellig.eintraege.length > 0 && (
                <div className="mb-2.5 ml-[46px] flex flex-col gap-1.5">
                  {daten.ueberfaellig.eintraege.map((e) => (
                    <UeberfaelligEintrag key={e.id} eintrag={e} />
                  ))}
                  {daten.ueberfaellig.anzahl > daten.ueberfaellig.eintraege.length && (
                    <span className="pl-3 text-xs text-muted-foreground">
                      +{daten.ueberfaellig.anzahl - daten.ueberfaellig.eintraege.length} weitere
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Karte>
  );
}

function UeberfaelligEintrag({ eintrag }: { eintrag: OverdueEintrag }) {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href={`/auftraege/${eintrag.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center justify-between gap-3 rounded-[9px] px-3 py-[7px] text-[13px] text-foreground/80"
      style={{
        // Hover state-driven (Projekt-Regel): Flaeche etwas kraeftiger.
        backgroundColor: `color-mix(in srgb, var(--foreground) ${hover ? 9 : 4.5}%, transparent)`,
        transition: "background-color 120ms",
      }}
    >
      <span className="min-w-0 truncate">
        {eintrag.job_number != null && (
          <>
            <b className="font-semibold text-foreground">INT-{eintrag.job_number}</b>
            {" · "}
          </>
        )}
        {eintrag.title}
      </span>
      <span className="shrink-0 font-semibold text-red-700 dark:text-red-300">{ueberfaelligSeit(eintrag.days_overdue)}</span>
    </Link>
  );
}
