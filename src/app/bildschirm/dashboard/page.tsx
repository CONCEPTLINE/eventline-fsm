"use client";

// Wand-Dashboard fuer den Buero-Monitor (Leo 2026-10-02): links die Agenda
// aller kommenden Auftraege (nach Monat), rechts Heute · Team · Aufmerksam-
// keit · Kennzahlen, unten Auftraege pro Woche. Daten alle 30 s still
// nachgeladen, Uhr auf Serverzeit synchronisiert, neue Builds laden sich
// selbst nach (kein Nutzer, keine Eingaben → gefahrlos). Kein Login:
// Zugang ueber das Bildschirm-Cookie (/bildschirm).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { BildschirmDaten, BildschirmTermin, BildschirmAuftrag } from "@/lib/bildschirm-typen";
import { initialen } from "@/components/ui/person-avatar";
import { BUILD_INFO } from "@/lib/build-info";
import "./board.css";

const ZRH = "Europe/Zurich";
const REFRESH_MS = 30_000;
const VERSION_MS = 10 * 60_000;
const AGENDA_MAX = 14;
const HEUTE_MAX = 4;

function zeit(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" });
}
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
function monatLang(datumIso: string): string {
  return tagDatum(datumIso).toLocaleDateString("de-CH", { timeZone: ZRH, month: "long", year: "numeric" });
}
function vorname(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
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
function statusVon(t: BildschirmTermin, jetztMs: number): "vorbei" | "laeuft" | "kommend" {
  const s = new Date(t.start).getTime();
  const e = t.ende ? new Date(t.ende).getTime() : null;
  if (e === null) return s <= jetztMs ? "vorbei" : "kommend";
  if (e <= jetztMs) return "vorbei";
  if (s <= jetztMs) return "laeuft";
  return "kommend";
}

const ABWESEND: Record<string, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

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
  const offsetRef = useRef(0);

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

  useEffect(() => {
    void laden();
    const id = setInterval(() => void laden(), REFRESH_MS);
    return () => clearInterval(id);
  }, [laden]);

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

  const jetztMs = jetzt?.getTime() ?? 0;
  const uhrTeile = jetzt
    ? new Intl.DateTimeFormat("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(jetzt)
    : [];
  const teil = (typ: string) => uhrTeile.find((p) => p.type === typ)?.value ?? "--";
  const datumLang = jetzt ? jetzt.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  const heuteIso = jetzt ? jetzt.toLocaleDateString("sv-SE", { timeZone: ZRH }) : "";

  const heute = daten?.heute ?? [];
  const laufend = heute.filter((t) => statusVon(t, jetztMs) === "laeuft").length;
  const agenda = daten?.auftraege ?? [];
  const agendaSichtbar = agenda.slice(0, AGENDA_MAX);
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
        <div className="b-datum">{datumLang}</div>
        <div className="b-uhrbox">
          <div className="b-uhr">
            {teil("hour")}<span className="b-colon">:</span>{teil("minute")}
            <span className="b-sek">{teil("second")}</span>
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

      <div className="b-mitte">
        {/* Agenda */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Kommende Aufträge</span>
            <b>{daten ? `${daten.kpi.auftraege_geplant} geplant` : ""}</b>
          </div>
          <div className="b-agenda">
            {!daten ? (
              [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="b-skel" />)
            ) : agenda.length === 0 ? (
              <div className="b-leer">Keine kommenden Aufträge.</div>
            ) : (
              agendaZeilen
            )}
            {daten && agenda.length > AGENDA_MAX && (
              <div className="b-mehr">+{agenda.length - AGENDA_MAX} weitere bis {tagMonat(agenda[agenda.length - 1].start)}</div>
            )}
          </div>
        </section>

        <div className="b-spalte">
          {/* Heute */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Heute</span>
              <b>{daten ? (heute.length === 0 ? "keine Einsätze" : `${heute.length} ${heute.length === 1 ? "Einsatz" : "Einsätze"}${laufend ? ` · ${laufend} läuft` : ""}`) : ""}</b>
            </div>
            <div className="b-heute">
              {!daten ? (
                <div className="b-skel" />
              ) : heute.length === 0 ? (
                <div className="b-naechster">
                  {daten.naechster ? (
                    <>Nächster Einsatz: <b>{wochentag(daten.naechster.start.slice(0, 10))} {tagMonat(daten.naechster.start.slice(0, 10))}, {zeit(daten.naechster.start)}</b> · {daten.naechster.titel}</>
                  ) : (
                    "Keine Einsätze geplant."
                  )}
                </div>
              ) : (
                heute.slice(0, HEUTE_MAX).map((t) => {
                  const status = statusVon(t, jetztMs);
                  return (
                    <div key={t.id} className={`b-zeile ${status}`}>
                      <div className="b-zeit">
                        {t.zeit_modus === "deadline" ? `bis ${zeit(t.start)}` : zeit(t.start)}
                        {t.ende && t.zeit_modus !== "deadline" && <small>– {zeit(t.ende)}</small>}
                      </div>
                      <div>
                        <div className="b-haupt">{t.titel}</div>
                        <div className="b-sub">{[t.auftrag_nr ? `INT-${t.auftrag_nr}` : null, t.ort].filter(Boolean).join(" · ")}</div>
                      </div>
                      <div className="b-personen">
                        {status === "laeuft" && <span className="b-chip rot">läuft</span>}
                        {t.personen.length === 0 ? (
                          <span className="b-chip amber">nicht zugewiesen</span>
                        ) : (
                          t.personen.slice(0, 2).map((p) => (
                            <span key={p.id} className="b-pers"><span className="b-av">{initialen(p.name)}</span><span>{vorname(p.name)}</span></span>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              {daten && heute.length > HEUTE_MAX && <div className="b-mehr">+{heute.length - HEUTE_MAX} weitere</div>}
            </div>
          </section>

          {/* Team */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Team</span>
              <b>{daten ? `${daten.kpi.im_einsatz} im Einsatz` : ""}</b>
            </div>
            <div className="b-team">
              {!daten
                ? [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
                : daten.team.map((m) => (
                    <div key={m.id} className={`b-person${m.status === "eingestempelt" ? " aktiv" : ""}`}>
                      <span className={`b-status${m.status === "eingestempelt" ? " gruen" : m.status === "abwesend" ? " amber" : ""}`} />
                      <span className="b-av">{initialen(m.full_name)}</span>
                      <span className="b-name">{m.full_name}</span>
                      <span className={`b-kontext${m.status === "eingestempelt" ? " gruen" : ""}`}>
                        {m.status === "eingestempelt" && m.clock_in
                          ? `seit ${zeit(m.clock_in)}${m.context_label ? ` · ${m.context_label}` : ""}`
                          : m.status === "abwesend"
                            ? ABWESEND[m.abwesenheit_typ ?? ""] ?? "Abwesend"
                            : ""}
                      </span>
                    </div>
                  ))}
            </div>
          </section>

          {/* Achtung */}
          <section className="b-panel">
            <div className="b-titel"><span>Braucht Aufmerksamkeit</span></div>
            <div className="b-achtung">
              {!daten ? (
                [0, 1].map((i) => <div key={i} className="b-skel" />)
              ) : achtungPunkte.length === 0 ? (
                <div className="b-ok"><Check strokeWidth={3} /> Alles im grünen Bereich</div>
              ) : (
                achtungPunkte.map((a) => (
                  <div key={a.key} className={`b-punkt ${a.ton}`}>
                    <span>{a.label}</span>
                    <span className="b-n">{daten.achtung[a.key]}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* KPI */}
          <div className="b-kpis">
            <div className="b-kpi"><div className={`b-n${(daten?.kpi.im_einsatz ?? 0) > 0 ? " gruen" : ""}`}>{daten?.kpi.im_einsatz ?? "–"}</div><div className="b-l">Im Einsatz</div></div>
            <div className="b-kpi"><div className="b-n">{daten?.kpi.auftraege_geplant ?? "–"}</div><div className="b-l">Aufträge geplant</div></div>
            <div className="b-kpi"><div className="b-n">{daten?.kpi.einsaetze_7_tage ?? "–"}</div><div className="b-l">Einsätze 7 Tage</div></div>
          </div>
        </div>
      </div>

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
                {w.auftraege || "·"}
                {w.einsaetze > 0 && <small>{w.einsaetze} Eins.</small>}
              </div>
              <div className="b-bararea"><div className="b-bar" style={{ height: `${Math.round((w.auftraege / maxWoche) * 100)}%` }} /></div>
              <div className="b-d"><b>KW {w.kw}</b>{tagMonat(w.start)} – {tagMonat(w.ende)}</div>
            </div>
          ))}
        </div>
      </section>

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
  const bald = !!heuteIso && tageBis(a.start, heuteIso) <= 14;
  const nummer = a.nummer ? (a.typ === "entwurf" ? `ENT-${a.nummer}` : `INT-${a.nummer}`) : null;
  const sub = [nummer, a.kunde, a.ort && a.ort !== a.kunde ? a.ort : null, mehrtaegig ? `${tagMonat(a.start)} – ${tagMonat(a.ende)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`b-auftrag ${a.typ}${laeuft ? " laeuft" : ""}`}>
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
        {a.typ !== "entwurf" && a.einsaetze > 0 && (
          <span className="b-meta">
            {a.einsaetze} {a.einsaetze === 1 ? "Einsatz" : "Einsätze"}
            {a.personen.length > 0 ? ` · ${a.personen.map(vorname).join(", ")}` : ""}
          </span>
        )}
        {a.typ === "auftrag" && a.einsaetze === 0 && bald && <span className="b-chip amber">kein Termin</span>}
        {!laeuft && <span className="b-rel">{relativ(a.start, heuteIso)}</span>}
        {a.verantwortlich && <span className="b-av">{initialen(a.verantwortlich)}</span>}
      </div>
    </div>
  );
}
