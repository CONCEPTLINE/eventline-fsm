"use client";

/**
 * UI-Mocks fuer /anleitung — kleine, nachgebaute Ausschnitte der echten
 * App-Elemente, damit Mitarbeiter die Features visuell wiedererkennen.
 *
 * Bewusst NACHGEBAUT statt Screenshots: kein Hosting von Bild-Assets,
 * keine echten Daten im Bild, Dark-Mode folgt automatisch den App-Tokens,
 * und die Mocks veralten nicht mit jedem Pixel-Tweak der echten UI.
 *
 * Farb-/Form-Referenzen aus den echten Komponenten:
 *   - Modus-Kacheln/Chips: src/components/stempel/rate-tier-chooser.tsx
 *   - Palette:             src/components/shell/command-palette.tsx
 *   - Stempel-Teal:        #14b8a6 (SidebarStempel/StempelWidget)
 *   - Team-Widget:         src/app/(app)/dashboard/page.tsx TeamStatusCard
 *
 * KEINE CHF-Betraege in den Mocks (Kunden-Pricing, Leo 2026-09-08).
 * Registry unten: MOCK_BY_UPDATE_ID — UpdateCard rendert den Mock, wenn
 * fuer die Eintrags-ID einer existiert.
 */

import {
  Search, Zap, Calendar as CalendarIcon, Clock, PhoneCall, FileText, Wrench,
  Check, Settings, Pin, Lock, Wifi, Phone, Mail, Fingerprint, Plus, Users,
} from "lucide-react";

function MockFrame({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <figure className="m-0">
      <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2.5">
        {children}
      </div>
      <figcaption className="text-[10px] text-muted-foreground mt-1.5 leading-snug">{caption}</figcaption>
    </figure>
  );
}

/* ── Suche mit Aktionen ─────────────────────────────────────────── */
function SucheMock() {
  return (
    <MockFrame caption="«krank» getippt — die passende Aktion steht zuoberst, Enter öffnet sie.">
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium">krank<span className="inline-block w-px h-3 bg-foreground align-[-2px] ml-px" /></span>
        </div>
        <div className="px-3 pt-1.5 pb-0.5 text-[8.5px] font-bold uppercase tracking-wider text-muted-foreground/60">
          Aktionen
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/70">
          <span className="w-6 h-6 rounded-md bg-red-500/20 text-red-500 dark:text-red-400 flex items-center justify-center shrink-0">
            <CalendarIcon className="h-3 w-3" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1 text-[11px] font-semibold leading-tight">
              Abwesenheit melden
              <Zap className="h-2.5 w-2.5 text-muted-foreground/50" />
            </span>
            <span className="block text-[9.5px] text-muted-foreground leading-tight">
              Krankheit, Ferien, Militär — Abwesenheit beantragen
            </span>
          </span>
        </div>
        <div className="h-1.5" />
      </div>
    </MockFrame>
  );
}

/* ── Modus-Kacheln + Wechsel-Chips ──────────────────────────────── */
const KACHEL_TONE = {
  pikett: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.35)", fg: "rgb(154,90,10)", fgDark: "rgb(217,160,60)" },
  admin: { bg: "rgba(37,99,235,0.06)", border: "rgba(37,99,235,0.30)", fg: "rgb(29,78,180)", fgDark: "rgb(120,160,235)" },
  aufbau: { bg: "rgba(124,58,237,0.06)", border: "rgba(124,58,237,0.30)", fg: "rgb(88,28,180)", fgDark: "rgb(170,130,240)" },
} as const;

function Kachel({ label, icon: Icon, tone, aktiv }: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: keyof typeof KACHEL_TONE;
  aktiv?: boolean;
}) {
  const t = tone ? KACHEL_TONE[tone] : null;
  return (
    <div
      className={`relative rounded-lg border-2 p-2 flex flex-col items-start ${
        aktiv ? "border-foreground bg-foreground/[0.06]" : ""
      }`}
      style={t ? { backgroundColor: t.bg, borderColor: t.border, color: t.fg } : undefined}
    >
      {aktiv && (
        <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-foreground text-background flex items-center justify-center">
          <Check className="h-2 w-2" strokeWidth={3.5} />
        </span>
      )}
      <span className="w-6 h-6 rounded-md bg-black/[0.06] dark:bg-white/[0.08] flex items-center justify-center mb-1">
        <Icon className="h-3 w-3" />
      </span>
      <span className="text-[10.5px] font-semibold leading-tight">{label}</span>
      {aktiv && <span className="text-[7px] font-extrabold uppercase tracking-wider opacity-55 mt-0.5">Standard</span>}
    </div>
  );
}

