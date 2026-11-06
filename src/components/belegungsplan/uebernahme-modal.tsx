"use client";

/**
 * Uebernahme-Zeitraum im Standort-Kalender: «EVENTLINE uebernimmt alle
 * Privatvermietungen» von–bis (+ Notiz). Ein Tag, eine Woche oder ein
 * Monat — die drei Schnellwahl-Knoepfe setzen «Bis» ab dem «Von»-Datum.
 * Gleiche Bausteine wie das Eintrag-Modal (Modal als Sheet, Input, kasten).
 */

import { useState } from "react";
import { toast } from "sonner";
import { Handshake, Loader2, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { plusTage, weekdayForDateIso } from "@/lib/swiss-time";
import { KALENDER_NOTIZ_MAX, type Uebernahme } from "@/lib/standort-kalender";
import type { KalenderApi } from "./kalender-api";

const FELD = "mt-1 max-md:h-[36px] max-md:text-[16px]";
const LABEL = "text-[11px] font-medium";

/** Wochentag Mo=0 … So=6 eines Kalendertags. */
function wochentagMo0(tag: string): number {
  return (weekdayForDateIso(tag) + 6) % 7;
}

function monatsLetzter(tag: string): string {
  const [y, m] = tag.split("-").map(Number);
  const t = new Date(Date.UTC(y, m, 0));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

type Schnell = "tag" | "woche" | "monat";

function schnellAktiv(von: string, bis: string): Schnell | null {
  if (!von || !bis) return null;
  if (von === bis) return "tag";
  if (wochentagMo0(von) === 0 && bis === plusTage(von, 6)) return "woche";
  if (von.endsWith("-01") && bis === monatsLetzter(von)) return "monat";
  return null;
}

interface Props {
  api: KalenderApi;
  /** null = neuer Zeitraum */
  eintrag: Uebernahme | null;
  datumVorgabe: string;
  /** Name der Location fuer den Hinweistext. */
  ortName: string | null;
  onClose: () => void;
  /** Nach erfolgreichem Speichern/Loeschen: Modal schliessen + neu laden. */
  onFertig: () => void;
}

export function UebernahmeModal({ api, eintrag, datumVorgabe, ortName, onClose, onFertig }: Props) {
  const [von, setVon] = useState(eintrag?.von ?? datumVorgabe);
  const [bis, setBis] = useState(eintrag?.bis ?? datumVorgabe);
  const [notiz, setNotiz] = useState(eintrag?.notiz ?? "");
  const [laeuft, setLaeuft] = useState<"speichern" | "loeschen" | null>(null);
  const [fragt, setFragt] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();
  const aktiv = schnellAktiv(von, bis);

  function schnell(s: Schnell) {
    if (!von) return;
    if (s === "tag") setBis(von);
    if (s === "woche") {
      const mo = plusTage(von, -wochentagMo0(von));
      setVon(mo);
      setBis(plusTage(mo, 6));
    }
    if (s === "monat") {
      const erster = `${von.slice(0, 7)}-01`;
      setVon(erster);
      setBis(monatsLetzter(erster));
    }
  }

  async function speichernKlick() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis)) {
      toast.error("Von und Bis sind Pflicht");
      return;
    }
    if (bis < von) {
      toast.error("«Bis» liegt vor «Von»");
      return;
    }
    setLaeuft("speichern");
    const r = await api.uebernahmeSpeichern(eintrag?.id ?? null, { von, bis, notiz: notiz.trim() || null });
    setLaeuft(null);
    if (!r.ok) {
      toast.error(r.fehler || "Übernahme-Zeitraum konnte nicht gespeichert werden");
      return;
    }
    toast.success(eintrag ? "Übernahme-Zeitraum gespeichert" : "Übernahme-Zeitraum eingetragen");
    onFertig();
  }

  async function loeschenKlick() {
    if (!eintrag) return;
    setFragt(true);
    const ok = await confirm({
      title: "Übernahme-Zeitraum löschen?",
      message: "Ab dann werden Privatvermietungen in diesem Zeitraum wieder selbst angenommen.",
      confirmLabel: "Löschen",
    });
    setFragt(false);
    if (!ok) return;
    setLaeuft("loeschen");
    const r = await api.uebernahmeLoeschen(eintrag.id);
    setLaeuft(null);
    if (!r.ok) {
      toast.error(r.fehler || "Übernahme-Zeitraum konnte nicht gelöscht werden");
      return;
    }
    toast.success("Übernahme-Zeitraum gelöscht");
    onFertig();
  }

  const beschaeftigt = laeuft !== null;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={eintrag ? "Übernahme-Zeitraum bearbeiten" : "Übernahme-Zeitraum"}
        icon={<Handshake className="h-5 w-5 text-emerald-500" />}
        size="md"
        sheet
        closable={!beschaeftigt && !fragt}
      >
        <div className="space-y-3">
          <p className="text-sm">
            EVENTLINE übernimmt in diesem Zeitraum <span className="font-medium">alle Privatvermietungen</span>
            {ortName ? ` im ${ortName}` : ""}.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="ueb-von">Von *</label>
              <Input id="ueb-von" type="date" value={von} onChange={(e) => setVon(e.target.value)} className={FELD} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ueb-bis">Bis *</label>
              <Input id="ueb-bis" type="date" value={bis} min={von || undefined} onChange={(e) => setBis(e.target.value)} className={FELD} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {([["tag", "Nur dieser Tag"], ["woche", "Ganze Woche"], ["monat", "Ganzer Monat"]] as [Schnell, string][]).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => schnell(k)}
                className={aktiv === k ? "kasten-active" : "kasten-toggle-off"}
              >
                {label}
              </button>
            ))}
          </div>
          <div>
            <label className={LABEL} htmlFor="ueb-notiz">Notiz</label>
            <textarea
              id="ueb-notiz"
              value={notiz}
              onChange={(e) => setNotiz(e.target.value)}
              rows={2}
              maxLength={KALENDER_NOTIZ_MAX}
              placeholder="z. B. Dezember: EVENTLINE macht alle Privatfeste"
              className="mt-1 w-full px-3 py-2 text-sm max-md:text-[16px] rounded-xl border border-input bg-transparent dark:bg-input/30 resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
              style={{ fieldSizing: "content", minHeight: "3.5rem" } as React.CSSProperties}
            />
          </div>
          <div className="flex gap-2 pt-1 max-md:flex-wrap">
            {eintrag && (
              <button type="button" onClick={loeschenKlick} disabled={beschaeftigt} className="kasten kasten-red max-md:min-h-[36px]" data-tooltip="Zeitraum löschen">
                {laeuft === "loeschen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {laeuft === "loeschen" ? "Wird gelöscht…" : "Löschen"}
              </button>
            )}
            <button type="button" onClick={onClose} disabled={beschaeftigt} className="kasten kasten-muted flex-1 max-md:min-h-[36px]">
              Abbrechen
            </button>
            <button type="button" onClick={speichernKlick} disabled={beschaeftigt} className="kasten kasten-blue flex-1 max-md:min-h-[36px]">
              {laeuft === "speichern" && <Loader2 className="h-4 w-4 animate-spin" />}
              {laeuft === "speichern" ? "Wird gespeichert…" : eintrag ? "Speichern" : "Eintragen"}
            </button>
          </div>
        </div>
      </Modal>
      {ConfirmModalElement}
    </>
  );
}
