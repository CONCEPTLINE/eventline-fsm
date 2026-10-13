// Technik-Dashboard: Detail-Panels je Bauteil (Entwurf panels()): Kopf mit Status, Kacheln, Kurven,
// Grenzen-Tabelle und Klartext aus den Ampeln. Nur echte Werte; was nicht gemessen wird, steht als «kommt».

import type { ReactNode } from "react";
import Link from "next/link";
import type { Ampel, Bauteil, Ereignis, TechnikStand } from "@/lib/technik-dashboard/typen";
import { DIENST_ANZEIGE, plattenName } from "@/lib/technik-dashboard/konstanten";
import { K, st } from "./farben";
import {
  BTN, Balken, Chip, EinAus, Hint, Icon, Kommt, Kopf, Limits, Meta, Note, NUM, Num, Ov, Quiet, Tile, TileWert, Tiles,
} from "./bausteine";
import { Kurve } from "./kurve";
import { Streifen } from "./streifen";
import { GRENZ_TABELLEN, GRENZ_UEBERSICHT, grenzLinien } from "./grenzen";
import { alterText, dauerText, gbBin, groesseDez, komma, prozent, tausend, uhr, uhrSek, zahlKurz, zeitpunkt, zeitpunktKurz } from "./format";
import { ampel, ampelnVon, anzeigeVon, bauteilAnzeige, probleme, type Anzeige } from "./status";
import type { Sicht, TeilKey } from "./sicht";
import { KuehlungTeil } from "./kuehlung-teil";
import { kuehlungEingerichtet, rpmAchse } from "./kuehlung";

const BAUTEIL_NAME: Record<Bauteil, string> = {
  cpu: "Prozessor und Kühlung", gpu: "Grafikkarte", ram: "Arbeitsspeicher", platten: "Platten", dienste: "Dienste", ki: "KI", app: "Verbindung",
  ablage: "Ablage-Abgleich", nas: "NAS", index: "Datei-Index", hardware: "NAS-Hardware", backup: "FSM-Sicherung",
};

const ton = (A: Ampel[], schluessel: string) => {
  const a = ampel(A, schluessel);
  return a ? anzeigeVon(a).ton : null;
};

/** Ampel-Texte eines Bauteils als Hinweise (Probleme zuerst, sonst der erste Text). */
function AmpelTexte({ A, bauteil, nurProbleme = false, jetzt }: { A: Ampel[]; bauteil: Bauteil; nurProbleme?: boolean; jetzt: number }) {
  const alle = ampelnVon(A, bauteil);
  const p = probleme(alle);
  const zeigen = p.length ? p : nurProbleme ? [] : alle.filter((a) => a.text).slice(0, 1);
  if (!zeigen.length) return null;
  return (
    <>
      {zeigen.map((a) => (
        <Hint key={a.schluessel} ton={anzeigeVon(a).ton === "gut" ? "neutral" : anzeigeVon(a).ton}>
          {a.stufe !== "gut" && a.stufe !== "neutral" ? <b>{a.titel}: </b> : null}
          {a.text}
          {a.seit && a.stufe !== "gut" ? <span style={{ color: K.mute }}> · seit {zeitpunktKurz(a.seit, jetzt)}</span> : null}
        </Hint>
      ))}
    </>
  );
}

function Nutzung({ label, wert, pct, sub }: { label: string; wert: string; pct: number; sub?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, ...NUM }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{wert}</span>
      </div>
      <Balken pct={pct} />
      {sub ? <Meta>{sub}</Meta> : null}
    </div>
  );
}

function Zone({ label, v, of, pct, farbe, sub }: { label: string; v: string; of: string; pct: number; farbe: string; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, ...NUM }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: farbe }} />
          {label}
        </span>
        <span style={{ whiteSpace: "nowrap" }}>
          <b>{v}</b> <span style={{ color: K.mute }}>von {of}</span>
        </span>
      </div>
      <Balken pct={pct} h={5} farbe={farbe} />
      {sub ? <Meta>{sub}</Meta> : null}
    </div>
  );
}

