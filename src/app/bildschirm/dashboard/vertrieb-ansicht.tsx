"use client";

// Zweite Ansicht des Buero-Bildschirms (Leo 2026-10-30): der Vertrieb in
// der Sprache des Firmen-Dashboards (Panels, Titel, Farbe nur mit
// Bedeutung), aber mit Diagrammen: links gross der Kreis ueber alle
// Kontakte mit Kennzahlen, Legende und «Als Naechstes», darunter je
// Kampagne ein kleiner Kreis; rechts «Zuletzt im Vertrieb» (3 Zeilen),
// «Offene Gespraeche» (gemessen, «+n weitere») und «Braucht Aufmerksamkeit».
// Farben: Gruen = im Gespraech, Blau = angeschrieben/geplant, Grau = kein
// Bedarf, gedaempftes Rot = unzustellbar, Rot-Chip = dringend.

import { useRef, type ReactNode } from "react";
import { Check } from "lucide-react";
import type {
  BildschirmGespraech, BildschirmKampagne, BildschirmVertrieb, BildschirmVertriebArt, BildschirmVertriebEreignis,
} from "@/lib/bildschirm-typen";
import { plusTage } from "@/lib/swiss-time";
import { ZRH, kurzDatum, uhrzeit } from "./format";
import { useZeilenPassen } from "./zeilen-passen";

const FEED_MAX = 3;
const NAECHSTES_MAX = 3;
/** Ab so vielen Tagen ohne unsere Reaktion ist eine Antwort «dringend». */
const DRINGEND_TAGE = 2;

type Zahlen = Pick<BildschirmKampagne, "kontakte" | "geplant" | "angeschrieben" | "antworten" | "im_gespraech" | "kein_bedarf" | "unzustellbar">;

/** Segmente der Kreise, im Uhrzeigersinn ab 12 Uhr. Der Rest des Kreises
 *  (noch nicht angeschrieben) bleibt die leere Spur. */
const SEGMENTE: { key: string; label: string; farbe: string; wert: (z: Zahlen) => number }[] = [
  { key: "gespraech", label: "Im Gespräch", farbe: "var(--gruen)", wert: (z) => z.im_gespraech },
  { key: "wartet", label: "Angeschrieben, wartet", farbe: "var(--blau)", wert: (z) => Math.max(0, z.angeschrieben - z.im_gespraech - z.kein_bedarf - z.unzustellbar) },
  { key: "kein", label: "Kein Bedarf", farbe: "#62626d", wert: (z) => z.kein_bedarf },
  { key: "unz", label: "Unzustellbar", farbe: "#a8403e", wert: (z) => z.unzustellbar },
  { key: "geplant", label: "Geplant", farbe: "rgba(96, 165, 250, 0.38)", wert: (z) => z.geplant },
];

const GRUPPE_KURZ: Record<BildschirmGespraech["status"], string> = {
  geantwortet: "Antwort offen",
  anrufen: "anrufen",
  termin: "Termin",
  offerte: "Offerte",
};

const ART: Record<BildschirmVertriebArt, { label: string; gruen: boolean }> = {
  antwort: { label: "Antwort", gruen: true },
  kein_bedarf: { label: "Kein Bedarf", gruen: false },
  unzustellbar: { label: "Unzustellbar", gruen: false },
  versand: { label: "Versendet", gruen: false },
};

function tagIso(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: ZRH });
}
function tageSeit(iso: string, heuteIso: string): number {
  return Math.round((Date.parse(`${heuteIso}T12:00:00Z`) - Date.parse(`${tagIso(iso)}T12:00:00Z`)) / 86_400_000);
}
function seitText(iso: string, heuteIso: string): string {
  const n = tageSeit(iso, heuteIso);
  if (n <= 0) return "heute";
  if (n === 1) return "gestern";
  if (n < 14) return `seit ${n} Tagen`;
  return `seit ${Math.round(n / 7)} Wo.`;
}
function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}
function summe(liste: BildschirmKampagne[]): Zahlen {
  const z: Zahlen = { kontakte: 0, geplant: 0, angeschrieben: 0, antworten: 0, im_gespraech: 0, kein_bedarf: 0, unzustellbar: 0 };
  for (const k of liste) for (const f of Object.keys(z) as (keyof Zahlen)[]) z[f] += k[f];
  return z;
}

