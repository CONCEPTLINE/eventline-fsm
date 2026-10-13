// Technik-Dashboard: Szene «digitaler Zwilling» — Rig im Gehaeuse, KI-Bildschirm, Dienste, EVENTLINE-App,
// Leitungen mit Datenfluss im echten Takt und NAS-Front. Port aus gen-main.mjs (scene()).
// Werte kommen aus GET /api/technik/stand, Stufen aus den Ampeln des Servers.
//
// Uebersicht (Mischa 2026-10-14): je Bauteil nur der wichtigste Wert plus Zustand; alles Weitere steht im
// Detail-Panel. Fokus-Modus: ein gewaehltes Bauteil hebt sich ab, der Rest der Szene wird gedimmt
// (sicht.ts). Zurueck: Esc, Schliessen-Knopf, Klick ins Leere der Szene oder erneuter Klick aufs Bauteil.
// Hover = Vorschau (state-driven, verbindet Fahne und Bauteil in der Zeichnung).

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Ampel, Bauteil } from "@/lib/technik-dashboard/typen";
import { GRENZEN } from "@/lib/technik-dashboard/konstanten";
import { K, st } from "./farben";
import { BTN, Chip, Icon, Meta, NUM, Num, Ov, Puls, Quiet, Ring } from "./bausteine";
import { Gehaeuse, NasFront, Rueckkammer, type LuefterZustand } from "./zeichnung";
import { alterText, gbBin, groesseDez, komma, prozent, uhr, uhrSek, zeitpunkt, zeitpunktKurz } from "./format";
import { ampel, anzeigeVon, bauteilAnzeige, type Anzeige } from "./status";
import { GERAET, fokusVon, geraetGedimmt, geraetVorschau, teilGedimmt, type Geraet, type Sicht, type TeilKey } from "./sicht";

const PART_FX: CSSProperties = { background: K.e3, boxShadow: K.partFx };
const LADE: Partial<Record<TeilKey, number>> = { app: 80, cpu: 100, nas: 110, gpu: 125, index: 135, ram: 150, hardware: 160, platten: 175, dienste: 190, ki: 210 };
const ja = (b: boolean) => (b ? "true" : "false");

/** Zustand eines Bauteils in der Szene (Auswahl, Fokus-Dimmung, Hover-Vorschau, Zustandsfarbe). */
interface Bt {
  an: boolean;
  dim: boolean;
  vorschau: boolean;
  /** CSS-Farbe fuer den Schein im Fokus. */
  ton: string;
  klick: () => void;
  zeige: (an: boolean) => void;
}

const btAttr = (b: Bt) => ({
  "aria-pressed": b.an,
  "data-dim": ja(b.dim),
  "data-vorschau": ja(b.vorschau),
  onClick: b.klick,
  onMouseEnter: () => b.zeige(true),
  onMouseLeave: () => b.zeige(false),
});

/** Schluss der Vorleser-Beschriftung: ein gewaehltes Bauteil schliesst beim erneuten Klick. */
const aktion = (b: Bt) => (b.an ? "Details schliessen" : "Details öffnen");

function Part({ teil, b, label, style, r = 11, children }: { teil: TeilKey; b: Bt; label: string; style?: CSSProperties; r?: number; children: ReactNode }) {
  return (
    <button
      type="button"
      className="td-part td-lade"
      data-part={teil}
      aria-controls="td-details"
      aria-label={label}
      {...btAttr(b)}
      style={{ ...BTN, position: "relative", minWidth: 0, borderRadius: r, animationDelay: `${LADE[teil] ?? 200}ms`, ["--td-ton" as string]: b.ton, ...style }}
    >
      <Ring r={r} inset={-4} />
      <span className="td-cq" style={{ position: "relative", zIndex: 1, display: "block", width: "100%", height: "100%", containerType: "inline-size" }}>{children}</span>
    </button>
  );
}

function Fahne({ teil, b, label, children }: { teil: TeilKey; b: Bt; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="td-part td-lade td-fahne"
      data-part={teil}
      aria-controls="td-details"
      aria-label={label}
      {...btAttr(b)}
      style={{ ...BTN, position: "relative", minWidth: 0, borderRadius: 10, ...PART_FX, display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "stretch", animationDelay: `${LADE[teil] ?? 200}ms`, ["--td-ton" as string]: b.ton }}
    >
      <Ring r={10} inset={-4} />
      <span style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 3, padding: "7px 9px 8px", minWidth: 0 }}>{children}</span>
    </button>
  );
}

const WertZeile = ({ children, chip }: { children: ReactNode; chip: ReactNode }) => (
  <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", minWidth: 0 }}>
    <span style={{ display: "flex", alignItems: "baseline", gap: "2px 6px", flexWrap: "wrap", minWidth: 0 }}>{children}</span>
    <span style={{ marginLeft: "auto", display: "inline-flex" }}>{chip}</span>
  </span>
);

const Hdr = ({ t, n, chip }: { t: string; n: string; chip: ReactNode }) => (
  <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", minWidth: 0 }}>
    <Ov t={t} n={n} />
    {chip}
  </span>
);

