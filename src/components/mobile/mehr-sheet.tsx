"use client";

/**
 * «Mehr»-Sheet der Bottom-Nav (nur Handy). Reine Navigation, keine
 * Aktionen: Suche, ICH (Stempelzeiten, Tickets & Belege, Ferien, Mein
 * Konto), ARBEIT (Aufträge, Locations), Fuss (Hell/Dunkel, Anleitung,
 * Abmelden). Buero-Seiten stehen bewusst nicht drin (Entscheid Mischa
 * 2026-10-11: alles Nicht-Feld bleibt Desktop).
 *
 * Rechte: isPathAllowed pro Eintrag — Admin sieht alles.
 */

import { useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  Search, Clock, Ticket, Palmtree, User, ClipboardList, MapPin,
  Sun, Moon, BookOpen, LogOut, ChevronRight, Loader2, type LucideIcon,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { CMDK_OPEN_EVENT } from "@/components/shell/command-palette";
import { isPathAllowed } from "@/lib/permissions";
import { MEHR_ARBEIT, MEHR_ICH } from "@/lib/mobile-seiten";
import { useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";

const ICONS: Record<string, LucideIcon> = {
  "/stempelzeiten": Clock,
  "/tickets": Ticket,
  "/ferien": Palmtree,
  "/mein-konto": User,
  "/auftraege": ClipboardList,
  "/locations": MapPin,
};

interface Props {
  open: boolean;
  onClose: () => void;
  permissions: string[];
  role: string;
  canManageTickets: boolean;
  onSignOut: () => void | Promise<void>;
  /** Wartende Offline-Aktionen (Stempeln) — Hinweis vor dem Abmelden. */
  ausstehend?: number;
}

export function MehrSheet({ open, onClose, permissions, role, canManageTickets, onSignOut, ausstehend = 0 }: Props) {
  const { theme, setTheme } = useTheme();
  const counts = useNavCounts();
  const [abmelden, setAbmelden] = useState(false);
  const ich = MEHR_ICH.filter((e) => isPathAllowed(e.href, permissions, role));
  const arbeit = MEHR_ARBEIT.filter((e) => isPathAllowed(e.href, permissions, role));

  function suche() {
    onClose();
    window.dispatchEvent(new Event(CMDK_OPEN_EVENT));
  }

  async function abmeldenKlick() {
    // Sheet bleibt offen mit Spinner, bis die Abmeldung durch ist (Session-
    // Ende + Supabase-SignOut sind Netzaufrufe) — kein toter Klick.
    setAbmelden(true);
    try {
      await onSignOut();
    } finally {
      setAbmelden(false);
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={() => !abmelden && onClose()} closable={!abmelden} sheet size="md" bodyClassName="p-0" ariaLabel="Mehr">
      <div className="pb-2">
        <div className="px-4 pt-2 pb-3">
          <button
            type="button"
            onClick={suche}
            className="flex h-[36px] w-full items-center gap-3 rounded-xl border border-border bg-background px-4 text-left text-base text-muted-foreground"
          >
            <Search className="h-5 w-5 shrink-0" />
            Suchen
          </button>
        </div>

        <Gruppe label="Ich">
          {ich.map((e) => (
            <Zeile
              key={e.href}
              href={e.href}
              label={e.label}
              icon={ICONS[e.href]}
              badge={getBadgeForHref(e.href, counts, canManageTickets)}
              onClick={onClose}
            />
          ))}
        </Gruppe>

        {arbeit.length > 0 && (
          <Gruppe label="Arbeit">
            {arbeit.map((e) => (
              <Zeile
                key={e.href}
                href={e.href}
                label={e.label}
                icon={ICONS[e.href]}
                badge={getBadgeForHref(e.href, counts, canManageTickets)}
                onClick={onClose}
              />
            ))}
          </Gruppe>
        )}

        {ausstehend > 0 && (
          <p className="mx-4 mb-1 mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
            {ausstehend === 1
              ? "1 Aktion wartet noch auf Netz. Nach dem Abmelden wird sie"
              : `${ausstehend} Aktionen warten noch auf Netz. Nach dem Abmelden werden sie`} beim nächsten Login von dir gesendet.
          </p>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border px-4 pt-3">
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="flex h-[36px] flex-col items-center justify-center gap-0.5 rounded-xl text-[12px] font-medium text-muted-foreground active:bg-foreground/10"
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            {theme === "dark" ? "Hell" : "Dunkel"}
          </button>
          <Link
            href="/anleitung"
            onClick={onClose}
            className="flex h-[36px] flex-col items-center justify-center gap-0.5 rounded-xl text-[12px] font-medium text-muted-foreground active:bg-foreground/10"
          >
            <BookOpen className="h-5 w-5" />
            Anleitung
          </Link>
          <button
            type="button"
            onClick={abmeldenKlick}
            disabled={abmelden}
            className="flex h-[36px] flex-col items-center justify-center gap-0.5 rounded-xl text-[12px] font-medium text-muted-foreground active:bg-foreground/10 disabled:opacity-60"
          >
            {abmelden ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogOut className="h-5 w-5" />}
            {abmelden ? "Wird abgemeldet…" : "Abmelden"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Gruppe({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 pb-2">
      <p className="px-1 pb-1 pt-2 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="overflow-hidden rounded-xl border border-border bg-background">{children}</div>
    </div>
  );
}

function Zeile({
  href, label, icon: Icon, badge, onClick,
}: {
  href: string; label: string; icon?: LucideIcon; badge: number; onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex min-h-[40px] items-center gap-3 border-t border-border px-4 text-base first:border-t-0 active:bg-foreground/10"
    >
      {Icon && <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />}
      <span className="flex-1">{label}</span>
      {badge > 0 && (
        <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-red-600 px-1.5 text-[12px] font-bold text-white tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
    </Link>
  );
}
