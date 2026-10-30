"use client";

// Zweite Ansicht des Buero-Bildschirms (Leo 2026-10-30, Neugestaltung am
// selben Abend): oben vier grosse Kennzahlen, darunter je Kampagne eine
// Karte mit Ring (wie weit ist sie, was kam zurueck); rechts die naechste
// Aussendung mit Countdown, die neuesten Antworten und was im Vertrieb
// Aufmerksamkeit braucht. Nur Zaehler und Firmennamen.

import { Check, Send } from "lucide-react";
import type { BildschirmKampagne, BildschirmVertrieb, VertriebStatus } from "@/lib/bildschirm-typen";
import { ZRH } from "./format";

type Ton = "gruen" | "amber" | "rot" | "grau" | "blau";

const STATUS: Partial<Record<VertriebStatus, { label: string; ton: Ton }>> = {
  geantwortet: { label: "Antwort offen", ton: "amber" },
  anrufen: { label: "anrufen", ton: "amber" },
  termin: { label: "Termin", ton: "gruen" },
  offerte: { label: "Offerte", ton: "gruen" },
  auftrag: { label: "Auftrag", ton: "gruen" },
  kein_bedarf: { label: "kein Bedarf", ton: "grau" },
  unzustellbar: { label: "unzustellbar", ton: "rot" },
  gesendet: { label: "angeschrieben", ton: "blau" },
};

/** Segmente des Kampagnen-Rings, in Lesereihenfolge ab 12 Uhr. */
const SEGMENTE: { key: string; label: string; farbe: string; wert: (k: BildschirmKampagne) => number }[] = [
  { key: "gespraech", label: "Im Gespräch", farbe: "var(--gruen)", wert: (k) => k.im_gespraech },
  { key: "kein", label: "Kein Bedarf", farbe: "#6b6b76", wert: (k) => k.kein_bedarf },
  { key: "unz", label: "Unzustellbar", farbe: "var(--rot)", wert: (k) => k.unzustellbar },
  { key: "wartet", label: "Wartet auf Antwort", farbe: "var(--blau)", wert: (k) => Math.max(0, k.angeschrieben - k.im_gespraech - k.kein_bedarf - k.unzustellbar) },
  { key: "geplant", label: "Geplant", farbe: "#a78bfa", wert: (k) => k.geplant },
];

