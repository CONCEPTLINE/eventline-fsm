// Technik-Dashboard: 24-h-Streifen (Entwurf strip()): Prozessor-Last, Arbeitsspeicher frei, KI-Warteschlange,
// FSM-Sicherung und Ereignisse auf einer gemeinsamen Zeitachse. Marken oeffnen das betroffene Bauteil.
// Kompakt (Mischa 2026-10-14): steht in der Uebersicht der Detail-Spalte («eingebettet»), bei schmalem
// Fenster als eigene Karte unter der Szene. Die wichtigsten Ereignisse stehen als kurze Liste unter der Achse.

import type { CSSProperties, ReactNode } from "react";
import type { Bauteil, Ereignis } from "@/lib/technik-dashboard/typen";
import { K, st } from "./farben";
import { BTN, Icon, Meta, NUM, Ov } from "./bausteine";
import { Spark, ticks } from "./kurve";
import { gbBin, tagKurz, uhr, zeitpunktKurz } from "./format";
import { bauteilAnzeige } from "./status";
import type { Sicht } from "./sicht";

const TAG_MS = 24 * 3_600_000;
const SPUR_H = 18;
const RANG = { kritisch: 3, warnung: 2, gut: 1, hinweis: 0 } as const;

const ereignisIcon = (e: Ereignis) => (e.stufe === "kritisch" ? "octagon-x" : e.stufe === "warnung" ? "triangle-alert" : e.stufe === "gut" ? "circle-check" : "info");
const ereignisTon = (e: Ereignis) => (e.stufe === "kritisch" ? "krit" : e.stufe === "warnung" ? "warn" : e.stufe === "gut" ? "gut" : "neutral");
const raute = (e: Ereignis, gross = 9): CSSProperties => {
  const t = ereignisTon(e);
  return { width: gross, height: gross, transform: "rotate(45deg)", background: t === "neutral" ? K.A : st(t, "ic"), boxShadow: `0 0 0 3px ${K.e1}`, flex: "none" };
};

