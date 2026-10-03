"use client";

// Bereich «Als Naechstes»: die kommenden Auftraege der naechsten 7 Tage —
// dieselbe Quelle wie die Agenda des Buero-Bildschirms (offene Auftraege,
// Partner-Anfragen, datierte Entwuerfe). Je Zeile Tag-Kachel, Titel,
// Zeit · Ort und die Status-Pille mit Namen und Farben aus JOB_STATUS;
// ein laufender Auftrag traegt wie auf dem Buero-Bildschirm das Chip
// «laeuft» im Markenrot. Klick oeffnet den Auftrag bzw. Entwurf. Team-Leiter
// sehen nur Auftraege, in denen ihr Team eingeteilt ist. Die Zeilen nutzen
// die Breite: im schmalen Platz eine Spalte, steht die Karte allein in
// ihrer Reihe (z. B. bei Admins), mehrere nebeneinander (ZeilenRaster).

import Link from "next/link";
import { List, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { JOB_STATUS } from "@/lib/constants";
import { ENTITY_PREFIX } from "@/lib/nummern-format";
import { laeuftAmTag, todayLocalIso } from "@/lib/swiss-time";
import type { NaechsteDaten, NaechsterAuftrag } from "@/components/dashboard/typen";
import { FLAECHE, Karte, ZeilenRaster } from "@/components/dashboard/karte";
import { datumKachelTag, tagKurz, tagText, uhrzeit } from "@/components/dashboard/format";

export function NaechsteKarte({ daten }: { daten: NaechsteDaten }) {
  const heute = todayLocalIso();
  return (
    <Karte
      titel="Als Nächstes"
      icon={List}
      rechts={<span className="text-xs text-muted-foreground">nächste 7 Tage</span>}
      className="pb-3.5"
    >
      {daten.eintraege.length === 0 ? (
        <div className={cn("flex flex-1 items-center gap-3.5 rounded-xl p-4", FLAECHE)}>
          <Sun className="h-[22px] w-[22px] shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
          <span className="flex flex-col gap-0.5">
            <b className="text-[15px] font-semibold">Keine Aufträge in den nächsten 7 Tagen</b>
            <span className="text-[13px] text-foreground/75">Neue Aufträge erscheinen hier, sobald sie geplant sind.</span>
          </span>
        </div>
      ) : (
        <ZeilenRaster min={340} className="flex-1">
          {daten.eintraege.map((e) => (
            <NaechsteZeile key={e.id} e={e} heute={heute} />
          ))}
        </ZeilenRaster>
      )}
      {daten.weitere > 0 && (
        <span className="text-xs text-muted-foreground">+{daten.weitere} weitere</span>
      )}
    </Karte>
  );
}

/** Chip «laeuft» im Markenrot — Flaeche und Schrift aus dem Akzent-Token,
 *  wie «b-chip rot» auf dem Buero-Bildschirm; Dark bewusst kraeftiger. */
const LAEUFT_KLASSE = "bg-accent/[0.12] text-accent dark:bg-accent/[0.22] dark:text-red-300";

/** Status-Pille: Namen und Farben wie ueberall in der App (JOB_STATUS);
 *  laeuft der Auftrag heute (laeuftAmTag — dieselbe Regel wie die Agenda des
 *  Buero-Bildschirms), steht statt des Status das Chip «laeuft». */
function pille(e: NaechsterAuftrag, heute: string): { label: string; klasse: string } {
  if (e.typ === "entwurf") return { label: JOB_STATUS.entwurf.label, klasse: JOB_STATUS.entwurf.color };
  if (e.typ === "anfrage") return { label: JOB_STATUS.partner_anfrage.label, klasse: JOB_STATUS.partner_anfrage.color };
  if (laeuftAmTag(e.start, e.ende, heute)) return { label: "läuft", klasse: LAEUFT_KLASSE };
  return { label: JOB_STATUS.offen.label, klasse: JOB_STATUS.offen.color };
}

function NaechsteZeile({ e, heute }: { e: NaechsterAuftrag; heute: string }) {
  const k = datumKachelTag(e.start);
  const p = pille(e, heute);
  const nummer = e.nummer != null ? `${e.typ === "entwurf" ? "ENT" : ENTITY_PREFIX.job}-${e.nummer}` : null;
  // «Heute · 18:00 · Volkshaus Basel» — mehrtaegig mit «bis Mi 7.10.»,
  // frueher begonnen «seit Do 1.10.» (die Uhrzeit des Starttags ist dann
  // vorbei und entfaellt; ein heute beginnender Auftrag zeigt sie noch).
  let wann = tagText(e.start);
  if (e.ende !== e.start) wann += ` bis ${tagKurz(e.ende)}`;
  const zeile2 = [
    wann + (e.erster_termin && e.start >= heute ? ` · ${uhrzeit(e.erster_termin)}` : ""),
    e.ort ?? e.kunde,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      href={e.typ === "entwurf" ? `/entwuerfe/${e.id}` : `/auftraege/${e.id}`}
      className="row-hover flex items-center gap-3 px-0.5 py-2"
    >
      <span className={cn("flex w-[42px] shrink-0 flex-col items-center rounded-[9px] py-1", FLAECHE)}>
        <span
          className={cn(
            "text-[10px] font-bold tracking-[0.08em]",
            e.start === heute ? "text-accent" : "text-muted-foreground",
          )}
        >
          {k.wochentag}
        </span>
        <b className="font-heading text-base font-bold leading-[1.2] tabular-nums">{k.tag}</b>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-sm">
          {nummer && (
            <>
              <b className="font-semibold">{nummer}</b>
              {" · "}
            </>
          )}
          {e.titel}
        </span>
        <span className="truncate text-xs text-muted-foreground">{zeile2}</span>
      </span>
      <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", p.klasse)}>{p.label}</span>
    </Link>
  );
}
