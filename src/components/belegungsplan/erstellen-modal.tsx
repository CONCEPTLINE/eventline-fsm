"use client";

/**
 * Auswahl hinter «Eintrag erstellen» im Standort-Kalender: vier Arten, je
 * eine Karte (TypePickerCard wie die Typ-Auswahl der App).
 */

import { BookOpen, CalendarPlus, ChevronRight, Handshake, Repeat } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { TypePickerCard } from "@/components/ui/type-picker-card";

export type ErstellenWahl = "termin" | "veranstaltung" | "uebernahme" | "programmheft";

interface Props {
  /** Vorbelegtes Datum, falls ein Tag angetippt wurde (nur fuer den Titel). */
  datumText: string | null;
  onClose: () => void;
  onWahl: (w: ErstellenWahl) => void;
}

export function ErstellenModal({ datumText, onClose, onWahl }: Props) {
  const pfeil = <ChevronRight className="h-4 w-4 text-muted-foreground" />;
  return (
    <Modal
      open
      onClose={onClose}
      title={datumText ? `Eintrag erstellen · ${datumText}` : "Eintrag erstellen"}
      icon={<CalendarPlus className="h-5 w-5 text-red-500" />}
      size="md"
      sheet
    >
      <div className="space-y-2">
        <TypePickerCard icon={CalendarPlus} tone="blue" label="Termin" description="Einmaliger Termin, z. B. Lieferung oder private Feier." onClick={() => onWahl("termin")} trailing={pfeil} />
        <TypePickerCard icon={Repeat} tone="blue" label="Veranstaltung" description="Eigene Veranstaltung, auf Wunsch wöchentlich oder monatlich wiederholt." onClick={() => onWahl("veranstaltung")} trailing={pfeil} />
        <TypePickerCard icon={Handshake} tone="green" label="Übernahme-Zeitraum" description="EVENTLINE übernimmt alle Privatvermietungen von–bis." onClick={() => onWahl("uebernahme")} trailing={pfeil} />
        <TypePickerCard icon={BookOpen} tone="blue" label="Programmheft abgleichen" description="Veranstaltungen von barakuba.ch in den Kalender holen." onClick={() => onWahl("programmheft")} trailing={pfeil} />
      </div>
    </Modal>
  );
}