function ModusChip({ label, tone, aktiv }: { label: string; tone?: keyof typeof KACHEL_TONE; aktiv?: boolean }) {
  const t = tone ? KACHEL_TONE[tone] : null;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9.5px] ${
        aktiv && !t ? "border-foreground bg-foreground/[0.08] font-bold" : t ? "" : "border-border bg-muted font-medium"
      }`}
      style={t ? {
        backgroundColor: aktiv ? t.bg.replace(/0\.0[68]/, "0.18") : t.bg,
        borderColor: aktiv ? t.border.replace("0.3", "0.7").replace("0.35", "0.7") : t.border,
        color: t.fg,
        fontWeight: aktiv ? 700 : 500,
      } : undefined}
    >
      {label}
    </span>
  );
}

function ModusMock() {
  return (
    <MockFrame caption="Oben: die Auswahl vor dem Einstempeln (Standard markiert). Unten: die Wechsel-Chips während der laufenden Stempelung.">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">Was für ein Einsatz?</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Kachel label="Normal" icon={Clock} aktiv />
          <Kachel label="Pikett" icon={PhoneCall} tone="pikett" />
          <Kachel label="Administration" icon={FileText} tone="admin" />
          <Kachel label="Aufbau/Abbau" icon={Wrench} tone="aufbau" />
        </div>
        <div
          className="mt-2 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-bold"
          style={{ border: "2px solid #14b8a6", backgroundColor: "rgba(20,184,166,0.06)", color: "#0d9488" }}
        >
          <Clock className="h-3 w-3" />
          Einstempeln
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card px-2.5 py-1.5 flex items-center gap-1 flex-wrap">
        <span className="text-[7.5px] font-bold uppercase tracking-wider text-muted-foreground mr-0.5">Modus:</span>
        <ModusChip label="Aufbau/Abbau" tone="aufbau" aktiv />
        <span className="text-[8px] text-muted-foreground/60">wechseln →</span>
        <ModusChip label="Normal" />
        <ModusChip label="Pikett" tone="pikett" />
      </div>
    </MockFrame>
  );
}

/* ── Rapport-Zeile ──────────────────────────────────────────────── */
function RapportMock() {
  return (
    <MockFrame caption="Eine Einsatzzeit-Zeile im Rapport — der Modus-Chip gehört zu genau dieser Zeile.">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-semibold whitespace-nowrap">Sa 12.09.</span>
          <span className="px-1.5 py-0.5 rounded-md border border-border text-[10px] tabular-nums">18:00</span>
          <span className="text-[8.5px] text-muted-foreground/60">bis</span>
          <span className="px-1.5 py-0.5 rounded-md border border-border text-[10px] tabular-nums">23:30</span>
          <span className="ml-auto text-[9px] text-muted-foreground tabular-nums whitespace-nowrap">5.5 h</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[7.5px] font-bold uppercase tracking-wider text-muted-foreground">Modus:</span>
          <ModusChip label="Normal" aktiv />
          <ModusChip label="Pikett" tone="pikett" />
          <ModusChip label="Administration" tone="admin" />
        </div>
      </div>
    </MockFrame>
  );
}

/* ── Standort-Tabs + Pins ───────────────────────────────────────── */
function StandortMock() {
  return (
    <MockFrame caption="Beispieldaten — deine Standorte zeigen die echten gepinnten Notizen und Kontakte.">
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex gap-3 px-2.5 border-b border-border">
          <span className="py-1.5 text-[10px] font-semibold border-b-2 border-red-500">Übersicht</span>
          <span className="py-1.5 text-[10px] font-medium text-muted-foreground border-b-2 border-transparent">Notizen &amp; Dokumente</span>
        </div>
        <div className="p-2.5 space-y-1.5">
          <span className="flex items-center gap-1 text-[7.5px] font-bold uppercase tracking-wider text-muted-foreground">
            <Pin className="h-2.5 w-2.5 fill-amber-400 text-amber-500" strokeWidth={2.5} />
            Gepinnt
          </span>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-muted border border-border text-[10px]">
            <Lock className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
            <span>Türcode Seiteneingang: <strong>4711#</strong></span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-muted border border-border text-[10px]">
            <Wifi className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
            <span>WLAN «Technik»: <strong>backstage-2026</strong></span>
          </div>
          <div className="flex items-center gap-1.5 pt-1.5 border-t border-border">
            <span className="w-6 h-6 rounded-full bg-foreground/[0.08] text-[8px] font-bold flex items-center justify-center shrink-0">MK</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold leading-tight">M. Keller</span>
              <span className="block text-[8.5px] text-muted-foreground leading-tight">Hauswart</span>
            </span>
            <span className="ml-auto flex gap-1">
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-border text-[8.5px] font-semibold"><Phone className="h-2 w-2" />Anrufen</span>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-border text-[8.5px] font-semibold"><Mail className="h-2 w-2" />Mailen</span>
            </span>
          </div>
        </div>
      </div>
    </MockFrame>
  );
}

/* ── Dashboard-Zahnrad ──────────────────────────────────────────── */
function DashboardMock() {
  return (
    <MockFrame caption="Zahnrad öffnet den Bearbeiten-Modus — ziehen, Grösse ändern, ein-/ausblenden.">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10.5px] font-bold">Dashboard</span>
          <span className="w-5 h-5 rounded-md border border-red-500 bg-red-500/10 text-red-500 flex items-center justify-center">
            <Settings className="h-2.5 w-2.5" />
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="col-span-2 rounded-lg border border-border bg-muted px-2 py-1.5">
            <span className="block text-[9px] font-semibold">Meine nächsten Einsätze</span>
            <span className="block text-[8px] text-muted-foreground">Sa 12.09. — Konzert…</span>
          </div>
          <div className="rounded-lg border border-border bg-muted px-2 py-1.5">
            <span className="block text-[9px] font-semibold">Stempeluhr</span>
            <span className="block text-[8px] text-muted-foreground">Eingestempelt 06:12</span>
          </div>
          <div className="rounded-lg border border-dashed border-border px-2 py-1.5 flex items-center justify-center text-[8.5px] text-muted-foreground/60">
            ausgeblendet
          </div>
        </div>
      </div>
    </MockFrame>
  );
}

/* ── Passkey-Card ───────────────────────────────────────────────── */
function PasskeyMock() {
  return (
    <MockFrame caption="Freiwillig — einmal selbst aktivieren, dann geht das Einloggen ohne Passwort.">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: "rgba(20,184,166,0.12)", color: "#0d9488" }}>
            <Fingerprint className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[10.5px] font-bold leading-tight">Passkeys — biometrische Anmeldung</span>
            <span className="block text-[8.5px] text-muted-foreground leading-tight">Mein Konto → Sicherheit</span>
          </span>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border-2 border-red-500 bg-red-500/10 text-[9.5px] font-bold text-red-600 dark:text-red-400">
          <Plus className="h-2.5 w-2.5" strokeWidth={3} />
          Passkey einrichten
        </span>
      </div>
    </MockFrame>
  );
}

/* ── Mein-Team-Widget ───────────────────────────────────────────── */
function TeamRow({ name, status, detail }: { name: string; status: "in" | "away" | "off"; detail: string }) {
  return (
    <div className={`flex items-center gap-1.5 py-1 ${status === "off" ? "opacity-60" : ""}`}>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {status === "in" && (
          <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full opacity-50" style={{ backgroundColor: "#22c55e" }} />
        )}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: status === "in" ? "#22c55e" : status === "away" ? "#f59e0b" : "var(--border)" }}
        />
      </span>
      <span className="text-[10px] font-semibold whitespace-nowrap">{name}</span>
      <span className="text-[8.5px] text-muted-foreground truncate flex-1 text-right tabular-nums">{detail}</span>
    </div>
  );
}

function TeamWidgetMock() {
  return (
    <MockFrame caption="Grün = eingestempelt (mit seit wann und worauf), amber = heute abwesend, grau = offline.">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10.5px] font-bold flex items-center gap-1"><Users className="h-3 w-3 text-red-500" /> Mein Team</span>
          <span className="text-[8px] text-muted-foreground tabular-nums">2 eingestempelt · 1 abwesend</span>
        </div>
        <div className="divide-y divide-border/60">
          <TeamRow name="L. Steiner" status="in" detail="seit 06:12 · INT-311 · Konzertaufbau" />
          <TeamRow name="T. Böhm" status="in" detail="seit 08:30 · PROJ-4 · Lagerumbau" />
          <TeamRow name="A. Meier" status="away" detail="Ferien" />
          <TeamRow name="J. Roth" status="off" detail="—" />
        </div>
      </div>
    </MockFrame>
  );
}

/* ── Projekte: Budget-Balken ────────────────────────────────────── */
function ProjektBudgetMock() {
  return (
    <MockFrame caption="Der Budget-Balken im Projekt: verbrauchte gegen genehmigte Stunden — ab 80% amber, ab 100% rot.">
      <div className="rounded-xl border border-border bg-card p-2.5 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] font-bold">PROJ-4 · Lagerumbau</span>
          <span className="inline-flex px-1.5 py-0 text-[8px] font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">Genehmigt</span>
        </div>
        <div>
          <div className="flex justify-between text-[8.5px] text-muted-foreground mb-0.5 tabular-nums">
            <span>34.5 h von 40 h</span>
            <span>86%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-amber-500" style={{ width: "86%" }} />
          </div>
        </div>
      </div>
    </MockFrame>
  );
}

/* ── Registry ───────────────────────────────────────────────────── */
export const MOCK_BY_UPDATE_ID: Record<string, React.ComponentType> = {
  "suche-aktionen": SucheMock,
  "einsatz-modus-stempeln": ModusMock,
  "rapport-modus": RapportMock,
  "standort-tabs": StandortMock,
  "dashboard-anpassen": DashboardMock,
  "passkey-login": PasskeyMock,
  "mein-team-widget": TeamWidgetMock,
  "projekte-guide": ProjektBudgetMock,
};
