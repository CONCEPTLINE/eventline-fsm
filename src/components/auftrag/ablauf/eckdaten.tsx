"use client";

/**
 * Eckdaten — die EINE Stelle für Kunde/Kontakt, Ort, Gäste, Notizen und die
 * Zeit, die EVENTLINE übernimmt (ersetzt bei Aufträgen mit Ablauf die
 * Übersicht). Standard zugeklappt als eine Zeile; die Wahl merkt sich
 * localStorage `auftrag-eckdaten-offen` (§10).
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Home, Mail, MapPin, Phone, User } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AblaufFelder as Felder } from "@/lib/ablauf/typen";
import { Chip } from "./teile";
import { datumKurz, datumVoll, minuten, plusTage, tagKurz } from "./format";

const MINI = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const ECKDATEN_KEY = "auftrag-eckdaten-offen";

function gespeichertOffen(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(ECKDATEN_KEY) === "1";
  } catch {
    return false; // Speicher gesperrt → zugeklappt
  }
}

export function Eckdaten({
  f,
  setF,
  von,
  ortName,
  ortAdresse,
  zeitraum,
  erkanntAm,
  notiz,
  setNotiz,
  nurLesen,
}: {
  f: Felder;
  setF: (p: Partial<Felder>) => void;
  /** Übergabe-Beginn HH:MM — ab da ist EVENTLINE zuständig. */
  von: string;
  ortName: string;
  ortAdresse: string;
  /** Von Basil eingetragener Übernahme-Zeitraum, in dem der Tag liegt. */
  zeitraum: { von: string; bis: string } | null;
  /** Wann der Ablauf erkannt wurde (auftrag_ablauf.created_at). */
  erkanntAm: string | null;
  notiz: string;
  setNotiz: (v: string) => void;
  nurLesen: boolean;
}) {
  const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([ortName, ortAdresse].filter(Boolean).join(", "));
  const feld = "h-7 text-sm px-2";
  // Die Auftragsseite rendert erst im Browser (Handy-Weiche) → Lazy-Init ohne Hydrations-Risiko.
  const [offen, setOffen] = useState(gespeichertOffen);
  const [hover, setHover] = useState(false);
  function umschalten() {
    setOffen((o) => {
      const neu = !o;
      try {
        localStorage.setItem(ECKDATEN_KEY, neu ? "1" : "0");
      } catch {
        /* egal */
      }
      return neu;
    });
  }

  // Zeit, die EVENTLINE übernimmt: Übergabe-Beginn bis Rückgabe Folgetag 12:00.
  const folgetag = plusTage(f.datum, 1);
  const stunden = Math.round(((36 * 60 - minuten(von || "14:00")) / 60) * 10) / 10;
  const spanne = f.datum ? `${tagKurz(f.datum).split(" ")[0]} ${von} – ${tagKurz(folgetag).split(" ")[0]} 12:00` : "—";
  const quelle = zeitraum
    ? `im Übernahme-Zeitraum ${datumVoll(zeitraum.von).slice(0, 3)}–${datumVoll(zeitraum.bis)}`
    : `Übernommen von Basil · Einzel-Event${erkanntAm ? ` (Mail ${datumKurz(erkanntAm)})` : ""}`;
  const kurz = [f.mieter, f.telefon, ortName, `EVENTLINE zuständig ${spanne}`].filter(Boolean).join(" · ");

  return (
    <Card className="bg-card" size="sm">
      <CardContent>
        <button
          type="button"
          onClick={umschalten}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-expanded={offen}
          className="-mx-1.5 w-[calc(100%+0.75rem)] flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors min-w-0"
          style={{ background: hover ? "color-mix(in oklab, var(--foreground) 6%, transparent)" : "transparent" }}
          data-tooltip={offen ? "Zuklappen" : "Aufklappen und bearbeiten"}
        >
          {offen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className={`${MINI} shrink-0`}>Eckdaten</span>
          {!offen && <span className="text-xs text-muted-foreground truncate min-w-0">{kurz}</span>}
          {!offen && !f.email && (
            <span className="shrink-0 ml-auto">
              <Chip ton="warn" tooltip="Bei Basil nachfragen">
                E-Mail fehlt
              </Chip>
            </span>
          )}
        </button>

        {offen && (
          <>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm items-start">
              <div className="space-y-1 min-w-0">
                <p className={MINI}>Kunde &amp; Kontakt</p>
                <div className="flex items-center gap-2 min-w-0">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input value={f.mieter} placeholder="Mieter:in" onChange={(e) => setF({ mieter: e.target.value })} disabled={nurLesen} className={feld} />
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input value={f.telefon} placeholder="Telefon" onChange={(e) => setF({ telefon: e.target.value })} disabled={nurLesen} className={`${feld} tabular-nums`} />
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input value={f.email} placeholder="E-Mail eintragen" onChange={(e) => setF({ email: e.target.value })} disabled={nurLesen} className={feld} />
                  {!f.email && (
                    <Chip ton="warn" tooltip="Bei Basil nachfragen">
                      fehlt
                    </Chip>
                  )}
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <Home className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input value={f.adresse} placeholder="Adresse" onChange={(e) => setF({ adresse: e.target.value })} disabled={nurLesen} className={feld} />
                </div>
              </div>

              <div className="space-y-1 min-w-0">
                <p className={MINI}>Ort</p>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium">{ortName || "—"}</span>
                      {f.gaeste && <span className="text-xs text-muted-foreground">· max. {f.gaeste} Gäste</span>}
                    </div>
                    {ortAdresse && <p className="text-xs text-muted-foreground pl-6">{ortAdresse}</p>}
                  </div>
                  {ortName && (
                    <a href={maps} target="_blank" rel="noopener noreferrer" className="kasten kasten-blue shrink-0" data-tooltip="In Google Maps öffnen">
                      <MapPin className="h-3.5 w-3.5" />
                      Maps
                    </a>
                  )}
                </div>
                <p className={`${MINI} pt-2`}>Notizen</p>
                <textarea
                  value={notiz}
                  onChange={(e) => setNotiz(e.target.value)}
                  disabled={nurLesen}
                  placeholder="Reinschreiben — wird automatisch gespeichert."
                  rows={2}
                  style={{ fieldSizing: "content" } as React.CSSProperties}
                  className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
              </div>
            </div>
            <p className="mt-3 pt-2 border-t text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">EVENTLINE zuständig:</span>{" "}
              <span className="tabular-nums">
                {spanne} · {stunden} h
              </span>{" "}
              · {quelle}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
