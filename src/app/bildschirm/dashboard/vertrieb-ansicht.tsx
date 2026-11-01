"use client";

// Zweite Ansicht des Buero-Bildschirms (Leo 2026-10-30, vereinfacht
// 2026-11-01: «nur die wichtigsten Infos»). Links oben das Ziel bis 31.12.
// als drei Kreise, darunter je Kampagne eine Zeile; rechts «Als Naechstes»,
// «Offene Gespraeche» (gemessen, «+n weitere») und «Braucht Aufmerksamkeit».
// Farben: Gruen = erreicht, Rot-Chip = dringend, Amber = wartet auf uns.

import { useRef } from "react";
import { Check } from "lucide-react";
import type { BildschirmGespraech, BildschirmKampagne, BildschirmVertrieb } from "@/lib/bildschirm-typen";
import { plusTage } from "@/lib/swiss-time";
import { ZRH, kurzDatum, uhrzeit } from "./format";
import { useZeilenPassen } from "./zeilen-passen";

const NAECHSTES_MAX = 3;
/** Ab so vielen Tagen ohne unsere Reaktion ist eine Antwort «dringend». */
const DRINGEND_TAGE = 2;

/** Vertriebsplan bis Ende Jahr (Leo 2026-10-30), bewusst fest im Code. */
const ZIEL_ENDE = "2026-12-31";
const ZIEL_LEADS = 40;
const ZIEL_GESPRAECHE = 10;
const ZIEL_AUFTRAEGE = 1;
/** Serien zaehlen nicht als belegte Leads, nur die Kampagnen aus dem Plan. */
const NICHT_IM_PLAN = new Set(["Messe 2027", "Schulen 2027"]);
/** Messe-Serie liegt auf der Stoppliste (Leo 2026-10-30): kein Nachfassen. */
const KEIN_NACHFASSEN = new Set(["Messe 2027"]);

const GRUPPE_KURZ: Record<BildschirmGespraech["status"], string> = {
  geantwortet: "Antwort offen",
  anrufen: "anrufen",
  termin: "Termin",
  offerte: "Offerte",
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
function tageBis(heuteIso: string, ziel: string): number {
  return Math.round((Date.parse(`${ziel}T12:00:00Z`) - Date.parse(`${heuteIso}T12:00:00Z`)) / 86_400_000);
}
function summeVon(liste: BildschirmKampagne[], wert: (k: BildschirmKampagne) => number): number {
  return liste.reduce((s, k) => s + wert(k), 0);
}

/** Fortschritt zum Ziel als Ring — zeichnet sich beim Einblenden auf. */
function ZielKreis({ wert, ziel, label, verzoegerung }: { wert: number; ziel: number; label: string; verzoegerung: number }) {
  const dicke = 9;
  const R = 50 - dicke / 2 - 1;
  const U = 2 * Math.PI * R;
  const laenge = (Math.min(wert, ziel) / ziel) * U;
  return (
    <div className="v-ziel">
      <div className="v-kreis">
        <svg viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r={R} strokeWidth={dicke} className="v-spur" />
          {wert > 0 && (
            <circle
              cx="50" cy="50" r={R}
              strokeWidth={dicke}
              stroke="var(--gruen)"
              strokeDasharray={`${laenge} ${U}`}
              className="v-bogen"
              style={{ "--u": U, animationDelay: `${verzoegerung}s` } as React.CSSProperties}
            />
          )}
        </svg>
        <div className="v-kreis-mitte">
          <span className="v-k-n">{wert}</span>
          <span className="v-k-l">von {ziel}</span>
        </div>
      </div>
      <div className="v-ziel-l">{label}</div>
    </div>
  );
}

export function VertriebAnsicht({ v, heuteIso, aktiv }: { v: BildschirmVertrieb | null; heuteIso: string; aktiv: boolean }) {
  const listeRef = useRef<HTMLDivElement>(null);
  const max = useZeilenPassen(listeRef, v?.jetzt ?? "", 1.9);

  const gespraeche = v?.gespraeche ?? [];
  const sichtbar = max === null ? gespraeche : gespraeche.slice(0, max);
  const rest = gespraeche.length - sichtbar.length;
  const kampagnen = v?.kampagnen ?? [];
  const leads = summeVon(kampagnen.filter((k) => !NICHT_IM_PLAN.has(k.name)), (k) => k.angeschrieben);
  const echteGespraeche = summeVon(kampagnen, (k) => k.termin + k.offerte + k.auftrag);
  const auftraege = summeVon(kampagnen, (k) => k.auftrag);
  const resttage = heuteIso ? tageBis(heuteIso, ZIEL_ENDE) : 0;
  const naechstes = v
    ? v.naechstes.filter((s) => !(s.art === "nachfassen" && KEIN_NACHFASSEN.has(s.kampagne))).slice(0, NAECHSTES_MAX)
    : [];
  const a = v?.achtung;
  const punkte = a
    ? [
        { key: "antworten", label: "Antworten warten auf uns", n: a.antworten_offen, ton: "rot" },
        { key: "anrufen", label: "Kontakte anrufen", n: a.anrufen, ton: "amber" },
      ].filter((x) => x.n > 0)
    : [];

  return (
    <div className={`b-mitte b-ansicht${aktiv ? " an" : " aus"}`} aria-hidden={!aktiv}>
      <div className="b-links">
        {/* Ziel */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Ziel bis 31.12.</span>
            <b>{resttage > 0 ? `noch ${resttage} Tage` : ""}</b>
          </div>
          {!v ? (
            <div className="b-skel v-skel-gross" />
          ) : (
            <div className="v-ziele">
              <ZielKreis wert={leads} ziel={ZIEL_LEADS} label="Belegte Leads angeschrieben" verzoegerung={0.7} />
              <ZielKreis wert={echteGespraeche} ziel={ZIEL_GESPRAECHE} label="Echte Gespräche" verzoegerung={0.9} />
              <ZielKreis wert={auftraege} ziel={ZIEL_AUFTRAEGE} label="Neuer Auftrag" verzoegerung={1.1} />
            </div>
          )}
        </section>

        {/* Kampagnen */}
        <section className="b-panel">
          <div className="b-titel"><span>Kampagnen</span></div>
          <div className="v-tabelle">
            <div className="v-zeile v-kopfzeile">
              <span />
              <span>Raus</span>
              <span>Antworten</span>
              <span>Im Gespräch</span>
            </div>
            {!v
              ? [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
              : kampagnen.map((k) => (
                  <div key={k.id} className="v-zeile">
                    <b>{k.name}</b>
                    <span>{k.angeschrieben > 0 ? k.angeschrieben : "–"}</span>
                    <span>{k.angeschrieben > 0 ? k.antworten : "–"}</span>
                    <span className={k.angeschrieben > 0 && k.im_gespraech > 0 ? "gruen" : undefined}>{k.angeschrieben > 0 ? k.im_gespraech : "–"}</span>
                  </div>
                ))}
          </div>
        </section>
      </div>

      <div className="b-spalte">
        {/* Als Naechstes */}
        <section className="b-panel">
          <div className="b-titel"><span>Als Nächstes</span></div>
          <div className="b-feed">
            {!v ? (
              [0, 1].map((i) => <div key={i} className="b-skel" />)
            ) : naechstes.length === 0 ? (
              <div className="b-leer">Gerade nichts geplant.</div>
            ) : (
              naechstes.map((s) => {
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
              })
            )}
          </div>
        </section>

        {/* Offene Gespraeche */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Offene Gespräche</span>
            <b>{v ? gespraeche.length : ""}</b>
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
