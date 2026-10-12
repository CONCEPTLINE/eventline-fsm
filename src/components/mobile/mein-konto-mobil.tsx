"use client";

/**
 * Mein Konto am Handy (< md).
 *
 * Ohne ?tab: Kopf (Avatar 56 px Initialen, Name, Rolle), Karte mit Zeilen
 * 56 px (Meine Daten · Anmeldung & Face ID · Benachrichtigungen · Kalender-Abo
 * · Darstellung · App installieren · Anleitung), «Abmelden» 52 px, Fuss
 * «Version · powered by CONCEPTLINE».
 *
 * Mit ?tab=…: Breadcrumbs [Mein Konto › Tab] (mobiler Kopf: Zurueck + Titel)
 * und derselbe Tab-Inhalt wie am Desktop — ohne Desktop-Tab-Leiste.
 *
 * Abmelden feuert das Window-Event ABMELDEN_EVENT; das (app)-Layout hoert
 * darauf und fuehrt dieselbe Abmelde-Logik wie im Mehr-Sheet aus.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Bell, BookOpen, Calendar, ChevronRight, Download, Fingerprint, Loader2, LogOut, Moon, Sun, User,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { BUILD_INFO } from "@/lib/build-info";
import { MeinKontoCard } from "@/components/einstellungen/mein-konto-card";
import { PasskeysCard } from "@/components/einstellungen/passkeys-card";
import { BenachrichtigungenTab } from "@/components/einstellungen/benachrichtigungen-tab";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";
import { AppInstallSheet, istAlsAppInstalliert } from "@/components/mobile/app-install-hinweis";
import { ABMELDEN_EVENT } from "@/lib/mobile-seiten";

type Tab = "profil" | "sicherheit" | "benachrichtigungen" | "kalender";

const TABS: Record<Tab, { label: string; icon: LucideIcon }> = {
  profil: { label: "Meine Daten", icon: User },
  sicherheit: { label: "Anmeldung & Face ID", icon: Fingerprint },
  benachrichtigungen: { label: "Benachrichtigungen", icon: Bell },
  kalender: { label: "Kalender-Abo", icon: Calendar },
};
const TAB_KEYS = Object.keys(TABS) as Tab[];

/** 1-2 Initialen («Mathis Berger» → «MB»). */
function initialen(name: string): string {
  const teile = name.trim().split(/\s+/).filter(Boolean);
  if (teile.length === 0) return "?";
  if (teile.length === 1) return teile[0].slice(0, 2).toUpperCase();
  return (teile[0][0] + teile[teile.length - 1][0]).toUpperCase();
}

export function MeinKontoMobil() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { profile, role } = usePermissions();
  const { theme, setTheme } = useTheme();

  const urlTab = searchParams.get("tab");
  const tab: Tab | null = urlTab && TAB_KEYS.includes(urlTab as Tab) ? (urlTab as Tab) : null;

  useBreadcrumbs(tab ? [{ label: "Mein Konto", href: "/mein-konto" }, { label: TABS[tab].label }] : []);

  // Rollen-Name (roles.label) zum Slug aus dem PermissionsProvider.
  const [rolleLabel, setRolleLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("roles").select("label").eq("slug", role).maybeSingle();
      if (cancelled) return;
      setRolleLabel((data as { label?: string } | null)?.label ?? role);
    })();
    return () => { cancelled = true; };
  }, [supabase, role]);

  const [installOffen, setInstallOffen] = useState(false);
  const [installierbar] = useState(() => !istAlsAppInstalliert());
  const [abmeldet, setAbmeldet] = useState(false);

  function abmelden() {
    setAbmeldet(true);
    // Geht die Abmeldung nicht durch (z. B. ohne Netz — das Layout meldet es
    // per Toast), wird der Knopf wieder frei.
    window.dispatchEvent(new CustomEvent(ABMELDEN_EVENT, { detail: { beiFehler: () => setAbmeldet(false) } }));
  }

  if (tab) {
    return (
      <div className="page-enter">
        {tab === "profil" && <MeinKontoCard />}
        {tab === "sicherheit" && <PasskeysCard />}
        {tab === "benachrichtigungen" && <BenachrichtigungenTab />}
        {tab === "kalender" && (
          <IcalFeedBlock
            title="Mein iCal-Feed"
            description="Abonniere deinen persönlichen Kalender mit Aufträgen, Terminen und Schichten in Google Calendar / Apple Calendar / Outlook."
            source="user"
          />
        )}
      </div>
    );
  }

  const dunkel = theme === "dark";
  const name = profile?.full_name ?? "";

  return (
    <div className="page-enter flex flex-col gap-5">
      {/* Kopf */}
      <div className="flex items-center gap-4 px-1">
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-[20px] font-bold text-muted-foreground">
          {initialen(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[19px] font-semibold leading-tight">{name}</p>
          <p className="truncate text-[14px] text-muted-foreground">{rolleLabel ?? role}</p>
        </div>
      </div>

      {/* Zeilen */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {TAB_KEYS.map((k) => (
          <Zeile key={k} href={`/mein-konto?tab=${k}`} icon={TABS[k].icon} label={TABS[k].label} />
        ))}
        <Zeile
          icon={dunkel ? Moon : Sun}
          label="Darstellung"
          wert={dunkel ? "Dunkel" : "Hell"}
          onClick={() => setTheme(dunkel ? "light" : "dark")}
        />
        {installierbar && (
          <Zeile icon={Download} label="App installieren" onClick={() => setInstallOffen(true)} />
        )}
        <Zeile href="/anleitung" icon={BookOpen} label="Anleitung" />
      </div>

      <button
        type="button"
        onClick={abmelden}
        disabled={abmeldet}
        className="kasten kasten-muted h-[52px] w-full text-base"
      >
        {abmeldet ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        {abmeldet ? "Wird abgemeldet…" : "Abmelden"}
      </button>

      <p className="text-center text-[13px] text-muted-foreground">
        Version {BUILD_INFO.sha} · powered by <span className="font-medium text-foreground/80">CONCEPTLINE</span>
      </p>

      <AppInstallSheet open={installOffen} onClose={() => setInstallOffen(false)} />
    </div>
  );
}

/** Zeile 56 px: Icon, Label, optional Wert rechts, Chevron. Link oder Knopf. */
function Zeile({
  href, onClick, icon: Icon, label, wert,
}: {
  href?: string;
  onClick?: () => void;
  icon: LucideIcon;
  label: string;
  wert?: string;
}) {
  const klasse = "flex h-14 w-full items-center gap-3 border-t border-border px-4 text-left text-base first:border-t-0 active:bg-foreground/10";
  const inhalt = (
    <>
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {wert && <span className="shrink-0 text-[14px] text-muted-foreground">{wert}</span>}
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
    </>
  );
  if (href) {
    return (
      <Link href={href} className={klasse}>
        {inhalt}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={klasse}>
      {inhalt}
    </button>
  );
}
