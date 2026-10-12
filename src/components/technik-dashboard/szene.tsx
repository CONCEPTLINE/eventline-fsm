// Technik-Dashboard: Szene «digitaler Zwilling» — Rig im Gehaeuse, KI-Bildschirm, Dienste, EVENTLINE-App,
// Leitungen mit Datenfluss im echten Takt und NAS-Front. Port aus gen-main.mjs (scene()).
// Werte kommen aus GET /api/technik/stand, Stufen aus den Ampeln des Servers.

import type { CSSProperties, ReactNode } from "react";
import type { Ampel, Bauteil } from "@/lib/technik-dashboard/typen";
import { DIENST_ANZEIGE, GRENZEN } from "@/lib/technik-dashboard/konstanten";
import { K, st } from "./farben";
import { BTN, Balken, Chip, Icon, Klein, Meta, NUM, Num, Ov, Puls, Quiet, Ring } from "./bausteine";
import { Spark } from "./kurve";
import { Gehaeuse, NasFront, Rueckkammer, type LuefterZustand } from "./zeichnung";
import { alterText, gbBin, groesseDez, komma, prozent, uhr, uhrSek, zeitpunkt, zeitpunktKurz } from "./format";
import { ampel, anzeigeVon, bauteilAnzeige, type Anzeige } from "./status";
import type { Sicht, TeilKey } from "./sicht";

const PART_FX: CSSProperties = { background: K.e3, boxShadow: K.partFx };
const LADE: Partial<Record<TeilKey, number>> = { app: 80, cpu: 100, nas: 110, gpu: 125, index: 135, ram: 150, hardware: 160, platten: 175, dienste: 190, ki: 210 };

function Part({ teil, s, label, style, r = 11, children }: { teil: TeilKey; s: Sicht; label: string; style?: CSSProperties; r?: number; children: ReactNode }) {
  const an = s.sel === teil && s.offen;
  return (
    <button
      type="button"
      className="td-part td-lade"
      data-part={teil}
      aria-pressed={an}
      aria-controls="td-details"
      aria-label={label}
      onClick={() => s.waehle(teil)}
      style={{ ...BTN, position: "relative", minWidth: 0, borderRadius: r, animationDelay: `${LADE[teil] ?? 200}ms`, ...style }}
    >
      <Ring r={r} inset={-4} />
      <span className="td-cq" style={{ position: "relative", zIndex: 1, display: "block", width: "100%", height: "100%", containerType: "inline-size" }}>{children}</span>
    </button>
  );
}

function Fahne({ teil, s, label, children }: { teil: TeilKey; s: Sicht; label: string; children: ReactNode }) {
  const an = s.sel === teil && s.offen;
  return (
    <button
      type="button"
      className="td-part td-lade td-fahne"
      data-part={teil}
      aria-pressed={an}
      aria-controls="td-details"
      aria-label={label}
      onClick={() => s.waehle(teil)}
      style={{ ...BTN, position: "relative", minWidth: 0, borderRadius: 10, ...PART_FX, display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "stretch", animationDelay: `${LADE[teil] ?? 200}ms` }}
    >
      <Ring r={10} inset={-4} />
      <span style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px 9px" }}>{children}</span>
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
  <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minWidth: 0 }}>
    <Ov t={t} n={n} />
    {chip}
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

function Leitung({ teil, s, label, a, b, zeile, fluss, mess, auftrag, verz, unterbrochen, chip, children }: {
  teil: TeilKey; s: Sicht; label: string; a: string; b: string; zeile: number; fluss: boolean; mess?: boolean; auftrag?: boolean; verz: number; unterbrochen: boolean; chip: ReactNode; children: ReactNode;
}) {
  const an = s.sel === teil && s.offen;
  return (
    <button
      type="button"
      className="td-part td-wire"
      data-part={teil}
      data-fluss={fluss ? "an" : "aus"}
      data-mess={mess ? "an" : "aus"}
      data-auftrag={auftrag ? "an" : "aus"}
      aria-pressed={an}
      aria-controls="td-details"
      aria-label={label}
      onClick={() => s.waehle(teil)}
      style={{ ...BTN, gridColumn: 2, gridRow: zeile, alignSelf: "stretch", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 60, borderRadius: 10 }}
    >
      <span aria-hidden="true" className="td-linie" style={{ ...linieStil(unterbrochen), animationDelay: `${verz}ms` }} />
      {children}
      <span className="td-etikett" style={{ position: "absolute", left: 0, right: 0, bottom: "calc(50% + 9px)", zIndex: 2, display: "flex", justifyContent: "center", animationDelay: `${verz + 160}ms` }}>
        <span style={{ position: "relative", display: "inline-flex", borderRadius: 7 }}>
          <Ring r={7} inset={-3} kerbe={false} />
          <Etikett a={a} b={b} />
        </span>
      </span>
      {chip ? <span style={{ position: "absolute", left: 0, right: 0, top: "calc(50% + 9px)", zIndex: 2, display: "flex", justifyContent: "center" }}>{chip}</span> : null}
    </button>
  );
}

