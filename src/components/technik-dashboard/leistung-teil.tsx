// Technik-Dashboard: Abschnitt «Leistung» im Panel der lokalen KI (Mischa 2026-10-15: «wo man nachschauen kann,
// wie lange wie viele Seiten dauern, wie oft die KI richtig liegt, was das grösste Dokument ist — wenn jemand
// fragt ‹was kann deine KI, wie gut ist sie›, zeigt man ihnen das»). VERTRAG §2.6, §6.5.
// - Daten: GET /api/technik/leistung?zeitraum=…, beim Öffnen, beim Zeitraum-Wechsel und alle 5 min (nur sichtbarer
//   Tab). Zeitraum in der URL (?leistung=7d|alle, 30 Tage = Standard ohne Parameter).
// - Nur echte Zahlen; was im Zeitraum fehlt, steht als «keine», nie geschätzt. Keine Namen, keine Inhalte.
// - Jede Kennzahl mit einer kurzen Zeile «wie gemessen» (sichtbar, für Besucher).
// - Nachtrag 15.10. abends: Lesezeit exakt je Datei (nicht mehr Abstand der Zeitstempel), Rechenzeit je Seite der
//   Aufträge mit Dokument, grösstes ÜBERNOMMENES Dokument, Trefferquote der Ablagen aus der App, Zeit je Rapport.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { LEISTUNG_VERALTET_MS, LEISTUNG_ZEITRAEUME, LEISTUNG_ZEITRAUM_STANDARD } from "@/lib/technik-dashboard/konstanten";
import type {
  LeistungAblage, LeistungAuftraege, LeistungGelesen, LeistungGroesstes, LeistungSelbsttestLauf, LeistungUploads, LeistungZeitraum,
  TechnikLeistung,
} from "@/lib/technik-dashboard/typen";
import { K } from "./farben";
import { BTN, Kommt, Meta, NUM, Ov } from "./bausteine";
import { alterText, datumLang, komma, tagKurz, tausend, uhr } from "./format";
import type { Sicht } from "./sicht";

const TAKT_MS = 5 * 60_000;
const URL_PARAM = "leistung";

export const ZEITRAUM_TEXT: Readonly<Record<LeistungZeitraum, string>> = { "7d": "7 Tage", "30d": "30 Tage", alle: "gesamt" };
const istZeitraum = (x: string | null): x is LeistungZeitraum => !!x && (LEISTUNG_ZEITRAEUME as readonly string[]).includes(x);

function leseUrl(): LeistungZeitraum {
  if (typeof window === "undefined") return LEISTUNG_ZEITRAUM_STANDARD;
  const z = new URLSearchParams(window.location.search).get(URL_PARAM);
  return istZeitraum(z) ? z : LEISTUNG_ZEITRAUM_STANDARD;
}

/** Nur den eigenen Parameter setzen (teil/bereich der Seite bleiben stehen), kein History-Eintrag. */
function schreibeUrl(z: LeistungZeitraum) {
  const q = new URLSearchParams(window.location.search);
  if (z === LEISTUNG_ZEITRAUM_STANDARD) q.delete(URL_PARAM);
  else q.set(URL_PARAM, z);
  const s = q.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
}

async function hole(z: LeistungZeitraum, signal: AbortSignal): Promise<TechnikLeistung> {
  const r = await fetch(`/api/technik/leistung?zeitraum=${z}`, { cache: "no-store", signal });
  const j = (await r.json().catch(() => null)) as (TechnikLeistung & { error?: string }) | null;
  if (!r.ok || !j || j.success !== true) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

// ---- Anzeige-Helfer ----

/** Dauer kurz: «0,06 s», «0,5 s», «4,4 s», «16 s», «1:45 min», «12 min». */
export function dauerKurz(ms: number): string {
  const s = ms / 1000;
  if (s < 0.095) return `${komma(s, 2)} s`;
  if (s < 9.95) return `${komma(s, 1)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 600) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")} min`;
  }
  return `${Math.round(s / 60)} min`;
}

export const pct = (anteil: number) => `${Math.round(anteil * 100)} %`;
const mal = (n: number, eins: string, viele: string) => `${tausend(n)} ${n === 1 ? eins : viele}`;

// ---- Bausteine ----

