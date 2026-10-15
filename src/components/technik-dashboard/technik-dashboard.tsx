"use client";

// Technik-Dashboard /technik (Mischa 2026-10-12): Rig, lokale KI und NAS als «digitaler Zwilling».
// Vertrag: docs/technik-dashboard/VERTRAG.md §6. Entwurf: gen-main.mjs (Main/Hell.dc.html).
// - Daten: GET /api/technik/stand alle 15 s (reihen=0), Reihen alle 60 s und sofort beim Zeitraum-Wechsel,
//   beides nur bei sichtbarem Tab. Kein Realtime. Fehler: ein Toast pro Fehlerserie, letzte Werte bleiben.
// - Zustand in der URL: ?teil=<bauteil>&bereich=6h|24h|7d (replaceState, kein History-Spam).
// - Nur Admins (Seite gated, API requireAdmin, RLS), nur Laptop (unter 1024 px nur ein Hinweis).
// - Auf einen Blick (Mischa 2026-10-14): Szene und Details fuellen die Fensterhoehe (--td-oben/--td-unten werden
//   gemessen, stil.ts), die Details scrollen intern. Gewaehltes Bauteil = Fokus-Modus der Szene (sicht.ts).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { Laptop, Loader2, Server } from "lucide-react";
import type { Bereich, Reihen, TechnikStand } from "@/lib/technik-dashboard/typen";
import { EmptyState } from "@/components/ui/empty-state";
import { K, st } from "./farben";
import { TECHNIK_CSS, PERIODE, SPALTE_AB_PX, T_ABL_START, T_MESS_AN } from "./stil";
import { BTN, Icon, Ov, NUM } from "./bausteine";
import { Szene } from "./szene";
import { Streifen } from "./streifen";
import { panelInhalt } from "./panels";
import { Banner } from "./banner";
import { BEREICH_TEXT } from "./kurve";
import { alterText, datumLang, uhr } from "./format";
import { ampel } from "./status";
import type { LuefterPhase, LuefterZustand } from "./zeichnung";
import { BEREICH_TEILE, istBereich, istTeil, type Sicht, type TeilKey } from "./sicht";
import { TechnikSkelett } from "./skelett";
import { eckDrehungen, luefterDauer } from "./kuehlung";

const TAKT_STAND_MS = 15_000;
const TAKT_REIHEN_MS = 60_000;
const FUSS = "Nur für Admins · für den Laptop gebaut · Werte vom Rig alle 60 s, Seite aktualisiert sich alle 15 s.";

/** Lage im Dokument ueber offsetTop (unabhaengig von laufenden Einblend-Animationen mit transform). */
function dokOben(el: HTMLElement): number {
  let y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return y;
}

/** Misst, wo die Szene beginnt und was neben der Zeichnung Hoehe braucht; die Zeichnung passt sich so an,
 *  dass Szene und Details ohne Seiten-Scroll ins Fenster passen (CSS in stil.ts: --td-split-h, .td-geraet). */
function useFensterMass(rootRef: RefObject<HTMLDivElement | null>, aktiv: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!aktiv || !root) return;
    let rahmen = 0;
    const setze = (k: string, v: number) => {
      const t = `${Math.max(0, Math.round(v))}px`;
      if (root.style.getPropertyValue(k) !== t) root.style.setProperty(k, t);
    };
    const miss = () => {
      rahmen = 0;
      const split = root.querySelector<HTMLElement>(".td-split");
      if (!split) return;
      setze("--td-oben", dokOben(split));
      const main = root.closest("main");
      setze("--td-unten", main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 24);
      // Rest = alles in der Szene ausser der Zeichnung. Gemessen am Rig-Gehaeuse (inhaltshoch) und am
      // Szenen-Rahmen oberhalb des Rasters, nie an gestreckten Hoehen (sonst schaukelt sich das auf).
      const szene = split.querySelector<HTMLElement>(".td-scene");
      const raster = szene?.querySelector<HTMLElement>(".td-grid");
      const rig = szene?.querySelector<HTMLElement>(".td-rigbox");
      const zeichnung = rig?.querySelector<HTMLElement>(".td-gehaeuse");
      if (!szene || !raster || !rig || !zeichnung) return;
      const rahmenOben = dokOben(raster) - dokOben(szene);
      const rahmenUnten = parseFloat(getComputedStyle(szene).paddingBottom) || 0;
      setze("--td-rest", rahmenOben + rahmenUnten + rig.offsetHeight - zeichnung.offsetHeight);
    };
    const plane = () => {
      if (!rahmen) rahmen = requestAnimationFrame(miss);
    };
    miss();
    const ro = new ResizeObserver(plane);
    ro.observe(root);
    window.addEventListener("resize", plane);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", plane);
      if (rahmen) cancelAnimationFrame(rahmen);
    };
  }, [rootRef, aktiv]);
}