export function Streifen({ s, eingebettet = false }: { s: Sicht; eingebettet?: boolean }) {
  const { stand, jetzt, reihen24: r } = s;
  const bis = r ? Date.parse(r.bis) : jetzt;
  const von = bis - TAG_MS;
  const x = (t: number) => Math.max(0, Math.min(100, ((t - von) / TAG_MS) * 100));
  const schritt = r?.schritt_s ?? 300;
  const nutzbar = stand.rig?.ram?.gesamt_b ? gbBin(stand.rig.ram.gesamt_b) : 48;
  const ymaxRam = Math.ceil(nutzbar / 8) * 8;
  const neustarts = (r?.neustarts ?? []).map((n) => Date.parse(n)).filter((t) => t >= von && t <= bis);

  const ev = stand.ereignisse.filter((e) => e.zeitpunkt && Date.parse(e.zeitpunkt) >= von);
  const bak = ev.filter((e) => e.bauteil === "backup");
  const andere = ev.filter((e) => e.bauteil !== "backup");
  const bakA = bauteilAnzeige(stand.ampeln, "backup");
  // Wichtigste Ereignisse zuerst (kritisch, Warnung, gut, Hinweis; dann neueste), hoechstens 3.
  const wichtig = andere.slice().sort((a, b) => RANG[b.stufe] - RANG[a.stufe] || Date.parse(b.zeitpunkt!) - Date.parse(a.zeitpunkt!)).slice(0, 3);
  // Beschriftung einer Sicherungs-Marke nur, solange sie in die Spur passt (schmal: linke Haelfte).
  const beschriftungBis = eingebettet ? 45 : 80;

  const zeileL = (t: string) => <span style={{ fontSize: 11.5, color: K.mute, whiteSpace: "nowrap", alignSelf: "center" }}>{t}</span>;
  const spur = (inhalt: ReactNode, extra?: CSSProperties) => (
    <div style={{ position: "relative", height: SPUR_H, borderRadius: 4, background: K.tile, ...extra }}>{inhalt}</div>
  );
  const schraffur = neustarts.map((t) => (
    <span key={t} aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${(x(t) - 0.6).toFixed(2)}%`, width: "1.4%", backgroundImage: `repeating-linear-gradient(135deg,${K.track} 0 1.5px,rgba(0,0,0,0) 1.5px 5px)` }} />
  ));
  const spark = (schluessel: string, ymax: number) =>
    r ? (
      <span aria-hidden="true" style={{ position: "absolute", inset: "2px 0 0" }}>
        <Spark punkte={r.werte[schluessel]} von={von} bis={bis} schrittS={schritt} ymin={0} ymax={ymax} h={SPUR_H - 2} />
      </span>
    ) : <span className="shimmer" style={{ position: "absolute", inset: 0, borderRadius: 4 }} />;

  const kopf = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
        {eingebettet ? (
          <Ov t="Letzte 24 h" />
        ) : (
          <>
            <Icon n="clock" s={16} c={K.mute} />
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Letzte 24 h</h2>
          </>
        )}
        <Meta>{eingebettet ? `${ev.length} Einträge` : `${tagKurz(von)}, ${uhr(von)} bis jetzt · ${ev.length} Einträge`}</Meta>
      </div>
      <button
        type="button"
        className="td-part"
        aria-pressed={s.sel === "ereignisse" && s.offen}
        aria-controls="td-details"
        aria-label="Alle Ereignisse der letzten 24 Stunden zeigen"
        onClick={() => s.waehle("ereignisse")}
        style={{ ...BTN, position: "relative", display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 8, boxShadow: `inset 0 0 0 1px ${K.line}`, fontSize: 12, fontWeight: 600 }}
      >
        {eingebettet ? null : <Icon n="bell" s={12} c={K.mute} />}
        Alle Ereignisse
        <Icon n="chevron-right" s={12} c={K.mute} />
      </button>
    </div>
  );

  return (
    <section
      aria-label="Letzte 24 Stunden"
      style={eingebettet
        ? { display: "flex", flexDirection: "column", gap: 8 }
        : { borderRadius: 14, background: K.e1, boxShadow: `0 0 0 1px ${K.hair},inset 0 1px 0 ${K.hiTop}`, padding: "12px 18px 12px", display: "flex", flexDirection: "column", gap: 10 }}
    >
      {kopf}
      <div className="td-strip" style={{ position: "relative", display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", columnGap: 10, rowGap: 4 }}>
        <div aria-hidden="true" style={{ gridColumn: 2, gridRow: "1 / 7", position: "relative", pointerEvents: "none", zIndex: 2 }}>
          {ticks("24h", von, bis).map(([tx]) => <span key={tx} style={{ position: "absolute", top: 0, bottom: 0, left: `${(tx * 100).toFixed(2)}%`, width: 1, background: K.grid }} />)}
          <span style={{ position: "absolute", top: -3, bottom: 14, left: "99.5%", width: 1, background: K.sel, opacity: 0.9 }} />
        </div>
        {zeileL("Prozessor-Last")}
        <div style={{ gridColumn: 2, gridRow: 1 }}>{spur(<>{schraffur}{spark("cpu.last", 100)}</>, { overflow: "hidden" })}</div>
        {zeileL("Arbeitsspeicher frei")}
        <div style={{ gridColumn: 2, gridRow: 2 }}>{spur(<>{schraffur}{spark("ram.verfuegbar_gb", ymaxRam)}</>, { overflow: "hidden" })}</div>
        {zeileL("KI-Warteschlange")}
        <div style={{ gridColumn: 2, gridRow: 3 }}>
          {spur(
            <>
              {spark("ki.warteschlange", Math.max(4, ...((r?.werte["ki.warteschlange"] ?? []).map((p) => p[2] ?? p[1] ?? 0))))}
              <span style={{ position: "absolute", right: 8, top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 11, color: K.sub, ...NUM }}>{stand.fsm.auftraege_24h} Aufträge in 24 h</span>
            </>,
            { overflow: "hidden" },
          )}
        </div>
        {zeileL("FSM-Sicherung")}
        <div style={{ gridColumn: 2, gridRow: 4 }}>
          {bakA.ton === "krit" || bakA.ton === "warn" ? (
            <button type="button" onClick={() => s.waehle("backup")} aria-label={`FSM-Sicherung ${bakA.wort}: ${bakA.ampel?.text ?? ""}. Details öffnen`} data-tooltip={bakA.ampel?.text || undefined} style={{ ...BTN, position: "relative", width: "100%", height: SPUR_H, borderRadius: 4, background: st(bakA.ton, "soft"), boxShadow: `inset 0 0 0 1px ${st(bakA.ton, "line")}`, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 11.5, ...NUM }}>
              <Icon n={bakA.icon} s={12} c={st(bakA.ton, "ic")} />
              <b style={{ color: st(bakA.ton, "fg") }}>{bakA.wort}</b>
              <span style={{ color: K.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bakA.ampel?.text ?? ""}</span>
            </button>
          ) : (
            spur(
              <>
                <span aria-hidden="true" style={{ position: "absolute", left: 8, right: 8, top: "50%", borderTop: `1px dashed ${K.dash}` }} />
                {bak.map((e) => (
                  <button key={e.id} type="button" onClick={() => s.waehle("backup")} aria-label={`FSM-Sicherung ${uhr(e.zeitpunkt)}: ${e.text} Details öffnen`} data-tooltip={`${zeitpunktKurz(e.zeitpunkt, jetzt)} · ${e.text}`} style={{ ...BTN, position: "absolute", left: `${x(Date.parse(e.zeitpunkt!)).toFixed(2)}%`, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 5, marginLeft: -7, zIndex: 3 }}>
                    <span style={{ display: "block", background: K.e1, borderRadius: "50%" }}><Icon n={ereignisIcon(e)} s={13} c={st(ereignisTon(e), "ic")} /></span>
                    {x(Date.parse(e.zeitpunkt!)) < beschriftungBis ? <span style={{ fontSize: 11, color: K.sub, ...NUM, whiteSpace: "nowrap", background: K.tile }}>{uhr(e.zeitpunkt)} {e.stufe === "gut" ? "Meldung ok" : "Meldung"}</span> : null}
                  </button>
                ))}
              </>,
            )
          )}
        </div>
        {zeileL("Ereignisse")}
        <div style={{ gridColumn: 2, gridRow: 5, position: "relative", height: SPUR_H }}>
          <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: `1px solid ${K.line}` }} />
          {andere.map((e) => {
            const xe = x(Date.parse(e.zeitpunkt!));
            const ziel = e.bauteil as Bauteil | null;
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => s.waehle(ziel ?? "ereignisse")}
                aria-label={`${e.stufe === "hinweis" ? "Hinweis" : e.stufe} ${uhr(e.zeitpunkt)}: ${e.text}. Öffnen`}
                data-tooltip={`${zeitpunktKurz(e.zeitpunkt, jetzt)} · ${e.text}`}
                style={{ ...BTN, position: "absolute", left: `${xe.toFixed(2)}%`, top: "50%", width: 18, height: 18, margin: "-9px 0 0 -9px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 }}
              >
                <span aria-hidden="true" style={raute(e)} />
              </button>
            );
          })}
        </div>
        <span style={{ gridColumn: 1, gridRow: 6 }} />
        <div style={{ gridColumn: 2, gridRow: 6, position: "relative", height: 13, fontSize: 10.5, lineHeight: "13px", color: K.mute, ...NUM }}>
          {ticks("24h", von, bis).map(([tx, t]) => <span key={tx} style={{ position: "absolute", left: `${(tx * 100).toFixed(2)}%`, transform: "translateX(-50%)" }}>{t}</span>)}
          <span style={{ position: "absolute", right: 0, fontWeight: 700, color: K.text }}>jetzt</span>
        </div>
      </div>
      {wichtig.length ? (
        <ul aria-label="Wichtigste Ereignisse" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {wichtig.map((e) => {
            const ziel = e.bauteil as Bauteil | null;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className="row-hover"
                  onClick={() => s.waehle(ziel ?? "ereignisse")}
                  aria-label={`${e.stufe === "hinweis" ? "Hinweis" : e.stufe} ${zeitpunktKurz(e.zeitpunkt, jetzt)}: ${e.text}. Öffnen`}
                  data-tooltip={e.text}
                  style={{ ...BTN, width: "100%", display: "grid", gridTemplateColumns: "10px max-content minmax(0,1fr)", columnGap: 8, alignItems: "center", padding: "5px 2px", borderTop: `1px solid ${K.line}`, fontSize: 12, lineHeight: 1.35, ...NUM }}
                >
                  <span aria-hidden="true" style={{ ...raute(e, 7), boxShadow: "none", justifySelf: "center" }} />
                  <span style={{ color: K.mute, whiteSpace: "nowrap" }}>{zeitpunktKurz(e.zeitpunkt, jetzt)}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
