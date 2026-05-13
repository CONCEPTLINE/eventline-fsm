"use client";

/**
 * HR-Hub — Sammelseite fuer Personal-bezogene Bereiche.
 * Aktuelle Sektionen: Todos, Stempelzeiten, Tickets, Schulungen.
 *
 * Karten-Animation kommt von der gemeinsamen TypePickerCard, die
 * app-weit fuer alle Auswahl-Karten genutzt wird (gleiche Stempel-Modal-
 * Animation).
 */

import { useRouter } from "next/navigation";
import { TypePickerCard, type TypePickerTone } from "@/components/ui/type-picker-card";
import { Clock, Ticket, Plane } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface HRSection {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: TypePickerTone;
}

// Schulungen ist noch nicht gebaut — wenn der Bereich live geht, hier
// wieder eintragen. Vorher zeigte die Karte auf eine "Kommt bald"-Page,
// das war eine Sackgasse fuer den User.
// Todos haben seit 2026-05-13 wieder eine eigene Sidebar-Position
// (Daily-Workflow → nicht zwei Clicks tief) und sind aus dem HR-Hub raus.
const sections: HRSection[] = [
  { href: "/stempelzeiten", label: "Stempelzeiten", description: "Arbeitszeit-Erfassung pro Auftrag",         icon: Clock,          tone: "green"  },
  { href: "/tickets",       label: "Tickets",       description: "IT, Stempel-Änderungen, Material",          icon: Ticket,         tone: "red"    },
  { href: "/ferien",        label: "Ferien",        description: "Ferien, Krankheit & Frei-Tage eintragen",   icon: Plane,          tone: "blue"   },
];

export default function HRPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">HR</h1>
        <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sections.map((s) => (
          <TypePickerCard
            key={s.href}
            icon={s.icon}
            tone={s.tone}
            label={s.label}
            description={s.description}
            onClick={() => router.push(s.href)}
          />
        ))}
      </div>
    </div>
  );
}
