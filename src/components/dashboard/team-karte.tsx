"use client";

// Bereich «Team» / «Mein Team»: wer gerade eingestempelt ist und wer heute
// fehlt — je eine Zeile. Alle anderen nur als Kuerzel unter «Nicht
// eingestempelt», damit die Karte auch bei vielen Leuten ruhig bleibt.

import Link from "next/link";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/ui/person-avatar";
import type { TeamDaten, TeamMemberStatus } from "@/components/dashboard/typen";
import { Karte, TON_KLASSEN } from "@/components/dashboard/karte";
import { abwesendBis, uhrzeit } from "@/components/dashboard/format";

/** Anzeige der Abwesenheits-Typen (time_off.type). */
const ABWESENHEIT_LABEL: Record<string, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

/** Mehr Kuerzel passen nicht ruhig in eine Zeile — der Rest als «+N». */
const MAX_KUERZEL = 10;

export function TeamKarte({ daten }: { daten: TeamDaten }) {
  const eingestempelt = daten.personen.filter((p) => p.status === "eingestempelt");
  const abwesend = daten.personen.filter((p) => p.status === "abwesend");
  const rest = daten.personen.filter((p) => p.status === "offline");
  const zeilen = [...eingestempelt, ...abwesend];
  const sichtbarerRest = rest.slice(0, MAX_KUERZEL);
  const weitere = rest.slice(MAX_KUERZEL);

  return (
    <Karte
      titel={daten.sicht === "team" ? "Mein Team" : "Team"}
      icon={Users}
      rechts={
        <span className="text-xs text-muted-foreground tabular-nums">
          {eingestempelt.length} eingestempelt · {abwesend.length} abwesend
        </span>
      }
    >
      {daten.personen.length === 0 ? (
        <p className="text-[13px] text-foreground/75">
          {daten.sicht === "team" ? "Deinem Team ist noch niemand zugeteilt." : "Noch keine Mitarbeitenden erfasst."}
        </p>
      ) : (
        <>
          {/* flex-1: die Liste waechst mit der Reihenhoehe, die Fusszeile
              «Nicht eingestempelt» bleibt unten. */}
          <div className="flex flex-1 flex-col gap-3.5">
            {eingestempelt.length === 0 && (
              <p className="text-[13px] text-foreground/75">Gerade ist niemand eingestempelt.</p>
            )}
            {zeilen.length > 0 && (
              <div className="flex flex-col divide-y">
                {zeilen.map((p) => (
                  <TeamZeile key={p.id} person={p} />
                ))}
              </div>
            )}
          </div>
          {rest.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t pt-3">
              <span className="text-xs text-muted-foreground">Nicht eingestempelt</span>
              <span className="flex items-center">
                {sichtbarerRest.map((p, i) => (
                  // Opaker Ring in Kartenfarbe trennt die ueberlappenden Kuerzel.
                  <span key={p.id} className={cn("rounded-full bg-card ring-2 ring-card", i > 0 && "-ml-[7px]")}>
                    <PersonAvatar name={p.full_name} size="md" />
                  </span>
                ))}
                {weitere.length > 0 && (
                  <span
                    className="-ml-[7px] rounded-full bg-card ring-2 ring-card"
                    data-tooltip={weitere.map((p) => p.full_name).join(", ")}
                    aria-label={`${weitere.length} weitere`}
                  >
                    <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-[10px] font-bold text-foreground/80 tabular-nums dark:bg-foreground/15">
                      +{weitere.length}
                    </span>
                  </span>
                )}
              </span>
            </div>
          )}
        </>
      )}
    </Karte>
  );
}

function TeamZeile({ person: p }: { person: TeamMemberStatus }) {
  const drin = p.status === "eingestempelt";
  const text = drin
    ? `seit ${p.clock_in ? uhrzeit(p.clock_in) : "–"}${p.context_label ? ` · ${p.context_label}` : ""}`
    : abwesendBis(p.abwesend_bis);
  const status = drin ? "Eingestempelt" : ABWESENHEIT_LABEL[p.abwesenheit_typ ?? ""] ?? "Abwesend";
  return (
    <Link href={`/stempelzeiten?user=${p.id}&from=dashboard`} className="row-hover flex items-center gap-3 px-0.5 py-2">
      <span className="relative shrink-0">
        {/* Name steht daneben — kein Tooltip am Kuerzel. */}
        <PersonAvatar name={p.full_name} size="md" tooltip="" />
        <span
          className={cn(
            "absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full border-2 border-card",
            drin ? "bg-emerald-500" : "bg-amber-500",
          )}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-sm">{p.full_name}</span>
        {text && <span className="truncate text-xs text-muted-foreground">{text}</span>}
      </span>
      <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", TON_KLASSEN[drin ? "gruen" : "amber"])}>
        {status}
      </span>
    </Link>
  );
}