const ICON_GROESSE = 24;

export interface SzeneProps {
  s: Sicht;
  luefter: LuefterZustand;
  eckDreh: string | null;
}

export function Szene({ s, luefter, eckDreh }: SzeneProps) {
  const { stand, jetzt } = s;
  const A: Ampel[] = stand.ampeln;
  const rig = stand.rig;
  const ki = stand.ki;
  const nas = stand.nas;
  const fsm = stand.fsm;
  const b = (t: Bauteil) => bauteilAnzeige(A, t);

  // ---- Rig ----
  const cpu = rig?.cpu;
  const ram = rig?.ram;
  const gpu = rig?.gpu;
  const sys = rig?.platten?.system;
  const online = ampel(A, "verbindung.online");
  const onlineA = online ? anzeigeVon(online) : null;
  const onlineWort = !online ? "Unbekannt" : online.stufe === "gut" ? "Online" : online.stufe === "warnung" ? "Verzögert" : online.stufe === "kritisch" ? "Offline" : anzeigeVon(online).wort;
  const laeuftSeit = rig?.uptime_s != null && rig.gemessen_am ? Date.parse(rig.gemessen_am) - rig.uptime_s * 1000 : null;

  const r24 = s.reihen24;
  const bis24 = r24 ? Date.parse(r24.bis) : jetzt;

  const cpuA = b("cpu");
  const ramA = b("ram");
  const gpuA = b("gpu");
  const plA = b("platten");
  const ramNutzbar = ram?.gesamt_b != null ? gbBin(ram.gesamt_b) : null;
  const ramFrei = ram?.verfuegbar_b != null ? gbBin(ram.verfuegbar_b) : null;
  const ramBelegt = ramNutzbar != null && ramFrei != null ? ramNutzbar - ramFrei : null;
  const kiB = ram?.ki;
  const tr = ram?.trustone;
  const vramPct = gpu?.vram_belegt_mib != null && gpu.vram_gesamt_mib ? prozent(gpu.vram_belegt_mib, gpu.vram_gesamt_mib) : 0;
  const gpuGb = gpu?.vram_gesamt_mib ? Math.round(gpu.vram_gesamt_mib / 1024) : null;
  const rechnet = !!ki?.auftrag;
  const sysPct = sys ? prozent(sys.belegt_b, sys.gesamt_b) : null;
  const ssdText = sys ? `SSD · ${groesseDez(sys.gesamt_b, true)}` : "SSD";

  const cpuF = (
    <Fahne teil="cpu" s={s} label={`Prozessor: ${wortKlein(cpuA)}, ${cpu?.temp_c != null ? `${Math.round(cpu.temp_c)} Grad` : "Temperatur unbekannt"}, Last ${cpu?.last_prozent != null ? Math.round(cpu.last_prozent) : "unbekannt"} Prozent. Details öffnen`}>
      <Ov t="Prozessor" n="01" />
      <WertZeile chip={<StatusChip a={cpuA} />}>
        <Num v={cpu?.last_prozent != null ? Math.round(cpu.last_prozent) : "–"} u="%" size={18} ch={3} />
        <span style={{ fontSize: 11.5, color: K.sub }}>Last</span>
      </WertZeile>
      <Spark punkte={r24?.werte["cpu.last"]} von={bis24 - 6 * 3_600_000} bis={bis24} schrittS={r24?.schritt_s ?? 300} ymin={0} ymax={100} h={16} />
      <Klein>{cpu?.takt_mhz != null ? `Takt ${komma(cpu.takt_mhz / 1000)} GHz · ` : ""}Last 6 h</Klein>
    </Fahne>
  );

  const ramF = (
    <Fahne teil="ram" s={s} label={`Arbeitsspeicher: ${wortKlein(ramA)}, ${ramFrei != null ? `${komma(ramFrei)} GB frei` : "frei unbekannt"}${ramNutzbar != null ? ` von ${Math.round(ramNutzbar)} GB nutzbar` : ""}${ram?.eingebaut_gb ? `, ${ram.eingebaut_gb} GB eingebaut` : ""}. Trust one nur als Summe. Details öffnen`}>
      <Ov t="Arbeitsspeicher" n="02" />
      <WertZeile chip={<StatusChip a={ramA} />}>
        <Num v={ramFrei != null ? komma(ramFrei) : "–"} u="GB frei" size={18} ch={4} />
      </WertZeile>
      <Klein style={{ whiteSpace: "nowrap" }}>{ramBelegt != null && ramNutzbar != null ? `${komma(ramBelegt)} GB belegt · ${Math.round(ramNutzbar)} GB nutzbar` : "–"}</Klein>
      <span aria-hidden="true" style={{ position: "relative", display: "block", height: 6, margin: "3px 0 4px", borderRadius: 999, overflow: "hidden", background: K.track }}>
        <span className="td-balken td-folgt" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "100%", borderRadius: 999, background: K.A, transformOrigin: "left center", transform: `scaleX(${ramBelegt != null && ramNutzbar ? (ramBelegt / ramNutzbar).toFixed(4) : 0})` }} />
      </span>
      <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 }}>
        {([
          ["KI-Bereich", kiB?.belegt_b, kiB?.grenze_b, K.A],
          ["Trust one", tr?.summe_b, tr?.grenze_max_b, K.B],
        ] as const).map(([l, v, of, col]) => (
          <span key={l} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, lineHeight: 1.25, color: K.mute, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</span>
            <span style={{ fontSize: 10.5, lineHeight: 1.25, whiteSpace: "nowrap", ...NUM }}>
              <b>{v != null ? komma(gbBin(v)) : "–"}</b>
              <span style={{ color: K.mute }}>{of ? ` / ${Math.round(gbBin(of))} GB` : ""}</span>
            </span>
            <Balken pct={v != null && of ? prozent(v, of) : 0} h={3} farbe={col} />
          </span>
        ))}
      </span>
    </Fahne>
  );

  const gpuF = (
    <Fahne teil="gpu" s={s} label={`Grafikkarte: ${wortKlein(gpuA)}, ${gpu?.temp_c != null ? `${Math.round(gpu.temp_c)} Grad` : "Temperatur unbekannt"}, Auslastung ${gpu?.last_prozent ?? "unbekannt"} Prozent, Lüfter ${gpu?.luefter_prozent ?? "unbekannt"} Prozent. Details öffnen`}>
      <Ov t="Grafikkarte" n="03" />
      <WertZeile chip={<StatusChip a={gpuA} />}>
        <Num v={gpu?.last_prozent != null ? Math.round(gpu.last_prozent) : "–"} u="%" size={18} />
        <span style={{ fontSize: 11.5, color: K.sub, ...NUM, whiteSpace: "nowrap" }}>{rechnet || (gpu?.last_prozent ?? 0) > 5 ? "rechnet" : "ruht"}{gpu?.watt != null ? ` · ${Math.round(gpu.watt)} W` : ""}</span>
      </WertZeile>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, lineHeight: 1.25, color: K.mute, ...NUM }}>
        <span>Speicher</span>
        <span style={{ whiteSpace: "nowrap" }}>{gpu?.vram_belegt_mib != null ? (gpu.vram_belegt_mib >= 1024 ? `${komma(gpu.vram_belegt_mib / 1024)} GB` : `${gpu.vram_belegt_mib} MiB`) : "–"}{gpuGb ? ` von ${gpuGb} GB` : ""}</span>
      </span>
      <span aria-hidden="true" style={{ position: "relative", display: "block", height: 3, borderRadius: 999, background: K.track, overflow: "hidden" }}>
        <span className="td-balken td-folgt" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "100%", borderRadius: 999, background: K.A, transformOrigin: "left center", transform: `scaleX(${Math.max(0.012, vramPct / 100).toFixed(4)})` }} />
      </span>
      <Klein>{gpu?.luefter_prozent != null ? `3 Lüfter · ${Math.round(gpu.luefter_prozent)} % · ${gpu.luefter_prozent > 0 ? "laufen" : "stehen"}` : "3 Lüfter · Drehzahl unbekannt"}</Klein>
    </Fahne>
  );

  const ssdF = (
    <Fahne teil="platten" s={s} label={`SSD: ${wortKlein(plA)}${sysPct != null ? `, ${Math.round(sysPct)} Prozent belegt` : ""}. Sitzt in der Rückkammer hinter dem Mainboard, unter dem Netzteil. Details öffnen`}>
      <Ov t={ssdText} n="04" />
      <span style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: 0 }}>
        <Rueckkammer />
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <WertZeile chip={<StatusChip a={plA} />}>
            <Num v={sysPct != null ? Math.round(sysPct) : "–"} u="%" size={18} ch={3} />
          </WertZeile>
          <Klein>{sys ? `${Math.round(sys.belegt_b / 1e9)} von ${Math.round(sys.gesamt_b / 1e9)} GB nutzbar` : "–"}</Klein>
          <span style={{ display: "block", margin: "3px 0 2px" }}><Balken pct={sysPct ?? 0} h={4} /></span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: K.mute }}>
            <span aria-hidden="true" className="td-ssd-led" data-an={stand.ampeln.some((x) => x.schluessel === "ablage.sync" && x.stufe === "gut") ? "true" : "false"} style={{ flex: "none", width: 5, height: 5, borderRadius: "50%", background: K.A, opacity: 0.3 }} />
            <span>Aktivität</span>
          </span>
          <Klein>in der Rückkammer</Klein>
        </span>
      </span>
    </Fahne>
  );

  // ---- Dienste ----
  const dienste = rig?.dienste ?? [];
  const laufen = dienste.filter((d) => d.zustand === "laeuft").length;
  // Pflichtdienste, die im Paket ganz fehlen (Ampel «fehlt»), zaehlen zum Soll.
  const fehlend = A.filter((x) => x.bauteil === "dienste" && x.wert === "fehlt").map((x) => x.schluessel);
  const soll = dienste.length + fehlend.length;
  const dA = b("dienste");
  const juengster = dienste
    .filter((d) => d.gestartet_am && jetzt - Date.parse(d.gestartet_am) < 24 * 3_600_000)
    .sort((x, y) => Date.parse(y.gestartet_am ?? "") - Date.parse(x.gestartet_am ?? ""))[0];
  const diensteTeil = (
    <Part teil="dienste" s={s} label={`Dienste: ${wortKlein(dA)}, ${laufen} von ${soll} laufen. Details öffnen`} style={PART_FX}>
      <span style={{ display: "flex", flexDirection: "column", gap: 6, padding: "11px 14px" }}>
        <Hdr t="Dienste" n="05" chip={<StatusChip a={dA} />} />
        <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 14px" }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <Num v={soll ? laufen : "–"} size={18} />
            <span style={{ fontSize: 11.5, color: K.sub }}>{soll ? `von ${soll} laufen` : "keine Meldung"}</span>
          </span>
          <span aria-hidden="true" style={{ display: "flex", gap: 5, alignItems: "center", height: 6 }}>
            {dienste.map((d) => {
              const a = ampel(A, `dienst.${d.name}`);
              const t = a ? anzeigeVon(a).ton : "neutral";
              return <span key={d.name} className="td-dienst" data-an={t === "gut" ? "true" : "false"} style={{ width: 6, height: 6, borderRadius: "50%", background: t === "gut" ? K.led : st(t, "ic") }} />;
            })}
            {fehlend.map((k) => <span key={k} className="td-dienst" data-an="false" style={{ width: 6, height: 6, borderRadius: "50%", background: st("krit", "ic") }} />)}
          </span>
          {juengster?.gestartet_am ? <span style={{ fontSize: 11, color: K.mute, ...NUM }}>{DIENST_ANZEIGE[juengster.name]} neu seit {zeitpunktKurz(juengster.gestartet_am, jetzt)}</span> : null}
        </span>
      </span>
    </Part>
  );

  // ---- KI-Bildschirm ----
  const kiA = b("ki");
  const geladen = ki?.geladen ?? [];
  const eingestelltGeladen = !!ki?.eingestellt && geladen.some((g) => g.name === ki.eingestellt);
  const hist = (() => {
    const p = r24?.werte["ki.warteschlange"];
    const balken = Array.from({ length: 24 }, () => 0);
    if (!p || !r24) return { balken, max: 0 };
    for (const [t, m, sp] of p) {
      const i = 23 - Math.floor((bis24 - t) / 3_600_000);
      if (i >= 0 && i < 24) balken[i] = Math.max(balken[i], sp ?? m ?? 0);
    }
    return { balken, max: Math.max(...balken) };
  })();
  const kcol = (l: string, v: ReactNode, sub: ReactNode) => (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: K.mute }}>{l}</span>
      <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...NUM }}>{v}</span>
      {/* Unterzeile darf umbrechen: Uhrzeiten nie abschneiden (schmale Szene neben der App-Navigation). */}
      <span style={{ fontSize: 11, lineHeight: 1.3, color: K.mute, overflowWrap: "anywhere", ...NUM }}>{sub}</span>
    </span>
  );
  const tix = ki?.tiefen_index;
  const kiTeil = (
    <Part
      teil="ki"
      s={s}
      label={`Jetzt gerade: KI ${rechnet ? "rechnet" : "ruht"}, Warteschlange ${ki?.warteschlange ?? fsm.warteschlange_offen}, Modell ${ki?.eingestellt ?? "unbekannt"} ${eingestelltGeladen ? "geladen" : "nicht geladen"}. Details öffnen`}
      style={PART_FX}
    >
      <span style={{ display: "block", padding: 10 }}>
        <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 11, padding: "13px 15px 12px", borderRadius: 8, background: K.glassIdle, boxShadow: K.glassFx, overflow: "hidden" }}>
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
          <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Icon n={rechnet ? "activity" : "circle-pause"} s={ICON_GROESSE} c={rechnet ? K.text : K.sub} />
            <Num v={rechnet ? "KI rechnet" : "KI ruht"} size={24} />
            <span style={{ fontSize: 12, color: K.sub }}>
              {rechnet ? `1 Auftrag${ki?.auftrag?.modell ? ` · ${ki.auftrag.modell}` : ""}` : `kein Auftrag · Warteschlange ${ki?.warteschlange ?? fsm.warteschlange_offen}`}
            </span>
          </span>
          <span className="td-kigrid" style={{ position: "relative", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr) minmax(0,.8fr) minmax(0,1fr)", gap: 10, borderTop: `1px solid ${K.line}`, paddingTop: 10 }}>
            {kcol("Modell", ki?.eingestellt ?? "–", eingestelltGeladen ? "geladen" : "nicht geladen")}
            {kcol("Suche", ki?.schalter?.suche == null ? "–" : ki.schalter.suche ? "ein" : "aus", `Archiv-Frage ${ki?.schalter?.archiv_frage == null ? "–" : ki.schalter.archiv_frage ? "ein" : "aus"}`)}
            {kcol("Archiv", ki?.archiv?.anzahl ?? "–", ki?.archiv?.letzter_lauf ? `Lauf ${zeitpunktKurz(ki.archiv.letzter_lauf, jetzt)}${ki.archiv.fehler ? ` · ${ki.archiv.fehler} Fehler` : " ok"}` : "kein Lauf")}
            {kcol("Tiefen-Index", tix?.dateien != null ? `${tix.dateien}${tix.nas_dateien != null ? ` von ${tix.nas_dateien}` : ""}` : "–", tix?.letzter_lauf ? `${tix.nacht_fertig ? "fertig" : "Lauf"} ${zeitpunktKurz(tix.letzter_lauf, jetzt)}` : "–")}
          </span>
          <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 5, borderTop: `1px solid ${K.line}`, paddingTop: 9 }}>
            <span aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 12 }}>
              {hist.balken.map((v, i) => (
                <span key={i} style={{ flex: 1, height: hist.max > 0 ? 2 + Math.round((v / hist.max) * 10) : 2, borderRadius: 1, background: v > 0 ? K.A : K.mute, opacity: v > 0 ? 0.8 : 0.45 }} />
              ))}
            </span>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: K.mute, ...NUM }}>
              <span>Warteschlange je Stunde · 24 h</span>
              <span>{fsm.auftraege_24h} Aufträge in 24 h</span>
            </span>
          </span>
        </span>
      </span>
    </Part>
  );

  const rigBox = (
    <div className="td-lade-geraet" style={{ animationDelay: "40ms", gridColumn: 1, gridRow: "1 / span 3", position: "relative", display: "flex", flexDirection: "column", gap: 10, borderRadius: 18, padding: 10, background: K.caseBg, boxShadow: K.caseFx }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px 10px", padding: "6px 8px 2px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Rig</h2>
          <Meta>{laeuftSeit ? `läuft seit ${zeitpunkt(laeuftSeit, jetzt)}` : "Laufzeit unbekannt"}</Meta>
        </div>
        {onlineA ? <StatusChip a={{ ...onlineA, wort: onlineWort }} /> : <Quiet ton="neutral" wort="Unbekannt" icon="info" />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="td-fahnen" style={{ display: "grid", gridTemplateColumns: "minmax(0,47fr) minmax(0,53fr)", gap: 10, alignItems: "stretch" }}>{cpuF}{ramF}</div>
        <Gehaeuse
          sel={s.offen ? s.sel : ""}
          waehle={(t) => s.waehle(t)}
          cpuTemp={cpu?.temp_c ?? null}
          cpuLast={cpu?.last_prozent ?? null}
          gpuTemp={gpu?.temp_c ?? null}
          luefter={luefter}
          module={ram?.module ?? null}
          eckDreh={eckDreh}
        />
        <div className="td-fahnen" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10, alignItems: "stretch" }}>{gpuF}{ssdF}</div>
      </div>
      <div style={{ padding: "0 4px" }}>
        <p style={{ margin: 0, display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11, lineHeight: 1.4, color: K.mute }}>
          <Icon n="info" s={13} c={K.mute} style={{ marginTop: 1 }} />
          <span>Blick von links durch das Glas. Netzteil und SSD sitzen in der Rückkammer hinter dem Mainboard. Nicht auslesbar: Netzteil (gestrichelt), Radiatorgrösse{cpu?.luefter_rpm?.length ? "" : ", Lüfterdrehzahl im Gehäuse"}.</span>
        </p>
      </div>
      {diensteTeil}
      {kiTeil}
      <span aria-hidden="true" style={{ position: "absolute", left: "12%", bottom: -6, width: "16%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
      <span aria-hidden="true" style={{ position: "absolute", right: "12%", bottom: -6, width: "16%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
    </div>
  );

  // ---- Leitungen ----
  const appA = b("app");
  const onlineGut = online?.stufe === "gut";
  const frischGut = ampel(A, "messwerte.frische")?.stufe === "gut";
  const appKrit = online?.stufe === "kritisch";
  const appWire = (
    <Leitung
      teil="app"
      s={s}
      label={`Verbindung Rig und FSM: ${wortKlein(appA)}. KI-Abfrage alle 2 Sekunden, Messwerte alle 60 Sekunden. Details öffnen`}
      a={onlineGut ? "Abfrage 2 s" : "Abfrage steht"}
      b={frischGut ? "Messwerte 60 s" : `Messwerte ${alterText(stand.rig_alter_s)}`}
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
  const ablWire = (
    <Leitung
      teil="ablage"
      s={s}
      label={`Ablage-Abgleich Rig und NAS: ${wortKlein(ablA)}, alle ${intervall} Sekunden, letzter ${uhrSek(fsm.sync.letzter_poll)}. Details öffnen`}
      a={`Ablage ${intervall} s`}
      b="Rig ⇄ NAS"
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
  const bakAn = s.sel === "backup" && s.offen;
  const sicherung = (
    <button
      type="button"
      className="td-part"
      data-part="backup"
      aria-pressed={bakAn}
      aria-controls="td-details"
      aria-label={`FSM-Sicherung von der App aufs NAS: ${wortKlein(bakA)}, letzte Meldung ${bk.letzte_ok_am ? zeitpunkt(bk.letzte_ok_am, jetzt) : "keine"}, jede Nacht 03:00. Details öffnen`}
      onClick={() => s.waehle("backup")}
      style={{ ...BTN, gridColumn: 3, gridRow: 2, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 140, padding: "22px 0", borderRadius: 10 }}
    >
      <span aria-hidden="true" className="td-linie-v" style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, marginLeft: -1, background: bakKrit ? `repeating-linear-gradient(180deg,${K.wire} 0 3px,rgba(0,0,0,0) 3px 12px)` : `repeating-linear-gradient(180deg,${K.wire} 0 6px,rgba(0,0,0,0) 6px 12px)`, zIndex: 1, transformOrigin: "center top", animationDelay: "380ms" }} />
      <BuchseV seite="top" />
      <BuchseV seite="bottom" />
      <span className="td-etikett" style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, borderRadius: 9, animationDelay: "560ms" }}>
        <Ring r={9} inset={-5} kerbe={false} />
        <Etikett a="FSM-Sicherung" b="jede Nacht 03:00" />
        <span style={{ position: "relative", zIndex: 2, display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, background: K.e1, boxShadow: `0 0 0 1px ${K.hair}` }}>
          <StatusChip a={bakA} />
          <span style={{ fontSize: 10.5, color: K.mute, ...NUM, whiteSpace: "nowrap" }}>{bk.letzte_ok_am ? `letzte ${zeitpunkt(bk.letzte_ok_am, jetzt)}` : bk.nie_gemeldet ? "noch nie gemeldet" : "keine OK-Meldung"}</span>
        </span>
      </span>
    </button>
  );

  // ---- EVENTLINE-App als Fenster ----
  const appZeile = (l: string, v: string) => (
    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, padding: "5px 0", borderTop: `1px solid ${K.line}`, fontSize: 11.5, ...NUM }}>
      <span style={{ color: K.mute }}>{l}</span>
      <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{v}</span>
    </span>
  );
  const ein = (v: boolean | undefined) => (v == null ? "–" : v ? "ein" : "aus");
  const appTeil = (
    <Part teil="app" s={s} label={`EVENTLINE-App: Verbindung ${wortKlein(appA)}, letzte KI-Abfrage ${uhrSek(fsm.ki_letzter_poll)}, Messwerte von ${uhr(rig?.gemessen_am)}. Details öffnen`} style={{ gridColumn: 3, gridRow: 1, ...PART_FX }} r={12}>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span aria-hidden="true" style={{ display: "flex", gap: 5, padding: "9px 12px 8px" }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: K.dash }} />)}
        </span>
        <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8, margin: "0 8px 8px", padding: "11px 12px 6px", borderRadius: 7, background: K.glass, boxShadow: K.glassFx, overflow: "hidden" }}>
          <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, height: "34%", background: `linear-gradient(118deg,${K.glassSheen} 0%,rgba(255,255,255,0) 62%)`, pointerEvents: "none" }} />
          <span style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: ".16em", fontFamily: "var(--font-heading)" }}>EVENTL<span style={{ color: K.brand }}>I</span>NE</span>
              <span style={{ fontSize: 11, color: K.mute }}>FSM · Web-App</span>
            </span>
            <StatusChip a={appA} />
          </span>
          <span style={{ position: "relative", display: "flex", flexDirection: "column" }}>
            {appZeile("KI-Abfrage", uhrSek(fsm.ki_letzter_poll))}
            {appZeile("Messwerte", uhr(rig?.gemessen_am))}
            {appZeile("Suche · Archiv", `${ein(ki?.schalter?.suche)} · ${ein(ki?.schalter?.archiv_frage)}`)}
          </span>
        </span>
      </span>
    </Part>
  );

  // ---- NAS ----
  const nasA = b("nas");
  const vol = nas?.volume ?? null;
  const volPct = vol ? prozent(vol.belegt_b, vol.gesamt_b) : null;
  const frA = ampel(A, "nas.freigaben");
  const snmpOk = nas?.snmp.status === "ok";
  const netzBlinkt = ablGut && !!fsm.sync.letzter_poll && jetzt - Date.parse(fsm.sync.letzter_poll) < 90_000;
  const nasTeil = (
    <Part
      teil="nas"
      s={s}
      label={`NAS mit 4 Schächten: ${wortKlein(nasA)}${volPct != null && vol ? `, Volume ${Math.round(volPct)} Prozent belegt, ${groesseDez(vol.belegt_b)} von ${groesseDez(vol.gesamt_b)}` : ""}. ${snmpOk ? "" : "Bestückung der Schächte kommt mit NAS-Zugang. "}Details öffnen`}
      style={PART_FX}
      r={10}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 9, padding: 10 }}>
        <NasFront netzBlinkt={netzBlinkt && !s.abrufFehler} schaechte={snmpOk ? nas?.snmp.platten ?? null : null} />
        {!snmpOk ? (
          <span style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 10.5, lineHeight: 1.35, color: K.mute }}>
            <Icon n="lock" s={11} c={K.mute} style={{ marginTop: 1 }} />
            <span>Bestückung der Schächte kommt mit NAS-Zugang</span>
          </span>
        ) : null}
        <span style={{ display: "flex", flexDirection: "column", gap: 5, borderTop: `1px solid ${K.line}`, paddingTop: 8 }}>
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <Ov t="Volume" n="07" />
            <StatusChip a={nasA.ton === "gut" ? { ...nasA, wort: "Erreichbar" } : nasA} />
          </span>
          <span style={{ display: "flex", alignItems: "baseline", gap: "2px 8px", flexWrap: "wrap" }}>
            <Num v={volPct != null ? Math.round(volPct) : "–"} u="%" size={20} ch={2} />
            <span style={{ fontSize: 11.5, color: K.sub, ...NUM }}>{vol ? `${groesseDez(vol.belegt_b)} von ${groesseDez(vol.gesamt_b)}` : "Belegung unbekannt"}</span>
          </span>
          <span aria-hidden="true" style={{ position: "relative", display: "block", height: 6 }}>
            <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: K.track, overflow: "hidden", display: "block" }}>
              <span data-anim="balken" style={{ display: "block", height: "100%", width: `${volPct ?? 0}%`, minWidth: 4, borderRadius: 999, background: K.A, transformOrigin: "left center" }} />
            </span>
            <span style={{ position: "absolute", left: `${GRENZEN["nas.volume"].warnung}%`, top: -3, bottom: -3, borderLeft: `1px dashed ${K.thr}` }} />
            <span style={{ position: "absolute", left: `${GRENZEN["nas.volume"].kritisch}%`, top: -3, bottom: -3, borderLeft: `1px dashed ${K.thr}` }} />
          </span>
          <span style={{ fontSize: 10.5, color: K.mute, ...NUM }}>Warnung {GRENZEN["nas.volume"].warnung} % · kritisch {GRENZEN["nas.volume"].kritisch} %</span>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap", borderTop: `1px solid ${K.line}`, paddingTop: 7 }}>
            <span style={{ fontSize: 11.5, color: K.sub, ...NUM }}>{nas?.freigaben ? `${nas.freigaben.ist} Freigaben` : "Freigaben unbekannt"}</span>
            {frA ? <StatusChip a={anzeigeVon(frA)} /> : null}
          </span>
        </span>
      </span>
    </Part>
  );

  const idxA = b("index");
  const indexTeil = (
    <Part teil="index" s={s} label={`Datei-Index: ${wortKlein(idxA)}, ${fsm.index.dateien} Dateien, letzter Scan ${uhr(fsm.index.letzter_scan)}. Details öffnen`} style={PART_FX} r={10}>
      <span style={{ display: "flex", flexDirection: "column", gap: 5, padding: "11px 13px" }}>
        <Hdr t="Datei-Index" n="08" chip={<StatusChip a={idxA} />} />
        <span style={{ display: "flex", alignItems: "baseline", gap: "2px 8px", flexWrap: "wrap" }}>
          <Num v={fsm.index.dateien} ch={3} />
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
  const hwTeil = (
    <Part teil="hardware" s={s} label={`NAS-Hardware: ${snmpOk ? wortKlein(hwA) : hwA.ton === "neutral" ? "kommt mit NAS-Zugang" : hwA.wort}. Details öffnen`} style={snmpOk ? PART_FX : { boxShadow: `inset 0 0 0 1px ${K.dash}` }} r={10}>
      <span style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px" }}>
        {snmpOk ? null : <Icon n="lock" s={13} c={K.mute} style={{ marginTop: 1 }} />}
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{snmpOk ? "Hardware" : sn?.status === "fehler" ? "Hardware · Fehler" : "Hardware · kommt"}</span>
            {snmpOk || sn?.status === "fehler" ? <StatusChip a={hwA} /> : null}
          </span>
          <span style={{ fontSize: 11, color: K.mute, ...NUM }}>{hwText}</span>
        </span>
      </span>
    </Part>
  );

  const nasBox = (
    <div className="td-lade-geraet" style={{ animationDelay: "90ms", gridColumn: 3, gridRow: 3, position: "relative", display: "flex", flexDirection: "column", gap: 8, padding: 8, borderRadius: 16, background: K.caseBg, boxShadow: K.caseFx }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, padding: "4px 6px 2px" }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>NAS</h2>
          <Meta>4 Schächte</Meta>
        </span>
      </div>
      {nasTeil}
      {indexTeil}
      {hwTeil}
      <span aria-hidden="true" style={{ position: "absolute", left: "18%", bottom: -6, width: "18%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
      <span aria-hidden="true" style={{ position: "absolute", right: "18%", bottom: -6, width: "18%", height: 6, borderRadius: "0 0 4px 4px", background: K.bg, boxShadow: `inset 0 -1px 0 ${K.hair}` }} />
    </div>
  );

  return (
    <section aria-label="Rig und NAS als Szene" className="td-scene" style={{ position: "relative", minWidth: 0, borderRadius: 14, background: K.e1, boxShadow: `0 0 0 1px ${K.hair},inset 0 1px 0 ${K.hiTop}`, padding: "16px 20px 26px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minHeight: 20 }}>
        <Ov t="Gerät und Verbindungen" />
        {!s.offen || s.sel === "uebersicht" ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: K.mute }}>
            <Icon n="mouse-pointer-click" s={14} c={K.mute} />
            Bauteil anklicken: Verlauf und Grenzwerte
          </span>
        ) : null}
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
