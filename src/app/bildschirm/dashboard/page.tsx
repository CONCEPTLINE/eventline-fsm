"use client";

// Wand-Dashboard fuer den Buero-Monitor (Leo 2026-10-02): heutige Einsaetze,
// wer im Einsatz ist, was Aufmerksamkeit braucht, die naechsten Tage und die
// Auslastung der kommenden zwei Wochen. Daten alle 30 s still nachgeladen,
// Uhr auf Serverzeit synchronisiert, neue Builds laden sich selbst nach
// (kein Nutzer, keine Eingaben → gefahrlos). Kein Login: Zugang ueber das
// Bildschirm-Cookie (/bildschirm).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { BildschirmDaten, BildschirmTermin } from "@/lib/bildschirm-typen";
import { initialen } from "@/components/ui/person-avatar";
import { BUILD_INFO } from "@/lib/build-info";
import "./board.css";

const ZRH = "Europe/Zurich";
const REFRESH_MS = 30_000;
const VERSION_MS = 10 * 60_000;
const HEUTE_MAX = 8;

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
function istWochenende(datumIso: string): boolean {
  const wd = tagDatum(datumIso).toLocaleDateString("en-US", { timeZone: ZRH, weekday: "short" });
  return wd === "Sat" || wd === "Sun";
}
function vorname(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
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
  const heuteSichtbar = heute.slice(0, HEUTE_MAX);
  const achtungPunkte = daten ? ACHTUNG.filter((a) => daten.achtung[a.key] > 0) : [];
  const maxAuslastung = Math.max(1, ...(daten?.auslastung.map((a) => a.termine) ?? [1]));
  const laufend = heute.filter((t) => statusVon(t, jetztMs) === "laeuft").length;

  return (
    <div className="board">
      {/* Kopf */}
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

      {/* Mitte */}
      <div className="b-mitte">
        <div className="b-spalte b-links">
          {/* Heute */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Heute</span>
              <b>{daten ? `${heute.length} ${heute.length === 1 ? "Einsatz" : "Einsätze"}${laufend ? ` · ${laufend} läuft` : ""}` : ""}</b>
            </div>
            <div className="b-liste">
              {!daten ? (
                [0, 1, 2, 3].map((i) => <div key={i} className="b-skel" />)
              ) : heute.length === 0 ? (
                <div className="b-leer">Heute keine Einsätze geplant.</div>
              ) : (
                heuteSichtbar.map((t) => {
                  const status = statusVon(t, jetztMs);
                  const sub = [
                    t.auftrag_nr ? `INT-${t.auftrag_nr}` : null,
                    t.titel !== t.auftrag_titel ? t.auftrag_titel : null,
                    t.ort,
                    t.kunde && t.kunde !== t.ort ? t.kunde : null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <div key={t.id} className={`b-zeile ${status}`}>
                      <div className="b-zeit">
                        {t.zeit_modus === "deadline" ? `bis ${zeit(t.start)}` : zeit(t.start)}
                        {t.ende && t.zeit_modus !== "deadline" && <small>– {zeit(t.ende)}</small>}
                      </div>
                      <div>
                        <div className="b-haupt">{t.titel}</div>
                        {sub && <div className="b-sub">{sub}</div>}
                      </div>
                      <div className="b-personen">
                        {status === "laeuft" && <span className="b-chip rot">läuft</span>}
                        {t.personen.length === 0 ? (
                          <span className="b-chip amber">nicht zugewiesen</span>
                        ) : (
                          t.personen.slice(0, 3).map((p) => (
                            <span key={p.id} className="b-pers">
                              <span className="b-av">{initialen(p.name)}</span>
                              <span>{vorname(p.name)}</span>
                            </span>
                          ))
                        )}
                        {t.personen.length > 3 && <span className="b-chip grau">+{t.personen.length - 3}</span>}
                      </div>
                    </div>
                  );
                })
              )}
              {daten && heute.length > HEUTE_MAX && (
                <div className="b-mehr">+{heute.length - HEUTE_MAX} weitere Einsätze heute</div>
              )}
            </div>
          </section>

          {/* Naechste 7 Tage */}
          <section className="b-panel">
            <div className="b-titel">
              <span>Nächste 7 Tage</span>
              <b>{daten ? `${daten.tage.reduce((n, t) => n + t.termine.length, 0)} Einsätze` : ""}</b>
            </div>
            <div className="b-tage">
              {(daten?.tage ?? Array.from({ length: 7 }, () => null)).map((tag, i) =>
                tag ? (
                  <div key={tag.datum} className={`b-tag${istWochenende(tag.datum) ? " we" : ""}`}>
                    <div className="b-tag-kopf"><b>{wochentag(tag.datum)}</b><span>{tagMonat(tag.datum)}</span></div>
                    <div className={`b-tag-n${tag.termine.length === 0 ? " null" : ""}`}>{tag.termine.length || "–"}</div>
                    {tag.termine.slice(0, 2).map((t) => (
                      <div key={t.id} className="b-tag-item">{zeit(t.start)} <b>{t.titel}</b></div>
                    ))}
                    {tag.termine.length > 2 && <div className="b-tag-item">+{tag.termine.length - 2} weitere</div>}
                  </div>
                ) : (
                  <div key={i} className="b-tag"><div className="b-skel" /></div>
                ),
              )}
            </div>
          </section>
        </div>

        <div className="b-spalte b-rechts">
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
                [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
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
            <div className="b-kpi"><div className="b-n">{daten?.kpi.offene_auftraege ?? "–"}</div><div className="b-l">Offene Aufträge</div></div>
            <div className="b-kpi"><div className="b-n">{daten?.kpi.geplante_termine_woche ?? "–"}</div><div className="b-l">Termine 7 Tage</div></div>
            <div className="b-kpi"><div className="b-n">{daten?.kpi.nicht_abgerechnet ?? "–"}</div><div className="b-l">Nicht abgerechnet</div></div>
          </div>
        </div>
      </div>

      {/* Auslastung */}
      <section className="b-panel">
        <div className="b-titel">
          <span>Auslastung · nächste 14 Tage</span>
          <b>{daten ? `${daten.auslastung.reduce((n, a) => n + a.termine, 0)} Einsätze` : ""}</b>
        </div>
        <div className="b-balken">
          {(daten?.auslastung ?? []).map((a) => (
            <div key={a.datum} className={`b-balk${a.datum === heuteIso ? " heute" : ""}${istWochenende(a.datum) ? " we" : ""}`}>
              <div className={`b-v${a.termine === 0 ? " null" : ""}`}>{a.termine || "·"}</div>
              <div className="b-bararea"><div className="b-bar" style={{ height: `${Math.round((a.termine / maxAuslastung) * 100)}%` }} /></div>
              <div className="b-d">{wochentag(a.datum)} {tagMonat(a.datum)}</div>
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
