"use client";

// Wand-Dashboard fuer den Buero-Monitor (Leo 2026-10-02): links die Agenda
// aller kommenden Auftraege (nach Monat) und darunter Auftraege pro Woche,
// rechts ueber die volle Hoehe Zuletzt passiert · Todos (Diashow, fuellt
// den Rest) · Aufmerksamkeit (Umbau 2026-10-11: Heute und Team entfallen).
// Daten alle 30 s still nachgeladen, Uhr auf Serverzeit synchronisiert,
// neue Builds laden sich selbst nach (kein Nutzer, keine Eingaben →
// gefahrlos). Kein Login: Zugang ueber das Bildschirm-Cookie (/bildschirm).
//
// Wechsel (Leo 2026-10-30): alle 2 Minuten zwischen Firma und Vertrieb
// (vertrieb-ansicht.tsx). Beide Ansichten bleiben gerendert und liegen
// uebereinander — so misst die Agenda auch, waehrend sie verborgen ist, und
// der Uebergang ist ein reines CSS-Ueberblenden ohne Neuaufbau.
//
// Die Agenda wird GEMESSEN: so viele Zeilen wie der Platz hergibt, der Rest
// als "+n weitere" — damit nichts abgeschnitten wird, egal welche
// Bildschirmgroesse (die Todos messen sich selbst, siehe todos-panel.tsx).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { BildschirmDaten, BildschirmAuftrag, BildschirmVertrieb } from "@/lib/bildschirm-typen";
import { initialen } from "@/components/ui/person-avatar";
import { BUILD_INFO } from "@/lib/build-info";
import { TodosPanel } from "./todos-panel";
import { ZuletztPanel } from "./zuletzt-panel";
import { VertriebAnsicht } from "./vertrieb-ansicht";
import { ZRH, vorname } from "./format";
import "./board.css";

const REFRESH_MS = 30_000;
const VERSION_MS = 10 * 60_000;
const ACHTUNG_MAX = 5;
/** Standzeit je Ansicht (Firma ↔ Vertrieb). */
const WECHSEL_MS = 120_000;

/** YYYY-MM-DD → Date am Mittag UTC (liegt in Zurich sicher am selben Tag). */
function tagDatum(datumIso: string): Date {
  return new Date(`${datumIso}T12:00:00Z`);
}
function wochentag(datumIso: string): string {
  return tagDatum(datumIso).toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short" }).replace(".", "");
}
function tagMonat(datumIso: string): string {
  return tagDatum(datumIso).toLocaleDateString("de-CH", { timeZone: ZRH, day: "numeric", month: "numeric" });
}
function tagMonatJahr(datumIso: string): string {
  return tagDatum(datumIso).toLocaleDateString("de-CH", { timeZone: ZRH, day: "numeric", month: "numeric", year: "numeric" });
}
function monatLang(datumIso: string): string {
  return tagDatum(datumIso).toLocaleDateString("de-CH", { timeZone: ZRH, month: "long", year: "numeric" });
}
function tageBis(datumIso: string, heuteIso: string): number {
  return Math.round((tagDatum(datumIso).getTime() - tagDatum(heuteIso).getTime()) / 86400000);
}
function relativ(datumIso: string, heuteIso: string): string {
  const n = tageBis(datumIso, heuteIso);
  if (n <= 0) return "heute";
  if (n === 1) return "morgen";
  if (n < 14) return `in ${n} Tagen`;
  return `in ${Math.round(n / 7)} Wo.`;
}
/** "Barakuba Bar & Bühne · Barakuba" → nur den laengeren Namen, wenn einer
 *  im anderen steckt (Location "Barakuba", Kunde "Barakuba Bar & Bühne"). */
function ortUndKunde(ort: string | null, kunde: string | null): string[] {
  if (!kunde) return ort ? [ort] : [];
  if (!ort) return [kunde];
  const o = ort.toLowerCase();
  const k = kunde.toLowerCase();
  if (o.includes(k)) return [ort];
  if (k.includes(o)) return [kunde];
  return [kunde, ort];
}
/** Jede Ziffer in ein Feld fester Breite: Comfortaa hat keine Tabellen-
 *  ziffern ("1" ist 0.39em, "4" 0.65em breit) — sonst springt die Uhr. */
