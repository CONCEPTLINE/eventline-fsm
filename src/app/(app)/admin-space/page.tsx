"use client";

/**
 * /admin-space — eigene Seite fuer den geteilten Admin-Notiz-Block.
 *
 * Nicht in der Sidebar — Zugang nur via Link im Dashboard (Admin-only).
 * Path-Guard: Non-Admins werden weggeleitet (RLS sperrt zusaetzlich ab).
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePermissions } from "@/lib/use-permissions";
import { AdminSpace } from "@/components/dashboard/admin-space";
import { BackButton } from "@/components/ui/back-button";

export default function AdminSpacePage() {
  const router = useRouter();
  const { role, ready } = usePermissions();

  useEffect(() => {
    if (ready && role !== "admin") router.replace("/dashboard");
  }, [ready, role, router]);

  if (!ready || role !== "admin") return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton fallbackHref="/dashboard" size="sm" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin-Space</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Persönliche Ziele &amp; Notizen — sichtbar für alle Admins, jeder bearbeitet nur seinen Eintrag.
          </p>
        </div>
      </div>

      <AdminSpace />
    </div>
  );
}