// ---- Laptop-Pruefung (Fensterbreite) ----
const MQ = "(min-width: 1024px)";
function abonniereBreite(cb: () => void) {
  const m = window.matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const istBreit = () => window.matchMedia(MQ).matches;
/** Laptop-Breite (ab 1024 px) — auch für den Tab «Wissen» (technik-seite.tsx). */
export const useBreit = () => useSyncExternalStore(abonniereBreite, istBreit, () => true);

// ---- Luefter: Anlauf/Auslauf wie im Entwurf (Rotor A dreht 3 Blatt-Teilungen, Rotor B gleichmaessig) ----
const dauer = luefterDauer;
const tAnlauf = (p: number) => 0.857 * dauer(p) * 1000;

function useLuefter(p: number): LuefterZustand {
  const [z, setZ] = useState<{ phase: LuefterPhase; p: number; pd: number; quelle: number }>(() => ({ phase: p > 0 ? "laeuft" : "steht", p, pd: p, quelle: p }));
  if (z.quelle !== p) {
    // Wechsel des Messwerts: Uebergang im Render ableiten (kein Effekt-setState)
    if (p > 0 && (z.phase === "steht" || z.phase === "auslauf")) setZ({ phase: "anlauf", p, pd: p, quelle: p });
    else if (p === 0 && (z.phase === "laeuft" || z.phase === "anlauf")) setZ({ phase: "auslauf", p: z.p, pd: z.p, quelle: p });
    else setZ({ phase: p > 0 ? "laeuft" : "steht", p, pd: p > 0 ? p : z.pd, quelle: p });
  }
  useEffect(() => {
    if (z.phase !== "anlauf" && z.phase !== "auslauf") return;
    const t = setTimeout(() => {
      setZ((a) => (a.phase === "anlauf" ? { ...a, phase: "laeuft" } : a.phase === "auslauf" ? { ...a, phase: "steht", p: 0 } : a));
    }, Math.round(tAnlauf(z.pd)) + 60);
    return () => clearTimeout(t);
  }, [z.phase, z.pd]);
  const bezug = z.pd || z.p;
  return { phase: z.phase, d: `${dauer(bezug).toFixed(2)}s`, t: `${(tAnlauf(bezug) / 1000).toFixed(2)}s`, schnell: z.p >= 60 };
}

const mod = (x: number) => ((x % PERIODE) + PERIODE) % PERIODE;
const abstand = (a: number, b: number) => {
  const d = mod(a - b);
  return Math.min(d, PERIODE - d);
};

interface Takt { s: "" | "a" | "b"; m: number; a: number }

function leseUrl(): { teil: TeilKey | null; bereich: Bereich } {
  if (typeof window === "undefined") return { teil: null, bereich: "6h" };
  const q = new URLSearchParams(window.location.search);
  const t = q.get("teil");
  const b = q.get("bereich");
  return { teil: istTeil(t) ? t : null, bereich: istBereich(b) ? b : "6h" };
}

function schreibeUrl(teil: TeilKey | null, bereich: Bereich) {
  const q = new URLSearchParams(window.location.search);
  if (teil) q.set("teil", teil);
  else q.delete("teil");
  if (bereich !== "6h") q.set("bereich", bereich);
  else q.delete("bereich");
  const s = q.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
}

async function holeStand(bereich: Bereich, reihen: boolean, signal?: AbortSignal): Promise<TechnikStand> {
  const r = await fetch(`/api/technik/stand?bereich=${bereich}&reihen=${reihen ? 1 : 0}`, { cache: "no-store", signal });
  const j = (await r.json().catch(() => null)) as (TechnikStand & { error?: string }) | null;
  if (!r.ok || !j || j.success !== true) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

/** `tabs`: die Tab-Zeile der Seite (technik-seite.tsx) — steht unter der Kopfzeile, in jedem Zustand mit Kopf. */
export function TechnikDashboard({ tabs }: { tabs?: ReactNode } = {}) {
  const breit = useBreit();
  const start = useMemo(leseUrl, []);
  const [stand, setStand] = useState<TechnikStand | null>(null);
  const [empfangen, setEmpfangen] = useState(0);
  const [erstFehler, setErstFehler] = useState(false);
  const [abrufFehler, setAbrufFehler] = useState(false);
  const [r24, setR24] = useState<Reihen | null>(null);
  const [rSel, setRSel] = useState<Reihen | null>(null);
  const [bereich, setBereich] = useState<Bereich>(start.bereich);
  const [bereichLaedt, setBereichLaedt] = useState(false);
  const [teil, setTeil] = useState<TeilKey | null>(start.teil);
  const [phase, setPhase] = useState<"ruhe" | "raus" | "zu">("ruhe");
  const [wechsel, setWechsel] = useState<"panel" | "bereich">("panel");
  const [takt, setTakt] = useState<Takt>({ s: "", m: 0, a: 0 });
  const [neuLaden, setNeuLaden] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const fehlerGemeldet = useRef(false);
  const anker = useRef<{ m: number | null; a: number | null }>({ m: null, a: null });
  const bereichRef = useRef(bereich);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zurueck = useRef<HTMLElement | null>(null);

  // ---- Laden ----
  const meldeFehler = useCallback((e: unknown) => {
    setAbrufFehler(true);
    if (!fehlerGemeldet.current) {
      fehlerGemeldet.current = true;
      toast.error("Technik-Stand konnte nicht geladen werden", { description: e instanceof Error && e.message.startsWith("HTTP") ? `Antwort der App: ${e.message}. Die letzten Werte bleiben stehen.` : "Die letzten Werte bleiben stehen." });
    }
  }, []);

  const uebernimm = useCallback((st_: TechnikStand) => {
    const empf = Date.now();
    const versatz = Date.parse(st_.jetzt) - empf; // Server minus Browser
    setStand(st_);
    setEmpfangen(empf);
    setAbrufFehler(false);
    setErstFehler(false);
    fehlerGemeldet.current = false;
    // Takt-Nullpunkte aus den echten Zeitstempeln (Browser-Uhr)
    const t0m = st_.ki_alter_s != null ? empf - st_.ki_alter_s * 1000 - T_MESS_AN : null;
    const poll = st_.fsm.sync.letzter_poll ? Date.parse(st_.fsm.sync.letzter_poll) - versatz : null;
    const t0a = poll != null ? poll - T_ABL_START : null;
    const alt = anker.current;
    const neuM = t0m != null && (alt.m == null || abstand(t0m, alt.m) > 2000);
    const neuA = t0a != null && (alt.a == null || abstand(t0a, alt.a) > 2000);
    if (neuM || neuA) {
      anker.current = { m: neuM ? t0m : alt.m, a: neuA ? t0a : alt.a };
      const am = anker.current.m, aa = anker.current.a;
      setTakt((t) => ({ s: t.s === "a" ? "b" : "a", m: am != null ? mod(empf - am) : 0, a: aa != null ? mod(empf - aa) : 0 }));
    }
  }, []);

  const ladeStand = useCallback(async () => {
    try {
      uebernimm(await holeStand("24h", false));
    } catch (e) {
      setErstFehler((alt) => alt || stand == null);
      meldeFehler(e);
    }
  }, [uebernimm, meldeFehler, stand]);

  const ladeReihen = useCallback(async (b: Bereich) => {
    try {
      const auftraege = [holeStand(b, true)];
      if (b !== "24h") auftraege.push(holeStand("24h", true));
      const [haupt, tag] = await Promise.all(auftraege);
      if (bereichRef.current === b) setRSel(haupt.reihen);
      setR24((tag ?? haupt).reihen);
    } catch (e) {
      meldeFehler(e);
    } finally {
      if (bereichRef.current === b) setBereichLaedt(false);
    }
  }, [meldeFehler]);

  // Abruf-Takt: nur bei sichtbarem Tab und Laptop-Breite
  const ladeStandRef = useRef(ladeStand);
  const ladeReihenRef = useRef(ladeReihen);
  useEffect(() => {
    ladeStandRef.current = ladeStand;
    ladeReihenRef.current = ladeReihen;
  });
  useEffect(() => {
    if (!breit) return;
    const sichtbar = () => document.visibilityState === "visible";
    void ladeStandRef.current();
    void ladeReihenRef.current(bereichRef.current);
    const a = setInterval(() => { if (sichtbar()) void ladeStandRef.current(); }, TAKT_STAND_MS);
    const b = setInterval(() => { if (sichtbar()) void ladeReihenRef.current(bereichRef.current); }, TAKT_REIHEN_MS);
    const onSicht = () => {
      if (!sichtbar()) return;
      void ladeStandRef.current();
      void ladeReihenRef.current(bereichRef.current);
    };
    document.addEventListener("visibilitychange", onSicht);
    return () => {
      clearInterval(a);
      clearInterval(b);
      document.removeEventListener("visibilitychange", onSicht);
    };
  }, [breit]);

  useFensterMass(rootRef, breit && !!stand?.hat_daten);

  // ---- Auswahl / Schublade ----
  const eng = () => (rootRef.current?.clientWidth ?? 0) < SPALTE_AB_PX;
  const ruhe = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fokusTitel = () => {
    setTimeout(() => {
      const h = document.querySelector<HTMLElement>("#td-details .td-panel-titel");
      h?.focus();
    }, 60);
  };

  const waehle = useCallback((k: TeilKey) => {
    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    const offen = teil != null;
    if (offen && k === teil) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && !a.closest("#td-details")) zurueck.current = a;
    const setze = () => {
      setTeil(k);
      setPhase("ruhe");
      setWechsel("panel");
      schreibeUrl(k, bereichRef.current);
      if (eng()) fokusTitel();
    };
    if (!offen || ruhe()) {
      setze();
      return;
    }
    setPhase("raus");
    phaseTimer.current = setTimeout(setze, 120);
  }, [teil]);

  const schliesse = useCallback(() => {
    if (teil == null) return;
    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    const fertig = () => {
      setTeil(null);
      setPhase("ruhe");
      setWechsel("panel");
      schreibeUrl(null, bereichRef.current);
      const z = zurueck.current;
      zurueck.current = null;
      if (z && document.contains(z)) setTimeout(() => z.focus(), 60);
    };
    if (!eng() || ruhe()) {
      fertig();
      return;
    }
    setPhase("zu");
    phaseTimer.current = setTimeout(fertig, 180);
  }, [teil]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && teil != null) schliesse();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [teil, schliesse]);
  useEffect(() => () => { if (phaseTimer.current) clearTimeout(phaseTimer.current); }, []);

  const waehleBereich = (b: Bereich) => {
    if (b === bereich) return;
    bereichRef.current = b;
    setBereich(b);
    setWechsel("bereich");
    setBereichLaedt(true);
    if (b === "24h" && r24) setRSel(r24);
    else setRSel(null);
    schreibeUrl(teil, b);
    void ladeReihen(b);
  };

  // ---- Luefter (nur echte Werte; veraltete Messung -> still) ----
  const frisch = stand ? ampel(stand.ampeln, "messwerte.frische")?.stufe === "gut" : false;
  const gpuP = frisch ? Math.max(0, Math.min(100, stand?.rig?.gpu?.luefter_prozent ?? 0)) : 0;
  const luefter = useLuefter(Math.round(gpuP));
  // Gehaeuseluefter vorne: echte Drehzahlen aus rig.kuehlung (je Luefter), sonst wie bisher cpu.luefter_rpm
  const eckDreh = eckDrehungen(stand?.rig ?? null, frisch);

  // ---- Darstellung ----
  const stil = <style dangerouslySetInnerHTML={{ __html: TECHNIK_CSS }} />;

  if (!breit) {
    return (
      <div className="page-enter">
        <EmptyState icon={Laptop} title="Technik ist für den Laptop gebaut" description="Die Technik-Seite braucht ein breites Fenster. Bitte am Laptop öffnen oder das Fenster breiter ziehen." />
      </div>
    );
  }

  if (!stand) {
    if (erstFehler) {
      return (
        <div className="page-enter flex flex-col gap-2.5">
          {tabs ? (
            <>
              <h1 style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, margin: 0, fontFamily: "var(--font-heading)" }}>Technik</h1>
              {tabs}
            </>
          ) : null}
          <EmptyState
            icon={Server}
            title="Technik-Stand konnte nicht geladen werden"
            description="Die App hat keine Antwort geliefert. Bitte gleich nochmals versuchen."
            action={
              <button
                type="button"
                className="kasten kasten-blue"
                disabled={neuLaden}
                onClick={async () => {
                  setNeuLaden(true);
                  fehlerGemeldet.current = false;
                  await ladeStand();
                  setNeuLaden(false);
                }}
              >
                {neuLaden ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {neuLaden ? "Wird geladen…" : "Nochmals laden"}
              </button>
            }
          />
        </div>
      );
    }
    return <TechnikSkelett tabs={tabs} />;
  }

  const jetzt = Date.parse(stand.jetzt);
  const sel: TeilKey = teil ?? "uebersicht";
  const offen = teil != null;
  const s: Sicht = { stand, jetzt, sel, offen, waehle, reihen24: r24, reihen: rSel, bereich, abrufFehler, aktualisiere: () => ladeStandRef.current() };
  const rootStil = { ["--td-m" as string]: String(Math.round(takt.m)), ["--td-a" as string]: String(Math.round(takt.a)) } as CSSProperties;

  if (!stand.hat_daten) {
    return (
      <div ref={rootRef} className="technik-zwilling page-enter" data-takt={takt.s} style={rootStil}>
        {stil}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Kopfzeile stand={stand} empfangen={empfangen} abrufFehler={abrufFehler} />
          {tabs}
          <div style={{ borderRadius: 14, background: K.e1, boxShadow: `0 0 0 1px ${K.hair}` }}>
            <EmptyState icon={Server} title="Noch keine Messwerte vom Rig" description="Sobald das Rig seine ersten Messwerte schickt, erscheint hier der digitale Zwilling. Was ohne Rig geht, steht schon darunter." />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 16, alignItems: "start" }}>
            {(["backup", "ablage", "index"] as const).map((t) => (
              <div key={t} className="td-panel" style={{ display: "flex", flexDirection: "column", gap: 16, borderRadius: 14, padding: "16px 18px", background: K.e1, boxShadow: `0 0 0 1px ${K.hair}` }}>
                {panelInhalt(t, { ...s, sel: t, offen: true, waehle: () => {} })}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const zeigeBereich = BEREICH_TEILE.includes(sel);
  return (
    <div ref={rootRef} className="technik-zwilling page-enter" data-takt={takt.s} style={rootStil}>
      {stil}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Kopfzeile stand={stand} empfangen={empfangen} abrufFehler={abrufFehler} />
        {tabs}
        <Banner s={s} />
        <div className="td-split">
          <Szene s={s} luefter={luefter} eckDreh={eckDreh} schliesse={schliesse} />
          <aside
            id="td-details"
            className="td-aside"
            data-open={offen ? "true" : "false"}
            data-phase={phase}
            data-wechsel={wechsel}
            aria-label="Details zum gewählten Bauteil"
            style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderRadius: 14, background: K.e1 }}
          >
            <div style={{ flex: "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minHeight: 46, padding: "8px 12px 8px 18px", borderBottom: `1px solid ${K.line}` }}>
              <Ov t={offen && sel !== "uebersicht" ? "Details" : "Übersicht"} />
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {zeigeBereich ? (
                  <div role="group" aria-label="Zeitraum der Kurven" style={{ display: "inline-flex", gap: 2, padding: 2, boxShadow: `inset 0 0 0 1px ${K.line}`, borderRadius: 9 }}>
                    {(["6h", "24h", "7d"] as const).map((b) => (
                      <button key={b} type="button" aria-pressed={bereich === b} aria-label={`Verlauf ${BEREICH_TEXT[b]}`} onClick={() => waehleBereich(b)} style={{ ...BTN, display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 12, borderRadius: 7, ...NUM }}>
                        {bereich === b && bereichLaedt ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        <span>{BEREICH_TEXT[b]}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {offen ? (
                  <button type="button" onClick={schliesse} aria-label="Details schliessen (Esc)" data-tooltip="Schliessen (Esc)" style={{ ...BTN, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, boxShadow: `inset 0 0 0 1px ${K.line}` }}>
                    <Icon n="x" s={15} c={K.text} />
                  </button>
                ) : null}
              </span>
            </div>
            <div className="td-panelwrap" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "14px 18px 18px" }}>
              <div key={sel} className="td-panel" data-panel={sel} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {panelInhalt(sel, s)}
              </div>
            </div>
          </aside>
        </div>
        {/* Schmales Fenster (Details als Schublade): Streifen als eigene Karte unter der Szene. */}
        <div className="td-lade-streifen td-streifen-unten">
          <Streifen s={s} />
        </div>
      </div>
    </div>
  );
}

/** Seitenkopf mit Frische-Anzeige (tickt jede Sekunde, unabhaengig von der Szene). */
function Kopfzeile({ stand, empfangen, abrufFehler }: { stand: TechnikStand; empfangen: number; abrufFehler: boolean }) {
  const [sek, setSek] = useState(0);
  useEffect(() => {
    const tick = () => setSek(Math.max(0, Math.round((Date.now() - empfangen) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [empfangen]);
  const fr = ampel(stand.ampeln, "messwerte.frische");
  const alter = stand.rig_alter_s != null ? stand.rig_alter_s + sek : null;
  const ton = abrufFehler ? "warn" : fr?.stufe === "gut" ? "gut" : fr?.stufe === "kritisch" ? "krit" : fr?.stufe === "warnung" ? "warn" : "neutral";
  const jetzt = Date.parse(stand.jetzt);
  return (
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px 16px", flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "2px 12px", flexWrap: "wrap", minWidth: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, margin: 0, fontFamily: "var(--font-heading)" }}>Technik</h1>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: K.mute, ...NUM }}>
          Rig, lokale KI und NAS · Stand {datumLang(jetzt)}, {uhr(jetzt)} · aktualisiert sich alle 15 s
          <span tabIndex={0} role="note" aria-label={FUSS} data-tooltip={FUSS} style={{ display: "inline-flex", cursor: "help" }}>
            <Icon n="laptop" s={14} c={K.mute} />
          </span>
        </span>
      </div>
      <div role="status" aria-live="off" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", borderRadius: 999, background: K.e1, boxShadow: `0 0 0 1px ${K.hair}`, fontSize: 12, ...NUM }}>
        <span className="td-herz" data-an={ton === "gut" ? "true" : "false"} style={{ display: "inline-flex" }}>
          <Icon n={abrufFehler ? "triangle-alert" : "activity"} s={13} c={st(ton, "ic")} />
        </span>
        {abrufFehler ? (
          <span style={{ fontWeight: 600 }}>Keine Antwort der App · Stand {uhr(jetzt)}</span>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>Messwerte <span style={{ display: "inline-block", minWidth: "8.5ch" }}>{alter != null ? alterText(alter) : "fehlen"}</span></span>
            <span style={{ color: K.mute }}>· Rig sendet alle 60 s</span>
          </>
        )}
      </div>
    </header>
  );
}
