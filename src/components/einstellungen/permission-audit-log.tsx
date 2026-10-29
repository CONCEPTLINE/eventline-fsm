"use client";

/**
 * Anzeige des Permission-Audit-Logs (wer hat wann was an Rollen oder
 * User-Rollen-Zuweisungen geaendert). Admin-only — RLS auf
 * permission_audit_log enforced das.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { History, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { WARTUNG_BEREICH_INFO, istWartungBereich } from "@/lib/wartung";

interface AuditEntry {
  id: string;
  occurred_at: string;
  actor_label: string | null;
  action: string;
  target_role_slug: string | null;
  target_profile_label: string | null;
  details: Record<string, unknown>;
}

const ACTION_LABELS: Record<string, { icon: React.ReactNode; label: string }> = {
  "role.created":            { icon: "➕", label: "Rolle angelegt" } as never,
  "role.updated":            { icon: "✎",  label: "Rolle bearbeitet" } as never,
  "role.deleted":            { icon: "🗑", label: "Rolle gelöscht" } as never,
  "user.role_changed":       { icon: "↔",  label: "User-Rolle gewechselt" } as never,
  "user.permissions_changed":{ icon: "🔑", label: "User-Permissions geändert" } as never,
  // Lohn-Umbau Phase 1: «Ansicht als» und Gerätefreigabe (Finanzen + Löhne)
  "view_as.started":         { icon: "👁", label: "Ansicht als gestartet" } as never,
  "view_as.stopped":         { icon: "↩",  label: "Ansicht als beendet" } as never,
  "view_as.write_enabled":   { icon: "✎",  label: "Ansicht als: Bearbeitung an" } as never,
  "view_as.write_disabled":  { icon: "🔒", label: "Ansicht als: Bearbeitung aus" } as never,
  "device.requested":        { icon: "📱", label: "Gerät angefragt" } as never,
  "device.approved":         { icon: "✔",  label: "Gerät freigegeben" } as never,
  "device.rejected":         { icon: "✖",  label: "Geräteanfrage abgelehnt" } as never,
  "device.revoked":          { icon: "🗑", label: "Gerät widerrufen" } as never,
  "device.notfreigabe":      { icon: "⚠",  label: "Gerät per Notweg freigegeben" } as never,
  "lohn.vertretung_changed": { icon: "👥", label: "Vertretung geändert" } as never,
  // Vier Augen bei Rechten (Migration 361)
  "rechte.antrag_gestellt":  { icon: "✉",  label: "Rechte-Antrag gestellt" } as never,
  "rechte.antrag_bestaetigt":{ icon: "✔",  label: "Rechte-Antrag bestätigt" } as never,
  "rechte.antrag_abgelehnt": { icon: "✖",  label: "Rechte-Antrag abgelehnt" } as never,
  "rechte.antrag_notweg":    { icon: "⚠",  label: "Rechte-Antrag per Notweg bestätigt" } as never,
  // Wartungsmodus (Migration 363)
  "wartung.an":              { icon: "🔧", label: "Wartung eingeschaltet" } as never,
  "wartung.aus":             { icon: "✔",  label: "Wartung ausgeschaltet" } as never,
  "wartung.ausnahmen":       { icon: "👥", label: "Wartung: Ausnahmen gesetzt" } as never,
};

export function PermissionAuditLogCard() {
  const supabase = createClient();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("permission_audit_log")
        .select("id, occurred_at, actor_label, action, target_role_slug, target_profile_label, details")
        .order("occurred_at", { ascending: false })
        .limit(100);
      if (error) toast.error(`Protokoll konnte nicht geladen werden: ${error.message}`);
      setEntries((data ?? []) as AuditEntry[]);
      setLoading(false);
    })();
  }, [supabase]);

  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Änderungs-Protokoll</h2>
          <span className="text-[10px] text-muted-foreground">(letzte 100)</span>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Lädt…</p>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-center space-y-1">
            <ShieldAlert className="h-5 w-5 text-muted-foreground/50 mx-auto" />
            <p className="text-xs text-muted-foreground">
              Noch keine Änderungen protokolliert.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {entries.map((e) => {
              const meta = ACTION_LABELS[e.action] ?? { icon: "•", label: e.action };
              // Ohne Ziel (z. B. Wartung) nur das Label, kein «· —».
              const target = e.target_role_slug
                ? `Rolle „${e.target_role_slug}"`
                : e.target_profile_label
                  ? `Benutzer „${e.target_profile_label}"`
                  : null;
              const summary = summarize(e);
              return (
                <div key={e.id} className="py-2 flex items-start gap-3 text-xs">
                  <span className="text-base leading-tight w-5 text-center shrink-0" aria-hidden>
                    {meta.icon as React.ReactNode}
                  </span>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="font-medium">
                      {meta.label}{target ? ` · ${target}` : ""}
                    </p>
                    {summary && (
                      <p className="text-[11px] text-muted-foreground">{summary}</p>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground text-right shrink-0">
                    <p>{new Date(e.occurred_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                    {e.actor_label && <p className="text-muted-foreground/70">von {e.actor_label}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Erzeugt eine Kurz-Beschreibung der konkreten Aenderung aus dem
 *  details-Payload — was hat sich konkret geaendert? */
