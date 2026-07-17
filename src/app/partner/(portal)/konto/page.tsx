"use client";

/**
 * Partner-Konto-Seite — eigene Daten ansehen, Datenschutz-Export,
 * Datenschutzerklaerung-Link. Bewusst minimal: kein Profil-Edit
 * (Email/Name aenderbar nur durch Admin), keine Passwort-Aenderung
 * hier (laeuft ueber Reset-Mail-Flow).
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/swiss-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Shield, User as UserIcon } from "lucide-react";
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
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version, location:locations!profiles_partner_location_id_fkey(name)")
        .eq("id", user.id)
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
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
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
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground w-20 shrink-0">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
