"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { sichtbareNavGruppen, isNavItemActive } from "@/lib/constants";
import type { NavGroup, NavItem } from "@/lib/constants";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { hasPermission } from "@/lib/permissions";
import { Logo } from "@/components/logo";
import { SidebarStempel } from "@/components/stempel/sidebar-stempel";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import {
  LogOut,
  ChevronRight,
  Sun,
  Moon,
  BookOpen,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";
import { useMeinKontoOnboarding } from "@/lib/use-mein-konto-onboarding";
import { CommandPaletteTrigger } from "@/components/shell/command-palette";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import type { Profile } from "@/types";

interface SidebarProps {
  profile: Profile;
  /** Erlaubte Modul-Slugs aus der Rollen-Konfiguration. */
  permissions: string[];
  onSignOut: () => void;
}

/** localStorage: JSON-Array der Labels der offenen Bereiche (persoenliche
 *  Anzeige-Vorliebe, ueberlebt Reload — CLAUDE.md §10). */
const BEREICHE_KEY = "sidebar-bereiche-offen";

function leseOffeneBereiche(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const roh = window.localStorage.getItem(BEREICHE_KEY);
    const wert: unknown = roh ? JSON.parse(roh) : [];
    return Array.isArray(wert) ? wert.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function Sidebar({ profile, permissions, onSignOut }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { theme, setTheme } = useTheme();
  const navCounts = useNavCounts();
  const onboarding = useMeinKontoOnboarding();
  const showMeinKontoBadge = onboarding.ready && !onboarding.firstVisitedAt;
  // Ticket-Badge-Quelle: tickets:manage-Queue statt role==='admin' (W5) —
  // muss zur NavCountsProvider-Prop im (app)/layout passen.
  const canManageTickets = hasPermission(permissions, profile.role, "tickets:manage");
  const searchString = searchParams.toString();

  // Wir filtern alle Nav-Items nach den Permissions der Rolle des Users
  // (sichtbareNavGruppen — dieselbe Liste wie Mobile-Sheet und Befehls-
  // palette); leere Gruppen verschwinden automatisch (kein hardcoded
  // role==="admin" — die Rollen-Tabelle entscheidet was sichtbar ist).
  const groups: NavGroup[] = sichtbareNavGruppen(permissions, profile.role);
  const navSignatur = groups.map((g) => g.items.map((i) => i.href).join(",")).join("|");

  // Fade-Mask nur dort wo's noch was zu scrollen gibt — Top-Fade nur wenn
  // hochgescrollt, Bottom-Fade nur wenn noch was unten ist. Sonst war auch
  // an Raendern transparent obwohl kein Overflow existierte.
  const navRef = useRef<HTMLElement | null>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      setFadeTop(el.scrollTop > 1);
      setFadeBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // ResizeObserver fuer Sidebar-Resize (window) und Content-Aenderungen
    // (Nav-Items kommen/gehen je nach Rolle/Permission).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child as Element);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
    // navSignatur: kommen nach dem Laden der Rechte Bereiche dazu, auch
    // diese beobachten (sonst stimmen die Fade-Kanten bis zum Scrollen nicht).
  }, [navSignatur]);

  // Aufklappbare Bereiche. Der oberste Block (label "") ist immer offen.
  // Offen = Labels in `offen` (localStorage, ueberlebt Reload). Ohne
  // gespeicherten Stand ist nur der Bereich der aktuellen Seite offen.
  const idBasis = useId();
  const aktiverBereich =
    groups.find((g) => g.label && g.items.some((i) => isNavItemActive(i, pathname, searchString)))?.label ?? null;
  const [offen, setOffen] = useState<string[]>(leseOffeneBereiche);
  // Bei jedem Seitenwechsel (und beim ersten Rendern) den Bereich der
  // aktiven Seite oeffnen — Abgleich waehrend des Renderns statt per
  // useEffect (react.dev «Storing information from previous renders»),
  // so ist der Bereich schon offen, wenn der Scroll-Effekt unten laeuft.
  // Nur der Pfad zaehlt: ein Tab-Wechsel innerhalb der Seite (?tab=…)
  // klappt einen bewusst zugeklappten Bereich nicht wieder auf.
  const seitenSchluessel = `${pathname}|${aktiverBereich ?? ""}`;
  const [geoeffnetFuer, setGeoeffnetFuer] = useState<string | null>(null);
  if (geoeffnetFuer !== seitenSchluessel) {
    setGeoeffnetFuer(seitenSchluessel);
    if (aktiverBereich && !offen.includes(aktiverBereich)) setOffen([...offen, aktiverBereich]);
  }
  useEffect(() => {
    try {
      window.localStorage.setItem(BEREICHE_KEY, JSON.stringify(offen));
    } catch {
      // Privates Fenster / Speicher gesperrt — Sidebar funktioniert trotzdem.
    }
  }, [offen]);
  const schalteBereich = (label: string) =>
    setOffen((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  // Hover state-driven (Projektregel: Tailwind hover: unzuverlaessig).
  const [hoverBereich, setHoverBereich] = useState<string | null>(null);

  // Aktiven Eintrag bei jedem Seitenwechsel in den sichtbaren Bereich holen —
  // ausserhalb der 64px-Fade-Zonen, sonst steht er blass am Rand.
  // Fusszeile (Stempel, Konto) und Rechte laden nach und verändern die Höhe
  // → bei Grössenänderung nachziehen, aber nie gegen eigenes Scrollen.
  // Nur Pfad-Wechsel zaehlen: Filter auf der Seite schreiben ?…-Parameter,
  // das darf die selbst gescrollte Leiste nicht zurueckreissen.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let selbstGescrollt = false;
    const holeAktivenInSicht = () => {
      const el = nav.querySelector<HTMLElement>('[data-nav-active="true"]');
      // Liegt der aktive Eintrag in einem zugeklappten Bereich (inert),
      // gibt es nichts zu zeigen.
      if (selbstGescrollt || !el || el.closest("[inert]")) return;
      const FADE = 64;
      const n = nav.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < n.top + FADE) nav.scrollTop -= n.top + FADE - r.top;
      else if (r.bottom > n.bottom - FADE) nav.scrollTop += r.bottom - (n.bottom - FADE);
    };
    const merkeSelbst = () => { selbstGescrollt = true; };
    // Wurde der Bereich gerade erst aufgeklappt, ist die Liste waehrend des
    // Uebergangs noch kuerzer (scrollTop wird gekappt) → nach dem Aufklappen
    // nochmals nachziehen. Nur der Bereichs-Uebergang, nicht Hover-Farben.
    const nachAufklappen = (e: TransitionEvent) => {
      if (e.propertyName === "grid-template-rows") holeAktivenInSicht();
    };
    holeAktivenInSicht();
    const ro = new ResizeObserver(holeAktivenInSicht);
    ro.observe(nav);
    nav.addEventListener("wheel", merkeSelbst, { passive: true });
    nav.addEventListener("touchmove", merkeSelbst, { passive: true });
    nav.addEventListener("transitionend", nachAufklappen);
    return () => {
      ro.disconnect();
      nav.removeEventListener("wheel", merkeSelbst);
      nav.removeEventListener("touchmove", merkeSelbst);
      nav.removeEventListener("transitionend", nachAufklappen);
    };
  }, [pathname, navSignatur]);
  const maskGradient = (() => {
    const top = fadeTop ? "transparent 0, black 64px" : "black 0";
    const bottom = fadeBottom ? "black calc(100% - 64px), transparent 100%" : "black 100%";
    return `linear-gradient(to bottom, ${top}, ${bottom})`;
  })();

  return (
    <aside className="hidden md:flex md:flex-col fixed left-0 top-0 w-[240px] h-screen bg-sidebar text-sidebar-foreground shadow-lg border-r border-sidebar-border font-heading z-30">
      {/* Logo — symmetrische Luft (Leo 2026-09-05): oben = unten = 32px,
          damit das Logo optisch zentriert in seinem Container-Slot sitzt. */}
      <div className="px-6 pt-8 pb-8">
        <PrefetchLink href="/dashboard" className="block">
          <Logo fillWidth />
        </PrefetchLink>
      </div>

      {/* Cmd-K Trigger direkt unter dem Logo — hoechste Discoverability. */}
      <div className="px-3 pb-2">
        <CommandPaletteTrigger />
      </div>

      {/* Navigation — mask-image fade nur an Raendern wo tatsaechlich noch
          Content zu scrollen ist (siehe useEffect oben). Top-Items
          erscheinen voll opak wenn nicht hochgescrollt; gleiche Logik unten. */}
      <nav
        ref={navRef}
        className="flex-1 px-3 py-2 overflow-y-auto space-y-1"
        style={{
          maskImage: maskGradient,
          WebkitMaskImage: maskGradient,
        }}
      >
        {/* Empty-State: User mit leerer Permissions-Liste sieht sonst gar
            nichts und glaubt die App ist kaputt. Der Hinweis macht klar
            dass es ein Permission-Problem ist und an wen er sich wenden
            soll. */}
        {groups.length === 0 && (
          <div className="px-3 py-4 rounded-lg bg-sidebar-accent/50 text-sidebar-foreground/70 text-[12px] leading-relaxed">
            <p className="font-medium mb-1 text-sidebar-foreground">Noch keine Berechtigungen</p>
            <p>Deine Rolle hat keine Module freigeschaltet. Bitte sprich mit deinem Admin.</p>
          </div>
        )}
        {groups.map((group, gi) => {
          const items = group.items;
          if (items.length === 0) return null;

          const eintraege = items.map((item) => (
            <SidebarEintrag
              key={item.href}
              item={item}
              active={isNavItemActive(item, pathname, searchString)}
              badge={getBadgeForHref(item.href, navCounts, canManageTickets)}
            />
          ));

          // Oberster Block: ohne Kopfzeile, immer offen.
          if (!group.label) {
            return (
              <div key={group.items[0]?.href} className="space-y-0.5 pb-3">
                {eintraege}
              </div>
            );
          }

          const istOffen = offen.includes(group.label);
          const hover = hoverBereich === group.label;
          // Zugeklappt darf nichts verschwinden: hat ein Eintrag einen
          // roten Punkt, zeigt ihn die Kopfzeile.
          const punktVersteckt =
            !istOffen && items.some((i) => getBadgeForHref(i.href, navCounts, canManageTickets) > 0);
          const inhaltId = `${idBasis}-bereich-${gi}`;
          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => schalteBereich(group.label)}
                onMouseEnter={() => setHoverBereich(group.label)}
                onMouseLeave={() => setHoverBereich((h) => (h === group.label ? null : h))}
                aria-expanded={istOffen}
                aria-controls={inhaltId}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-[10px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase transition-colors duration-150"
                style={hover ? { backgroundColor: "var(--sidebar-accent)", color: "var(--sidebar-foreground)" } : undefined}
              >
                <span className="flex-1 text-left">{group.label}</span>
                {punktVersteckt && (
                  <span
                    className="w-2 h-2 rounded-full bg-red-500 animate-pulse"
                    aria-label="Offene Einträge"
                  />
                )}
                <ChevronRight
                  className="h-3 w-3 shrink-0 transition-transform duration-150"
                  style={istOffen ? { transform: "rotate(90deg)" } : undefined}
                  aria-hidden
                />
              </button>
              {/* Sanftes Auf-/Zuklappen ohne Hoehen-Messen: Grid-Zeile
                  0fr ↔ 1fr. Zugeklappt `inert` → Eintraege nicht per Tab
                  erreichbar und fuer Screenreader versteckt. */}
              <div
                id={inhaltId}
                inert={!istOffen}
                className="grid transition-[grid-template-rows] duration-150 ease-out"
                style={{ gridTemplateRows: istOffen ? "1fr" : "0fr" }}
              >
                {/* -mx-1 px-1: Luft, damit overflow-hidden den Schatten
                    des aktiven Eintrags seitlich nicht abschneidet. */}
                <div className="overflow-hidden min-h-0 -mx-1 px-1">
                  <div className="space-y-0.5 pt-0.5 pb-3">{eintraege}</div>
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      {/* Stempel — eingestempelt zeigt Live-Timer + Ausstempeln,
          ausgestempelt zeigt "Einstempeln"-Button. Steht ueber dem
          Theme-Toggle damit es als prominenter Action-Bereich endet. */}
      <SidebarStempel />

      {/* Theme-Toggle (Light/Dark) + Anleitung + Notifications-Glocke.
          Glocke rechts ausgerichtet damit sie immer sichtbar ist. */}
      <div className="px-3 mb-2 flex items-center gap-1">
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all"
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </button>
        {/* Anleitung & Neuerungen — feste Adresse /anleitung. */}
        <PrefetchLink
          href="/anleitung"
          className="p-2 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all"
          data-tooltip="Anleitung & Neuerungen"
          aria-label="Anleitung & Neuerungen"
        >
          <BookOpen className="h-4 w-4" />
        </PrefetchLink>
        <NotificationsBell />
      </div>

      {/* User — Card komplett klickbar fuer /mein-konto.
          Logout-Button bleibt rechts daneben separat. */}
      <div className="p-1 mx-3 mb-3 rounded-xl bg-sidebar-foreground/[0.04] border border-sidebar-border flex items-center gap-1">
        <PrefetchLink
          href="/mein-konto"
          className="flex-1 min-w-0 flex items-center gap-3 p-3 rounded-lg hover:bg-sidebar-accent/60 transition-all relative"
        >
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-red-500/20 shrink-0 relative">
            {profile.full_name.charAt(0).toUpperCase()}
            {showMeinKontoBadge && (
              <span
                className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-red-500 border-2 border-sidebar shadow-md animate-pulse"
                data-tooltip="Neu: dein Mein-Konto-Bereich"
                aria-label="Neue Funktion"
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-sidebar-foreground truncate">
              {profile.full_name}
            </p>
            <p className="text-[11px] text-sidebar-foreground/50 capitalize">
              Mein Konto{showMeinKontoBadge && <span className="ml-1 text-red-500 font-bold">· neu</span>}
            </p>
          </div>
        </PrefetchLink>
        <button
          onClick={onSignOut}
          className="p-2 mr-2 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all duration-200 shrink-0"
          data-tooltip="Abmelden"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}

/** Ein Nav-Eintrag (Icon, Label, roter Punkt bzw. Pfeil am aktiven). */
function SidebarEintrag({ item, active, badge }: { item: NavItem; active: boolean; badge: number }) {
  const Icon = NAV_ICON_MAP[item.icon];
  return (
    <PrefetchLink
      href={item.href}
      data-nav-active={active ? "true" : undefined}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-200",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60"
      )}
    >
      {Icon && (
        <div className={cn(
          "flex items-center justify-center w-7 h-7 rounded-md transition-all duration-200",
          active
            ? "bg-red-500/20 text-red-500 dark:text-red-400"
            : "bg-sidebar-foreground/[0.08] text-sidebar-foreground"
        )}>
          <Icon className="h-4 w-4" />
        </div>
      )}
      <span className="flex-1">{item.label}</span>
      {badge > 0 && (
        // App-weit: dezenter roter Punkt (Menge irrelevant,
        // Klick fuehrt eh in die Liste). Kein Zahl-Badge mehr.
        <span
          className="w-2 h-2 rounded-full bg-red-500 animate-pulse"
          aria-label={`${badge} offen`}
        />
      )}
      {active && badge === 0 && (
        <ChevronRight className="h-3 w-3 text-sidebar-foreground/30" />
      )}
    </PrefetchLink>
  );
}