/** Duenner Fuellbalken, folgt dem Messwert weich. */
const Fuell = ({ anteil, h = 3, farbe = K.A }: { anteil: number; h?: number; farbe?: string }) => (
  <span aria-hidden="true" style={{ position: "relative", display: "block", height: h, borderRadius: 999, overflow: "hidden", background: K.track }}>
    <span className="td-balken td-folgt" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "100%", borderRadius: 999, background: farbe, transformOrigin: "left center", transform: `scaleX(${Math.max(0.012, Math.min(1, anteil)).toFixed(4)})` }} />
  </span>
);

const StatusChip = ({ a }: { a: Anzeige }) => (a.ton === "warn" || a.ton === "krit" ? <Puls ton={a.ton}><Chip a={a} /></Puls> : <Chip a={a} />);

/** Kurzform fuer Vorleser: «gut», «Warnung» … */
const wortKlein = (a: Anzeige) => (a.ton === "gut" ? "gut" : a.wort);

/** Buchse auf der Gehaeusekante; «blitz» = Ring, der beim Ankommen eines Pakets kurz aufleuchtet. */
const BuchseH = ({ seite, blitz = false }: { seite: "left" | "right"; blitz?: boolean }) => (
  <span aria-hidden="true" style={{ position: "absolute", [seite]: -5, top: "50%", width: 10, height: 6, marginTop: -3, borderRadius: 2, background: K.port, boxShadow: K.portFx, zIndex: 2 }}>
    {blitz ? <span className="td-blitz" style={{ position: "absolute", inset: -4, borderRadius: 5, boxShadow: `0 0 0 1.5px ${K.flow}`, opacity: 0 }} /> : null}
  </span>
);
const BuchseV = ({ seite }: { seite: "top" | "bottom" }) => (
  <span aria-hidden="true" style={{ position: "absolute", [seite]: -5, left: "50%", width: 6, height: 10, marginLeft: -3, borderRadius: 2, background: K.port, boxShadow: K.portFx, zIndex: 2 }} />
);

/** Paket-Wagen: ganze Leitungsbreite, wandert per translateX(0 -> 100 %), rueck = gespiegelt. */
function Wagen({ art, rueck = false, ring = false }: { art: string; rueck?: boolean; ring?: boolean }) {
  const sz = ring ? 5 : 8;
  return (
    <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 12, marginTop: -6, overflow: "hidden", pointerEvents: "none", zIndex: 1, transform: rueck ? "scaleX(-1)" : undefined }}>
      <span className="td-paket" data-paket={art} style={{ position: "absolute", left: 0, right: 0, top: 6, height: 0, display: "block", opacity: 0 }}>
        {ring ? (
          <span style={{ position: "absolute", left: -2.5, top: -2.5, width: 5, height: 5, borderRadius: "50%", boxShadow: `inset 0 0 0 1.25px ${K.flow}` }} />
        ) : (
          <>
            <span style={{ position: "absolute", left: -40, top: -1, width: 40, height: 2, borderRadius: 1, background: `linear-gradient(90deg,rgba(0,0,0,0),${K.flow})`, opacity: 0.35 }} />
            <span style={{ position: "absolute", left: -sz / 2, top: -sz / 2, width: sz, height: sz, borderRadius: "50%", background: K.flow }} />
          </>
        )}
      </span>
    </span>
  );
}

function Etikett({ a, b }: { a: string; b?: string }) {
  return (
    <span style={{ position: "relative", zIndex: 2, display: "inline-flex", flexDirection: "column", alignItems: "center", padding: "3px 7px", borderRadius: 6, background: K.e1, boxShadow: `0 0 0 1px ${K.hair}`, fontSize: 10.5, lineHeight: "13px", ...NUM, whiteSpace: "nowrap" }}>
      <span style={{ fontWeight: 700 }}>{a}</span>
      {b ? <span style={{ color: K.mute }}>{b}</span> : null}
    </span>
  );
}

const linieStil = (unterbrochen: boolean): CSSProperties => ({
  position: "absolute", left: 0, right: 0, top: "50%", height: 2, marginTop: -1, zIndex: 1, transformOrigin: "left center",
  background: unterbrochen ? `repeating-linear-gradient(90deg,${K.wire} 0 4px,rgba(0,0,0,0) 4px 14px)` : K.wire,
});

function Leitung({ teil, b, label, a, zweit, zeile, fluss, mess, auftrag, verz, unterbrochen, chip, children }: {
  teil: TeilKey; b: Bt; label: string; a: string; zweit: string; zeile: number; fluss: boolean; mess?: boolean; auftrag?: boolean; verz: number; unterbrochen: boolean; chip: ReactNode; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="td-part td-wire"
      data-part={teil}
      data-fluss={fluss ? "an" : "aus"}
      data-mess={mess ? "an" : "aus"}
      data-auftrag={auftrag ? "an" : "aus"}
      aria-controls="td-details"
      aria-label={label}
      {...btAttr(b)}
      style={{ ...BTN, gridColumn: 2, gridRow: zeile, alignSelf: "stretch", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 60, borderRadius: 10, ["--td-ton" as string]: b.ton }}
    >
      <span aria-hidden="true" className="td-linie" style={{ ...linieStil(unterbrochen), animationDelay: `${verz}ms` }} />
      {children}
      <span className="td-etikett" style={{ position: "absolute", left: 0, right: 0, bottom: "calc(50% + 9px)", zIndex: 2, display: "flex", justifyContent: "center", animationDelay: `${verz + 160}ms` }}>
        <span style={{ position: "relative", display: "inline-flex", borderRadius: 7 }}>
          <Ring r={7} inset={-3} kerbe={false} />
          <Etikett a={a} b={zweit} />
        </span>
      </span>
      {chip ? <span style={{ position: "absolute", left: 0, right: 0, top: "calc(50% + 9px)", zIndex: 2, display: "flex", justifyContent: "center" }}>{chip}</span> : null}
    </button>
  );
}

