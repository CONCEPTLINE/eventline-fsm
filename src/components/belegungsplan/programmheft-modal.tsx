"use client";

/**
 * «Programmheft abgleichen» im Standort-Kalender: Quelle (Website),
 * taeglicher automatischer Abgleich, letzter Abgleich, «Jetzt abgleichen»
 * und die gefundenen Veranstaltungen mit Zustand «neu» / «schon im
 * Kalender» / «geändert» zum Ankreuzen und Uebernehmen. Uebernommene
 * Eintraege erscheinen im Kalender als Art «Programm».
 *
 * Der Abgleich liest die Website serverseitig (GET …/programmheft) — er
 * startet beim Oeffnen sofort, damit Schalter und Stand echt sind.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BookOpen, Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import type { ProgrammFund } from "@/lib/standort-kalender";
import type { KalenderApi, ProgrammheftStand } from "./kalender-api";

type FundZustand = ProgrammFund["status"];

const ZUSTAND: Record<FundZustand, { label: string; cls: string }> = {
  neu:       { label: "neu",               cls: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
  geaendert: { label: "geändert",          cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  vorhanden: { label: "schon im Kalender", cls: "bg-foreground/[0.06] text-muted-foreground dark:bg-foreground/10" },
  manuell:   { label: "von Hand geändert", cls: "bg-foreground/[0.06] text-muted-foreground dark:bg-foreground/10" },
  ausgeblendet: { label: "im Kalender gelöscht", cls: "bg-foreground/[0.06] text-muted-foreground dark:bg-foreground/10" },
};

/** Nur neue und geaenderte Funde sind waehlbar — vorhandene, von Hand
 *  geaenderte und im Kalender geloeschte fasst der Abgleich nicht an. */
const waehlbar = (f: ProgrammFund) => f.status === "neu" || f.status === "geaendert";

const TAG = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
function tagText(datum: string): string {
  return TAG.format(new Date(`${datum}T12:00:00Z`));
}

const ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" });
const DATUM = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
const ZUERICH_TAG = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

/** «heute, 06:00» bzw. «03.11.2026, 06:00» — Zuercher Zeit. */
function abgleichText(iso: string | null): string {
  if (!iso) return "noch nie";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const heute = ZUERICH_TAG.format(new Date()) === ZUERICH_TAG.format(d);
  return `${heute ? "heute" : DATUM.format(d)}, ${ZEIT.format(d)}`;
}

