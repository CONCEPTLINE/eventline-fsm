"use client";

/**
 * Dossier im Location-Detail: was die Website über das Haus hergibt.
 *
 * Darstellung bewusst ruhig: keine Kästen um jeden Block, keine Chip-
 * Wolke für die Ausstattung. Stattdessen eine Spalte mit schmalen
 * Beschriftungen links und Inhalt rechts — wie in einem Datenblatt.
 * Die Vorgängerfassung hatte für jede Angabe einen eigenen Rahmen, und
 * das Panel las sich wie ein Formularstapel.
 *
 * Fachlich stehen zwei Dinge nebeneinander: die Besetzung (Team, Technik,
 * Rechtsform) entscheidet, ob EVENTLINE hineinkommt; das Angebot (Räume,
 * Ausstattung) entscheidet, worüber man spricht.
 */

import type { AkquiseLocation } from "@/types/akquise";

function Posten({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2">
      <dt className="pt-0.5 text-[11px] font-semibold uppercase leading-tight tracking-wide text-foreground/55">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

export function Dossier({ location }: { location: AkquiseLocation }) {
  const r = location.recherche;
  const hatBesetzung =
    location.techniker_im_team !== null ||
    (location.technikpartner && location.technikpartner !== "unklar") ||
    location.team_beschreibung || location.geschaeftsstruktur;

  if (!hatBesetzung && !r) return null;

  const technikBesetzt =
    (location.techniker_im_team !== null && location.techniker_im_team > 0) ||
    location.technikpartner === "ja";

  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/55">
        Das Haus
      </h3>

      <dl className="divide-y divide-border">
        {hatBesetzung && (
          <>
            <Posten label="Technik">
              {location.techniker_im_team !== null
                ? location.techniker_im_team === 0
                  ? "Keine eigenen Techniker genannt"
                  : `${location.techniker_im_team} eigene Techniker`
                : "Unklar"}
              {location.technikpartner === "ja" && (
                <> · fester Partner{location.technikpartner_name ? `: ${location.technikpartner_name}` : ""}</>
              )}
              {technikBesetzt && (
                <span className="mt-1 block text-[13px] font-medium text-amber-700 dark:text-amber-400">
                  Technik besetzt — als Technikpartner kein Zugang.
                </span>
              )}
            </Posten>

            {location.team_beschreibung && (
              <Posten label="Team">{location.team_beschreibung}</Posten>
            )}
            {location.geschaeftsstruktur && (
              <Posten label="Struktur">{location.geschaeftsstruktur}</Posten>
            )}
          </>
        )}

        {r && r.raeume.length > 0 && (
          <Posten label="Räume">
            {r.raeume.map((raum, i) => (
              <div key={i} className="flex justify-between gap-3 py-0.5">
                <span className="truncate">{raum.name}</span>
                {(raum.kapazitaet || raum.flaeche_m2) && (
                  <span className="shrink-0 tabular-nums text-foreground/70">
                    {raum.kapazitaet ? `${raum.kapazitaet} Pl.` : ""}
                    {raum.flaeche_m2 ? ` · ${raum.flaeche_m2} m²` : ""}
                  </span>
                )}
              </div>
            ))}
          </Posten>
        )}

        {/* Ausstattung als Fliesstext, nicht als Chip-Wolke: zehn kleine
            Kästchen machen die Spalte unruhig und sagen nicht mehr. */}
        {r && r.infrastruktur.length > 0 && (
          <Posten label="Ausstattung">{r.infrastruktur.join(" · ")}</Posten>
        )}

        {r?.preis_hinweis && <Posten label="Preise">{r.preis_hinweis}</Posten>}

        {r && r.veranstaltungstypen.length > 0 && (
          <Posten label="Anlässe">{r.veranstaltungstypen.join(", ")}</Posten>
        )}

        {r?.betrieb_seit && <Posten label="Seit">{r.betrieb_seit}</Posten>}

        {r?.besonderheiten && <Posten label="Notiz">{r.besonderheiten}</Posten>}
      </dl>

      {r && r.gelesene_seiten.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[12px] text-foreground/55 hover:text-foreground">
            {r.gelesene_seiten.length} Seiten gelesen
          </summary>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {r.gelesene_seiten.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                 className="text-[12px] text-blue-700 hover:underline dark:text-blue-400">
                {s.zweck}
              </a>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
