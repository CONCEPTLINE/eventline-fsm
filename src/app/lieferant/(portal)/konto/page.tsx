"use client";

/**
 * Lieferanten-Konto-Seite — Spiegel der Partner-Konto-Seite: eigene Daten
 * ansehen, Datenschutz-Export, Datenschutzerklaerung-Link. Bewusst minimal:
 * kein Profil-Edit (Email/Name aenderbar nur durch Admin), keine Passwort-
 * Aenderung hier (laeuft ueber Reset-Mail-Flow auf /lieferant/login).
 * Ohne Partner-Spezifika: keine Notifications-Card, kein Akzeptanz-Status
 * (das Datenschutz-Zwangsmodal laeuft im Lieferantenportal noch nicht).
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/swiss-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Shield, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface LieferantProfileSummary {
  full_name: string;
  email: string;
  firma_name: string | null;
}

export default function LieferantKontoPage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<LieferantProfileSummary | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email, firma:lieferanten!profiles_lieferant_id_fkey(name)")
        .eq("id", user.id)
        .maybeSingle();
      if (!data) return;
      const firma = Array.isArray(data.firma) ? data.firma[0] : data.firma;
      setProfile({
        full_name: data.full_name,
        email: data.email,
        firma_name: firma?.name ?? null,
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
    <div className="max-w-4xl mx-auto space-y-4">
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
          <Row label="Firma" value={profile.firma_name ?? "—"} />
          <p className="text-[11px] text-muted-foreground pt-2">
            Änderungen an Name oder E-Mail bitte direkt an EVENTLINE melden.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />Datenschutz
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
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
            Der Export enthält alle zu deinem Konto gespeicherten Daten
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