function Ziffern({ wert }: { wert: string }) {
  return <>{wert.split("").map((z, i) => <span key={i} className="b-ziffer">{z}</span>)}</>;
}

/** Wie viele `.b-fit`-Kinder passen in den Container (Platz fuer die
 *  "+n weitere"-Zeile freigehalten)? null = noch nicht gemessen → alle
 *  rendern, messen, dann kuerzen (useLayoutEffect, also vor dem Paint). */
function useZeilenPassen(ref: RefObject<HTMLDivElement | null>, key: string, reserveEm: number): number | null {
  const [max, setMax] = useState<number | null>(null);
  useLayoutEffect(() => { setMax(null); }, [key]);
  useLayoutEffect(() => {
    if (max !== null) return;
    const el = ref.current;
    if (!el) return;
    const em = parseFloat(getComputedStyle(el).fontSize) || 16;
    const limit = el.getBoundingClientRect().bottom;
    const kinder = Array.from(el.children) as HTMLElement[];
    const zaehle = (grenze: number) => {
      let n = 0;
      for (const k of kinder) {
        if (k.getBoundingClientRect().bottom > grenze) return { n, alle: false };
        if (k.classList.contains("b-fit")) n++;
      }
      return { n, alle: true };
    };
    const voll = zaehle(limit);
    setMax(voll.alle ? Number.MAX_SAFE_INTEGER : zaehle(limit - reserveEm * em).n);
  }, [max, ref, reserveEm]);
  useEffect(() => {
    const onResize = () => setMax(null);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return max;
}

const ACHTUNG: { key: keyof BildschirmDaten["achtung"]; label: string; ton: "rot" | "amber" | "blau" }[] = [
  { key: "ueberfaellige_auftraege", label: "Aufträge überfällig", ton: "rot" },
  { key: "termine_ohne_person", label: "Termine ohne Person (7 Tage)", ton: "rot" },
  { key: "partner_anfragen", label: "Partner-Anfragen warten", ton: "amber" },
  { key: "rapport_entwuerfe", label: "Rapporte nicht abgeschlossen", ton: "amber" },
  { key: "nicht_abgerechnet", label: "Aufträge nicht abgerechnet", ton: "amber" },
  { key: "fristen_30_tage", label: "Fristen in 30 Tagen", ton: "amber" },
  { key: "ferien_pending", label: "Ferienanträge offen", ton: "blau" },
  { key: "neue_belege", label: "Neue Belege", ton: "blau" },
  { key: "offene_tickets", label: "Offene Tickets", ton: "blau" },
];

export default function BildschirmDashboardPage() {
  const router = useRouter();
  const [daten, setDaten] = useState<BildschirmDaten | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [stand, setStand] = useState<Date | null>(null);
  // null bis zum Mount: die Uhr darf nicht serverseitig vorgerendert werden
  // (andere Sekunde als im Browser = Hydrations-Konflikt, React #418).
  const [jetzt, setJetzt] = useState<Date | null>(null);
  const [trennen, setTrennen] = useState<"nein" | "fragen" | "laeuft">("nein");
  const [vertrieb, setVertrieb] = useState<BildschirmVertrieb | null>(null);
  const [ansicht, setAnsicht] = useState<"firma" | "vertrieb">("firma");
  /** Zaehlt jeden Wechsel — startet den Fortschrittsbalken im Kopf neu. */
  const [wechselNr, setWechselNr] = useState(0);
  const offsetRef = useRef(0);
  const agendaRef = useRef<HTMLDivElement>(null);
  const messKey = daten?.jetzt ?? "";
  const agendaMax = useZeilenPassen(agendaRef, messKey, 1.9);

  const laden = useCallback(async () => {
    const t0 = Date.now();
    try {
      const res = await fetch("/api/bildschirm/daten", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/bildschirm");
        return;
      }
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
      const t1 = Date.now();
      offsetRef.current = new Date(json.jetzt).getTime() - (t0 + (t1 - t0) / 2);
      setDaten(json as BildschirmDaten);
      setFehler(null);
      setStand(new Date(t1 + offsetRef.current));
    } catch (e) {
      setFehler(e instanceof Error ? e.message : "Verbindung unterbrochen");
    }
  }, [router]);

  // Vertrieb separat: faellt er aus, laeuft das Firmen-Dashboard allein weiter.
  const ladenVertrieb = useCallback(async () => {
    try {
      const res = await fetch("/api/bildschirm/vertrieb", { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json?.success) setVertrieb(json as BildschirmVertrieb);
    } catch { /* naechster Versuch im naechsten Takt */ }
  }, []);

  useEffect(() => {
    void laden();
    void ladenVertrieb();
    const id = setInterval(() => { void laden(); void ladenVertrieb(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [laden, ladenVertrieb]);

  // Ohne laufende Kampagne bleibt die Wand beim Firmen-Dashboard.
  const mitVertrieb = (vertrieb?.kampagnen.length ?? 0) > 0;
  useEffect(() => {
    if (!mitVertrieb) return;
    const id = setInterval(() => {
      setAnsicht((a) => (a === "firma" ? "vertrieb" : "firma"));
      setWechselNr((n) => n + 1);
    }, WECHSEL_MS);
    return () => clearInterval(id);
  }, [mitVertrieb]);
  const sichtbar = mitVertrieb ? ansicht : "firma";

  // Wanddisplay ohne Scrollbalken-Streifen: die App erzwingt auf <html>
  // overflow-y: scroll + scrollbar-gutter: stable (heller Rand am TV).
  useEffect(() => {
    const html = document.documentElement;
    const vorher = { overflow: html.style.getPropertyValue("overflow"), gutter: html.style.getPropertyValue("scrollbar-gutter") };
    html.style.setProperty("overflow", "hidden");
    html.style.setProperty("scrollbar-gutter", "auto");
    return () => {
      html.style.setProperty("overflow", vorher.overflow);
      html.style.setProperty("scrollbar-gutter", vorher.gutter);
    };
  }, []);

  useEffect(() => {
    const tick = () => setJetzt(new Date(Date.now() + offsetRef.current));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const sha = BUILD_INFO.sha as string;
    if (!sha || sha === "dev") return;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const j = await r.json();
        if (j?.sha && j.sha !== sha) window.location.reload();
      } catch { /* naechster Versuch in 10 Minuten */ }
    };
    const id = setInterval(check, VERSION_MS);
    return () => clearInterval(id);
  }, []);

  async function bildschirmTrennen() {
    setTrennen("laeuft");
    await fetch("/api/bildschirm/session", { method: "DELETE" }).catch(() => null);
    router.replace("/bildschirm");
  }

  const uhrTeile = jetzt
    ? new Intl.DateTimeFormat("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(jetzt)
    : [];
  const teil = (typ: string) => uhrTeile.find((p) => p.type === typ)?.value ?? "--";
  const datumLang = jetzt ? jetzt.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  const heuteIso = jetzt ? jetzt.toLocaleDateString("sv-SE", { timeZone: ZRH }) : "";

  const agenda = daten?.auftraege ?? [];
  const agendaSichtbar = agendaMax === null ? agenda : agenda.slice(0, agendaMax);
  const agendaRest = agenda.length - agendaSichtbar.length;
  const achtungPunkte = daten ? ACHTUNG.filter((a) => daten.achtung[a.key] > 0) : [];
  const maxWoche = Math.max(1, ...(daten?.wochen.map((w) => w.auftraege) ?? [1]));

  // Agenda nach Monat gliedern (Monat des Starttermins; laufende zuerst).
  const agendaZeilen: ReactNode[] = [];
  let letzterMonat = "";
  for (const a of agendaSichtbar) {
    const monat = a.start.slice(0, 7);
    if (monat !== letzterMonat) {
      letzterMonat = monat;
      const imMonat = agenda.filter((x) => x.start.slice(0, 7) === monat && x.typ !== "entwurf").length;
      agendaZeilen.push(
        <div key={`m-${monat}`} className="b-monat">
          <span>{monatLang(a.start)}</span>
          <span>{imMonat} {imMonat === 1 ? "Auftrag" : "Aufträge"}</span>
        </div>,
      );
    }
    agendaZeilen.push(<AgendaZeile key={a.id} a={a} heuteIso={heuteIso} />);
  }

  return (
    <div className="board">
      <header className="b-kopf">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-gmbh.png" alt="EVENTLINE GmbH" className="b-logo" />
        <div className="b-datummitte">
          <div className="b-datum">{datumLang}</div>
          {mitVertrieb && (
            <div className="b-wechsel" aria-hidden>
              {(["firma", "vertrieb"] as const).map((x) => (
                <span key={x} className={sichtbar === x ? "an" : ""}>
                  {x === "firma" ? "Firma" : "Vertrieb"}
                  <i>{sichtbar === x && <b key={wechselNr} style={{ animationDuration: `${WECHSEL_MS}ms` }} />}</i>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="b-uhrbox">
          <div className="b-uhr">
            <Ziffern wert={teil("hour")} /><span className="b-colon">:</span><Ziffern wert={teil("minute")} />
            <span className="b-sek"><Ziffern wert={teil("second")} /></span>
          </div>
          <div className="b-live">
            <span className={`b-dot${fehler ? " warn" : ""}`} />
            {fehler
              ? `Verbindung unterbrochen${stand ? ` · Stand ${stand.toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" })}` : ""}`
              : stand
                ? `live · aktualisiert ${stand.toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "verbinde…"}
          </div>
        </div>
      </header>

      <div className="b-buehne">
      <div className={`b-mitte b-ansicht${sichtbar === "firma" ? " an" : " aus"}`} aria-hidden={sichtbar !== "firma"}>
        <div className="b-links">
          {/* Agenda */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Kommende Aufträge</span>
              <b>{daten ? `${daten.kpi.auftraege_geplant} geplant` : ""}</b>
            </div>
            <div className="b-agenda" ref={agendaRef}>
              {!daten ? (
                [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="b-skel" />)
              ) : agenda.length === 0 ? (
                <div className="b-leer">Keine kommenden Aufträge.</div>
              ) : (
                agendaZeilen
              )}
              {daten && agendaRest > 0 && (
                <div className="b-mehr">+{agendaRest} weitere bis {tagMonatJahr(agenda[agenda.length - 1].start)}</div>
              )}
            </div>
          </section>

          {/* Wochen */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Aufträge pro Woche · nächste 9 Wochen</span>
              <b>{daten ? `${daten.wochen.reduce((n, w) => n + w.auftraege, 0)} Aufträge · ${daten.wochen.reduce((n, w) => n + w.einsaetze, 0)} Einsätze` : ""}</b>
            </div>
            <div className="b-wochen">
              {(daten?.wochen ?? []).map((w, i) => (
                <div key={w.start} className={`b-woche${i === 0 ? " aktuell" : ""}`}>
                  <div className={`b-v${w.auftraege === 0 ? " null" : ""}`}>
                    {w.auftraege > 0 && w.auftraege}
                    {w.einsaetze > 0 && <small>{w.auftraege > 0 ? "· " : ""}{w.einsaetze} {w.einsaetze === 1 ? "Einsatz" : "Einsätze"}</small>}
                    {w.auftraege === 0 && w.einsaetze === 0 && "·"}
                  </div>
                  <div className="b-bararea"><div className="b-bar" style={{ height: `${Math.round((w.auftraege / maxWoche) * 100)}%` }} /></div>
                  <div className="b-d"><b>KW {w.kw}</b>{tagMonat(w.start)} – {tagMonat(w.ende)}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="b-spalte">
          {/* Zuletzt passiert (Hoehe nach Inhalt) · Todos (fuellen den Rest) */}
          <ZuletztPanel zuletzt={daten?.zuletzt ?? null} heuteIso={heuteIso} />
          <TodosPanel todos={daten?.todos ?? null} heuteIso={heuteIso} />

          {/* Achtung */}
          <section className="b-panel">
            <div className="b-titel"><span>Braucht Aufmerksamkeit</span></div>
            <div className="b-achtung">
              {!daten ? (
                [0, 1].map((i) => <div key={i} className="b-skel" />)
              ) : achtungPunkte.length === 0 ? (
                <div className="b-ok"><Check strokeWidth={3} /> Alles im grünen Bereich</div>
              ) : (
                achtungPunkte.slice(0, ACHTUNG_MAX).map((a) => (
                  <div key={a.key} className={`b-punkt ${a.ton}`}>
                    <span>{a.label}</span>
                    <span className="b-n">{daten.achtung[a.key]}</span>
                  </div>
                ))
              )}
              {daten && achtungPunkte.length > ACHTUNG_MAX && <div className="b-mehr">+{achtungPunkte.length - ACHTUNG_MAX} weitere</div>}
            </div>
          </section>

        </div>
      </div>
      <VertriebAnsicht v={vertrieb} heuteIso={heuteIso} aktiv={sichtbar === "vertrieb"} />
      </div>

      {trennen === "nein" ? (
        <button type="button" className="b-trennen" onClick={() => setTrennen("fragen")}>Bildschirm trennen</button>
      ) : (
        <span className="b-trennen">
          Bildschirm wirklich trennen?{" "}
          <button type="button" onClick={bildschirmTrennen} disabled={trennen === "laeuft"}>{trennen === "laeuft" ? "…" : "Ja"}</button>
          {" · "}
          <button type="button" onClick={() => setTrennen("nein")}>Nein</button>
        </span>
      )}
    </div>
  );
}

function AgendaZeile({ a, heuteIso }: { a: BildschirmAuftrag; heuteIso: string }) {
  const laeuft = !!heuteIso && a.start <= heuteIso && a.ende >= heuteIso;
  const mehrtaegig = a.ende !== a.start;
  const nummer = a.nummer ? (a.typ === "entwurf" ? `ENT-${a.nummer}` : `INT-${a.nummer}`) : null;
  const sub = [nummer, ...ortUndKunde(a.ort, a.kunde), mehrtaegig ? `${tagMonat(a.start)} – ${tagMonat(a.ende)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`b-auftrag b-fit ${a.typ}${laeuft ? " laeuft" : ""}`}>
      <div className="b-tagbox">
        <span className="b-tagnr">{tagDatum(a.start).toLocaleDateString("de-CH", { timeZone: ZRH, day: "2-digit" })}</span>
        <span className="b-tagwt">{wochentag(a.start)}</span>
      </div>
      <div>
        <div className="b-a-titel">{a.titel}</div>
        {sub && <div className="b-a-sub">{sub}</div>}
      </div>
      <div className="b-a-rechts">
        {a.dringend && <span className="b-chip rot">dringend</span>}
        {laeuft && <span className="b-chip rot">läuft</span>}
        {a.typ === "anfrage" && <span className="b-chip amber">Anfrage</span>}
        {a.typ === "entwurf" && <span className="b-chip grau">Entwurf</span>}
        {/* Zugeteilte Personen in Gruen — gleiche Sprache wie im Partnerportal
            (Leo 2026-10-02: Anzahl Einsaetze raus, Namen bleiben). */}
        {a.typ !== "entwurf" && a.personen.length > 0 && (
          <span className="b-namen">{a.personen.map(vorname).join(", ")}</span>
        )}
        {a.typ === "auftrag" && a.einsaetze > 0 && a.personen.length === 0 && <span className="b-chip amber">nicht zugewiesen</span>}
        {a.typ === "auftrag" && a.einsaetze === 0 && <span className="b-chip amber">kein Termin</span>}
        {!laeuft && <span className="b-rel">{relativ(a.start, heuteIso)}</span>}
        {a.verantwortlich && <span className="b-av">{initialen(a.verantwortlich)}</span>}
      </div>
    </div>
  );
}