const RIG_INFO = "Blick von links durch das Glas. Netzteil und SSD sitzen in der Rückkammer hinter dem Mainboard.";

export interface SzeneProps {
  s: Sicht;
  luefter: LuefterZustand;
  eckDreh: string | null;
  /** Zurueck zur Uebersicht (Fokus aufheben). */
  schliesse: () => void;
}

export function Szene({ s, luefter, eckDreh, schliesse }: SzeneProps) {
  const { stand, jetzt } = s;
  const A: Ampel[] = stand.ampeln;
  const rig = stand.rig;
  const ki = stand.ki;
  const nas = stand.nas;
  const fsm = stand.fsm;
  const b = (t: Bauteil) => bauteilAnzeige(A, t);

  // ---- Fokus und Hover-Vorschau ----
  const fokus = fokusVon(s);
  const [vorschau, setVorschau] = useState<Bauteil | null>(null);
  const zeigeTeil = (t: Bauteil) => (an: boolean) => setVorschau((v) => (an ? t : v === t ? null : v));
  const klick = (t: Bauteil) => (s.offen && s.sel === t ? schliesse() : s.waehle(t));
  /** Bauteil-Zustand; dim = eigene Regel fuer Strecken (ganzes «Geraet»), sonst innerhalb des Geraets. */
  const bt = (t: Bauteil, a: Anzeige, dim: boolean = teilGedimmt(fokus, t)): Bt => ({
    an: s.offen && s.sel === t,
    dim,
    vorschau: vorschau === t,
    ton: st(a.ton, "edge"),
    klick: () => klick(t),
    zeige: zeigeTeil(t),
  });
  const geraetAttr = (g: Geraet) => ({ "data-dim": ja(geraetGedimmt(fokus, g)), "data-vorschau": ja(geraetVorschau(vorschau, g)) });
  // Klick ins Leere der Szene (kein Bauteil, kein Knopf): zurueck zur Uebersicht.
  const insLeere = (e: MouseEvent<HTMLElement>) => {
    if (!s.offen || s.sel === "uebersicht") return;
    if ((e.target as HTMLElement).closest("button, a, .td-hw, [data-tooltip]")) return;
    if (window.getSelection()?.toString()) return; // Text markiert, kein Klick ins Leere
    schliesse();
  };

  // ---- Rig ----
  const cpu = rig?.cpu;
  const ram = rig?.ram;
  const gpu = rig?.gpu;
  const sys = rig?.platten?.system;
  const online = ampel(A, "verbindung.online");
  const onlineA = online ? anzeigeVon(online) : null;
  const onlineWort = !online ? "Unbekannt" : online.stufe === "gut" ? "Online" : online.stufe === "warnung" ? "Verzögert" : online.stufe === "kritisch" ? "Offline" : anzeigeVon(online).wort;
  const laeuftSeit = rig?.uptime_s != null && rig.gemessen_am ? Date.parse(rig.gemessen_am) - rig.uptime_s * 1000 : null;

  const cpuA = b("cpu");
  const ramA = b("ram");
  const gpuA = b("gpu");
  const plA = b("platten");
  const ramNutzbar = ram?.gesamt_b != null ? gbBin(ram.gesamt_b) : null;
  const ramFrei = ram?.verfuegbar_b != null ? gbBin(ram.verfuegbar_b) : null;
  const ramBelegt = ramNutzbar != null && ramFrei != null ? ramNutzbar - ramFrei : null;
  const rechnet = !!ki?.auftrag;
  const sysPct = sys ? prozent(sys.belegt_b, sys.gesamt_b) : null;
  const ssdText = sys ? `SSD · ${groesseDez(sys.gesamt_b, true)}` : "SSD";
  const rigFokus = fokus != null && GERAET[fokus] === "rig" ? fokus : null;

  const cpuB = bt("cpu", cpuA);
  const cpuF = (
    <Fahne teil="cpu" b={cpuB} label={`Prozessor: ${wortKlein(cpuA)}, ${cpu?.temp_c != null ? `${Math.round(cpu.temp_c)} Grad` : "Temperatur unbekannt"}, Last ${cpu?.last_prozent != null ? Math.round(cpu.last_prozent) : "unbekannt"} Prozent${cpu?.takt_mhz != null ? `, Takt ${komma(cpu.takt_mhz / 1000)} Gigahertz` : ""}. ${aktion(cpuB)}`}>
      <Ov t="Prozessor" n="01" eng />
      <WertZeile chip={<StatusChip a={cpuA} />}>
        <Num v={cpu?.last_prozent != null ? Math.round(cpu.last_prozent) : "–"} u="%" size={18} ch={3} />
        <span style={{ fontSize: 11.5, color: K.sub }}>Last</span>
      </WertZeile>
    </Fahne>
  );

  const ramB = bt("ram", ramA);
  const ramF = (
    <Fahne teil="ram" b={ramB} label={`Arbeitsspeicher: ${wortKlein(ramA)}, ${ramFrei != null ? `${komma(ramFrei)} GB frei` : "frei unbekannt"}${ramNutzbar != null ? ` von ${Math.round(ramNutzbar)} GB nutzbar` : ""}${ram?.eingebaut_gb ? `, ${ram.eingebaut_gb} GB eingebaut` : ""}. Trust one nur als Summe. ${aktion(ramB)}`}>
      <Ov t="Arbeitsspeicher" n="02" eng />
      <WertZeile chip={<StatusChip a={ramA} />}>
        <Num v={ramFrei != null ? komma(ramFrei) : "–"} u="GB frei" size={18} ch={4} />
      </WertZeile>
      <Fuell anteil={ramBelegt != null && ramNutzbar ? ramBelegt / ramNutzbar : 0} />
    </Fahne>
  );

  const gpuB = bt("gpu", gpuA);
  const gpuF = (
    <Fahne teil="gpu" b={gpuB} label={`Grafikkarte: ${wortKlein(gpuA)}, ${gpu?.temp_c != null ? `${Math.round(gpu.temp_c)} Grad` : "Temperatur unbekannt"}, Auslastung ${gpu?.last_prozent ?? "unbekannt"} Prozent, Lüfter ${gpu?.luefter_prozent ?? "unbekannt"} Prozent. ${aktion(gpuB)}`}>
      <Ov t="Grafikkarte" n="03" eng />
      <WertZeile chip={<StatusChip a={gpuA} />}>
        <Num v={gpu?.last_prozent != null ? Math.round(gpu.last_prozent) : "–"} u="%" size={18} />
        <span style={{ fontSize: 11.5, color: K.sub, ...NUM, whiteSpace: "nowrap" }}>{rechnet || (gpu?.last_prozent ?? 0) > 5 ? "rechnet" : "ruht"}{gpu?.watt != null ? ` · ${Math.round(gpu.watt)} W` : ""}</span>
      </WertZeile>
    </Fahne>
  );

  const plB = bt("platten", plA);
  const ssdAktiv = A.some((x) => x.schluessel === "ablage.sync" && x.stufe === "gut");
  const ssdF = (
    <Fahne teil="platten" b={plB} label={`SSD: ${wortKlein(plA)}${sysPct != null ? `, ${Math.round(sysPct)} Prozent belegt` : ""}. Sitzt in der Rückkammer hinter dem Mainboard, unter dem Netzteil. ${aktion(plB)}`}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <Rueckkammer breite={24} />
        <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
          <Ov t={ssdText} n="04" eng />
          <WertZeile chip={<StatusChip a={plA} />}>
            <Num v={sysPct != null ? Math.round(sysPct) : "–"} u="%" size={18} ch={3} />
            <span aria-hidden="true" className="td-ssd-led" data-an={ja(ssdAktiv)} style={{ alignSelf: "center", width: 5, height: 5, borderRadius: "50%", background: K.A, opacity: 0.3 }} />
          </WertZeile>
        </span>
      </span>
      <Fuell anteil={(sysPct ?? 0) / 100} />
    </Fahne>
  );

  // ---- Dienste ----
  const dienste = rig?.dienste ?? [];
  const laufen = dienste.filter((d) => d.zustand === "laeuft").length;
  // Pflichtdienste, die im Paket ganz fehlen (Ampel «fehlt»), zaehlen zum Soll.
  const fehlend = A.filter((x) => x.bauteil === "dienste" && x.wert === "fehlt").map((x) => x.schluessel);
  const soll = dienste.length + fehlend.length;
  const dA = b("dienste");
  const dB = bt("dienste", dA);
  const diensteTeil = (
    <Part teil="dienste" b={dB} label={`Dienste: ${wortKlein(dA)}, ${laufen} von ${soll} laufen. ${aktion(dB)}`} style={PART_FX}>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 11px 9px" }}>
        <Hdr t="Dienste" n="05" chip={<StatusChip a={dA} />} />
        <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "3px 10px" }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <Num v={soll ? laufen : "–"} size={18} />
            <span style={{ fontSize: 11.5, color: K.sub, whiteSpace: "nowrap" }}>{soll ? `von ${soll} laufen` : "keine Meldung"}</span>
          </span>
          <span aria-hidden="true" style={{ display: "flex", gap: 4, alignItems: "center", height: 6 }}>
            {dienste.map((d) => {
              const a = ampel(A, `dienst.${d.name}`);
              const t = a ? anzeigeVon(a).ton : "neutral";
              return <span key={d.name} className="td-dienst" data-an={ja(t === "gut")} style={{ width: 6, height: 6, borderRadius: "50%", background: t === "gut" ? K.led : st(t, "ic") }} />;
            })}
            {fehlend.map((k) => <span key={k} className="td-dienst" data-an="false" style={{ width: 6, height: 6, borderRadius: "50%", background: st("krit", "ic") }} />)}
          </span>
        </span>
      </span>
    </Part>
  );

  // ---- KI-Bildschirm ----
  const kiA = b("ki");
  const kiB = bt("ki", rechnet ? { ton: "neutral", wort: "Rechnet", icon: "activity" } : kiA);
  const eingestelltGeladen = !!ki?.eingestellt && (ki?.geladen ?? []).some((g) => g.name === ki.eingestellt);
  const warteschlange = ki?.warteschlange ?? fsm.warteschlange_offen;
  const kiTeil = (
    <Part
      teil="ki"
      b={kiB}
      label={`Jetzt gerade: KI ${rechnet ? "rechnet" : "ruht"}, Warteschlange ${warteschlange}, Modell ${ki?.eingestellt ?? "unbekannt"} ${eingestelltGeladen ? "geladen" : "nicht geladen"}. ${aktion(kiB)}`}
      style={PART_FX}
    >
      <span style={{ display: "block", padding: 5 }}>
        <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4, padding: "7px 10px 8px", borderRadius: 8, background: K.glassIdle, boxShadow: K.glassFx, overflow: "hidden" }}>
          <span aria-hidden="true" className="td-glas-an" style={{ position: "absolute", inset: 0, background: K.glass, opacity: rechnet ? 1 : 0, pointerEvents: "none" }} />
          <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: "34%", background: `linear-gradient(118deg,${K.glassSheen} 0%,rgba(255,255,255,0) 62%)`, pointerEvents: "none" }} />
          {rechnet ? (
            <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, overflow: "hidden" }}>
              <span className="td-arbeit" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "28%", background: K.A, opacity: 0.55 }} />
            </span>
          ) : null}
          <span style={{ position: "relative" }}>
            <Hdr t="Jetzt gerade" n="06" chip={rechnet ? <Quiet ton="neutral" wort="Rechnet" icon="activity" /> : <StatusChip a={kiA} />} />
          </span>
          <span style={{ position: "relative", display: "flex", alignItems: "center", gap: "2px 8px", flexWrap: "wrap" }}>
            <Icon n={rechnet ? "activity" : "circle-pause"} s={16} c={rechnet ? K.text : K.sub} />
            <Num v={rechnet ? "KI rechnet" : "KI ruht"} size={17} />
            <span style={{ fontSize: 11.5, color: K.sub, ...NUM }}>
              {rechnet ? `1 Auftrag${ki?.auftrag?.modell ? ` · ${ki.auftrag.modell}` : ""}` : `Warteschlange ${warteschlange}`}
            </span>
          </span>
        </span>
      </span>
    </Part>
  );

  const rigBox = (
    <div className="td-lade-geraet td-rigbox" {...geraetAttr("rig")} style={{ animationDelay: "40ms", gridColumn: 1, gridRow: "1 / span 3", alignSelf: "start", position: "relative", display: "flex", flexDirection: "column", gap: 8, borderRadius: 16, padding: 8, background: K.caseBg, boxShadow: K.caseFx }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px 10px", padding: "3px 6px 0", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, margin: 0 }}>Rig</h2>
          <Meta>{laeuftSeit ? `läuft seit ${zeitpunkt(laeuftSeit, jetzt)}` : "Laufzeit unbekannt"}</Meta>
          <span
            tabIndex={0}
            role="note"
            aria-label={`${RIG_INFO} Nicht auslesbar: Netzteil, Radiatorgrösse${cpu?.luefter_rpm?.length ? "" : ", Lüfterdrehzahl im Gehäuse"}.`}
            data-tooltip={`${RIG_INFO} Nicht auslesbar: Netzteil (gestrichelt), Radiatorgrösse${cpu?.luefter_rpm?.length ? "" : ", Lüfterdrehzahl im Gehäuse"}.`}
            style={{ display: "inline-flex", cursor: "help" }}
          >
            <Icon n="info" s={13} c={K.mute} />
          </span>
        </div>
        {onlineA ? <StatusChip a={{ ...onlineA, wort: onlineWort }} /> : <Quiet ton="neutral" wort="Unbekannt" icon="info" />}
      </div>
      {/* Fahnen in voller Breite, nur die Zeichnung passt sich der Fensterhoehe an (stil.ts .td-geraet): so
          bleibt die gemessene Resthoehe stabil, und die Haarlinien treffen ihre Fahnen auch bei schmalerer Zeichnung. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,45fr) minmax(0,55fr)", gap: 8, alignItems: "stretch" }}>{cpuF}{ramF}</div>
        <div className="td-geraet">
        <Gehaeuse
          sel={s.offen ? s.sel : ""}
          waehle={klick}
          fokus={rigFokus}
          vorschau={vorschau}
          zeige={(t) => setVorschau((v) => (t ? t : v === "cpu" || v === "gpu" || v === "ram" ? null : v))}
          toene={{ cpu: cpuB.ton, gpu: gpuB.ton, ram: ramB.ton }}
          cpuTemp={cpu?.temp_c ?? null}
          cpuLast={cpu?.last_prozent ?? null}
          gpuTemp={gpu?.temp_c ?? null}
          luefter={luefter}
          module={ram?.module ?? null}
          eckDreh={eckDreh}
        />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8, alignItems: "stretch" }}>{gpuF}{ssdF}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,.8fr) minmax(0,1.2fr)", gap: 8, alignItems: "stretch" }}>{diensteTeil}{kiTeil}</div>
      <span aria-hidden="true" style={{ position: "absolute", left: "12%", bottom: -6, width: "16%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
      <span aria-hidden="true" style={{ position: "absolute", right: "12%", bottom: -6, width: "16%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
    </div>
  );

  // ---- Leitungen ----
  const appA = b("app");
  const onlineGut = online?.stufe === "gut";
  const frischGut = ampel(A, "messwerte.frische")?.stufe === "gut";
  const appKrit = online?.stufe === "kritisch";
  const appB = bt("app", appA, geraetGedimmt(fokus, "app"));
  const appWire = (
    <Leitung
      teil="app"
      b={appB}
      label={`Verbindung Rig und FSM: ${wortKlein(appA)}. KI-Abfrage alle 2 Sekunden, Messwerte alle 60 Sekunden. ${aktion(appB)}`}
      a={onlineGut ? "Abfrage 2 s" : "Abfrage steht"}
      zweit={frischGut ? "Messwerte 60 s" : `Messwerte ${alterText(stand.rig_alter_s)}`}
      zeile={1}
      fluss={onlineGut && !s.abrufFehler}
      mess={frischGut && !s.abrufFehler}
      auftrag={rechnet && onlineGut}
      verz={300}
      unterbrochen={appKrit}
      chip={appA.ton === "warn" || appA.ton === "krit" ? <Puls ton={appA.ton}><Chip a={appA} /></Puls> : null}
    >
      <BuchseH seite="left" />
      <BuchseH seite="right" blitz />
      <Wagen art="abfrage" ring />
      <Wagen art="messwerte" />
      <Wagen art="auftrag" rueck />
      <Wagen art="ergebnis" />
    </Leitung>
  );

  const ablA = b("ablage");
  const ablGut = ampel(A, "ablage.sync")?.stufe === "gut";
  const intervall = fsm.sync.intervall_s ?? 60;
  const ablB = bt("ablage", ablA, geraetGedimmt(fokus, "ablage"));
  const ablWire = (
    <Leitung
      teil="ablage"
      b={ablB}
      label={`Ablage-Abgleich Rig und NAS: ${wortKlein(ablA)}, alle ${intervall} Sekunden, letzter ${uhrSek(fsm.sync.letzter_poll)}. ${aktion(ablB)}`}
      a={`Ablage ${intervall} s`}
      zweit="Rig ⇄ NAS"
      zeile={3}
      fluss={ablGut && !s.abrufFehler}
      verz={340}
      unterbrochen={ablA.ton === "krit"}
      chip={ablA.ton === "warn" || ablA.ton === "krit" ? <Puls ton={ablA.ton}><Chip a={ablA} /></Puls> : null}
    >
      <BuchseH seite="left" />
      <BuchseH seite="right" />
      <Wagen art="ablage-hin" />
      <Wagen art="ablage-antwort" rueck />
    </Leitung>
  );

  // ---- FSM-Sicherung App -> NAS: ruhend gestrichelt, Fehl-Lauf = unterbrochen ----
  const bakA = b("backup");
  const bk = fsm.backup;
  const bakKrit = bakA.ton === "krit";
  const bakB = bt("backup", bakA, geraetGedimmt(fokus, "backup"));
  const sicherung = (
    <button
      type="button"
      className="td-part"
      data-part="backup"
      aria-controls="td-details"
      aria-label={`FSM-Sicherung von der App aufs NAS: ${wortKlein(bakA)}, letzte Meldung ${bk.letzte_ok_am ? zeitpunkt(bk.letzte_ok_am, jetzt) : "keine"}, jede Nacht 03:00. ${aktion(bakB)}`}
      {...btAttr(bakB)}
      style={{ ...BTN, gridColumn: 3, gridRow: 2, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 84, padding: "14px 0", borderRadius: 10, ["--td-ton" as string]: bakB.ton }}
    >
      <span aria-hidden="true" className="td-linie-v" style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, marginLeft: -1, background: bakKrit ? `repeating-linear-gradient(180deg,${K.wire} 0 3px,rgba(0,0,0,0) 3px 12px)` : `repeating-linear-gradient(180deg,${K.wire} 0 6px,rgba(0,0,0,0) 6px 12px)`, zIndex: 1, transformOrigin: "center top", animationDelay: "380ms" }} />
      <BuchseV seite="top" />
      <BuchseV seite="bottom" />
      <span className="td-etikett" style={{ position: "relative", zIndex: 2, display: "flex", borderRadius: 9, animationDelay: "560ms" }}>
        <Ring r={9} inset={-4} kerbe={false} />
        <span style={{ position: "relative", zIndex: 2, display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "5px 9px 6px", borderRadius: 8, background: K.e1, boxShadow: `0 0 0 1px ${K.hair}`, ...NUM }}>
          <span style={{ fontSize: 10.5, lineHeight: "13px", fontWeight: 700, whiteSpace: "nowrap" }}>FSM-Sicherung</span>
          <StatusChip a={bakA} />
          <span style={{ fontSize: 10.5, lineHeight: "13px", color: K.mute, whiteSpace: "nowrap" }}>{bk.letzte_ok_am ? `letzte ${zeitpunkt(bk.letzte_ok_am, jetzt)}` : bk.nie_gemeldet ? "noch nie gemeldet" : "keine OK-Meldung"}</span>
        </span>
      </span>
    </button>
  );

  // ---- EVENTLINE-App als Fenster ----
  const appZeile = (l: string, v: string) => (
    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, padding: "4px 0", borderTop: `1px solid ${K.line}`, fontSize: 11.5, ...NUM }}>
      <span style={{ color: K.mute }}>{l}</span>
      <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{v}</span>
    </span>
  );
  const appFensterB = bt("app", appA, geraetGedimmt(fokus, "app"));
  const appTeil = (
    <Part teil="app" b={appFensterB} label={`EVENTLINE-App: Verbindung ${wortKlein(appA)}, letzte KI-Abfrage ${uhrSek(fsm.ki_letzter_poll)}, Messwerte von ${uhr(rig?.gemessen_am)}. ${aktion(appFensterB)}`} style={{ gridColumn: 3, gridRow: 1, ...PART_FX }} r={12}>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span aria-hidden="true" style={{ display: "flex", gap: 5, padding: "7px 11px 6px" }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: K.dash }} />)}
        </span>
        <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 5, margin: "0 6px 6px", padding: "8px 10px 3px", borderRadius: 7, background: K.glass, boxShadow: K.glassFx, overflow: "hidden" }}>
          <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: "34%", background: `linear-gradient(118deg,${K.glassSheen} 0%,rgba(255,255,255,0) 62%)`, pointerEvents: "none" }} />
          <span style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".16em", fontFamily: "var(--font-heading)" }}>EVENTL<span style={{ color: K.brand }}>I</span>NE</span>
              <span style={{ fontSize: 10.5, color: K.mute }}>FSM · Web-App</span>
            </span>
            <StatusChip a={appA} />
          </span>
          <span style={{ position: "relative", display: "flex", flexDirection: "column" }}>
            {appZeile("KI-Abfrage", uhrSek(fsm.ki_letzter_poll))}
            {appZeile("Messwerte", uhr(rig?.gemessen_am))}
          </span>
        </span>
      </span>
    </Part>
  );

  // ---- NAS ----
  const nasA = b("nas");
  const vol = nas?.volume ?? null;
  const volPct = vol ? prozent(vol.belegt_b, vol.gesamt_b) : null;
  const snmpOk = nas?.snmp.status === "ok";
  const netzBlinkt = ablGut && !!fsm.sync.letzter_poll && jetzt - Date.parse(fsm.sync.letzter_poll) < 90_000;
  const nasB = bt("nas", nasA);
  const nasTeil = (
    <Part
      teil="nas"
      b={nasB}
      label={`NAS mit 4 Schächten: ${wortKlein(nasA)}${volPct != null && vol ? `, Volume ${Math.round(volPct)} Prozent belegt, ${groesseDez(vol.belegt_b)} von ${groesseDez(vol.gesamt_b)}` : ""}${nas?.freigaben ? `, ${nas.freigaben.ist} Freigaben` : ""}. ${snmpOk ? "" : "Bestückung der Schächte kommt mit NAS-Zugang. "}${aktion(nasB)}`}
      style={PART_FX}
      r={10}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
        <span style={{ display: "grid", gridTemplateColumns: "minmax(0,46fr) minmax(0,54fr)", gap: 9, alignItems: "center" }}>
          <NasFront netzBlinkt={netzBlinkt && !s.abrufFehler} schaechte={snmpOk ? nas?.snmp.platten ?? null : null} />
          <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <Ov t="Volume" n="07" eng />
            <Num v={volPct != null ? Math.round(volPct) : "–"} u="%" size={20} ch={2} />
            <span style={{ fontSize: 11, lineHeight: 1.3, color: K.sub, ...NUM }}>{vol ? `${groesseDez(vol.belegt_b)} von ${groesseDez(vol.gesamt_b)}` : "Belegung unbekannt"}</span>
            <span aria-hidden="true" style={{ position: "relative", display: "block", height: 5, margin: "2px 0 3px" }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: K.track, overflow: "hidden", display: "block" }}>
                <span data-anim="balken" style={{ display: "block", height: "100%", width: `${volPct ?? 0}%`, minWidth: 4, borderRadius: 999, background: K.A, transformOrigin: "left center" }} />
              </span>
              <span style={{ position: "absolute", left: `${GRENZEN["nas.volume"].warnung}%`, top: -3, bottom: -3, borderLeft: `1px dashed ${K.thr}` }} />
              <span style={{ position: "absolute", left: `${GRENZEN["nas.volume"].kritisch}%`, top: -3, bottom: -3, borderLeft: `1px dashed ${K.thr}` }} />
            </span>
            <span style={{ display: "flex" }}><StatusChip a={nasA.ton === "gut" ? { ...nasA, wort: "Erreichbar" } : nasA} /></span>
          </span>
        </span>
        {!snmpOk ? (
          <span style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 10.5, lineHeight: 1.35, color: K.mute }}>
            <Icon n="lock" s={11} c={K.mute} style={{ marginTop: 1 }} />
            <span>Bestückung der Schächte kommt mit NAS-Zugang</span>
          </span>
        ) : null}
      </span>
    </Part>
  );

  const idxA = b("index");
  const idxB = bt("index", idxA);
  const indexTeil = (
    <Part teil="index" b={idxB} label={`Datei-Index: ${wortKlein(idxA)}, ${fsm.index.dateien} Dateien, letzter Scan ${uhr(fsm.index.letzter_scan)}. ${aktion(idxB)}`} style={PART_FX} r={10}>
      <span style={{ display: "flex", flexDirection: "column", gap: 3, padding: "7px 10px 8px" }}>
        <Hdr t="Datei-Index" n="08" chip={<StatusChip a={idxA} />} />
        <span style={{ display: "flex", alignItems: "baseline", gap: "2px 7px", flexWrap: "wrap" }}>
          <Num v={fsm.index.dateien} size={18} ch={3} />
          <span style={{ fontSize: 11.5, color: K.sub, ...NUM }}>Dateien · {zeitpunktKurz(fsm.index.letzter_scan, jetzt)}</span>
        </span>
      </span>
    </Part>
  );

  const hwA = b("hardware");
  const sn = nas?.snmp;
  const hwText = snmpOk && sn
    ? [sn.system_temp_c != null ? `System ${Math.round(sn.system_temp_c)} °C` : null, sn.platten?.length ? `Platten bis ${Math.round(Math.max(...sn.platten.map((p) => p.temp_c ?? 0)))} °C` : null, sn.raid ? `RAID ${sn.raid}` : null].filter(Boolean).join(" · ") || "Werte nicht lesbar"
    : sn?.status === "fehler" ? "Zugang eingerichtet, Abfrage schlägt fehl" : "Platten, Temperaturen, RAID mit NAS-Zugang";
  const hwB = bt("hardware", hwA);
  const hwTeil = (
    <Part teil="hardware" b={hwB} label={`NAS-Hardware: ${snmpOk ? wortKlein(hwA) : hwA.ton === "neutral" ? "kommt mit NAS-Zugang" : hwA.wort}. ${aktion(hwB)}`} style={snmpOk ? PART_FX : { boxShadow: `inset 0 0 0 1px ${K.dash}` }} r={10}>
      <span style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 10px 8px" }}>
        {snmpOk ? null : <Icon n="lock" s={13} c={K.mute} style={{ marginTop: 1 }} />}
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{snmpOk ? "Hardware" : sn?.status === "fehler" ? "Hardware · Fehler" : "Hardware · kommt"}</span>
            {snmpOk || sn?.status === "fehler" ? <StatusChip a={hwA} /> : null}
          </span>
          <span style={{ fontSize: 11, lineHeight: 1.35, color: K.mute, ...NUM }}>{hwText}</span>
        </span>
      </span>
    </Part>
  );

  const nasBox = (
    <div className="td-lade-geraet" {...geraetAttr("nas")} style={{ animationDelay: "90ms", gridColumn: 3, gridRow: 3, position: "relative", display: "flex", flexDirection: "column", gap: 6, padding: 7, borderRadius: 14, background: K.caseBg, boxShadow: K.caseFx }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2px 5px 0", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, margin: 0 }}>NAS</h2>
        <Meta>4 Schächte</Meta>
      </div>
      {nasTeil}
      {indexTeil}
      {hwTeil}
      <span aria-hidden="true" style={{ position: "absolute", left: "18%", bottom: -6, width: "18%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
      <span aria-hidden="true" style={{ position: "absolute", right: "18%", bottom: -6, width: "18%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
    </div>
  );

  return (
    <section aria-label="Rig und NAS als Szene" className="td-scene" onClick={insLeere} style={{ position: "relative", minWidth: 0, borderRadius: 14, background: K.e1, boxShadow: `0 0 0 1px ${K.hair},inset 0 1px 0 ${K.hiTop}`, padding: "10px 14px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minHeight: 20 }}>
        <Ov t="Gerät und Verbindungen" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: K.mute }}>
          <Icon n="mouse-pointer-click" s={14} c={K.mute} />
          {fokus ? "Esc oder Klick ins Leere: zurück zur Übersicht" : "Bauteil anklicken: Details, Verlauf und Grenzwerte"}
        </span>
      </div>
      <div className="td-grid">
        {rigBox}
        {appWire}
        {appTeil}
        {sicherung}
        {ablWire}
        {nasBox}
      </div>
    </section>
  );
}