/** Kreisdiagramm (Ring) — zeichnet sich beim Einblenden der Ansicht auf. */
function Kreis({ z, dicke, verzoegerung, children }: { z: Zahlen; dicke: number; verzoegerung: number; children?: ReactNode }) {
  const R = 50 - dicke / 2 - 1;
  const U = 2 * Math.PI * R;
  const gesamt = Math.max(1, z.kontakte);
  const werte = SEGMENTE.map((s) => s.wert(z));
  const luecke = dicke > 8 ? 0.9 : 0.6;
  const boegen = SEGMENTE.map((s, i) => {
    const laenge = (werte[i] / gesamt) * U;
    const start = (werte.slice(0, i).reduce((x, y) => x + y, 0) / gesamt) * U;
    return { key: s.key, farbe: s.farbe, n: werte[i], start, laenge: Math.max(0.5, laenge - (laenge > luecke * 3 ? luecke : 0)) };
  }).filter((b) => b.n > 0);
  return (
    <div className="v-kreis">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={R} strokeWidth={dicke} className="v-spur" />
        {boegen.map((b, i) => (
          <circle
            key={b.key}
            cx="50" cy="50" r={R}
            strokeWidth={dicke}
            stroke={b.farbe}
            strokeDasharray={`${b.laenge} ${U}`}
            strokeDashoffset={-b.start}
            className="v-bogen"
            style={{ "--u": U, animationDelay: `${verzoegerung + i * 0.18}s` } as React.CSSProperties}
          />
        ))}
      </svg>
      {children && <div className="v-kreis-mitte">{children}</div>}
    </div>
  );
}

