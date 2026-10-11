"use client";

/**
 * Dossier-Block im Location-Detail: was die Website über das Haus hergibt.
 *
 * Zwei Dinge stehen hier bewusst nebeneinander: die Besetzung (Team,
 * Technikpartner, Rechtsform) und das Angebot (Räume, Infrastruktur,
 * Preise). Die Besetzung entscheidet, ob EVENTLINE hineinkommt — vier
 * eigene Techniker heissen, dass das Technikmodell wegfällt. Das Angebot
 * entscheidet, worüber man spricht.
 *
 * Zur Darstellung: Inhalte stehen in voller Textfarbe, gedämpft sind nur
 * die Beschriftungen. Eine Karte, auf der auch die Aussagen grau sind,
 * liest sich wie eine Fussnote — und das ist sie nicht, sie ist die
 * Gesprächsgrundlage.
 */

import { Users, Wrench, Building2, DoorOpen, Tag, ExternalLink } from "lucide-react";
import type { AkquiseLocation } from "@/types/akquise";

function Zeile({ icon: Icon, label, children }: {
  icon: typeof Users; label: string; children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.1rem_5.5rem_minmax(0,1fr)] items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-foreground/60" />
      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/65">
        {label}
      </p>
      <div className="text-sm leading-relaxed text-foreground">{children}</div>
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

  // Vier eigene Techniker heissen: als Technikpartner kommen wir hier
  // nicht hinein. Das ist die wichtigste Einzelaussage im Dossier.
  const technikBesetzt =
    (location.techniker_im_team !== null && location.techniker_im_team > 0) ||
    location.technikpartner === "ja";

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
          Was das Haus mitbringt
        </h3>
      </header>

      <div className="space-y-3 p-3">
        {hatBesetzung && (
          <>
            <Zeile icon={Wrench} label="Technik">
              <span className={technikBesetzt ? "font-medium text-amber-700 dark:text-amber-400" : ""}>
                {location.techniker_im_team !== null
                  ? location.techniker_im_team === 0
                    ? "Keine eigenen Techniker genannt"
                    : `${location.techniker_im_team} eigene Techniker im Team`
                  : "Eigenes Technikteam unklar"}
                {location.technikpartner === "ja" && (
                  <> · fester Partner{location.technikpartner_name ? `: ${location.technikpartner_name}` : ""}</>
                )}
                {location.technikpartner === "nein" && <> · kein fester Partner</>}
              </span>
              {technikBesetzt && (
                <p className="mt-1 rounded border border-amber-300/60 bg-amber-50 px-2 py-1 text-[13px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                  Technik besetzt — als Technikpartner kommt EVENTLINE hier nicht hinein.
                </p>
              )}
            </Zeile>

            {location.team_beschreibung && (
              <Zeile icon={Users} label="Team">{location.team_beschreibung}</Zeile>
            )}
            {location.geschaeftsstruktur && (
              <Zeile icon={Building2} label="Struktur">{location.geschaeftsstruktur}</Zeile>
            )}
          </>
        )}

        {r && r.raeume.length > 0 && (
          <Zeile icon={DoorOpen} label={`Räume ${r.raeume.length}`}>
            <ul className="divide-y divide-border/60">
              {r.raeume.map((raum, i) => (
                <li key={i} className="flex justify-between gap-3 py-1 first:pt-0 last:pb-0">
                  <span className="truncate">{raum.name}</span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">
                    {raum.kapazitaet ? `${raum.kapazitaet} Pl.` : ""}
                    {raum.flaeche_m2 ? ` · ${raum.flaeche_m2} m²` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Zeile>
        )}

        {r && r.infrastruktur.length > 0 && (
          <Zeile icon={Building2} label="Ausstattung">
            <div className="flex flex-wrap gap-1">
              {r.infrastruktur.map((x, i) => (
                <span key={i} className="rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[13px]">
                  {x}
                </span>
              ))}
            </div>
          </Zeile>
        )}

        {r && (r.preis_hinweis || r.veranstaltungstypen.length > 0 || r.betrieb_seit) && (
          <Zeile icon={Tag} label="Betrieb">
            {[
              r.preis_hinweis,
              r.veranstaltungstypen.length > 0 ? r.veranstaltungstypen.join(", ") : null,
              r.betrieb_seit ? `seit ${r.betrieb_seit}` : null,
            ].filter(Boolean).join(" · ")}
          </Zeile>
        )}

        {r?.besonderheiten && (
          <p className="border-t border-border pt-2.5 text-sm leading-relaxed text-foreground">
            {r.besonderheiten}
          </p>
        )}

        {r && r.gelesene_seiten.length > 0 && (
          <details className="border-t border-border pt-2">
            <summary className="cursor-pointer text-[13px] font-medium text-foreground/60 hover:text-foreground">
              Belege · {r.gelesene_seiten.length} Seiten gelesen
            </summary>
            <ul className="mt-1.5 space-y-1">
              {r.gelesene_seiten.map((s, i) => (
                <li key={i}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-1.5 text-[13px] text-blue-700 hover:underline dark:text-blue-400">
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{s.zweck}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
