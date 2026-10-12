"use client";

/**
 * Partner-Konto-Seite — eigene Daten ansehen, Datenschutz-Export,
 * Datenschutzerklaerung-Link. Bewusst minimal: kein Profil-Edit
 * (Email/Name aenderbar nur durch Admin), keine Passwort-Aenderung
 * hier (laeuft ueber Reset-Mail-Flow). Am Handy zusaetzlich Darstellung
 * und Abmelden (am Desktop im Portal-Kopf).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { todayLocalIso } from "@/lib/swiss-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronRight, Download, Loader2, LogOut, Moon, Shield, Sun, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { PartnerNotificationsCard } from "@/components/partner/partner-notifications-card";

interface PartnerProfileSummary {
  full_name: string;
  email: string;
  location_name: string | null;
  datenschutz_akzeptiert_at: string | null;
  datenschutz_akzeptiert_version: string | null;
}

export default function PartnerKontoPage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<PartnerProfileSummary | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // View-As: Profil des impersonierten Partners (wie Portal-Layout).
      const profileId = readImpersonationCookie() || user.id;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version, location:locations!profiles_partner_location_id_fkey(name)")
        .eq("id", profileId)
        .maybeSingle();
      if (!data) return;
      const loc = Array.isArray(data.location) ? data.location[0] : data.location;
      setProfile({
        full_name: data.full_name,
        email: data.email,
        location_name: loc?.name ?? null,
        datenschutz_akzeptiert_at: data.datenschutz_akzeptiert_at,
        datenschutz_akzeptiert_version: data.datenschutz_akzeptiert_version,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/profile/export-data", { method: "GET" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Export fehlgeschlagen");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eventline-meine-daten-${todayLocalIso()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export heruntergeladen");
    } finally {
      setExporting(false);
    }
  }

  if (!profile) {
    return <div className="h-32 rounded-xl bg-muted animate-pulse" />;
  }

  return (
    // Aeusserer Rahmen nur, damit der Handy-Block unten nicht im space-y der
    // Karten steht (sonst bekaeme die letzte Karte am Desktop einen Abstand).
    <div className="max-w-4xl mx-auto">
      <div className="space-y-4">
        {/* Am Handy steht der Titel im mobilen Kopf des Portals. */}
        <div className="max-md:hidden">
          <h1 className="text-xl font-bold tracking-tight">Mein Konto</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Deine Profildaten und Datenschutz-Optionen.
          </p>
        </div>

        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <UserIcon className="h-4 w-4" />Profil
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Name" value={profile.full_name} />
            <Row label="E-Mail" value={profile.email} />
            <Row label="Location" value={profile.location_name ?? "—"} />
            <p className="text-[11px] text-muted-foreground pt-2">
              Änderungen an Name oder E-Mail bitte direkt an EVENTLINE melden.
            </p>
          </CardContent>
        </Card>

        <PartnerNotificationsCard />

        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Shield className="h-4 w-4" />Datenschutz
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {profile.datenschutz_akzeptiert_at ? (
              <p className="text-xs text-muted-foreground">
                Akzeptiert am {new Date(profile.datenschutz_akzeptiert_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" })}
                {profile.datenschutz_akzeptiert_version && ` (Version ${profile.datenschutz_akzeptiert_version})`}
              </p>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300">Noch nicht akzeptiert</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Link
                href="/datenschutz"
                target="_blank"
                rel="noopener noreferrer"
                className="kasten kasten-muted"
              >
                <Shield className="h-3.5 w-3.5" />
                Erklärung ansehen
              </Link>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="kasten kasten-blue"
              >
                <Download className="h-3.5 w-3.5" />
                {exporting ? "Lädt…" : "Meine Daten exportieren"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Der Export enthält Profil, Anfragen, Notizen und akzeptanz-Logs
              im JSON-Format.
            </p>
          </CardContent>
        </Card>
      </div>

      <DarstellungUndAbmelden />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground w-20 shrink-0">{label}</span>
      {/* min-w-0 + break-words: eine lange E-Mail bricht um statt ueberzulaufen. */}
      <span className="font-medium min-w-0 break-words">{value}</span>
    </div>
  );
}

/** Nur am Handy (< md): Darstellung Hell/Dunkel und Abmelden. Am Desktop
 *  sitzen beide als Icon-Knoepfe im Portal-Kopf; am Handy blendet die Shell
 *  diesen Kopf aus. Zeile und Knopf wie in src/components/mobile/mein-konto-mobil.tsx. */
function DarstellungUndAbmelden() {
  const supabase = createClient();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [abmeldet, setAbmeldet] = useState(false);
  const dunkel = theme === "dark";

  // Gleicher Ablauf wie der Abmelde-Knopf im Portal-Kopf. Geht die Abmeldung
  // nicht durch (z. B. ohne Netz, die Sitzung besteht dann weiter), Toast und
  // der Knopf wird wieder frei.
  async function abmelden() {
    setAbmeldet(true);
    try {
      const { error } = await supabase.auth.signOut({ scope: "local" }); // nur dieses Geraet
      if (error) throw error;
      router.push("/partner/login");
      router.refresh();
    } catch {
      toast.error("Abmelden fehlgeschlagen — bitte mit Netz nochmals versuchen");
      setAbmeldet(false);
    }
  }

  return (
    <div className="md:hidden mt-4 flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setTheme(dunkel ? "light" : "dark")}
          className="flex h-14 w-full items-center gap-3 px-4 text-left text-base active:bg-foreground/10"
        >
          {dunkel
            ? <Moon className="h-5 w-5 shrink-0 text-muted-foreground" />
            : <Sun className="h-5 w-5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">Darstellung</span>
          <span className="shrink-0 text-[14px] text-muted-foreground">{dunkel ? "Dunkel" : "Hell"}</span>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
        </button>
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
    </div>
  );
}
