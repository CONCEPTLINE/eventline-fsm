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
 * Nichts davon ist geschätzt; `gelesene_seiten` belegt jede Angabe.
 */

import { Users, Wrench, Building2, DoorOpen, Tag, ExternalLink } from "lucide-react";
import type { AkquiseLocation } from "@/types/akquise";

function Zeile({ icon: Icon, label, children }: {
  icon: typeof Users; label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <div className="mt-0.5 text-xs">{children}</div>
      </div>
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
    <div className="space-y-2.5 rounded-lg border border-border p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Was das Haus mitbringt
      </p>

      {hatBesetzung && (
        <>
          <Zeile icon={Wrench} label="Technik">
            <span className={technikBesetzt ? "text-amber-600 dark:text-amber-400" : ""}>
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
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Technik ist besetzt — als Technikpartner kommt EVENTLINE hier nicht hinein.
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
        <Zeile icon={DoorOpen} label={`Räume (${r.raeume.length})`}>
          <ul className="space-y-0.5">
            {r.raeume.map((raum, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="truncate">{raum.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {raum.kapazitaet ? `${raum.kapazitaet} Pl.` : ""}
                  {raum.flaeche_m2 ? ` · ${raum.flaeche_m2} m²` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Zeile>
      )}

      {r && r.infrastruktur.length > 0 && (
        <Zeile icon={Building2} label="Ausstattung">{r.infrastruktur.join(" · ")}</Zeile>
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
        <p className="border-t border-border pt-2 text-xs">{r.besonderheiten}</p>
      )}

      {r && r.gelesene_seiten.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {r.gelesene_seiten.length} Seiten gelesen
          </summary>
          <ul className="mt-1 space-y-0.5">
            {r.gelesene_seiten.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                   className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400">
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{s.zweck}</span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
