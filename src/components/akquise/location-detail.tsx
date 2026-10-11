"use client";

/**
 * Detail-Ansicht eines Akquise-Kandidaten: die Fakten, die vier Faktoren
 * (von Hand korrigierbar), die daraus errechnete Empfehlung — und was sie
 * voraussetzt. Die Annahmen stehen bewusst sichtbar dabei: die Zahlen sind
 * Schaetzungen, und niemand soll sie fuer Messwerte halten.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  Pin, Globe, Mail, Phone, MapPin, Loader2, FileText, Handshake, Users, RefreshCw, X,
} from "lucide-react";
import { SearchableSelect } from "@/components/searchable-select";
import {
  KOOPERATIONS_MODELLE, EIGENTUEMER_TYPEN, FLAECHEN_ARTEN, bewerte, chf,
  type Dreiwertig, type EigentuemerTyp, type FlaechenArt,
} from "@/lib/akquise-faktoren";
import type { AkquiseLocation } from "@/types/akquise";
import { Dossier } from "./dossier";
import { modellLabel, scoreTon } from "./treffer-zeile";

const DREIWERTIG = [
  { id: "ja", label: "Ja" },
  { id: "nein", label: "Nein" },
  { id: "unklar", label: "Unklar" },
];

function Feld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-xs">{children}</div>
    </div>
  );
}

export function LocationDetail({
  location, onAendern, onPin, onSchliessen,
}: {
  location: AkquiseLocation;
  /** Teil-Update der Zeile; der Aufrufer schreibt in die DB. */
  onAendern: (patch: Partial<AkquiseLocation>) => Promise<void>;
  onPin: () => void;
  /** Schliesst das Panel. Sitzt hier und nicht als Overlay darüber, damit
   *  er sich nicht mit dem Pin-Knopf im Kopf überlagert. */
  onSchliessen?: () => void;
}) {
  const [speichert, setSpeichert] = useState(false);
  const [analyseLaeuft, setAnalyseLaeuft] = useState(false);
  const angepinnt = location.angepinnt_am !== null;

  /**
   * Faktor geaendert → Empfehlung sofort neu rechnen. Die Rechnung liegt im
   * Code (nicht in der KI), also kostet eine Korrektur keinen API-Aufruf
   * und das Ergebnis ist reproduzierbar.
   */
  async function faktorGesetzt(patch: Partial<AkquiseLocation>) {
    setSpeichert(true);
    try {
      const neu = { ...location, ...patch };
      const b = bewerte({
        flaeche: neu.flaeche,
        kapazitaet: neu.kapazitaet,
        eigene_vermarktung: neu.eigene_vermarktung,
        personal_vor_ort: neu.personal_vor_ort,
        technik_vorhanden: neu.technik_vorhanden,
        eigentuemer_typ: neu.eigentuemer_typ,
      });
      await onAendern({
        ...patch,
        empfohlenes_modell: b.modell,
        rentabilitaet_chf: b.rentabilitaet_chf,
        score: b.score,
        bewertung: {
          ...(location.bewertung ?? { teilscores: b.teilscores, alternativen: b.alternativen }),
          begruendung: b.begruendung,
          teilscores: b.teilscores,
          annahmen: b.annahmen,
          alternativen: b.alternativen,
        },
      });
    } catch {
      toast.error("Speichern fehlgeschlagen");
    } finally {
      setSpeichert(false);
    }
  }

  async function bedarfsanalyse() {
    setAnalyseLaeuft(true);
    try {
      const res = await fetch("/api/akquise/bedarfsanalyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: location.id }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error ?? "Bedarfsanalyse fehlgeschlagen");
        return;
      }
      await onAendern({ bedarfsanalyse: json.bedarfsanalyse });
      toast.success("Bedarfsanalyse erstellt");
    } catch {
      toast.error("Bedarfsanalyse fehlgeschlagen");
    } finally {
      setAnalyseLaeuft(false);
    }
  }

  const adresse = [location.strasse, [location.plz, location.ort].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  const modell = KOOPERATIONS_MODELLE.find((m) => m.key === location.empfohlenes_modell);

  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Kopf */}
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">NR-{location.nr} · {location.typ ?? "Location"}</p>
            <h2 className="truncate text-lg font-semibold">{location.name}</h2>
            {adresse && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />{adresse}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="text-right">
              <p className={`text-2xl font-bold tabular-nums ${scoreTon(location.score)}`}>
                {location.score ?? "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">Score</p>
            </div>
            <button type="button" onClick={onPin} className={`kasten text-xs ${angepinnt ? "kasten-amber" : "kasten-muted"}`}>
              <Pin className="h-3.5 w-3.5" style={{ fill: angepinnt ? "currentColor" : "none" }} />
              {angepinnt ? "Angepinnt" : "Anpinnen"}
            </button>
            {onSchliessen && (
              <button
                type="button" onClick={onSchliessen}
                aria-label="Detail schliessen" data-tooltip="Schliessen"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Kontaktwege — nur zeigen was da ist (§14: inhalt-getrieben) */}
        {(location.website || location.email || location.telefon) && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {location.website && (
              <a href={location.website} target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                <Globe className="h-3 w-3" />Website
              </a>
            )}
            {location.email && (
              <a href={`mailto:${location.email}`} className="flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                <Mail className="h-3 w-3" />{location.email}
              </a>
            )}
            {location.telefon && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Phone className="h-3 w-3" />{location.telefon}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* Ansprechpartner — die Angabe, die aus einem Treffer einen Anruf
            macht. Mit Quelle, damit niemand einen ungeprüften Namen nutzt. */}
        {(location.ansprechperson || location.vermietung_hinweis) && (
          <div className="rounded-lg border border-border p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Ansprechpartner
                </p>
                {location.ansprechperson ? (
                  <p className="mt-0.5 text-sm font-medium">
                    {location.ansprechperson}
                    {location.position && (
                      <span className="font-normal text-muted-foreground"> · {location.position}</span>
                    )}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Auf der Website keine Person genannt
                  </p>
                )}
              </div>
              {location.kontakt_quelle && (
                <a href={location.kontakt_quelle} target="_blank" rel="noopener noreferrer"
                   data-tooltip="Quelle der Angaben"
                   className="shrink-0 text-[11px] text-blue-600 hover:underline dark:text-blue-400">
                  Beleg
                </a>
              )}
            </div>
            {location.vermietung_hinweis && (
              <p className="mt-1.5 text-xs text-muted-foreground">{location.vermietung_hinweis}</p>
            )}
          </div>
        )}

        <Dossier location={location} />

        {/* Empfehlung */}
        <div className="rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-2">
            <Handshake className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-semibold">{modellLabel(location.empfohlenes_modell)}</p>
            {speichert && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {location.rentabilitaet_chf !== null && (
              <span className="ml-auto text-sm font-semibold tabular-nums">
                {chf(location.rentabilitaet_chf)} CHF/Jahr
              </span>
            )}
          </div>
          {modell && <p className="mt-1 text-xs text-muted-foreground">{modell.beschreibung}</p>}

          {location.bewertung && (
            <>
              <p className="mt-2 text-xs">{location.bewertung.begruendung}</p>
              {location.bewertung.ki_einschaetzung && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Einschätzung: {location.bewertung.ki_einschaetzung}
                </p>
              )}
              <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground">
                <span>Hebel {location.bewertung.teilscores.hebel}</span>
                <span>Grösse {location.bewertung.teilscores.groesse}</span>
                <span>Zugang {location.bewertung.teilscores.zugang}</span>
              </div>
              {location.bewertung.annahmen.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">
                    {location.bewertung.annahmen.length} Annahmen
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {location.bewertung.annahmen.map((a, i) => (
                      <li key={i} className="list-disc text-[11px] text-muted-foreground">{a}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>

        {/* Faktoren — korrigierbar */}
        <div className="rounded-lg border border-border p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Faktoren
            </p>
            <p className="text-[10px] text-muted-foreground">
              {location.angereichert_am
                ? "aus der Website ermittelt · Korrektur rechnet neu"
                : "geschätzt — Kontakte holen schärft das"}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2.5">
            <Feld label="Fläche wird …">
              <SearchableSelect
                value={location.flaeche}
                onChange={(v) => void faktorGesetzt({ flaeche: v as FlaechenArt })}
                items={FLAECHEN_ARTEN.map((a) => ({ id: a.key, label: a.label, sub: a.hinweis }))}
                clearable={false}
              />
            </Feld>
            <Feld label="Kapazität">
              <input
                type="number" min={0} defaultValue={location.kapazitaet ?? ""}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const n = v === "" ? null : Number.parseInt(v, 10);
                  if (n !== location.kapazitaet) void faktorGesetzt({ kapazitaet: Number.isFinite(n as number) ? n : null });
                }}
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                placeholder="Plätze"
              />
            </Feld>
            <Feld label="Eigentümer">
              <SearchableSelect
                value={location.eigentuemer_typ}
                onChange={(v) => void faktorGesetzt({ eigentuemer_typ: v as EigentuemerTyp })}
                items={EIGENTUEMER_TYPEN.map((t) => ({ id: t.key, label: t.label, sub: t.hinweis }))}
                clearable={false}
              />
            </Feld>
            <Feld label="Vermarktet selbst">
              <SearchableSelect
                value={location.eigene_vermarktung}
                onChange={(v) => void faktorGesetzt({ eigene_vermarktung: v as Dreiwertig })}
                items={DREIWERTIG}
                clearable={false}
              />
            </Feld>
            <Feld label="Personal vor Ort">
              <SearchableSelect
                value={location.personal_vor_ort}
                onChange={(v) => void faktorGesetzt({ personal_vor_ort: v as Dreiwertig })}
                items={DREIWERTIG}
                clearable={false}
              />
            </Feld>
            <Feld label="Technik vorhanden">
              <SearchableSelect
                value={location.technik_vorhanden}
                onChange={(v) => void faktorGesetzt({ technik_vorhanden: v as Dreiwertig })}
                items={DREIWERTIG}
                clearable={false}
              />
            </Feld>
          </div>
        </div>

        {/* Bedarfsanalyse */}
        <div className="rounded-lg border border-border p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Bedarfsanalyse
            </p>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={bedarfsanalyse} disabled={analyseLaeuft}
                      className="kasten kasten-muted text-xs">
                {analyseLaeuft
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird erstellt…</>
                  : <><RefreshCw className="h-3.5 w-3.5" />{location.bedarfsanalyse ? "Neu erstellen" : "Erstellen"}</>}
              </button>
              {location.bedarfsanalyse && (
                <a href={`/api/akquise/${location.id}/pdf`} target="_blank" rel="noopener noreferrer"
                   className="kasten kasten-blue text-xs">
                  <FileText className="h-3.5 w-3.5" />PDF
                </a>
              )}
            </div>
          </div>

          {!location.bedarfsanalyse ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Noch keine Analyse. Sie schaut die Location im Detail an und ist die Grundlage für das
              Kooperationskonzept.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-xs">{location.bedarfsanalyse.ausgangslage}</p>
              <Liste titel="Lücken" eintraege={location.bedarfsanalyse.luecken} />
              <Liste titel="Unser Beitrag" eintraege={location.bedarfsanalyse.unser_beitrag} />
              <Liste titel="Risiken" eintraege={location.bedarfsanalyse.risiken} />
              <Liste titel="Fragen fürs Erstgespräch" eintraege={location.bedarfsanalyse.offene_fragen} />
            </div>
          )}
        </div>

        {/* Kooperationskonzept — erst sinnvoll, wenn die Analyse steht */}
        <KonzeptBlock location={location} onAendern={onAendern} />
      </div>
    </div>
  );
}

function Liste({ titel, eintraege }: { titel: string; eintraege: string[] }) {
  if (eintraege.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{titel}</p>
      <ul className="mt-0.5 space-y-0.5 pl-3">
        {eintraege.map((e, i) => <li key={i} className="list-disc text-xs">{e}</li>)}
      </ul>
    </div>
  );
}

function KonzeptBlock({
  location, onAendern,
}: {
  location: AkquiseLocation;
  onAendern: (patch: Partial<AkquiseLocation>) => Promise<void>;
}) {
  const [laeuft, setLaeuft] = useState(false);

  async function erstellen() {
    setLaeuft(true);
    try {
      const res = await fetch("/api/akquise/konzept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: location.id }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error ?? "Konzept fehlgeschlagen");
        return;
      }
      await onAendern({ kooperationskonzept: json.konzept });
      toast.success("Kooperationskonzept erstellt");
    } catch {
      toast.error("Konzept fehlgeschlagen");
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Kooperationskonzept
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button" onClick={erstellen}
            disabled={laeuft || !location.bedarfsanalyse}
            data-tooltip={!location.bedarfsanalyse ? "Zuerst die Bedarfsanalyse erstellen" : undefined}
            className="kasten kasten-muted text-xs"
          >
            {laeuft
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird erstellt…</>
              : <><Users className="h-3.5 w-3.5" />{location.kooperationskonzept ? "Neu erstellen" : "Erstellen"}</>}
          </button>
          {location.kooperationskonzept && (
            <a href={`/api/akquise/${location.id}/pdf?teil=konzept`} target="_blank" rel="noopener noreferrer"
               className="kasten kasten-blue text-xs">
              <FileText className="h-3.5 w-3.5" />PDF
            </a>
          )}
        </div>
      </div>

      {!location.kooperationskonzept ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Entsteht aus der Bedarfsanalyse — das Angebot, das EVENTLINE dieser Location macht.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs font-medium">{location.kooperationskonzept.titel}</p>
          {location.kooperationskonzept.abschnitte.map((a, i) => (
            <div key={i}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{a.titel}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-xs">{a.text}</p>
            </div>
          ))}
          <Liste titel="Nächste Schritte" eintraege={location.kooperationskonzept.naechste_schritte} />
        </div>
      )}
    </div>
  );
}