function Zeile({ label, chip, text }: { label: string; chip: ReactNode; text?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderTop: `1px solid ${K.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span>{label}</span>
        {chip}
      </div>
      {text ? <Meta>{text}</Meta> : null}
    </div>
  );
}

const ChipB = ({ a }: { a: Anzeige }) => <Chip a={a} />;

const RAID_WORT = { normal: "normal", wiederaufbau: "im Wiederaufbau", degradiert: "degradiert" } as const;

/** Klartext zur Bestueckung: echte Werte, sobald der NAS-Zugang liefert, sonst der Hinweis «kommt». */
export function nasBestueckung(nas: TechnikStand["nas"]): string {
  const sn = nas?.snmp;
  if (sn?.status !== "ok") return "4 Schächte, ein Volume. Wie viele Platten stecken und ob gespiegelt wird, zeigt sich erst mit NAS-Zugang.";
  const platten = sn.platten ?? [];
  const intern = platten.filter((p) => !p.extern).length;
  const usb = platten.filter((p) => p.extern).length;
  const teile = [
    platten.length ? `${intern} von 4 Schächten bestückt${usb ? `, dazu ${usb === 1 ? "eine USB-Platte" : `${usb} USB-Platten`}` : ""}` : "Bestückung der Schächte nicht lesbar",
    sn.raid ? `Speicherpool ${RAID_WORT[sn.raid]}` : "Speicherpool nicht lesbar",
  ];
  return `4 Schächte, ein Volume. ${teile.join(" · ")}. Einzelheiten unter NAS-Hardware.`;
}
const leer = (v: number | null | undefined, f: (n: number) => ReactNode) => (v == null ? "–" : f(v));

/** Liefert den Panel-Inhalt fuer ein Bauteil. */
export function panelInhalt(teil: TeilKey, s: Sicht): ReactNode[] {
  const { stand, jetzt, reihen, reihen24 } = s;
  const A = stand.ampeln;
  const rig = stand.rig;
  const ki = stand.ki;
  const nas = stand.nas;
  const fsm = stand.fsm;
  const chip = (b: Bauteil) => <ChipB a={bauteilAnzeige(A, b)} />;
  const aktiv = (schluessel: string) => ton(A, schluessel);

  switch (teil) {
    case "cpu": {
      const c = rig?.cpu;
      const kue = kuehlungEingerichtet(rig?.kuehlung);
      const rpm = (v: number) => `${tausend(v)} U/min`;
      const pumpeMax = rpmAchse(reihen?.werte["kuehlung.pumpe_rpm"], 3000);
      const luefterMax = rpmAchse(reihen?.werte["kuehlung.luefter_rpm"], 2000);
      return [
        <Kopf key="k" icon="cpu" titel="Prozessor und Kühlung" sub={c?.kerne ? `${c.kerne} Kerne · ${c.threads ?? "?"} Threads · Wasserkühlung` : "Wasserkühlung"} chip={chip("cpu")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="cpu" />,
        <Tiles key="t">
          <Tile label="Temperatur" wert={<TileWert v={leer(c?.temp_c, (n) => Math.round(n))} u="°C" ch={3} />} sub={c?.temp_c_5min != null ? `Ø 5 min ${komma(c.temp_c_5min)} °C` : undefined} />
          <Tile label="Last" wert={<TileWert v={leer(c?.last_prozent, (n) => Math.round(n))} u="%" ch={3} />} sub={c?.last_prozent_5min != null ? `Ø 5 min ${Math.round(c.last_prozent_5min)} %${c.last_prozent_10min != null ? ` · 10 min ${Math.round(c.last_prozent_10min)} %` : ""}` : undefined} />
          <Tile label="Takt" wert={<TileWert v={leer(c?.takt_mhz, (n) => komma(n / 1000))} u="GHz" />} sub={c?.takt_mhz_max_kern != null ? `schnellster Kern ${komma(c.takt_mhz_max_kern / 1000)} GHz` : undefined} />
          <Tile label="Spitze 1 min" wert={<TileWert v={leer(c?.temp_c_max_1min, (n) => Math.round(n))} u="°C" />} sub={c?.drosselung ? "Drosselung aktiv" : c?.drosselung === false ? "keine Drosselung" : undefined} />
        </Tiles>,
        <KuehlungTeil key="kue" s={s} />,
        <Kurve key="k1" id="cpu-temp" titel="Temperatur" reihen={reihen} serien={[{ schluessel: "cpu.temp", name: "Mittel", spitze: true }]} ymin={30} ymax={100} yt={[[50, "50°"], [75, "75°"]]} grenzen={grenzLinien("cpu.temp", "°C")} h={96} format={(v) => `${Math.round(v)} °C`} />,
        <Kurve key="k2" id="cpu-last" titel="Last" reihen={reihen} serien={[{ schluessel: "cpu.last" }]} ymin={0} ymax={100} yt={[[50, "50 %"], [100, "100 %"]]} grenzen={grenzLinien("cpu.last", "%").slice(1)} h={72} format={(v) => `Ø ${Math.round(v)} %`} />,
        kue ? <Kurve key="k3" id="kuehlmittel" titel="Kühlmittel" reihen={reihen} serien={[{ schluessel: "kuehlung.kuehlmittel_c" }]} ymin={20} ymax={60} yt={[[30, "30°"], [45, "45°"]]} h={64} format={(v) => `${komma(v)} °C`} /> : null,
        kue ? <Kurve key="k4" id="pumpe" titel="Pumpe" reihen={reihen} serien={[{ schluessel: "kuehlung.pumpe_rpm" }]} ymin={0} ymax={pumpeMax} yt={[[pumpeMax / 2, String(pumpeMax / 2)], [pumpeMax, String(pumpeMax)]]} h={64} format={rpm} /> : null,
        kue ? <Kurve key="k5" id="luefter" titel="Lüfter, Mittel" reihen={reihen} serien={[{ schluessel: "kuehlung.luefter_rpm" }]} ymin={0} ymax={luefterMax} yt={[[luefterMax / 2, String(luefterMax / 2)], [luefterMax, String(luefterMax)]]} h={64} format={rpm} /> : null,
        c?.anteil_kerne ? <Note key="n0">Rechenzeit gerade: KI {komma(c.anteil_kerne.ki ?? 0)} Kerne · Trust one {komma(c.anteil_kerne.trustone ?? 0)} Kerne (nur Summe).</Note> : null,
        <Limits key="l" titel="Grenzwerte Temperatur" zeilen={GRENZ_TABELLEN.cpuTemp} aktiv={aktiv("cpu.temp")} />,
        <Limits key="l2" titel="Grenzwerte Last" zeilen={GRENZ_TABELLEN.cpuLast} aktiv={aktiv("cpu.last")} />,
        <Limits key="l3" titel="Grenzwerte Kühlung" zeilen={GRENZ_TABELLEN.kuehlung} aktiv={aktiv("kuehlung")} />,
        <Note key="n">Bauart: Wasserkühlung mit rundem Pumpenkopf, Schläuche seitlich zum Radiator im Deckel. Die Grösse des Radiators ist nicht auslesbar.</Note>,
      ];
    }
    case "gpu": {
      const g = rig?.gpu;
      const gb = g?.vram_gesamt_mib ? Math.round(g.vram_gesamt_mib / 1024) : null;
      const geladen = ki?.geladen ?? [];
      return [
        <Kopf key="k" icon="gauge" titel="Grafikkarte" sub={`${gb ? `${gb} GB Grafikspeicher · ` : ""}${geladen.length ? `${geladen.map((x) => x.name).join(", ")} geladen` : "kein Modell geladen"}`} chip={chip("gpu")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="gpu" />,
        <Tiles key="t">
          <Tile label="Temperatur" wert={<TileWert v={leer(g?.temp_c, (n) => Math.round(n))} u="°C" ch={3} />} sub={g?.temp_c_max_1min != null ? `Spitze 1 min ${Math.round(g.temp_c_max_1min)} °C` : undefined} />
          <Tile label="Auslastung" wert={<TileWert v={leer(g?.last_prozent, (n) => Math.round(n))} u="%" />} sub={ki?.auftrag ? "1 Auftrag läuft" : "ruht, kein Auftrag"} />
          <Tile label="Grafikspeicher" wert={<TileWert v={leer(g?.vram_belegt_mib, (n) => (n >= 1024 ? komma(n / 1024) : n))} u={g?.vram_belegt_mib != null && g.vram_belegt_mib >= 1024 ? "GB" : "MiB"} />} sub={gb ? `von ${gb} GB belegt` : undefined} />
          <Tile label="Leistung" wert={<TileWert v={leer(g?.watt, (n) => zahlKurz(n))} u="W" />} sub={g?.watt_grenze ? `von ${Math.round(g.watt_grenze)} W` : undefined} />
          <Tile label="Takt" wert={<TileWert v={leer(g?.takt_mhz, (n) => Math.round(n))} u="MHz" />} sub={g?.takt_max_mhz ? `max. ${Math.round(g.takt_max_mhz)} MHz` : undefined} />
          <Tile label="Lüfter" wert={<TileWert v={leer(g?.luefter_prozent, (n) => Math.round(n))} u="%" />} sub={g?.luefter_prozent === 0 ? "steht, normal im Leerlauf" : g?.luefter_prozent != null ? "laufen" : undefined} />
        </Tiles>,
        <Kurve key="k1" id="gpu-temp" titel="Temperatur" reihen={reihen} serien={[{ schluessel: "gpu.temp", name: "Mittel", spitze: true }]} ymin={30} ymax={95} yt={[[50, "50°"], [75, "75°"]]} grenzen={grenzLinien("gpu.temp", "°C")} h={88} format={(v) => `${Math.round(v)} °C`} />,
        <Kurve key="k2" id="gpu-last" titel="Auslastung" reihen={reihen} serien={[{ schluessel: "gpu.last" }]} ymin={0} ymax={100} yt={[[50, "50 %"], [100, "100 %"]]} h={64} format={(v) => `${Math.round(v)} %`} />,
        <Note key="n">Karte mit 3 Lüftern, der mittlere dreht gegenläufig. Das Seitendisplay zeigt im Bild die Temperatur.{g?.treiber ? ` Treiber ${g.treiber}` : ""}{g?.pstate ? ` · Leistungsstufe ${g.pstate}` : ""}</Note>,
        <Limits key="l" titel="Grenzwerte Temperatur" zeilen={GRENZ_TABELLEN.gpuTemp} aktiv={aktiv("gpu.temp")} />,
      ];
    }
    case "ram": {
      const r = rig?.ram;
      const nutzbar = r?.gesamt_b != null ? gbBin(r.gesamt_b) : null;
      const frei = r?.verfuegbar_b != null ? gbBin(r.verfuegbar_b) : null;
      const belegt = nutzbar != null && frei != null ? nutzbar - frei : null;
      const kb = r?.ki;
      const tr = r?.trustone;
      const ymax = nutzbar ? Math.ceil(nutzbar / 8) * 8 : 48;
      return [
        <Kopf key="k" icon="memory-stick" titel="Arbeitsspeicher" sub={[r?.eingebaut_gb ? `${r.eingebaut_gb} GB eingebaut` : null, nutzbar != null ? `${Math.round(nutzbar)} GB nutzbar` : null, frei != null ? `${komma(frei)} GB frei` : null].filter(Boolean).join(" · ")} chip={chip("ram")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="ram" nurProbleme />,
        <div key="z" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Zone label="Belegt gesamt" v={belegt != null ? `${komma(belegt)} GB` : "–"} of={nutzbar != null ? `${Math.round(nutzbar)} GB nutzbar` : "–"} pct={belegt != null && nutzbar ? (belegt / nutzbar) * 100 : 0} farbe={K.A} />
          {kb ? <Zone label="KI-Bereich" v={kb.belegt_b != null ? `${komma(gbBin(kb.belegt_b))} GB` : "–"} of={kb.grenze_b ? `${Math.round(gbBin(kb.grenze_b))} GB` : "–"} pct={kb.belegt_b != null && kb.grenze_b ? prozent(kb.belegt_b, kb.grenze_b) : 0} farbe={K.A} sub={kb.fest_b != null ? `davon ${komma(gbBin(kb.fest_b))} GB fest, Rest Zwischenspeicher` : undefined} /> : null}
          {tr ? <Zone label="Trust one (Summe)" v={tr.summe_b != null ? `${komma(gbBin(tr.summe_b))} GB` : "–"} of={tr.grenze_max_b ? `${Math.round(gbBin(tr.grenze_max_b))} GB` : "–"} pct={tr.summe_b != null && tr.grenze_max_b ? prozent(tr.summe_b, tr.grenze_max_b) : 0} farbe={K.B} sub={`inkl. Zwischenspeicher${tr.grenze_hoch_b ? ` · weiche Grenze ${Math.round(gbBin(tr.grenze_hoch_b))} GB` : ""}`} /> : null}
        </div>,
        <Tiles key="t">
          <Tile label="Auslagerung" wert={<TileWert v={leer(r?.swap_belegt_b, (n) => komma(gbBin(n), 2))} u="GB" />} sub={r?.swap_gesamt_b ? `von ${Math.round(gbBin(r.swap_gesamt_b))} GB` : undefined} />
          <Tile label="Speicherdruck" wert={<TileWert v={leer(r?.psi_full_avg10, (n) => komma(n, n < 10 ? 1 : 0))} />} sub="0 = kein Warten auf Speicher" tooltip="Anteil der Zeit, in der Programme auf Arbeitsspeicher warten mussten (Mittel 10 s)" />
        </Tiles>,
        <Kurve key="k1" id="ram-frei" titel="Verfügbar" reihen={reihen} serien={[{ schluessel: "ram.verfuegbar_gb" }]} ymin={0} ymax={ymax} yt={[[ymax / 2, `${ymax / 2} GB`], [ymax, `${ymax} GB`]]} grenzen={grenzLinien("ram.verfuegbar_gb", "GB")} h={80} format={(v) => `${komma(v)} GB`} />,
        <Kurve key="k2" id="ram-swap" titel="Auslagerung" reihen={reihen} serien={[{ schluessel: "ram.swap_gb" }]} ymin={0} ymax={8} yt={[[4, "4 GB"], [8, "8 GB"]]} grenzen={grenzLinien("ram.swap_gb", "GB")} h={72} format={(v) => `${komma(v, 2)} GB`} />,
        <Kurve key="k3" id="ram-zonen" titel="KI-Bereich und Trust one" reihen={reihen} serien={[{ schluessel: "ram.ki_gb", name: "KI-Bereich" }, { schluessel: "ram.trustone_gb", name: "Trust one (Summe)", farbe: K.B, flaeche: false }]} ymin={0} ymax={24} yt={[[12, "12 GB"], [24, "24 GB"]]} h={80} format={(v) => `${komma(v)} GB`} />,
        <Limits key="l" titel="Grenzwerte Verfügbar" zeilen={GRENZ_TABELLEN.ramFrei} aktiv={aktiv("ram.verfuegbar")} />,
        <Limits key="l2" titel="Grenzwerte Auslagerung" zeilen={GRENZ_TABELLEN.ramSwap} aktiv={aktiv("ram.swap")} />,
        <Note key="n">Trust one wird nur als Summe gelesen und vom System hart begrenzt. Keine Ampel, keine Bedienung.</Note>,
        r?.module?.length
          ? <Note key="m">Riegel von der CPU aus: {r.module.slice().sort((a, b) => a.platz - b.platz).map((m) => `Platz ${m.platz} ${m.groesse_gb} GB${m.temp_c != null ? ` (${Math.round(m.temp_c)} °C)` : ""}`).join(", ")}. Ab 16 GB mit Kühlblech gezeichnet.</Note>
          : <Kommt key="m" text="Riegel-Bestückung: nicht lesbar" icon="info" />,
      ];
    }
    case "platten": {
      const p = rig?.platten;
      const ssd = p?.ssd;
      const sysPct = p?.system ? prozent(p.system.belegt_b, p.system.gesamt_b) : null;
      const trPct = p?.tresor ? prozent(p.tresor.belegt_b, p.tresor.gesamt_b) : null;
      return [
        <Kopf key="k" icon="hard-drive" titel="Platten" sub={`SSD${p?.system ? ` · ${groesseDez(p.system.gesamt_b, true)}` : ""} · einziges Laufwerk im Rig`} chip={chip("platten")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="platten" nurProbleme />,
        p?.system ? <Nutzung key="s" label="Systemplatte" wert={`${Math.round(p.system.belegt_b / 1e9)} von ${Math.round(p.system.gesamt_b / 1e9)} GB · ${Math.round(sysPct ?? 0)} %`} pct={sysPct ?? 0} sub={`${Math.round((p.system.gesamt_b - p.system.belegt_b) / 1e9)} GB frei`} /> : <Kommt key="s" text="Systemplatte: keine Messung" icon="info" />,
        p?.tresor ? <Nutzung key="t" label="KI-Tresor (verschlüsselt)" wert={`${Math.round(p.tresor.belegt_b / 1e9)} von ${Math.round(p.tresor.gesamt_b / 1e9)} GB · ${Math.round(trPct ?? 0)} %`} pct={trPct ?? 0} /> : <Kommt key="t" text="KI-Tresor: nicht eingehängt oder keine Messung" icon="info" />,
        ssd?.status === "ok" ? (
          <Tiles key="ssd">
            <Tile label="SSD-Temperatur" wert={<TileWert v={leer(ssd.temp_c, (n) => Math.round(n))} u="°C" />} />
            <Tile label="Gesundheit" wert={<TileWert v={ssd.gesundheit === "ok" ? "gut" : ssd.gesundheit === "warnung" ? "Warnung" : ssd.gesundheit === "fehler" ? "Fehler" : "–"} />} />
            <Tile label="Abnutzung" wert={<TileWert v={leer(ssd.abnutzung_prozent, (n) => Math.round(n))} u="%" />} />
            <Tile label="Betriebsstunden" wert={<TileWert v={leer(ssd.betriebsstunden, (n) => Math.round(n))} u="h" />} />
          </Tiles>
        ) : <Kommt key="ssd" text="SSD-Temperatur und Gesundheit: kommt mit Freigabe am Rig" />,
        ssd?.status === "ok" ? <Kurve key="k1" id="ssd-temp" titel="SSD-Temperatur" reihen={reihen24} serien={[{ schluessel: "ssd.temp" }]} ymin={20} ymax={80} yt={[[40, "40°"], [60, "60°"]]} grenzen={grenzLinien("ssd.temp", "°C")} h={64} format={(v) => `${Math.round(v)} °C`} /> : null,
        <Limits key="l" titel="Grenzwerte Belegung" zeilen={GRENZ_TABELLEN.platte} aktiv={aktiv("platte.system")} />,
        ssd?.status === "ok" ? <Limits key="l2" titel="Grenzwerte SSD-Temperatur" zeilen={GRENZ_TABELLEN.ssdTemp} aktiv={aktiv("ssd.temp")} /> : null,
      ];
    }
    case "dienste": {
      const d = rig?.dienste ?? [];
      const laufen = d.filter((x) => x.zustand === "laeuft").length;
      const soll = d.length + A.filter((x) => x.bauteil === "dienste" && x.wert === "fehlt").length;
      return [
        <Kopf key="k" icon="package" titel="Dienste" sub={soll ? `${laufen} von ${soll} laufen` : "keine Meldung vom Rig"} chip={chip("dienste")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="dienste" nurProbleme />,
        <div key="t" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 76px", gap: 10, padding: "0 0 6px", fontSize: 11, color: K.mute }}>
            <span>Dienst</span><span>läuft seit</span><span style={{ textAlign: "right" }}>Speicher</span>
          </div>
          {d.map((x) => {
            const a = ampel(A, `dienst.${x.name}`);
            const an = a ? anzeigeVon(a) : null;
            const seit = x.gestartet_am ? (jetzt - Date.parse(x.gestartet_am)) / 1000 : null;
            return (
              <div key={x.name} data-tooltip={a?.text || undefined} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 76px", gap: 10, alignItems: "center", padding: "8px 0", borderTop: `1px solid ${K.line}`, fontSize: 13, ...NUM }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {an && an.ton !== "gut" ? <Icon n={an.icon} s={12} c={st(an.ton, "ic")} /> : <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: K.led, flex: "none" }} />}
                  <span>{DIENST_ANZEIGE[x.name]}</span>
                  {x.zustand !== "laeuft" ? <span style={{ fontSize: 11, color: K.mute }}>{x.zustand === "gestoppt" ? "gestoppt" : x.zustand === "startet" ? "startet" : "Neustart"}</span> : null}
                </span>
                <span style={{ fontSize: 12, color: K.mute, whiteSpace: "nowrap" }}>{seit != null ? dauerText(seit) : "–"}{x.neustarts ? ` · ${x.neustarts}× neu` : ""}</span>
                <span style={{ fontSize: 12, color: K.mute, textAlign: "right", whiteSpace: "nowrap" }}>{x.speicher_b != null ? `${komma(gbBin(x.speicher_b))}${x.grenze_b ? ` / ${Math.round(gbBin(x.grenze_b))}` : ""} GB` : "–"}</span>
              </div>
            );
          })}
        </div>,
        <Note key="n">Geplante Neustarts (z. B. für ein Update) zählen nicht als Absturz, sie stehen nur bei den Ereignissen.</Note>,
        <Limits key="l" titel="Grenzwerte" zeilen={GRENZ_TABELLEN.dienste} aktiv={bauteilAnzeige(A, "dienste").ton} />,
      ];
    }
    case "ki": {
      const modelle = (ki?.modelle ?? []).slice().sort((a, b) => b.groesse_b - a.groesse_b);
      const geladen = ki?.geladen ?? [];
      const vramGb = rig?.gpu?.vram_gesamt_mib ? rig.gpu.vram_gesamt_mib / 1024 : null;
      const skala = vramGb ? vramGb * 2 : 16;
      const tix = ki?.tiefen_index;
      const sch = ki?.schalter ?? {};
      const rechnet = !!ki?.auftrag;
      return [
        <Kopf key="k" icon="bot" titel="KI · Jetzt gerade" sub={`${modelle.length} Modelle installiert · ${geladen.length} geladen`} chip={rechnet ? <Quiet ton="neutral" wort="Rechnet" icon="activity" /> : chip("ki")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="ki" nurProbleme />,
        <p key="p" style={{ margin: 0, fontSize: 13, ...NUM }}>
          {ki?.auftrag ? `1 Auftrag in Arbeit (${ki.auftrag.art}) seit ${uhr(ki.auftrag.seit)}` : "Kein Auftrag in Arbeit"} · {fsm.auftraege_24h} Aufträge in 24 h
        </p>,
        <Tiles key="t">
          <Tile label="Modell" wert={<Num v={ki?.eingestellt ?? "–"} size={17} />} sub={ki?.eingestellt ? (geladen.some((g) => g.name === ki.eingestellt) ? "eingestellt, geladen" : "eingestellt, nicht geladen") : undefined} />
          <Tile label="Warteschlange" wert={<TileWert v={ki?.warteschlange ?? fsm.warteschlange_offen} />} sub={fsm.aeltester_offen_am ? `ältester seit ${zeitpunktKurz(fsm.aeltester_offen_am, jetzt)}` : "Aufträge wartend"} />
          <Tile label="Archiv" wert={<TileWert v={ki?.archiv?.anzahl ?? "–"} />} sub={ki?.archiv?.letzter_lauf ? `Lauf ${zeitpunktKurz(ki.archiv.letzter_lauf, jetzt)} · ${ki.archiv.fehler ?? 0} Fehler${ki.archiv.dauer_s != null ? ` · ${komma(ki.archiv.dauer_s)} s` : ""}` : undefined} />
          <Tile label="Tiefen-Index" wert={<span><Num v={tix?.dateien ?? "–"} size={20} /><span style={{ fontSize: 12, color: K.mute }}>{tix?.nas_dateien != null ? ` von ${tix.nas_dateien}` : ""}</span></span>} sub={tix ? `${tix.mit_text ?? "?"} mit Text · ${tix.abschnitte ?? "?"} Abschnitte` : undefined} />
          {ki?.tempo ? <Tile label="Tempo" tooltip="Tokens sind Wortteile, keine Wörter" wert={<TileWert v={komma(ki.tempo.tokens_s)} />} sub={`Tokens pro Sekunde · ${ki.tempo.modell} · ${zeitpunktKurz(ki.tempo.am, jetzt)}`} /> : null}
          {ki?.fsm_antwort_ms != null ? <Tile label="Antwort der App" wert={<TileWert v={ki.fsm_antwort_ms} u="ms" />} sub={ki.fsm_fehler_in_folge ? `${ki.fsm_fehler_in_folge} Fehler in Folge` : "ohne Fehler"} /> : null}
        </Tiles>,
        <div key="e" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Ov t="Eingeschaltet" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "6px 12px" }}>
            <EinAus label="Suche" an={sch.suche} />
            <EinAus label="Frag das Archiv" an={sch.archiv_frage} />
            <EinAus label="Hintergrund" an={sch.hintergrund} />
            <EinAus label="Lernen" an={sch.lernen} />
            <EinAus label="Tiefen-Index" an={sch.tiefe} />
            <EinAus label="Hauptmodell" an={sch.hauptmodell} />
          </div>
        </div>,
        ki?.instanzen?.length ? (
          <div key="i" style={{ display: "flex", flexDirection: "column" }}>
            <Ov t="Rechen-Instanzen" style={{ marginBottom: 4 }} />
            {ki.instanzen.map((x) => (
              <Zeile key={x.name} label={x.name === "schnell" ? "Ollama schnell" : "Ollama gründlich"} chip={x.erreichbar ? <Quiet ton="gut" wort="erreichbar" icon="circle-check" /> : <Chip a={{ ton: "krit", wort: "nicht erreichbar", icon: "octagon-x" }} />} text={[x.version ? `Version ${x.version}` : null, x.grenze_b ? `Grenze ${Math.round(gbBin(x.grenze_b))} GB` : null, geladen.filter((g) => g.instanz === x.name).map((g) => `${g.name} geladen${g.entlaedt_am ? ` bis ${uhr(g.entlaedt_am)}` : ""}`).join(", ") || null].filter(Boolean).join(" · ")} />
            ))}
          </div>
        ) : null,
        tix?.letzter_lauf ? <Note key="n">Tiefen-Index {tix.nacht_fertig ? "fertig" : "zuletzt gelaufen"} {zeitpunkt(tix.letzter_lauf, jetzt)}: {tix.dateien ?? "?"} von {tix.nas_dateien ?? "?"} Dateien gelesen.</Note> : null,
        modelle.length ? (
          <div key="m" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Ov t={vramGb ? `Modelle · passt in ${Math.round(vramGb)} GB Grafikspeicher? (Strich)` : "Modelle"} style={{ marginBottom: 4 }} />
            {modelle.map((m) => {
              const gb = m.groesse_b / 1e9;
              const passt = vramGb == null || gb <= vramGb;
              return (
                <div key={m.name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 52px 56px", gap: 10, alignItems: "center", padding: "4px 0", fontSize: 12.5, ...NUM }}>
                  <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2, minWidth: 0 }}>
                    <span style={{ whiteSpace: "nowrap" }}>{m.name}</span>
                    {m.name === ki?.eingestellt ? <span style={{ fontSize: 10.5, padding: "0 6px", borderRadius: 999, boxShadow: `inset 0 0 0 1px ${K.dash}`, color: K.sub, whiteSpace: "nowrap" }}>eingestellt</span> : null}
                    {geladen.some((g) => g.name === m.name) ? <span style={{ fontSize: 10.5, padding: "0 6px", borderRadius: 999, boxShadow: `inset 0 0 0 1px ${K.dash}`, color: K.sub, whiteSpace: "nowrap" }}>geladen</span> : null}
                    {passt ? null : <span style={{ fontSize: 10.5, color: K.sub, display: "inline-flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }}><Icon n="info" s={11} c={K.sub} />zu gross</span>}
                  </span>
                  <span style={{ textAlign: "right", color: K.mute }}>{komma(gb)} GB</span>
                  <span aria-hidden="true" style={{ position: "relative", display: "block", height: 5, borderRadius: 999, background: K.track }}>
                    <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, (gb / skala) * 100).toFixed(1)}%`, borderRadius: 999, background: K.A }} />
                    {vramGb ? <span style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1.5, marginLeft: -0.75, background: K.mute }} /> : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null,
        <Limits key="l" titel="Grenzwerte Warteschlange" zeilen={GRENZ_TABELLEN.warteschlange} aktiv={aktiv("ki.warteschlange")} />,
        <Kommt key="kp" text="Nachtplan, Hauptmodell und Speicher-Tor: kommt mit KI-Planer" icon="moon" />,
      ];
    }
    case "app": {
      const on = ampel(A, "verbindung.online");
      return [
        <Kopf key="k" icon="link" titel="Verbindung Rig ⇄ FSM" sub="KI-Abfrage alle 2 s · Messwerte alle 60 s · über HTTPS" chip={chip("app")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="app" />,
        <Tiles key="t">
          <Tile label="Letzte KI-Abfrage" wert={<TileWert v={uhrSek(fsm.ki_letzter_poll)} />} sub={fsm.ki_letzter_poll ? alterText((jetzt - Date.parse(fsm.ki_letzter_poll)) / 1000) : "noch nie"} />
          <Tile label="Messwerte" wert={<TileWert v={uhr(rig?.gemessen_am)} />} sub={stand.rig_alter_s != null ? alterText(stand.rig_alter_s) : "noch keine"} />
          <Tile label="KI-Version" wert={<TileWert v={fsm.ki_version ?? ki?.version ?? "–"} />} sub={fsm.ki_online_seit ? `online seit ${zeitpunktKurz(fsm.ki_online_seit, jetzt)}` : undefined} />
          <Tile label="Antwortzeit" wert={<TileWert v={ki?.fsm_antwort_ms ?? "–"} u="ms" />} sub={ki?.fsm_fehler_in_folge ? `${ki.fsm_fehler_in_folge} Fehler in Folge` : "Messwerte an die App"} />
        </Tiles>,
        <Kurve key="k1" id="antwort" titel="Antwortzeit" reihen={reihen24} serien={[{ schluessel: "ki.fsm_antwort_ms", spitze: true }]} ymin={0} ymax={3500} yt={[[1000, "1 s"], [3000, "3 s"]]} grenzen={grenzLinien("ki.fsm_antwort_ms", "ms")} h={64} format={(v) => `${Math.round(v)} ms`} />,
        fsm.ki_letzter_fehler && on?.stufe !== "gut" ? <Hint key="f" ton="warn">Letzte Fehlermeldung der KI: {fsm.ki_letzter_fehler}</Hint> : null,
        <Limits key="l" titel="Grenzwerte Messwerte" zeilen={GRENZ_TABELLEN.messwerte} aktiv={aktiv("messwerte.frische")} />,
        <Limits key="l2" titel="Grenzwerte Antwortzeit" zeilen={GRENZ_TABELLEN.antwort} aktiv={aktiv("verbindung.antwortzeit")} />,
      ];
    }
    case "ablage": {
      const fr = nas?.freigaben;
      return [
        <Kopf key="k" icon="refresh-cw" titel="Ablage-Abgleich" sub={`Rig ⇄ NAS · Takt ${fsm.sync.intervall_s ?? 60} s`} chip={chip("ablage")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="ablage" />,
        <Tiles key="t">
          <Tile label="Letzter Abgleich" wert={<TileWert v={uhrSek(fsm.sync.letzter_poll)} />} sub={fsm.sync.letzter_poll ? alterText((jetzt - Date.parse(fsm.sync.letzter_poll)) / 1000) : "noch nie"} />
          <Tile label="Freigaben am Rig" wert={<TileWert v={fr?.ist ?? "–"} />} sub={fr ? `${fr.schreibend ?? "?"} schreibend · ${fr.lesend ?? "?"} lesend` : undefined} />
        </Tiles>,
        <Limits key="l" titel="Grenzwerte Abgleich" zeilen={GRENZ_TABELLEN.ablage} aktiv={aktiv("ablage.sync")} />,
      ];
    }
    case "index": {
      const tix = ki?.tiefen_index;
      return [
        <Kopf key="k" icon="search" titel="Datei-Index" sub="Rig liest die Ablage auf dem NAS" chip={chip("index")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="index" />,
        <Tiles key="t">
          <Tile label="Dateien im FSM" wert={<TileWert v={fsm.index.dateien} />} sub="Ablage-Index" />
          <Tile label="Letzter Scan" wert={<TileWert v={zeitpunktKurz(fsm.index.letzter_scan, jetzt)} />} sub={fsm.index.letzter_scan ? alterText((jetzt - Date.parse(fsm.index.letzter_scan)) / 1000) : "noch nie"} />
        </Tiles>,
        <Note key="n">Der Scan hat eine eigene Ampel, damit ein stiller Stillstand sofort auffällt.</Note>,
        tix?.dateien != null ? <Note key="n2">Tiefen-Index der KI: {tix.dateien} von {tix.nas_dateien ?? "?"} Dateien gelesen{tix.letzter_lauf ? `, ${tix.nacht_fertig ? "fertig" : "zuletzt"} ${zeitpunkt(tix.letzter_lauf, jetzt)}` : ""}.</Note> : null,
        <Limits key="l" titel="Grenzwerte Datei-Index" zeilen={GRENZ_TABELLEN.index} aktiv={aktiv("ablage.index")} />,
      ];
    }
    case "nas": {
      const vol = nas?.volume;
      const pct = vol ? prozent(vol.belegt_b, vol.gesamt_b) : null;
      const fr = nas?.freigaben;
      const frA = ampel(A, "nas.freigaben");
      return [
        <Kopf key="k" icon="hard-drive-upload" titel="NAS" sub={`4 Schächte${vol ? ` · Volume ${groesseDez(vol.gesamt_b)} nutzbar` : ""}`} chip={chip("nas")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="nas" nurProbleme />,
        vol ? <Nutzung key="v" label="Volume" wert={`${groesseDez(vol.belegt_b)} von ${groesseDez(vol.gesamt_b)} · ${Math.round(pct ?? 0)} %`} pct={pct ?? 0} sub={nas ? `Wert von ${zeitpunktKurz(nas.gemessen_am, jetzt)}` : undefined} /> : <Kommt key="v" text="Belegung: keine Messung" icon="info" />,
        <div key="z" style={{ display: "flex", flexDirection: "column" }}>
          <Zeile label="Erreichbar" chip={ampel(A, "nas.erreichbar") ? <Chip a={anzeigeVon(ampel(A, "nas.erreichbar")!)} /> : <Quiet ton="neutral" wort="unbekannt" icon="info" />} text={nas ? (nas.fehlversuche_in_folge ? `${nas.fehlversuche_in_folge} Fehlversuche in Folge` : "antwortet") : undefined} />
          <Zeile label="Freigaben am Rig" chip={frA ? <Chip a={anzeigeVon(frA)} /> : null} text={fr ? `${fr.ist} eingehängt${fr.schreibend != null ? ` (${fr.schreibend} schreibend, ${fr.lesend ?? "?"} lesend)` : ""}${fr.soll == null ? " · wie viele es sein sollen, wird noch festgelegt" : ` · Soll ${fr.soll}`}` : undefined} />
          <Zeile label="Dateifreigabe" chip={nas?.dateifreigabe == null ? <Quiet ton="neutral" wort="unbekannt" icon="info" /> : nas.dateifreigabe ? <Quiet ton="gut" wort="antwortet" icon="circle-check" /> : <Chip a={{ ton: "krit", wort: "antwortet nicht", icon: "octagon-x" }} />} />
          <Zeile label="Weboberfläche" chip={nas?.weboberflaeche == null ? <Quiet ton="neutral" wort="unbekannt" icon="info" /> : nas.weboberflaeche ? <Quiet ton="gut" wort="antwortet" icon="circle-check" /> : <Chip a={{ ton: "warn", wort: "antwortet nicht", icon: "triangle-alert" }} />} />
          <Zeile label="Ablage-Abgleich" chip={<Chip a={bauteilAnzeige(A, "ablage")} wort={uhrSek(fsm.sync.letzter_poll)} />} />
        </div>,
        <Kurve key="k1" id="nas-belegt" titel="Belegung" reihen={reihen24} serien={[{ schluessel: "nas.belegt_prozent" }]} ymin={0} ymax={100} yt={[[50, "50 %"], [100, "100 %"]]} grenzen={grenzLinien("nas.belegt_prozent", "%")} h={56} format={(v) => `${Math.round(v)} %`} />,
        <Note key="n">{nasBestueckung(nas)}</Note>,
        <Limits key="l" titel="Grenzwerte Volume" zeilen={GRENZ_TABELLEN.nasVolume} aktiv={aktiv("nas.volume")} />,
      ];
    }
    case "hardware": {
      const sn = nas?.snmp;
      const zugang = ampel(A, "nas.hw.zugang");
      if (!sn || sn.status === "nicht_eingerichtet") {
        const hw = ["Systemtemperatur", "Plattentemperaturen", "Plattengesundheit", "Speicherpool / RAID", "Prozessor und RAM", "Laufzeit"];
        return [
          <Kopf key="k" icon="lock" titel="NAS-Hardware" sub="kommt mit NAS-Zugang (nur lesen, eigener Benutzer)" chip={<Quiet ton="neutral" wort="Kommt" icon="lock" />} />,
          <p key="p" style={{ margin: 0, fontSize: 13 }}>{sn?.grund === "werkzeug_fehlt" ? "Das Abfrage-Werkzeug fehlt noch auf dem Rig." : sn?.grund === "zugang_ungueltig" ? "Die hinterlegten Zugangsdaten auf dem Rig sind unvollständig oder ungültig; was fehlt, steht im Protokoll des Sammlers." : "Bis der Zugang steht, zeigt die Seite hier keine Zahl."} Danach erscheinen diese Werte am NAS in der Szene:</p>,
          <ul key="u" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
            {hw.map((h) => (
              <li key={h} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: `1px solid ${K.line}`, fontSize: 13 }}>
                <Icon n="lock" s={13} c={K.mute} />
                <span>{h}</span>
              </li>
            ))}
          </ul>,
          <Limits key="l" titel="Grenzwerte Systemtemperatur" zeilen={GRENZ_TABELLEN.nasSysTemp} />,
          <Limits key="l2" titel="Grenzwerte Plattentemperatur" zeilen={GRENZ_TABELLEN.nasPlTemp} />,
        ];
      }
      const platten = sn.platten ?? [];
      const plattenZeile = (key: string | number, label: string, p: (typeof platten)[number] | undefined) => (
        <Zeile key={key} label={label} chip={!p ? <Quiet ton="neutral" wort="nicht lesbar" icon="info" /> : p.gesundheit === "fehler" ? <Chip a={{ ton: "krit", wort: "Fehler", icon: "octagon-x" }} /> : p.gesundheit === "warnung" ? <Chip a={{ ton: "warn", wort: "Warnung", icon: "triangle-alert" }} /> : <Quiet ton="gut" wort="gesund" icon="circle-check" />} text={p?.temp_c != null ? `${Math.round(p.temp_c)} °C` : undefined} />
      );
      return [
        <Kopf key="k" icon="hard-drive-upload" titel="NAS-Hardware" sub={sn.gemessen_am ? `Messung ${zeitpunktKurz(sn.gemessen_am, jetzt)} · nur lesend` : "nur lesend"} chip={chip("hardware")} />,
        sn.status === "fehler" ? <Hint key="f" ton="warn">{zugang?.text ?? "Die Abfrage am NAS schlägt fehl."}</Hint> : <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="hardware" nurProbleme />,
        <Tiles key="t">
          <Tile label="Systemtemperatur" wert={<TileWert v={leer(sn.system_temp_c, (n) => Math.round(n))} u="°C" />} sub={sn.system_temp_c == null ? "nicht lesbar" : undefined} />
          <Tile label="Prozessor NAS" wert={<TileWert v={leer(sn.cpu_temp_c, (n) => Math.round(n))} u="°C" />} sub={sn.last_prozent != null ? `Last ${Math.round(sn.last_prozent)} %` : undefined} />
          <Tile label="Arbeitsspeicher" wert={<TileWert v={leer(sn.ram_prozent, (n) => Math.round(n))} u="%" />} sub="belegt" />
          <Tile label="Laufzeit" wert={<TileWert v={sn.uptime_s != null ? dauerText(sn.uptime_s) : "–"} />} />
        </Tiles>,
        <div key="p" style={{ display: "flex", flexDirection: "column" }}>
          <Ov t="Schächte" style={{ marginBottom: 4 }} />
          {[1, 2, 3, 4].map((n) => plattenZeile(n, `Schacht 0${n}`, platten.find((x) => x.schacht === n && !x.extern)))}
          {platten.filter((x) => x.extern).sort((a, b) => a.schacht - b.schacht).map((p) => plattenZeile(`usb${p.schacht}`, plattenName(p, platten), p))}
          <Zeile label="Speicherpool / RAID" chip={sn.raid == null ? <Quiet ton="neutral" wort="nicht lesbar" icon="info" /> : sn.raid === "normal" ? <Quiet ton="gut" wort="normal" icon="circle-check" /> : sn.raid === "wiederaufbau" ? <Chip a={{ ton: "warn", wort: "Wiederaufbau", icon: "triangle-alert" }} /> : <Chip a={{ ton: "krit", wort: "degradiert", icon: "octagon-x" }} />} />
        </div>,
        <Limits key="l" titel="Grenzwerte Systemtemperatur" zeilen={GRENZ_TABELLEN.nasSysTemp} aktiv={aktiv("nas.hw.systemtemp")} />,
        <Limits key="l2" titel="Grenzwerte Plattentemperatur" zeilen={GRENZ_TABELLEN.nasPlTemp} aktiv={aktiv("nas.hw.plattentemp")} />,
      ];
    }
    case "backup": {
      const bk = fsm.backup;
      return [
        <Kopf key="k" icon="archive" titel="FSM-Sicherung" sub="App → NAS · jede Nacht 03:00" chip={chip("backup")} />,
        <AmpelTexte key="h" jetzt={jetzt} A={A} bauteil="backup" />,
        <div key="m" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Meta>Letzte Meldung</Meta>
          <Num v={bk.letzte_meldung_am ? zeitpunkt(bk.letzte_meldung_am, jetzt) : "noch keine"} size={20} />
          <Meta>{bk.letzte_status === "ok" ? "Status ok" : bk.letzte_status === "fehler" ? "Status Fehler" : "kein Status"}{bk.letzte_ok_am && bk.letzte_status !== "ok" ? ` · letzte OK-Meldung ${zeitpunkt(bk.letzte_ok_am, jetzt)}` : ""}</Meta>
        </div>,
        <Tiles key="t">
          <Tile label="Grösse gesamt" wert={<TileWert v={bk.groesse_gesamt ?? "–"} />} sub={bk.groesse_db || bk.groesse_dokumente ? `Datenbank ${bk.groesse_db ?? "?"} · Dokumente ${bk.groesse_dokumente ?? "?"}` : undefined} />
          <Tile label="Warn-Mails 7 Tage" wert={<TileWert v={bk.warnmails_7d} />} sub={bk.letzte_warnmail_am ? `zuletzt ${zeitpunktKurz(bk.letzte_warnmail_am, jetzt)}` : "keine"} />
        </Tiles>,
        <Link key="a" href="/nas?tab=backup" prefetch={false} style={{ fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start", textDecoration: "underline", textUnderlineOffset: 3, color: K.text }}>
          Zum Backup-Tab
          <Icon n="chevron-right" s={14} />
        </Link>,
        <Limits key="l" titel="Grenzwerte" zeilen={GRENZ_TABELLEN.backup} aktiv={aktiv("backup.fsm")} />,
      ];
    }
    case "ereignisse": {
      const ev = stand.ereignisse;
      return [
        <Kopf key="k" icon="bell" titel="Letzte 24 h" sub={`${ev.length} Einträge · ${stand.gesamt.probleme.length ? `${stand.gesamt.probleme.length} offene Probleme` : "kein offenes Problem"} · neueste zuerst`} />,
        ev.length ? (
          <ol key="l" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
            {ev.map((e) => <EreignisZeile key={e.id} e={e} s={s} />)}
          </ol>
        ) : <Note key="l">Keine Ereignisse in den letzten 24 Stunden.</Note>,
      ];
    }
    case "uebersicht": {
      const pr = stand.gesamt.probleme;
      // Gleichartige Hinweise eines Bauteils (z. B. alle NAS-Hardware-Werte «kommt») als eine Zeile
      const imBlick: Ampel[] = [];
      for (const a of A) {
        if (a.stufe !== "neutral" || !a.neutral || !["kommt", "soll_offen", "veraltet", "nie_gemeldet", "nicht_lesbar"].includes(a.neutral)) continue;
        const i = imBlick.findIndex((b) => b.bauteil === a.bauteil && b.neutral === a.neutral && b.text === a.text);
        if (i < 0) imBlick.push(a);
        else imBlick[i] = { ...imBlick[i], titel: BAUTEIL_NAME[a.bauteil], wert: null };
      }
      const gcols = { gridTemplateColumns: "minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) 14px", gap: 8 } as const;
      return [
        <Kopf key="k" icon="list" titel="Auf einen Blick" sub="Was Aufmerksamkeit braucht und ab wann gewarnt wird" />,
        <div key="p" style={{ display: "flex", flexDirection: "column" }}>
          <Ov t="Braucht Aufmerksamkeit" style={{ marginBottom: 6 }} />
          {pr.length ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{pr.map((a) => <AmpelZeile key={a.schluessel} a={a} s={s} />)}</ul>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", borderTop: `1px solid ${K.line}`, fontSize: 13 }}>
              <Icon n="circle-check" s={14} c={st("gut", "ic")} />
              <span>Nichts. Alles läuft.</span>
            </div>
          )}
        </div>,
        // 24-h-Streifen: in der Detail-Spalte hier, bei schmalem Fenster unter der Szene (stil.ts).
        <div key="s" className="td-streifen-panel" style={{ flexDirection: "column" }}>
          <Streifen s={s} eingebettet />
        </div>,
        imBlick.length ? (
          <div key="b" style={{ display: "flex", flexDirection: "column" }}>
            <Ov t="Im Blick behalten" style={{ marginBottom: 6 }} />
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{imBlick.map((a) => <AmpelZeile key={a.schluessel} a={a} s={s} />)}</ul>
          </div>
        ) : null,
        <div key="g" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Ov t="Grenzwerte auf einen Blick" style={{ marginBottom: 4 }} />
          <div style={{ display: "grid", ...gcols, padding: "0 0 6px", fontSize: 11.5, fontWeight: 700 }}>
            <span style={{ color: K.mute, fontWeight: 600 }}>Bauteil</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: st("warn", "fg") }}><Icon n="triangle-alert" s={12} c={st("warn", "ic")} />Warnung</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: st("krit", "fg") }}><Icon n="octagon-x" s={12} c={st("krit", "ic")} />Kritisch</span>
            <span />
          </div>
          {GRENZ_UEBERSICHT.map(([to, n, w, kr]) => (
            <button key={n} type="button" className="row-hover" onClick={() => s.waehle(to as TeilKey)} aria-label={`${n}: Warnung ${w}, kritisch ${kr}. Details öffnen`} style={{ ...BTN, display: "grid", ...gcols, alignItems: "center", width: "100%", padding: "6px 0", borderTop: `1px solid ${K.line}`, fontSize: 12.5, ...NUM }}>
              <span style={{ minWidth: 0 }}>{n}</span>
              <span style={{ minWidth: 0, color: K.sub }}>{w}</span>
              <span style={{ minWidth: 0, color: K.sub }}>{kr}</span>
              <span style={{ display: "block" }}><Icon n="chevron-right" s={13} c={K.mute} /></span>
            </button>
          ))}
        </div>,
      ];
    }
  }
}

