"use client";

/**
 * Admin-Sicht: alle vertrauten Geraete aller User. Wird in Einstellungen
 * → Integrationen gerendert. Admin kann jedes Geraet revoken (Security-
 * Audit-Pfad: wenn jemand seine Devices nicht selber aufraeumt).
 *
 * Datenquelle: /api/trust/devices?all=true (Admin-only Endpoint).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, CheckCircle2, Clock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/use-confirm";

interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  user_agent_hint: string | null;
  status: "pending" | "approved" | "revoked";
  requested_at: string;
  approved_at: string | null;
  last_seen_at: string;
  expires_at: string;
  profiles: { full_name: string; email: string } | null;
}

export function AlleVertrauteGeraeteCard() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { confirm, ConfirmModalElement } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/trust/devices?all=true");
    const json = await res.json();
    if (res.ok && json.success) setDevices(json.devices as DeviceRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRevoke(d: DeviceRow) {
    const owner = d.profiles?.full_name ?? "Unbekannt";
    const ok = await confirm({
      title: `Geräte "${d.device_name}" von ${owner} entfernen?`,
      message: "Dieses Gerät verliert sofort den Zugriff auf Finanzen + Löhne. Der User kann ein neues vertrauen wenn er den Mail-Flow durchläuft.",
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/trust/devices?id=${d.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Entfernen fehlgeschlagen");
      return;
    }
    toast.success("Gerät entfernt");
    load();
  }

  // Pro User gruppieren — bessere Lesbarkeit als flache Liste.
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; email: string; devices: DeviceRow[] }>();
    for (const d of devices) {
      const key = d.user_id;
      if (!map.has(key)) {
        map.set(key, {
          name: d.profiles?.full_name ?? "Unbekannt",
          email: d.profiles?.email ?? "—",
          devices: [],
        });
      }
      map.get(key)!.devices.push(d);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [devices]);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Vertraute Geräte — alle User
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Alle Geräte aller Mitarbeiter mit Zugriff auf Finanzen + Löhne. Bei Verdacht oder Geräte-Wechsel kannst du hier auch fremde Geräte revoken.
        </p>
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lade…</p>
        ) : grouped.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Keine Geräte registriert.</p>
        ) : (
          <div className="space-y-3">
            {grouped.map((g) => (
              <div key={g.name} className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-muted/40 border-b">
                  <p className="text-xs font-semibold">{g.name}</p>
                  <p className="text-[10px] text-muted-foreground">{g.email}</p>
                </div>
                <ul className="divide-y">
                  {g.devices.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{d.device_name}</span>
                          {d.status === "approved" ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              Aktiv
                            </span>
                          ) : d.status === "pending" ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                              <Clock className="h-2.5 w-2.5" />
                              Wartet
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{d.user_agent_hint ?? "—"}</div>
                        <div className="text-[11px] text-muted-foreground">
                          Zuletzt gesehen: {new Date(d.last_seen_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevoke(d)}
                        className="p-1.5 rounded hover:bg-foreground/10 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                        data-tooltip="Gerät entfernen"
                        data-tooltip-align="end"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {ConfirmModalElement}
    </Card>
  );
}