function summarize(e: AuditEntry): string | null {
  const d = e.details ?? {};
  if (e.action === "user.role_changed") {
    const from = (d as { from?: string }).from;
    const to = (d as { to?: string }).to;
    return `${from ?? "—"} → ${to ?? "—"}`;
  }
  if (e.action === "role.created") {
    const perms = (d as { permissions?: string[] }).permissions ?? [];
    return `${perms.length} Permission${perms.length === 1 ? "" : "s"} initial vergeben`;
  }
  if (e.action === "role.updated") {
    const changes = (d as { changes?: Record<string, unknown> }).changes ?? {};
    const fields = Object.keys(changes);
    if (fields.includes("permissions")) {
      const before = ((d as { before?: { permissions?: string[] } }).before?.permissions) ?? [];
      const after = (changes.permissions as string[]) ?? [];
      const added = after.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !after.includes(p));
      const parts: string[] = [];
      if (added.length) parts.push(`+${added.length} (${added.slice(0, 3).join(", ")}${added.length > 3 ? "…" : ""})`);
      if (removed.length) parts.push(`-${removed.length} (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? "…" : ""})`);
      return parts.length ? parts.join("  ") : "keine Permission-Änderung";
    }
    return fields.length ? `${fields.join(", ")} geändert` : null;
  }
  if (e.action.startsWith("device.")) {
    const { geraet, grund, als } = d as { geraet?: string | null; grund?: string | null; als?: string | null };
    const parts: string[] = [];
    if (geraet) parts.push(`Gerät «${geraet}»`);
    if (als === "vertretung") parts.push("als Vertretung");
    if (grund) parts.push(`Grund: ${grund}`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (e.action.startsWith("rechte.")) {
    const { beschreibung, grund, beantragt_von } = d as { beschreibung?: string | null; grund?: string | null; beantragt_von?: string | null };
    const parts: string[] = [];
    if (beschreibung) parts.push(beschreibung);
    if (beantragt_von) parts.push(`beantragt von ${beantragt_von}`);
    if (grund) parts.push(`Grund: ${grund}`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (e.action.startsWith("wartung.")) {
    const { bereiche, aktiv, grund, personen } = d as { bereiche?: string[]; aktiv?: string[]; grund?: string | null; personen?: string[] };
    const name = (b: string) => (istWartungBereich(b) ? WARTUNG_BEREICH_INFO[b].label : b);
    if (e.action === "wartung.ausnahmen") return personen?.length ? personen.join(", ") : "keine Ausnahmen";
    const parts: string[] = [];
    if (bereiche?.length) parts.push(bereiche.map(name).join(", "));
    if (aktiv) parts.push(aktiv.length ? `in Wartung: ${aktiv.map(name).join(", ")}` : "nichts mehr in Wartung");
    if (grund) parts.push(`Grund: ${grund}`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (e.action === "lohn.vertretung_changed") {
    const vertretung = (d as { vertretung?: string | null }).vertretung;
    return vertretung ? `neu: ${vertretung}` : "keine Vertretung mehr";
  }
  if (e.action === "role.deleted") {
    const before = (d as { before?: { permissions?: string[] } }).before;
    const count = before?.permissions?.length ?? 0;
    return count ? `hatte ${count} Permission${count === 1 ? "" : "s"}` : null;
  }
  return null;
}