/** «barakuba.ch/veranstaltungen» aus der Quell-URL. */
function quelleKurz(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

function zeitText(f: ProgrammFund): string {
  if (f.von && f.bis) return `${f.von}–${f.bis}`;
  if (f.von) return `ab ${f.von}`;
  return "ganztägig";
}

interface Props {
  api: KalenderApi;
  onClose: () => void;
  /** Nach erfolgreichem Uebernehmen: Modal schliessen + Kalender neu laden. */
  onFertig: () => void;
}

export function ProgrammheftModal({ api, onClose, onFertig }: Props) {
  const [laeuft, setLaeuft] = useState<"abgleich" | "uebernehmen" | null>("abgleich");
  const [stand, setStand] = useState<ProgrammheftStand | null>(null);
  const [autoLaeuft, setAutoLaeuft] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set());

  /** Ergebnis eines Abgleichs uebernehmen. */
  function ergebnis(r: Awaited<ReturnType<KalenderApi["programmheftLaden"]>>) {
    setLaeuft(null);
    if (!r.ok) {
      toast.error(r.fehler || "Programmheft konnte nicht gelesen werden");
      return;
    }
    const neu: ProgrammheftStand = { funde: r.funde, quelle: r.quelle, auto: r.auto, abgeglichenAm: r.abgeglichenAm };
    setStand(neu);
    // Vorauswahl: alles, was neu oder geaendert ist.
    setGewaehlt(new Set(neu.funde.filter(waehlbar).map((f) => f.quelleId)));
  }

  async function abgleichen() {
    setLaeuft("abgleich");
    ergebnis(await api.programmheftLaden());
  }

  // Beim Oeffnen einmal abgleichen (Modal wird pro Oeffnen neu gemountet;
  // laeuft startet schon auf «abgleich»).
  useEffect(() => {
    let ab = false;
    api.programmheftLaden().then((r) => {
      if (!ab) ergebnis(r);
    });
    return () => { ab = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function autoUmschalten() {
    if (!stand) return;
    const neu = !stand.auto;
    setAutoLaeuft(true);
    const r = await api.programmheftAuto(neu);
    setAutoLaeuft(false);
    if (!r.ok) {
      toast.error(r.fehler || "Einstellung konnte nicht gespeichert werden");
      return;
    }
    setStand((s) => (s ? { ...s, auto: neu } : s));
  }

  async function uebernehmen() {
    const ids = (stand?.funde ?? []).filter((f) => gewaehlt.has(f.quelleId)).map((f) => f.quelleId);
    if (ids.length === 0) {
      toast.error("Nichts ausgewählt");
      return;
    }
    setLaeuft("uebernehmen");
    const r = await api.programmheftUebernehmen(ids);
    setLaeuft(null);
    if (!r.ok) {
      toast.error(r.fehler || "Veranstaltungen konnten nicht übernommen werden");
      return;
    }
    toast.success(ids.length === 1 ? "1 Veranstaltung übernommen" : `${ids.length} Veranstaltungen übernommen`);
    onFertig();
  }

  function umschalten(id: string) {
    setGewaehlt((alt) => {
      const n = new Set(alt);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const beschaeftigt = laeuft !== null;
  const anzahl = gewaehlt.size;
  const quelle = stand?.quelle || null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Programmheft abgleichen"
      icon={<BookOpen className="h-5 w-5 text-blue-500" />}
      size="lg"
      sheet
      closable={laeuft !== "uebernehmen"}
    >
      <div className="space-y-3">
        {/* Quelle + Automatik */}
        <div className="rounded-xl border bg-foreground/[0.02] dark:bg-foreground/[0.04] divide-y text-sm">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-[11px] font-medium text-muted-foreground shrink-0">Quelle</span>
            {quelle ? (
              <a
                href={quelle}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 min-w-0 truncate text-blue-700 dark:text-blue-300 underline-offset-2 hover:underline"
              >
                <span className="truncate">{quelleKurz(quelle)}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-[11px] font-medium text-muted-foreground shrink-0">Automatisch täglich</span>
            <button
              type="button"
              role="switch"
              aria-checked={stand?.auto ?? false}
              onClick={autoUmschalten}
              disabled={!stand || autoLaeuft}
              className="flex items-center gap-2 text-xs max-md:min-h-[34px]"
            >
              {autoLaeuft && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <span className={stand?.auto ? "text-green-700 dark:text-green-300 font-medium" : "text-muted-foreground"}>
                {!stand ? "—" : stand.auto ? "aktiv · jeden Morgen" : "aus"}
              </span>
              <span className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${stand?.auto ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${stand?.auto ? "translate-x-4" : "translate-x-0.5"}`} />
              </span>
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-[11px] font-medium text-muted-foreground shrink-0">Zuletzt abgeglichen</span>
            <span className="text-xs">{stand ? abgleichText(stand.abgeglichenAm) : "—"}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={abgleichen}
          disabled={beschaeftigt}
          className="kasten kasten-blue w-full justify-center max-md:min-h-[36px]"
        >
          {laeuft === "abgleich" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {laeuft === "abgleich" ? "Wird abgeglichen…" : "Jetzt abgleichen"}
        </button>

        {/* Funde */}
        {stand === null ? (
          <p className="text-xs text-muted-foreground text-center py-2">
            Der Abgleich liest das Programm auf der Website und zeigt, was neu ist oder sich geändert hat.
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Gefunden{quelle ? ` auf ${quelleKurz(quelle).split("/")[0]}` : ""} ({stand.funde.length})
            </p>
            {stand.funde.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">Auf der Website stehen gerade keine Veranstaltungen.</p>
            )}
            {stand.funde.map((f) => (
              <FundZeile
                key={f.quelleId}
                fund={f}
                an={gewaehlt.has(f.quelleId)}
                gesperrt={!waehlbar(f) || beschaeftigt}
                onToggle={() => umschalten(f.quelleId)}
              />
            ))}
            <div className="flex gap-2 pt-2 max-md:flex-wrap">
              <button type="button" onClick={onClose} disabled={laeuft === "uebernehmen"} className="kasten kasten-muted flex-1 max-md:min-h-[36px]">
                Schliessen
              </button>
              <button
                type="button"
                onClick={uebernehmen}
                disabled={beschaeftigt || anzahl === 0}
                className="kasten kasten-blue flex-1 max-md:min-h-[36px]"
              >
                {laeuft === "uebernehmen" && <Loader2 className="h-4 w-4 animate-spin" />}
                {laeuft === "uebernehmen" ? "Wird übernommen…" : `Übernehmen (${anzahl})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FundZeile({
  fund,
  an,
  gesperrt,
  onToggle,
}: {
  fund: ProgrammFund;
  an: boolean;
  gesperrt: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const z = ZUSTAND[fund.status] ?? ZUSTAND.neu;
  const vorhanden = !waehlbar(fund);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={an}
      disabled={gesperrt}
      onClick={onToggle}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="w-full flex items-center gap-3 px-3 py-2.5 max-md:py-[7px] max-md:min-h-[46px] rounded-lg border text-left bg-card"
      style={{
        opacity: vorhanden ? 0.6 : 1,
        cursor: gesperrt ? "default" : "pointer",
        backgroundColor: hover && !gesperrt ? "color-mix(in oklab, var(--foreground) 4%, var(--card))" : undefined,
        transition: "background-color 150ms",
      }}
    >
      <span
        className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
          an ? "bg-red-500 border-red-500 text-white" : "border-foreground/30"
        }`}
      >
        {an && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate max-md:whitespace-normal max-md:line-clamp-2">{fund.titel}</span>
        <span className="block text-[11px] text-muted-foreground">
          {tagText(fund.datum)} · {zeitText(fund)}
          {fund.notiz ? <span className="max-md:hidden"> · {fund.notiz}</span> : null}
        </span>
      </span>
      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${z.cls}`}>{z.label}</span>
    </button>
  );
}
