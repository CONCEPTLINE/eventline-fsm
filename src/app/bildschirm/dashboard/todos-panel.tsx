"use client";

// Todos-Fenster des Buero-Bildschirms (Mischa 2026-10-11): ALLE offenen
// Todos aller Personen. Passen nicht alle ins Fenster, laeuft eine Diashow
// (Seiten zu je N Zeilen, alle 8 s die naechste, Endlosschleife) — so ist
// ueber die Zeit jedes Todo zu sehen. Keine Interaktion (Wand-TV).
//
// N wird GEMESSEN (Hoehe der Liste / Hoehe einer Zeile), per ResizeObserver
// nachgefuehrt (Fenstergroesse, Team-Panel darueber). Der 30-s-Poll setzt
// die Diashow nicht zurueck: die Seite bleibt (nur auf die neue Seitenzahl
// begrenzt), der Timer laeuft nur bei Seiten- oder Seitenzahl-Wechsel neu,
// Zeilen sind ueber todo.id verschluesselt.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { BildschirmDaten, BildschirmTodo } from "@/lib/bildschirm-typen";
import { initialen } from "@/components/ui/person-avatar";

const SEITE_MS = 8_000;
/** Dauer des Seitenwechsels — muss zu den Animationen in board.css passen. */
const WECHSEL_MS = 600;
const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** YYYY-MM-DD als reines Kalenderdatum (UTC-Mitternacht) — keine Zeitzone im Spiel. */
function kalender(iso: string): Date {
  const [j, m, t] = iso.split("-").map(Number);
  return new Date(Date.UTC(j, m - 1, t));
}