function AmpelZeile({ a, s }: { a: Ampel; s: Sicht }) {
  const an = anzeigeVon(a);
  return (
    <li style={{ borderTop: `1px solid ${K.line}` }}>
      <button type="button" className="row-hover" onClick={() => s.waehle(a.bauteil)} aria-label={`${an.wort}: ${a.titel}. ${a.text} Details öffnen`} style={{ ...BTN, width: "100%", display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0" }}>
        <span style={{ flex: "none", paddingTop: 1, display: "inline-flex", gap: 6 }}><Chip a={an} /></span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4, ...NUM }}>
          <b>{a.titel}</b>
          {a.wert ? ` · ${a.wert}` : ""}
          <span style={{ display: "block", color: K.sub }}>{a.text}</span>
        </span>
        <span style={{ flex: "none", paddingTop: 3 }}><Icon n="chevron-right" s={14} c={K.mute} /></span>
      </button>
    </li>
  );
}

const EREIGNIS_ANZEIGE: Record<Ereignis["stufe"], Anzeige> = {
  kritisch: { ton: "krit", wort: "Kritisch", icon: "octagon-x" },
  warnung: { ton: "warn", wort: "Warnung", icon: "triangle-alert" },
  hinweis: { ton: "neutral", wort: "Hinweis", icon: "info" },
  gut: { ton: "gut", wort: "Gut", icon: "circle-check" },
};