export function VertriebAnsicht({ v, heuteIso, aktiv }: { v: BildschirmVertrieb | null; heuteIso: string; aktiv: boolean }) {
  const listeRef = useRef<HTMLDivElement>(null);
  const max = useZeilenPassen(listeRef, v?.jetzt ?? "", 1.9);

  const gespraeche = v?.gespraeche ?? [];
  const sichtbar = max === null ? gespraeche : gespraeche.slice(0, max);
  const rest = gespraeche.length - sichtbar.length;
  const z = summe(v?.kampagnen ?? []);
  const feed = v ? v.zuletzt.liste.slice(0, FEED_MAX) : [];
  const feedRest = v ? Math.max(0, v.zuletzt.anzahl_7_tage - feed.filter((e) => e.zeit >= v.zuletzt.seit_7_tage).length) : 0;
  const offen = Math.max(0, z.kontakte - z.angeschrieben - z.geplant);
  const a = v?.achtung;
  const punkte = a
    ? [
        { key: "antworten", label: "Antworten warten auf uns", n: a.antworten_offen, ton: "rot" },
        { key: "anrufen", label: "Kontakte anrufen", n: a.anrufen, ton: "amber" },
        { key: "nachfassen", label: "Nachfassen fällig", n: a.nachfassen, ton: "amber" },
        { key: "unzustellbar", label: "Adressen unzustellbar", n: a.unzustellbar, ton: "blau" },
      ].filter((x) => x.n > 0)
    : [];

  return (
    <div className={`b-mitte b-ansicht${aktiv ? " an" : " aus"}`} aria-hidden={!aktiv}>
      <div className="b-links">
        {/* Gesamtbild */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Vertrieb · alle Kampagnen</span>
            <b>{v ? `${z.kontakte} Kontakte` : ""}</b>
          </div>
          {!v ? (
            <div className="b-skel v-skel-gross" />
          ) : (
            <div className="v-gesamt">
              <Kreis z={z} dicke={11} verzoegerung={0.7}>
                <span className="v-k-n">{z.angeschrieben}</span>
                <span className="v-k-l">von {z.kontakte} angeschrieben</span>
              </Kreis>
              <div className="v-text">
                <div className="v-zahlen">
                  <div><span className="v-z-n">{z.antworten}</span><span className="v-z-l">Antworten</span></div>
                  <div><span className="v-z-n gruen">{prozent(z.antworten, z.angeschrieben)}</span><span className="v-z-l">Rücklauf</span></div>
                  <div><span className="v-z-n">{z.im_gespraech}</span><span className="v-z-l">im Gespräch</span></div>
                </div>
                <div className="v-legende">
                  {SEGMENTE.map((s) => {
                    const w = s.wert(z);
                    if (w === 0) return null;
                    return (
                      <div key={s.key} className="v-leg">
                        <i style={{ background: s.farbe }} />
                        <span>{s.label}</span>
                        <b>{w}</b>
                        <small>{prozent(w, z.kontakte)}</small>
                      </div>
                    );
                  })}
                  {offen > 0 && (
                    <div className="v-leg leise">
                      <i />
                      <span>Noch nicht angeschrieben</span>
                      <b>{offen}</b>
                      <small>{prozent(offen, z.kontakte)}</small>
                    </div>
                  )}
                </div>
                {v.naechstes.length > 0 && (
                  <div className="v-als-naechstes">
                    <div className="b-monat"><span>Als Nächstes</span><span /></div>
                    {v.naechstes.slice(0, NAECHSTES_MAX).map((s) => {
                      const heute = s.tag === heuteIso;
                      const morgen = !!heuteIso && s.tag === plusTage(heuteIso, 1);
                      return (
                        <div key={s.id} className="v-schritt">
                          <span className={`b-faellig${heute ? " amber" : ""}`}>{heute ? "heute" : morgen ? "morgen" : kurzDatum(s.tag)}</span>
                          <span className="v-s-was">
                            {s.art === "versand" ? `${s.anzahl} ${s.anzahl === 1 ? "Mail" : "Mails"} raus` : `${s.anzahl} nachfassen`}
                          </span>
                          <span className="b-e-info">{s.kampagne}{s.zeit ? ` · ${uhrzeit(s.zeit)}` : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Kampagnen */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Kampagnen</span>
            <b>{v ? `${v.kampagnen.length} laufend` : ""}</b>
          </div>
          <div className="v-kampagnen" style={{ gridTemplateColumns: `repeat(${Math.max(1, v?.kampagnen.length ?? 3)}, minmax(0, 1fr))` }}>
            {(v?.kampagnen ?? []).map((k, i) => (
              <div key={k.id} className="v-kampagne">
                <Kreis z={k} dicke={14} verzoegerung={1.2 + i * 0.15}>
                  <span className="v-mini-n">{k.angeschrieben > 0 ? prozent(k.angeschrieben, k.kontakte) : k.geplant > 0 ? prozent(k.geplant, k.kontakte) : "0 %"}</span>
                </Kreis>
                <div className="v-k-text">
                  <b>{k.name}</b>
                  <span>
                    {k.angeschrieben > 0
                      ? `${k.angeschrieben} / ${k.kontakte} angeschrieben`
                      : k.geplant > 0
                        ? `${k.geplant} / ${k.kontakte} geplant`
                        : `${k.kontakte} Kontakte bereit`}
                  </span>
                  {k.angeschrieben > 0 && (
                    <span><em>{k.antworten} {k.antworten === 1 ? "Antwort" : "Antworten"}</em> · {prozent(k.antworten, k.angeschrieben)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="b-spalte">
        {/* Zuletzt im Vertrieb */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Zuletzt im Vertrieb</span>
            <b>{v ? `${v.zuletzt.anzahl_7_tage} in 7 Tagen` : ""}</b>
          </div>
          <div className="b-feed">
            {!v ? (
              [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
            ) : v.zuletzt.liste.length === 0 ? (
              <div className="b-leer">Seit 30 Tagen nichts Neues.</div>
            ) : (
              feed.map((e) => <Ereignis key={e.id} e={e} heuteIso={heuteIso} />)
            )}
            {v && feedRest > 0 && <div className="b-mehr">+{feedRest} weitere in 7 Tagen</div>}
          </div>
        </section>

        {/* Offene Gespraeche */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Offene Gespräche</span>
            <b>{v ? `${gespraeche.length} im Gespräch` : ""}</b>
          </div>
          <div className="b-agenda" ref={listeRef}>
            {!v ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="b-skel" />)
            ) : gespraeche.length === 0 ? (
              <div className="b-leer">Gerade keine offenen Gespräche.</div>
            ) : (
              sichtbar.map((g) => <GespraechZeile key={g.id} g={g} heuteIso={heuteIso} />)
            )}
            {v && rest > 0 && <div className="b-mehr">+{rest} weitere</div>}
          </div>
        </section>

        {/* Aufmerksamkeit */}
        <section className="b-panel">
          <div className="b-titel"><span>Braucht Aufmerksamkeit</span></div>
          <div className="b-achtung">
            {!v ? (
              [0, 1].map((i) => <div key={i} className="b-skel" />)
            ) : punkte.length === 0 ? (
              <div className="b-ok"><Check strokeWidth={3} /> Alles im grünen Bereich</div>
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

function GespraechZeile({ g, heuteIso }: { g: BildschirmGespraech; heuteIso: string }) {
  const tage = tageSeit(g.seit, heuteIso);
  const dringend = g.status === "geantwortet" && tage >= DRINGEND_TAGE;
  const d = new Date(g.seit);
  return (
    <div className={`b-auftrag b-fit${dringend ? " laeuft" : ""}`}>
      <div className="b-tagbox">
        <span className="b-tagnr">{d.toLocaleDateString("de-CH", { timeZone: ZRH, day: "2-digit" })}</span>
        <span className="b-tagwt">{d.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short" }).replace(".", "")}</span>
      </div>
      <div>
        <div className="b-a-titel">{g.firma}</div>
        <div className="b-a-sub">{[g.kampagne, g.ort].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="b-a-rechts">
        {dringend ? (
          <span className="b-chip rot">dringend</span>
        ) : (
          <span className={`b-chip ${g.status === "geantwortet" || g.status === "anrufen" ? "amber" : "grau"}`}>{GRUPPE_KURZ[g.status]}</span>
        )}
        <span className="b-rel">{seitText(g.seit, heuteIso)}</span>
      </div>
    </div>
  );
}

function Ereignis({ e, heuteIso }: { e: BildschirmVertriebEreignis; heuteIso: string }) {
  const { label, gruen } = ART[e.art];
  const zeitText = e.tag === heuteIso ? uhrzeit(e.zeit) : heuteIso && e.tag === plusTage(heuteIso, -1) ? "gestern" : kurzDatum(e.tag);
  return (
    <div className="b-ereignis">
      <span className="b-e-zeit">{zeitText}</span>
      <span className={`b-e-art${gruen ? " gruen" : ""}`}>{label}</span>
      <span className="b-e-titel">{e.titel}</span>
      <span className="b-e-rechts"><span className="b-e-info">{e.kampagne}</span></span>
    </div>
  );
}