/** Faelligkeit relativ zum Zurich-Tagesdatum `heuteIso` (beides DATE-Strings). */
function faelligkeit(faellig: string | null, heuteIso: string): { text: string; ton: "rot" | "amber" | "" | "leer" } {
  if (!faellig) return { text: "—", ton: "leer" };
  const d = kalender(faellig);
  const datum = `${WOCHENTAG[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
  if (!heuteIso) return { text: datum, ton: "" };
  const n = Math.round((d.getTime() - kalender(heuteIso).getTime()) / 86_400_000);
  if (n < -1) return { text: `seit ${-n} T.`, ton: "rot" };
  if (n === -1) return { text: "gestern", ton: "rot" };
  if (n === 0) return { text: "heute", ton: "amber" };
  if (n === 1) return { text: "morgen", ton: "" };
  return { text: datum, ton: "" };
}

function vorname(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function bevorzugtWenigBewegung(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function TodoZeile({ t, heuteIso }: { t: BildschirmTodo; heuteIso: string }) {
  const f = faelligkeit(t.faellig, heuteIso);
  return (
    <div className="b-todo">
      <span className={`b-faellig${f.ton ? ` ${f.ton}` : ""}`}>{f.text}</span>
      <span className="b-todo-titel">{t.titel}</span>
      <span className="b-personen">
        {t.prioritaet === "dringend" && <span className="b-chip rot">dringend</span>}
        {t.person ? (
          <span className="b-pers"><span className="b-av">{initialen(t.person.name)}</span><span>{vorname(t.person.name)}</span></span>
        ) : (
          <span className="b-chip amber">nicht zugewiesen</span>
        )}
      </span>
    </div>
  );
}

export function TodosPanel({ todos, heuteIso }: { todos: BildschirmDaten["todos"] | null; heuteIso: string }) {
  const listeRef = useRef<HTMLDivElement>(null);
  const [mass, setMass] = useState<{ h: number; zeile: number; gap: number } | null>(null);
  const [seite, setSeite] = useState(0);
  const [vorher, setVorher] = useState<number | null>(null);

  const liste = todos?.liste ?? [];
  const hatZeilen = liste.length > 0;

  const messen = useCallback(() => {
    const el = listeRef.current;
    const zeile = el?.querySelector<HTMLElement>(".b-seite:not(.aus) .b-todo");
    if (!el || !zeile) return;
    const gap = parseFloat(getComputedStyle(zeile.parentElement as HTMLElement).rowGap) || 0;
    const neu = { h: el.getBoundingClientRect().height, zeile: zeile.getBoundingClientRect().height, gap };
    setMass((alt) =>
      alt && Math.abs(alt.h - neu.h) < 0.5 && Math.abs(alt.zeile - neu.zeile) < 0.5 && Math.abs(alt.gap - neu.gap) < 0.5 ? alt : neu,
    );
  }, []);

  // Erste Messung vor dem Paint, sobald es Zeilen gibt; danach jede
  // Groessenaenderung der Liste (Fenster, Team-Panel, Schriftgroesse).
  useLayoutEffect(() => {
    if (hatZeilen) messen();
  }, [hatZeilen, messen]);
  useEffect(() => {
    const el = listeRef.current;
    if (!el || !hatZeilen || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => messen());
    ro.observe(el);
    return () => ro.disconnect();
  }, [hatZeilen, messen]);

  const perSeite = mass ? Math.max(1, Math.floor((mass.h + mass.gap + 0.5) / (mass.zeile + mass.gap))) : liste.length || 1;
  const seiten = Math.max(1, Math.ceil(liste.length / perSeite));
  const aktuell = Math.min(seite, seiten - 1);
  const diashow = seiten > 1;

  // Naechste Seite nach SEITE_MS. Haengt nur an Seite + Seitenzahl, damit
  // der Daten-Poll (neue Arrays, gleiche Seitenzahl) den Takt nicht stoert.
  useEffect(() => {
    if (!diashow) return;
    const id = window.setTimeout(() => {
      if (!bevorzugtWenigBewegung()) setVorher(aktuell);
      setSeite((aktuell + 1) % seiten);
    }, SEITE_MS);
    return () => window.clearTimeout(id);
  }, [aktuell, seiten, diashow]);

  // Die ausgleitende Seite nach dem Uebergang entfernen.
  useEffect(() => {
    if (vorher === null) return;
    const id = window.setTimeout(() => setVorher(null), WECHSEL_MS + 50);
    return () => window.clearTimeout(id);
  }, [vorher]);

  const seiteZeilen = (i: number) => liste.slice(i * perSeite, (i + 1) * perSeite);
  const zeigeVorher = diashow && vorher !== null && vorher !== aktuell && vorher < seiten;

  return (
    <section className="b-panel b-todos">
      <div className="b-titel">
        <span>Todos</span>
        <b>
          {todos && (
            <>
              {todos.offen} offen
              {todos.ueberfaellig > 0 && <> · <span className="b-rot">{todos.ueberfaellig} überfällig</span></>}
              {diashow && <span className="b-seitenzahl">{aktuell + 1}/{seiten}</span>}
            </>
          )}
        </b>
      </div>
      <div className={`b-fortschritt${diashow ? " an" : ""}`}>
        {diashow && <span key={`${aktuell}-${seiten}`} style={{ animationDuration: `${SEITE_MS}ms` }} />}
      </div>
      <div className="b-todo-liste" ref={listeRef}>
        {!todos ? (
          <div className="b-seite">{[0, 1, 2].map((i) => <div key={i} className="b-skel" />)}</div>
        ) : !hatZeilen ? (
          <div className="b-ok"><Check strokeWidth={3} /> Keine offenen Todos</div>
        ) : (
          <>
            {zeigeVorher && (
              <div key={`s-${vorher}`} className="b-seite aus" aria-hidden>
                {seiteZeilen(vorher).map((t) => <TodoZeile key={t.id} t={t} heuteIso={heuteIso} />)}
              </div>
            )}
            <div key={`s-${aktuell}`} className="b-seite">
              {seiteZeilen(aktuell).map((t) => <TodoZeile key={t.id} t={t} heuteIso={heuteIso} />)}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