function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)} %`;
}
function wann(iso: string, heuteIso: string): string {
  const d = new Date(iso);
  if (d.toLocaleDateString("sv-SE", { timeZone: ZRH }) === heuteIso) {
    return d.toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short", day: "numeric", month: "numeric" }).replace(".,", ",");
}
function countdown(zielIso: string, jetzt: Date | null): string {
  if (!jetzt) return "";
  const ms = new Date(zielIso).getTime() - jetzt.getTime();
  if (ms <= 0) return "läuft";
  const std = Math.floor(ms / 3_600_000);
  const tage = Math.floor(std / 24);
  if (tage >= 1) return `in ${tage} ${tage === 1 ? "Tag" : "Tagen"} ${std % 24} Std.`;
  const min = Math.floor((ms % 3_600_000) / 60_000);
  return std > 0 ? `in ${std} Std. ${min} Min.` : `in ${min} Min.`;
}
function initialen(firma: string): string {
  const w = firma.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase() || "·";
}

function Ring({ k }: { k: BildschirmKampagne }) {
  const R = 42;
  const U = 2 * Math.PI * R;
  const LUECKE = 1.4;
  const gesamt = Math.max(1, k.kontakte);
  const werte = SEGMENTE.map((s) => s.wert(k));
  const boegen = SEGMENTE.map((s, i) => {
    const n = werte[i];
    const laenge = (n / gesamt) * U;
    const start = (werte.slice(0, i).reduce((x, y) => x + y, 0) / gesamt) * U;
    return { key: s.key, farbe: s.farbe, laenge: Math.max(0.6, laenge - (laenge > LUECKE * 2 ? LUECKE : 0)), start, n };
  }).filter((b) => b.n > 0);
  const haupt = k.angeschrieben > 0 ? { n: k.angeschrieben, l: "angeschrieben" } : k.geplant > 0 ? { n: k.geplant, l: "geplant" } : { n: k.kontakte, l: "Kontakte" };
  return (
    <div className="v-ring">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={R} className="v-ring-spur" />
        {boegen.map((b, i) => (
          <circle
            key={b.key}
            cx="50" cy="50" r={R}
            className="v-ring-bogen"
            stroke={b.farbe}
            strokeDasharray={`${b.laenge} ${U}`}
            strokeDashoffset={-b.start}
            style={{ animationDelay: `${0.8 + i * 0.12}s` }}
          />
        ))}
      </svg>
      <div className="v-ring-mitte">
        <span className="v-ring-n">{haupt.n}</span>
        <span className="v-ring-l">{haupt.l}</span>
      </div>
    </div>
  );
}

export function VertriebAnsicht({ v, heuteIso, jetzt, aktiv }: { v: BildschirmVertrieb | null; heuteIso: string; jetzt: Date | null; aktiv: boolean }) {
  const p = v?.pipeline;
  const imGespraech = v ? v.kampagnen.reduce((s, k) => s + k.im_gespraech, 0) : 0;
  const kpis = v && p
    ? [
        { key: "raus", label: "Angeschrieben", n: p.angeschrieben, sub: (() => { const z = v.kampagnen.filter((k) => k.angeschrieben > 0).length; return `aus ${z} ${z === 1 ? "Kampagne" : "Kampagnen"}`; })(), ton: "blau" },
        { key: "antw", label: "Antworten", n: p.antworten, sub: `Rücklauf ${prozent(p.antworten, p.angeschrieben)}`, ton: "amber" },
        { key: "gespr", label: "Im Gespräch", n: imGespraech, sub: `${p.termin} Termine · ${p.offerte} Offerten`, ton: "gruen" },
        { key: "geplant", label: "Geplant", n: p.geplant, sub: "Mails in der Warteschlange", ton: "lila" },
      ]
    : [];
  const a = v?.achtung;
  const punkte = a
    ? [
        { key: "antworten", label: "Antworten warten auf uns", n: a.antworten_offen, ton: "rot" },
        { key: "anrufen", label: "Kontakte anrufen", n: a.anrufen, ton: "amber" },
        { key: "nachfassen", label: "Nachfassen fällig", n: a.nachfassen, ton: "amber" },
        { key: "unzustellbar", label: "Adressen unzustellbar", n: a.unzustellbar, ton: "blau" },
      ].filter((x) => x.n > 0)
    : [];
  const n = v?.naechste;

  return (
    <div className={`b-mitte b-ansicht v-ansicht${aktiv ? " an" : " aus"}`} aria-hidden={!aktiv}>
      <div className="b-links v-links">
        {/* Kennzahlen */}
        <section className="v-kpis">
          {!v
            ? [0, 1, 2, 3].map((x) => <div key={x} className="b-skel v-kpi-skel" />)
            : kpis.map((k) => (
                <div key={k.key} className={`b-panel v-kpi ${k.ton}`}>
                  <span className="v-kpi-l">{k.label}</span>
                  <span className="v-kpi-n">{k.n}</span>
                  <span className="v-kpi-s">{k.sub}</span>
                </div>
              ))}
        </section>

        {/* Kampagnen */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Kampagnen</span>
            <b>{v ? `${v.kampagnen.reduce((s, k) => s + k.kontakte, 0)} Kontakte` : ""}</b>
          </div>
          <div className="v-kampagnen">
            {!v ? (
              [0, 1, 2].map((x) => <div key={x} className="b-skel" />)
            ) : v.kampagnen.length === 0 ? (
              <div className="b-leer">Keine laufenden Kampagnen.</div>
            ) : (
              v.kampagnen.map((k) => {
                const offen = k.kontakte - k.angeschrieben - k.geplant;
                return (
                  <div key={k.id} className="v-karte">
                    <div className="v-karte-kopf">
                      <span className="v-karte-name">{k.name}</span>
                      {k.angeschrieben > 0 && <span className="v-quote">{prozent(k.antworten, k.angeschrieben)}</span>}
                    </div>
                    <Ring k={k} />
                    <div className="v-zeilen">
                      {SEGMENTE.map((s) => {
                        const w = s.wert(k);
                        if (w === 0) return null;
                        return (
                          <div key={s.key} className="v-zeile">
                            <i style={{ background: s.farbe }} />
                            <span>{s.label}</span>
                            <b>{w}</b>
                          </div>
                        );
                      })}
                      {offen > 0 && (
                        <div className="v-zeile leise">
                          <i />
                          <span>Noch nicht angeschrieben</span>
                          <b>{offen}</b>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      <div className="b-spalte v-spalte">
        {/* Naechste Aussendung */}
        <section className="b-panel v-naechste">
          <div className="b-titel"><span>Nächste Aussendung</span>{n && <b className="v-countdown">{countdown(n.zeit, jetzt)}</b>}</div>
          {n ? (
            <div className="v-n-inhalt">
              <span className="v-n-icon"><Send strokeWidth={2.2} /></span>
              <div className="v-n-text">
                <span className="v-n-wann">
                  {new Date(n.zeit).toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "long", day: "numeric", month: "long" })}
                  <span> · {new Date(n.zeit).toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                <span className="v-n-was"><b>{n.anzahl}</b> {n.anzahl === 1 ? "Mail" : "Mails"} · {n.kampagne}</span>
              </div>
            </div>
          ) : (
            <div className="b-leer">Nichts geplant.</div>
          )}
        </section>

        {/* Neueste Antworten */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Neueste Antworten</span>
            <b>{v ? `${v.pipeline.antworten} total` : ""}</b>
          </div>
          <div className="v-antworten">
            {!v ? (
              [0, 1, 2, 3].map((x) => <div key={x} className="b-skel" />)
            ) : v.antworten.length === 0 ? (
              <div className="b-leer">Noch keine Antworten.</div>
            ) : (
              v.antworten.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, ton: "grau" as Ton };
                return (
                  <div key={r.id} className="v-antwort">
                    <span className={`v-av ${st.ton}`}>{initialen(r.firma)}</span>
                    <span className="v-a-text">
                      <span className="v-a-firma">{r.firma}</span>
                      <span className="v-a-kamp">{r.kampagne} · {wann(r.zeit, heuteIso)}</span>
                    </span>
                    <span className={`b-chip ${st.ton}`}>{st.label}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Aufmerksamkeit */}
        <section className="b-panel">
          <div className="b-titel"><span>Vertrieb · braucht Aufmerksamkeit</span></div>
          <div className="b-achtung">
            {!v ? (
              [0, 1].map((x) => <div key={x} className="b-skel" />)
            ) : punkte.length === 0 ? (
              <div className="b-ok"><Check strokeWidth={3} /> Alles beantwortet</div>
            ) : (
              punkte.map((x) => (
                <div key={x.key} className={`b-punkt ${x.ton}`}>
                  <span>{x.label}</span>
                  <span className="b-n">{x.n}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