function ZeitraumKnopf({ z, gewaehlt, dreht, onWahl }: { z: LeistungZeitraum; gewaehlt: boolean; dreht: boolean; onWahl: (z: LeistungZeitraum) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={gewaehlt}
      aria-label={`Leistung ${ZEITRAUM_TEXT[z]}`}
      onClick={() => onWahl(z)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...BTN, display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 9px", fontSize: 12, borderRadius: 7, ...NUM, ...(hover && !gewaehlt ? { background: K.tile } : null) }}
    >
      {dreht ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
      <span>{ZEITRAUM_TEXT[z]}</span>
    </button>
  );
}

/** Eine Kennzahl: Name, Wert rechts, darunter «wie gemessen». */
function Kennzahl({ label, wert, wie, children }: { label: string; wert: ReactNode; wie: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 0", borderTop: `1px solid ${K.line}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", columnGap: 10, rowGap: 2, fontSize: 13 }}>
        <span>{label}</span>
        <span style={{ marginLeft: "auto", fontWeight: 700, textAlign: "right", ...NUM }}>{wert}</span>
      </div>
      {children}
      <Meta>{wie}</Meta>
    </div>
  );
}

const VERLAUF_H = 56;

/** Selbsttest-Verlauf: eine Achse (0–100 %), zwei Linien (erster Vorschlag, unter den ersten drei), Legende und
 *  Endwerte als Text, je Nacht ein Zielbereich mit Tooltip (Werte stehen zusätzlich im Satz darunter). */
