"use client";

/**
 * Sicherheit-Tab — Einstellungen › Firmenportal › Sicherheit, nur Admin.
 * Drei Abschnitte untereinander (statt dritter Navigationsebene):
 *   Anmeldungen       wer war wann in der App (internes Team) — Mini-Ueberschrift
 *   Vertraute Geräte  alle vertrauten Geraete aller User, revoken — Karte mit eigenem Titel
 *   Zugriffe          wer hat Finanzen/Lohn angesehen — Karte mit eigenem Titel
 *   Entwickler-Modus  «Ansicht als» + aktueller Build — Karte mit eigenem Titel
 * Die Anmeldungen der Partner und Lieferanten stehen in deren Portal
 * (Partnerportal › Anmeldungen, Lieferantenportal › Anmeldungen).
 *
 * Wird von /einstellungen per next/dynamic geladen — die drei Teile
 * landen so zusammen in einem eigenen Chunk.
 */

import { AktivitaetTab } from "@/components/einstellungen/aktivitaet-tab";
import { AlleVertrauteGeraeteCard } from "@/components/einstellungen/alle-vertraute-geraete-card";
import { ZugriffeCard } from "@/components/einstellungen/zugriffe-card";
import { DeveloperModeCard } from "@/components/einstellungen/developer-mode-card";
import { BuildInfoBadge } from "@/components/einstellungen/build-info-badge";

function Abschnitt({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{titel}</h2>
      {children}
    </section>
  );
}

export function SicherheitTab() {
  return (
    <div className="space-y-8">
      <Abschnitt titel="Anmeldungen">
        <AktivitaetTab scope="firma" />
      </Abschnitt>

      {/* Karten tragen ihren Titel selbst — keine zweite Ueberschrift darueber. */}
      <AlleVertrauteGeraeteCard />
      <ZugriffeCard />

      <section className="space-y-3">
        <DeveloperModeCard />
        <div className="flex">
          <BuildInfoBadge />
        </div>
      </section>
    </div>
  );
}