function EreignisZeile({ e, s }: { e: Ereignis; s: Sicht }) {
  const an = EREIGNIS_ANZEIGE[e.stufe];
  const zeit = e.zeitpunkt ? zeitpunktKurz(e.zeitpunkt, s.jetzt) : "andauernd";
  const inhalt = (
    <>
      <span style={{ fontSize: 12, color: K.mute, ...NUM, paddingTop: 1 }}>{zeit}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span><Chip a={an} /></span>
        <span style={{ fontSize: 13, lineHeight: 1.4, ...NUM }}>{e.text}</span>
      </span>
      <span style={{ paddingTop: 2 }}>{e.bauteil ? <Icon n="chevron-right" s={14} c={K.mute} /> : null}</span>
    </>
  );
  const grid = { width: "100%", display: "grid", gridTemplateColumns: "84px minmax(0,1fr) 14px", gap: 10, alignItems: "start", padding: "10px 0" } as const;
  return (
    <li style={{ borderTop: `1px solid ${K.line}` }}>
      {e.bauteil ? (
        <button type="button" className="row-hover" onClick={() => s.waehle(e.bauteil as Bauteil)} aria-label={`${an.wort} ${zeit}: ${e.text} Bauteil öffnen`} style={{ ...BTN, ...grid }}>{inhalt}</button>
      ) : (
        <div style={grid}>{inhalt}</div>
      )}
    </li>
  );
}
