"use client";

/**
 * Ausstempeln nach mehr als 16 Stunden (Lohn-Umbau Phase 4).
 *
 * Laeuft der eigene Stempel laenger als LANG_STUNDEN, fragt «Ausstempeln»
 * (Handy und Desktop — alle Knoepfe gehen ueber useStempel().clockOut, der
 * Provider zeigt diesen Dialog) zuerst nach der Endzeit (Datum + ZeitFeld,
 * Pflicht, nicht in der Zukunft, nach dem Beginn) und einer Begruendung
 * (Pflicht). Ausgestempelt wird dann mit dieser Endzeit und
 * time_entries.lang_begruendung — offline-fest ueber die Warteschlange.
 *
 * Liegt der Beginn in einem abgerechneten Monat, geht Ausstempeln nicht mehr:
 * der Dialog sagt das klar und fuehrt zum Ticket «Stempel-Änderung» (das Ende
 * setzt die Lohnverwaltung per Antrag).
 *
 * Bleibt immer gemountet (der Provider rendert ihn), damit das Ticket-Fenster
 * offen bleiben kann, nachdem die Frage beantwortet ist.
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import { Clock, Lock } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { useIsMobile } from "@/lib/use-is-mobile";
import { usePermissions } from "@/lib/use-permissions";
import { isoZuZuerich, LANG_STUNDEN, stempelTag, stempelZeit, zeitEingabeFehler, zuerichZuIso } from "@/lib/stempel-meldungen";
import type { TimeEntry } from "@/types";

// Ticket-Fenster erst laden, wenn es gebraucht wird (Provider haengt an jeder Seite).
const NewTicketModal = dynamic(
  () => import("@/components/tickets/new-ticket-modal").then((m) => m.NewTicketModal),
  { ssr: false },
);

export interface AusstempelnAntwort {
  /** Endzeit (UTC-ISO). */
  endzeit: string;
  /** Begruendung → time_entries.lang_begruendung. */
  begruendung: string;
}

export interface AusstempelnFrage {
  eintrag: TimeEntry;
  /** Beginn liegt in einem abgerechneten Monat. */
  gesperrt: boolean;
  /** Ausstempeln aus der Warteschlange (vor Phase 4 ohne Endzeit eingereiht):
   *  Zeitpunkt der Aktion — die Endzeit darf nicht spaeter liegen. */
  spaetestens?: string | null;
}