function SelbsttestVerlauf({ laeufe }: { laeufe: LeistungSelbsttestLauf[] }) {
  const alt = laeufe.slice().reverse(); // aelteste zuerst
  const n = alt.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 4 + (1 - v) * (VERLAUF_H - 8);
  const linie = (feld: "top1" | "top3") =>
    alt.map((l, i) => (l[feld] == null ? null : `${x(i).toFixed(2)},${y(l[feld]!).toFixed(1)}`)).filter(Boolean).join(" ");
  const letzte = alt[n - 1];
  const serien = [
    { feld: "top3" as const, name: "unter den ersten drei", farbe: K.B },
    { feld: "top1" as const, name: "erster Vorschlag", farbe: K.A },
  ];
  // Endwert-Beschriftungen ohne Ueberlappung (mind. 12 px Abstand)
  const ends = serien
    .map((s) => ({ ...s, v: letzte?.[s.feld] }))
    .filter((s): s is typeof s & { v: number } => s.v != null)
    .map((s) => ({ ...s, top: y(s.v) - 6 }))
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < ends.length; i++) if (ends[i].top - ends[i - 1].top < 12) ends[i].top = ends[i - 1].top + 12;
  const tip = (l: LeistungSelbsttestLauf) =>
    `${tagKurz(l.am)}: erster Vorschlag ${l.top1 != null ? pct(l.top1) : "–"}, unter den ersten drei ${l.top3 != null ? pct(l.top3) : "–"} (${tausend(l.dateien)} Dateien)`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "2px 0 2px" }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: K.sub, ...NUM }}>
        {serien.slice().reverse().map((s) => (
          <span key={s.feld} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true" style={{ width: 12, height: 2, borderRadius: 1, background: s.farbe }} />
            {s.name}
          </span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 34px", gap: 6 }}>
        <div style={{ position: "relative", height: VERLAUF_H }}>
          <svg viewBox={`0 0 100 ${VERLAUF_H}`} preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
            {[0, 0.5, 1].map((g) => (
              <line key={g} x1="0" x2="100" y1={y(g)} y2={y(g)} stroke={K.grid} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {serien.map((s) => (
              <polyline key={s.feld} points={linie(s.feld)} fill="none" stroke={s.farbe} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {alt.map((l, i) =>
            serien.map((s) =>
              l[s.feld] == null ? null : (
                <span key={`${l.am}-${s.feld}`} aria-hidden="true" style={{ position: "absolute", left: `${x(i)}%`, top: y(l[s.feld]!), width: 6, height: 6, margin: "-3px 0 0 -3px", borderRadius: "50%", background: s.farbe, boxShadow: `0 0 0 2px ${K.e1}` }} />
              ),
            ),
          )}
          {/* Zielbereiche je Nacht: naechster Punkt (Grenzen auf halbem Weg), lueckenlos, Tastatur und Maus */}
          {alt.map((l, i) => {
            const links = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
            const rechts = i === n - 1 ? 100 : (x(i) + x(i + 1)) / 2;
            return (
              <span key={l.am} role="img" tabIndex={0} aria-label={tip(l)} data-tooltip={tip(l)} style={{ position: "absolute", top: -4, bottom: -4, left: `${links}%`, width: `${rechts - links}%`, borderRadius: 4 }} />
            );
          })}
        </div>
        <div style={{ position: "relative", height: VERLAUF_H }}>
          {ends.map((e) => (
            <span key={e.feld} style={{ position: "absolute", left: 0, top: e.top, fontSize: 11, lineHeight: "12px", fontWeight: 700, color: K.text, ...NUM, whiteSpace: "nowrap" }}>{pct(e.v)}</span>
          ))}
        </div>
      </div>
      {n > 1 ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 34px", gap: 6, fontSize: 10.5, color: K.mute, ...NUM }}>
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{tagKurz(alt[0].am)}</span>
            <span>{tagKurz(alt[n - 1].am)}</span>
          </span>
          <span />
        </div>
      ) : null}
    </div>
  );
}

const ART_TEXT: Partial<Record<string, { label: string; eins: string; viele: string; wie: string }>> = {
  ablage_analyse: { label: "Dokument einordnen (App)", eins: "Dokument", viele: "Dokumente", wie: "Rechenzeit auf dem Rig für ein Dokument aus der App: lesen, beschreiben, Ordner vorschlagen" },
  nas_suche: { label: "Inhaltssuche", eins: "Suche", viele: "Suchen", wie: "Antwortzeit auf dem Rig, ohne den Weg über das Internet" },
  archiv_frage: { label: "Frag das Archiv", eins: "Frage", viele: "Fragen", wie: "Rechenzeit auf dem Rig bis zur fertigen Antwort mit Quellen" },
  nacht_zz: { label: "Rückstau vorbereiten", eins: "Datei", viele: "Dateien", wie: "Rechenzeit je Datei aus dem Rückstau ZZ: lesen und den Ablage-Vorschlag vorbereiten" },
};

/** Kleinere Auftragsarten, zusammen in einer Zeile. */
const KLEIN_TEXT: Partial<Record<string, { eins: string; viele: string }>> = {
  beleg_analyse: { eins: "Beleg", viele: "Belege" },
  warenkorb_analyse: { eins: "Warenkorb", viele: "Warenkörbe" },
  diktat: { eins: "Diktat", viele: "Diktate" },
};

/** Rechenzeit je Seite und grösstes Dokument einer Auftragsart (seit 15.10. im Protokoll) — leer, wenn nichts da ist.
 *  «je Seite» = Median über die erfolgreichen Aufträge mit Seitenzahl: ganze Rechenzeit / Seiten des Dokuments. */
export function seitenText(a: LeistungAuftraege): string {
  const je = [
    a.ms_seite_text != null ? `${dauerKurz(a.ms_seite_text)} Text` : null,
    a.ms_seite_gescannt != null ? `${dauerKurz(a.ms_seite_gescannt)} gescannt` : null,
  ].filter(Boolean).join(", ");
  const groesse = [
    a.seiten_max != null && a.seiten_max > 1 ? `bis ${mal(a.seiten_max, "Seite", "Seiten")}` : null,
    a.teile_max != null && a.teile_max > 1 ? `in bis zu ${tausend(a.teile_max)} Teilen gelesen` : null,
  ].filter(Boolean).join(" ");
  return [je ? `je Seite ${je}` : null, groesse || null].filter(Boolean).join(" · ");
}

function AuftragZeile({ a }: { a: LeistungAuftraege }) {
  const t = ART_TEXT[a.art];
  if (!t) return null;
  const fehler = a.n - a.ok;
  const seiten = seitenText(a);
  return (
    <Kennzahl
      label={t.label}
      wert={`${mal(a.n, t.eins, t.viele)}${a.median_ms != null ? ` · ${dauerKurz(a.median_ms)}` : ""}`}
      wie={`Median der ${t.wie}${a.max_ms != null && a.n > 1 ? `; längste ${dauerKurz(a.max_ms)}` : ""}${seiten ? ` · ${seiten}` : ""}${fehler > 0 ? ` · ${tausend(fehler)} ohne Ergebnis` : ""}.`}
    />
  );
}

function KleineAuftraege({ liste }: { liste: LeistungAuftraege[] }) {
  if (!liste.length) return null;
  return (
    <Kennzahl
      label="Belege und Diktate"
      wert={liste.map((a) => mal(a.n, KLEIN_TEXT[a.art]!.eins, KLEIN_TEXT[a.art]!.viele)).join(" · ")}
      wie={`Median der Rechenzeit: ${liste.map((a) => `${KLEIN_TEXT[a.art]!.viele} ${a.median_ms != null ? dauerKurz(a.median_ms) : "–"}`).join(", ")}. Beleg-Fotos und Sprache werden auf dem Rig gelesen, ohne Cloud.`}
    />
  );
}

/** Anteile ganzzahlig, die drei Teile ergeben zusammen 100 % (groesster Rest bekommt die Rundung). */
export function anteile(teile: number[]): number[] {
  const summe = teile.reduce((a, b) => a + b, 0);
  if (!summe) return teile.map(() => 0);
  const roh = teile.map((t) => (t / summe) * 100);
  const ab = roh.map(Math.floor);
  let rest = 100 - ab.reduce((a, b) => a + b, 0);
  const reihenfolge = roh.map((r, i) => [r - ab[i], i] as const).sort((x, y) => y[0] - x[0]);
  for (const [, i] of reihenfolge) {
    if (rest <= 0) break;
    ab[i] += 1;
    rest -= 1;
  }
  return ab;
}

function AblageZeile({ a, zeitraum }: { a: LeistungAblage; zeitraum: LeistungZeitraum }) {
  const entschieden = a.unveraendert + a.geaendert + a.abgelehnt;
  const [pU, pG, pA] = anteile([a.unveraendert, a.geaendert, a.abgelehnt]);
  const titel = a.logik === "claude" ? "Ablage-Vorschläge mit Claude" : "Ablage-Vorschläge nur lokal";
  const logik = a.logik === "claude"
    ? "Rückstau ZZ: die lokale KI beschreibt die Datei, Claude schlägt Ordner und Namen vor, ein Admin entscheidet"
    : "Rückstau ZZ: Ordner aus Regel, Vorbild oder Modell auf dem Rig, ein Admin entscheidet";
  const offen = a.offen ? ` · ${mal(a.offen, "Vorschlag wartet", "Vorschläge warten")}` : "";
  const entscheide = entschieden
    ? `${pG} % geändert (${tausend(a.ordner_geaendert)}× Ordner, ${tausend(a.name_geaendert)}× Name), ${pA} % abgelehnt — ${mal(entschieden, "Entscheid", "Entscheide")}${a.entscheid_von && a.entscheid_bis ? ` ${tagKurz(a.entscheid_von)}–${tagKurz(a.entscheid_bis)}` : ""}`
    : zeitraum === "alle" ? "noch keine Entscheide" : "keine Entscheide in diesem Zeitraum";
  return (
    <Kennzahl
      label={titel}
      wert={entschieden ? `${pU} % unverändert` : "noch offen"}
      wie={`${entscheide}${offen}. ${logik}; gezählt nur Entscheide über Vorschläge dieser Logik.`}
    />
  );
}

/** Lesezeit des Tiefen-Index, exakt je Datei gemessen (archiv_text.dauer_ms seit 15.10.) — ohne Messung keine Zeile. */
function LesezeitZeile({ g }: { g: LeistungGelesen }) {
  if (g.gemessen == null) return null;
  const wert = [
    g.s_seite_text != null ? `${dauerKurz(g.s_seite_text * 1000)} Text` : null,
    g.s_seite_gescannt != null ? `${dauerKurz(g.s_seite_gescannt * 1000)} gescannt` : null,
  ].filter(Boolean).join(" · ");
  const dokument = g.s_datei_median != null
    ? `; je Dokument ${dauerKurz(g.s_datei_median * 1000)}${g.s_datei_max != null && g.gemessen > 1 ? `, längstes ${dauerKurz(g.s_datei_max * 1000)}` : ""}`
    : "";
  return (
    <Kennzahl
      label="Lesezeit je Seite"
      wert={g.gemessen > 0 ? wert || "–" : "keine"}
      wie={g.gemessen > 0
        ? `Median${dokument}; ${mal(g.gemessen, "Datei", "Dateien")} gemessen. Gemessen wird die Dauer, bis der Text einer Datei herausgezogen ist (gescannte Seiten mit Texterkennung, je erkannte Seite), geteilt durch ihre Seiten.`
        : "Noch keine Datei gemessen. Seit 15.10. misst der Tiefen-Index jede Datei, die er neu liest (nachts); früher gelesene und verschobene Dateien haben keine Lesezeit."}
    />
  );
}

/** Grösstes Dokument, dessen vorgeschlagener Ordner übernommen wurde (FSM), dazu das grösste gelesene (Tiefen-Index). */
function GroesstesZeile({ groesstes, g }: { groesstes: LeistungGroesstes | null; g: LeistungGelesen | null }) {
  const gelesen = g && (g.seiten_max != null || g.zeichen_max != null)
    ? ` Grösstes gelesenes Dokument (Tiefen-Index): ${[g.seiten_max != null ? mal(g.seiten_max, "Seite", "Seiten") : null, g.zeichen_max != null ? `${tausend(g.zeichen_max)} Zeichen` : null, g.mb_max != null ? `${komma(g.mb_max, 1)} MB` : null].filter(Boolean).join(", ")}.`
    : "";
  const herkunft = groesstes?.herkunft === "zz" ? "aus dem Rückstau ZZ" : "aus der App";
  return (
    <Kennzahl
      label="Grösstes übernommenes Dokument"
      wert={groesstes ? mal(groesstes.seiten, "Seite", "Seiten") : "noch keins"}
      wie={groesstes
        ? `Das Dokument mit den meisten Seiten, dessen vorgeschlagener Ordner übernommen wurde — ${herkunft}, am ${tagKurz(groesstes.am)}${gelesen}`
        : `Noch kein Vorschlag mit Seitenzahl übernommen (zählt: Ablage aus der App und Rückstau ZZ, Ordner wie vorgeschlagen).${gelesen}`}
    />
  );
}

const QUELLE_TEXT: Readonly<Record<keyof LeistungUploads["quellen"], string>> = {
  regel: "Regel", lokal: "lokale KI", claude: "Claude", beschrieb: "getippter Beschrieb",
};

/** Trefferquote der Ablagen aus der App (Upload und Mail-Eingang): Vorschlag der KI gegen das gewählte Ziel. */
function UploadsZeile({ u, zeitraum }: { u: LeistungUploads; zeitraum: LeistungZeitraum }) {
  const n = u.mit_vorschlag;
  const quellen = (Object.keys(QUELLE_TEXT) as Array<keyof LeistungUploads["quellen"]>)
    .filter((k) => u.quellen[k] > 0)
    .map((k) => `${QUELLE_TEXT[k]} ${tausend(u.quellen[k])}`)
    .join(", ");
  return (
    <Kennzahl
      label="Ablage aus der App"
      wert={n ? `${pct(u.unveraendert / n)} unverändert` : "noch keine"}
      wie={n
        ? `${pct(u.ordner_geaendert / n)} Ordner geändert, ${pct(u.name_geaendert / n)} Name geändert — ${mal(n, "Ablage", "Ablagen")} mit KI-Vorschlag (Upload und Mail-Eingang)${quellen ? `; Vorschlag von: ${quellen}` : ""}. Verglichen wird der Vorschlag der KI mit dem Ordner und Namen, unter dem abgelegt wurde.`
        : `${zeitraum === "alle" ? "Noch keine Ablage" : "In diesem Zeitraum keine Ablage"} mit KI-Vorschlag. Beim Ablegen hält die App den Vorschlag der KI neben dem gewählten Ordner und Namen fest.`}
    />
  );
}

// ---- Abschnitt ----

export function LeistungTeil({ s }: { s: Sicht }) {
  const [zeitraum, setZeitraum] = useState<LeistungZeitraum>(leseUrl);
  const [daten, setDaten] = useState<TechnikLeistung | null>(null);
  const [laedt, setLaedt] = useState(true);
  const gemeldet = useRef(false);
  const zeitraumRef = useRef(zeitraum);

  const ladeRef = useRef<(z: LeistungZeitraum, signal: AbortSignal) => Promise<void>>(async () => {});
  useEffect(() => {
    ladeRef.current = async (z, signal) => {
      try {
        const j = await hole(z, signal);
        if (signal.aborted || zeitraumRef.current !== z) return;
        setDaten(j);
        gemeldet.current = false;
      } catch (e) {
        if (signal.aborted) return;
        if (!gemeldet.current) {
          gemeldet.current = true;
          toast.error("Leistung der KI konnte nicht geladen werden", { description: e instanceof Error && e.message.startsWith("HTTP") ? `Antwort der App: ${e.message}. Die letzten Werte bleiben stehen.` : "Die letzten Werte bleiben stehen." });
        }
      } finally {
        if (!signal.aborted && zeitraumRef.current === z) setLaedt(false);
      }
    };
  });

  // Laden beim Oeffnen und beim Zeitraum-Wechsel; danach alle 5 min, nur bei sichtbarem Tab.
  useEffect(() => {
    const ac = new AbortController();
    void ladeRef.current(zeitraum, ac.signal);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void ladeRef.current(zeitraumRef.current, ac.signal);
    }, TAKT_MS);
    return () => {
      ac.abort();
      clearInterval(t);
    };
  }, [zeitraum]);

  const waehle = (z: LeistungZeitraum) => {
    if (z === zeitraum) return;
    zeitraumRef.current = z;
    setZeitraum(z);
    setLaedt(true);
    schreibeUrl(z);
  };

  const kopf = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Ov t={<span id="td-ki-leistung">Leistung</span>} />
      <div role="group" aria-label="Zeitraum der Leistung" style={{ display: "inline-flex", gap: 2, padding: 2, boxShadow: `inset 0 0 0 1px ${K.line}`, borderRadius: 9 }}>
        {LEISTUNG_ZEITRAEUME.map((z) => (
          <ZeitraumKnopf key={z} z={z} gewaehlt={zeitraum === z} dreht={zeitraum === z && laedt && daten != null} onWahl={waehle} />
        ))}
      </div>
    </div>
  );

  if (!daten) {
    return (
      <section aria-labelledby="td-ki-leistung" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {kopf}
        <div className="shimmer rounded-md" style={{ height: 14, width: "70%" }} />
        {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer rounded-md" style={{ height: 38 }} />)}
      </section>
    );
  }

  const rig = daten.rig;
  const b = rig?.block ?? null;
  const g = b?.gelesen;
  const laeufe = rig?.selbsttest ?? [];
  const letzter = laeufe[0] ?? null;
  const sm = b?.selbsttest;
  const sortiert = (text: Partial<Record<string, unknown>>) => {
    const reihenfolge = Object.keys(text);
    return (b?.auftraege ?? []).filter((a) => a.n > 0 && text[a.art]).sort((x, y) => reihenfolge.indexOf(x.art) - reihenfolge.indexOf(y.art));
  };
  const auftraege = sortiert(ART_TEXT);
  const klein = sortiert(KLEIN_TEXT);
  const rigAlt = rig ? s.jetzt - Date.parse(rig.stand) > LEISTUNG_VERALTET_MS : false;
  const seit = rig?.seit ?? null;
  const fg = b?.fristen_geprueft;
  // Rechenzeit der Sicherheits-Rapporte auf dem Rig (Protokoll seit 15.10.), ohne den Weg zur App
  const rapport = b?.auftraege.find((a) => a.art === "sicherheit_rapport" && a.median_ms != null);
  const rapportZeit = rapport?.median_ms != null
    ? `Rechenzeit auf dem Rig ${rapport.ok > 1 ? "Median " : ""}${dauerKurz(rapport.median_ms)}${rapport.max_ms != null && rapport.ok > 1 ? `, längste ${dauerKurz(rapport.max_ms)}` : ""}`
    : "";

  return (
    <section aria-labelledby="td-ki-leistung" aria-busy={laedt} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {kopf}
      <Meta>
        {seit ? `Gemessen seit ${datumLang(seit)}` : "Kennzahlen der lokalen KI"}
        {rig ? ` · Rig-Stand ${rigAlt ? alterText((s.jetzt - Date.parse(rig.stand)) / 1000) : uhr(rig.stand)}` : ""}
        {" · nur Zahlen, keine Namen oder Inhalte"}
      </Meta>
      <div style={{ display: "flex", flexDirection: "column", opacity: laedt ? 0.55 : 1, transition: "opacity 160ms" }}>
        {!rig ? <div style={{ padding: "8px 0", borderTop: `1px solid ${K.line}` }}><Kommt text="Zahlen vom Rig: noch keine Auswertung angekommen" icon="info" /></div> : null}

        {rig ? (
          g && g.dateien > 0 ? (
            <>
              <Kennzahl
                label="Gelesen"
                wert={`${mal(g.dateien, "Dokument", "Dokumente")}${g.seiten ? ` · ${mal(g.seiten, "Seite", "Seiten")}` : ""}`}
                wie={`${g.gescannt ? `davon ${tausend(g.gescannt)} gescannt (Texterkennung). ` : ""}Der Tiefen-Index liest jede Datei der Ablage selbst und macht sie durchsuchbar.`}
              />
              <LesezeitZeile g={g} />
            </>
          ) : (
            <Kennzahl label="Gelesen" wert="keine neuen" wie="In diesem Zeitraum hat der Tiefen-Index keine neuen oder geänderten Dateien gelesen." />
          )
        ) : null}

        <GroesstesZeile groesstes={daten.groesstes} g={g && g.dateien > 0 ? g : null} />

        {rig ? (
          letzter ? (
            <Kennzahl
              label="Richtiger Ordner (Selbsttest)"
              wert={`${letzter.top1 != null ? pct(letzter.top1) : "–"} · ${letzter.top3 != null ? pct(letzter.top3) : "–"}`}
              wie={(() => {
                const o1 = letzter.top1_ohne_name;
                const o3 = letzter.top3_ohne_name;
                const mittel = sm && sm.laeufe > 1 && sm.top1 != null && sm.top3 != null ? `; Ø ${mal(sm.laeufe, "Lauf", "Läufe")} ${pct(sm.top1)} · ${pct(sm.top3)}` : "";
                const zeit = letzter.ms_median != null ? `; ${dauerKurz(letzter.ms_median)} je Datei (Median)` : "";
                // Mit Verlauf erklaert die Legende die zwei Zahlen, sonst der Satz.
                const was = laeufe.length > 1 ? "" : "Erster Vorschlag richtig · richtig unter den ersten drei. ";
                return `${was}Lauf vom ${tagKurz(letzter.am)}${o1 != null && o3 != null ? `; ohne Dateinamen ${pct(o1)} · ${pct(o3)}` : ""}${mittel}. Jede Nacht ordnet die KI ${tausend(letzter.dateien)} schon abgelegte Dateien neu ein, ohne sie selbst als Vorbild${zeit}.`;
              })()}
            >
              {laeufe.length > 1 ? <SelbsttestVerlauf laeufe={laeufe} /> : null}
            </Kennzahl>
          ) : (
            <Kennzahl label="Richtiger Ordner (Selbsttest)" wert="kein Lauf" wie="In diesem Zeitraum lief kein Selbsttest (jede Nacht ab 05:30)." />
          )
        ) : null}

        {auftraege.map((a) => <AuftragZeile key={a.art} a={a} />)}
        <KleineAuftraege liste={klein} />

        <UploadsZeile u={daten.uploads} zeitraum={daten.zeitraum} />
        {daten.ablage.filter((a) => a.vorschlaege > 0 || a.offen > 0 || a.unveraendert + a.geaendert + a.abgelehnt > 0).map((a) => (
          <AblageZeile key={a.logik} a={a} zeitraum={daten.zeitraum} />
        ))}

        <Kennzahl
          label="Fristen aus Verträgen"
          wert={daten.fristen.gefunden ? mal(daten.fristen.gefunden, "gefunden", "gefunden") : "keine gefunden"}
          wie={`${tausend(daten.fristen.bestaetigt)} bestätigt · ${tausend(daten.fristen.verworfen)} verworfen · ${tausend(daten.fristen.offen)} offen${fg?.dateien ? ` · ${mal(fg.dateien, "Dokument", "Dokumente")} geprüft, ${tausend(fg.mit_frist)} mit Frist-Hinweis` : ""}. Die KI liest Kündigungs- und Ablauffristen, ein Admin bestätigt oder verwirft.`}
        />

        {daten.sicherheit.seit ? (
          <Kennzahl
            label="Sicherheits-Rapporte"
            wert={daten.sicherheit.rapporte ? mal(daten.sicherheit.rapporte, "geschrieben", "geschrieben") : "keine"}
            wie={`Die KI schreibt zum täglichen Sicherheits-Check einen Rapport in Klartext, seit ${tagKurz(daten.sicherheit.seit)}${rapportZeit ? `; ${rapportZeit}` : ""}.`}
          />
        ) : null}
      </div>
    </section>
  );
}