function dauerText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} h`;
}

const WOCHENTAG = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short" });

interface Props {
  frage: AusstempelnFrage | null;
  onAntwort: (a: AusstempelnAntwort | null) => void;
}

export function LangAusstempelnDialog({ frage, onAntwort }: Props) {
  const isMobile = useIsMobile();
  const { can } = usePermissions();
  const [ticketFuer, setTicketFuer] = useState<TimeEntry | null>(null);

  return (
    <>
      {frage && !frage.gesperrt && (
        <EndzeitFrage
          key={frage.eintrag.id}
          eintrag={frage.eintrag}
          spaetestens={frage.spaetestens ?? null}
          sheet={isMobile === true}
          onAntwort={onAntwort}
        />
      )}
      {frage && frage.gesperrt && (
        <Modal
          open
          onClose={() => onAntwort(null)}
          sheet={isMobile === true}
          size="md"
          title="Stempel im abgerechneten Monat"
          icon={<Lock className="h-5 w-5 text-amber-600 dark:text-amber-400" />}
        >
          <p className="text-sm leading-relaxed">
            Dein Stempel seit{" "}
            <span className="font-semibold">
              {WOCHENTAG.format(new Date(frage.eintrag.clock_in))} {stempelTag(frage.eintrag.clock_in)} {stempelZeit(frage.eintrag.clock_in)}
            </span>{" "}
            läuft noch, der Monat ist aber schon abgerechnet. Ausstempeln geht hier nicht mehr — das Ende setzt die
            Lohnverwaltung per Antrag.
          </p>
          <p className="text-sm text-muted-foreground">
            Melde die richtige Endzeit mit einem Ticket «Stempel-Änderung».
          </p>
          <div className="flex gap-2 pt-1 max-md:flex-col-reverse">
            <button type="button" onClick={() => onAntwort(null)} className="kasten flex-1 max-md:h-[40px] max-md:text-[15px]">
              Schliessen
            </button>
            {can("tickets:create") && (
              <button
                type="button"
                onClick={() => {
                  setTicketFuer(frage.eintrag);
                  onAntwort(null);
                }}
                className="kasten kasten-green flex-1 max-md:h-[40px] max-md:text-[15px]"
              >
                <Clock className="h-3.5 w-3.5" />
                Ticket «Stempel-Änderung»
              </button>
            )}
          </div>
        </Modal>
      )}
      {ticketFuer && (
        <NewTicketModal
          open
          onClose={() => setTicketFuer(null)}
          onCreated={() => setTicketFuer(null)}
          initialType="stempel_aenderung"
          initialData={{
            timeEntryId: ticketFuer.id,
            clockIn: ticketFuer.clock_in,
            clockOut: null,
            jobId: ticketFuer.job_id,
          }}
          sheet={isMobile === true}
        />
      )}
    </>
  );
}

function EndzeitFrage({ eintrag, spaetestens, sheet, onAntwort }: {
  eintrag: TimeEntry;
  spaetestens: string | null;
  sheet: boolean;
  onAntwort: (a: AusstempelnAntwort | null) => void;
}) {
  const beginn = isoZuZuerich(eintrag.clock_in);
  // Beim Oeffnen einmal festgehalten — die Pruefung «nicht in der Zukunft»
  // laeuft beim Absenden nochmals gegen die echte Uhr.
  const [offenSeit] = useState(() => Date.now());
  const grenze = (jetzt: number) => (spaetestens ? Math.min(jetzt, Date.parse(spaetestens)) : jetzt);
  const heute = isoZuZuerich(new Date(grenze(offenSeit)).toISOString()).datum;
  const [datum, setDatum] = useState(beginn.datum);
  const [zeit, setZeit] = useState("");
  const [begruendung, setBegruendung] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);

  const endzeit = datum && zeit ? zuerichZuIso(datum, zeit) : null;
  const dauer = endzeit ? Date.parse(endzeit) - Date.parse(eintrag.clock_in) : null;
  const pruefung = (jetzt: number): string | null => {
    if (!endzeit) return zeitEingabeFehler(datum, zeit) ?? "Endzeit fehlt (Datum und Uhrzeit).";
    if (spaetestens && Date.parse(endzeit) > Date.parse(spaetestens)) {
      return `Die Endzeit liegt nach deinem Ausstempeln (${stempelTag(spaetestens)} ${stempelZeit(spaetestens)}).`;
    }
    if (Date.parse(endzeit) > jetzt) return "Die Endzeit liegt in der Zukunft.";
    if (dauer !== null && dauer <= 0) return "Die Endzeit muss nach dem Beginn liegen.";
    if (!begruendung.trim()) return "Begründung fehlt.";
    return null;
  };
  const hinweis = datum && zeit ? pruefung(offenSeit) : null;

  function absenden() {
    const f = pruefung(Date.now());
    if (f) {
      setFehler(f);
      return;
    }
    onAntwort({ endzeit: endzeit!, begruendung: begruendung.trim() });
  }

  const laeuft = dauerText(grenze(offenSeit) - Date.parse(eintrag.clock_in));

  return (
    <Modal
      open
      onClose={() => onAntwort(null)}
      sheet={sheet}
      size="md"
      title="Ausstempeln"
      icon={<Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />}
    >
      <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:bg-amber-500/15 dark:text-amber-100">
        Dein Stempel läuft seit{" "}
        <span className="font-semibold">
          {WOCHENTAG.format(new Date(eintrag.clock_in))} {stempelTag(eintrag.clock_in)} {stempelZeit(eintrag.clock_in)}
        </span>{" "}
        — {spaetestens
          ? `bis zu deinem Ausstempeln am ${stempelTag(spaetestens)} um ${stempelZeit(spaetestens)} waren es ${laeuft}`
          : `schon ${laeuft}`}. Über {LANG_STUNDEN} Stunden ist meist das Ausstempeln vergessen gegangen.
      </p>

      <div className="space-y-1">
        <label htmlFor="lang-ende-datum" className="ml-1 text-[11px] font-medium text-muted-foreground">
          Wann hast du aufgehört? *
        </label>
        <div className="flex gap-2">
          <Input
            id="lang-ende-datum"
            type="date"
            value={datum}
            min={beginn.datum}
            max={heute}
            onChange={(e) => { setDatum(e.target.value); setFehler(null); }}
            className="flex-1 max-md:h-[40px]"
          />
          <ZeitFeld
            value={zeit}
            onChange={(v) => { setZeit(v); setFehler(null); }}
            className="w-28 max-md:h-[40px]"
            aria-label="Endzeit"
          />
        </div>
        <p className={`ml-1 text-[12px] ${hinweis && hinweis !== "Begründung fehlt." ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
          {hinweis && hinweis !== "Begründung fehlt."
            ? hinweis
            : dauer !== null && dauer > 0
              ? `Dauer ${dauerText(dauer)}${dauer > LANG_STUNDEN * 3600_000 ? " — über 16 Stunden, wird von der Lohnverwaltung geprüft" : ""}`
              : "Datum und Uhrzeit des Arbeitsendes"}
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="lang-begruendung" className="ml-1 text-[11px] font-medium text-muted-foreground">
          Begründung *
        </label>
        <textarea
          id="lang-begruendung"
          value={begruendung}
          onChange={(e) => { setBegruendung(e.target.value); setFehler(null); }}
          rows={2}
          maxLength={500}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm"
          placeholder="z. B. Ausstempeln vergessen — Schluss war um 17:30"
        />
      </div>

      {fehler && <p className="text-sm font-medium text-red-600 dark:text-red-400" role="alert">{fehler}</p>}

      <div className="flex gap-2 pt-1 max-md:flex-col-reverse">
        <button type="button" onClick={() => onAntwort(null)} className="kasten flex-1 max-md:h-[40px] max-md:text-[15px]">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={absenden}
          className="kasten flex-1 font-semibold text-teal-700 dark:text-teal-300 max-md:h-[40px] max-md:text-[15px]"
          style={{ border: "2px solid var(--stempel-color, #14b8a6)", backgroundColor: "rgba(20,184,166,0.16)" }}
        >
          Ausstempeln
        </button>
      </div>
    </Modal>
  );
}
