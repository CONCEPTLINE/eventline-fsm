"use client";

/**
 * Aktivitaets-Tab in /einstellungen — admin-only Uebersicht wann welcher
 * Mitarbeiter in der App war.
 *
 * Datenquelle: public.user_sessions (Migration 081). RLS gibt nur Admins
 * lesenden Zugriff via has_permission('admin:activity').
 *
 * Anzeige: pro User eine Zeile mit
 *   - Name
 *   - "Letzte Aktivitaet": relativer Timestamp (vor 5 min / vor 2 Std / etc.)
 *   - Aktiv-Indikator (gruener Punkt) wenn last_seen_at < 10 min alt
 *   - Sessions-Count + Total-Stunden in den letzten 30 Tagen
 *   - Click → Detail-Modal mit Session-Liste (Datum, Dauer, End-Grund)
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Loading } from "@/components/ui/spinner";
import { Modal } from "@/components/ui/modal";
import { Activity, Clock, LogOut, Hourglass, Calendar } from "lucide-react";
import { TOAST } from "@/lib/messages";

interface UserSession {
  id: string;
  user_id: string;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  end_reason: "logout" | "inactive" | "expired" | null;
}

interface UserStats {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  lastSeen: Date | null;
  sessionCount: number;
  totalMinutes: number;
  isOnline: boolean;
}

const ONLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min — synchron mit heartbeat-Logik
const RETENTION_DAYS = 30;

function formatRelativeTime(date: Date | null): string {
  if (!date) return "noch nie";
  const ms = Date.now() - date.getTime();
  if (ms < 60_000) return "gerade aktiv";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `vor ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
  return date.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1min";
  if (minutes < 60) return `${Math.round(minutes)}min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function endReasonLabel(reason: UserSession["end_reason"]): string {
  if (!reason) return "Aktiv";
  if (reason === "logout") return "Abmeldung";
  if (reason === "inactive") return "Inaktivität";
  if (reason === "expired") return "Abgelaufen";
  return reason;
}

function endReasonColor(reason: UserSession["end_reason"]): string {
  if (!reason) return "text-green-600 dark:text-green-400";
  if (reason === "logout") return "text-muted-foreground";
  if (reason === "inactive") return "text-amber-600 dark:text-amber-400";
  if (reason === "expired") return "text-muted-foreground";
  return "text-muted-foreground";
}

interface AktivitaetTabProps {
  /** "firma" = alle Profile ausser partner, "partner" = nur partner,
      "all" = beide. Default "all" seit Flach-Rebuild — die Trennung
      passiert jetzt via Segment-Toggle in der Page, nicht mehr via
      separaten Tab pro Portal. */
  scope?: "firma" | "partner" | "all";
}

export function AktivitaetTab({ scope = "all" }: AktivitaetTabProps = {}) {
  const supabase = createClient();
  const [users, setUsers] = useState<UserStats[]>([]);
  const [allSessions, setAllSessions] = useState<UserSession[]>([]);
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // scope=firma → alle ausser partner; scope=partner → nur partner;
    // scope=all → keine Filterung (Default seit dem Flach-Rebuild von
    // /einstellungen — Firma/Partner-Toggle sitzt jetzt in der Page).
    let profilesQuery = supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active");
    if (scope === "partner") {
      profilesQuery = profilesQuery.eq("role", "partner");
    } else if (scope === "firma") {
      profilesQuery = profilesQuery.neq("role", "partner").neq("role", "lieferant");
    }
    // Rollen-Labels aus der Tabelle laden — dann werden custom Rollen
    // (z.B. Vertrieb/Buchhaltung) mit ihrem echten Label angezeigt statt
    // hart auf 'Admin' vs 'Mitarbeiter' zu fallen.
    const [profilesRes, sessionsRes, rolesRes] = await Promise.all([
      profilesQuery.order("full_name", { ascending: true }),
      supabase
        .from("user_sessions")
        .select("id, user_id, started_at, last_seen_at, ended_at, end_reason")
        .gte("started_at", cutoff.toISOString())
        .order("started_at", { ascending: false }),
      supabase.from("roles").select("slug, label"),
    ]);

    if (profilesRes.error) {
      TOAST.supabaseError(profilesRes.error, "Profile konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    if (sessionsRes.error) {
      TOAST.supabaseError(sessionsRes.error, "Sessions konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    // rolesRes.error ist non-fatal — fallback auf Slug-Anzeige unten.
    const labels: Record<string, string> = {};
    for (const r of (rolesRes.data as Array<{ slug: string; label: string }> | null) ?? []) {
      labels[r.slug] = r.label;
    }
    setRoleLabels(labels);

    const sessions = (sessionsRes.data ?? []) as UserSession[];
    setAllSessions(sessions);

    // Stats pro User aggregieren.
    const byUser = new Map<string, UserSession[]>();
    for (const s of sessions) {
      const arr = byUser.get(s.user_id) ?? [];
      arr.push(s);
      byUser.set(s.user_id, arr);
    }

    const now = Date.now();
    const stats: UserStats[] = (profilesRes.data ?? []).map((p) => {
      const userSessions = byUser.get(p.id) ?? [];
      const lastSeenMs = userSessions.reduce((max, s) => {
        const t = new Date(s.last_seen_at).getTime();
        return t > max ? t : max;
      }, 0);
      const lastSeen = lastSeenMs > 0 ? new Date(lastSeenMs) : null;
      const isOnline = lastSeen ? (now - lastSeenMs) < ONLINE_THRESHOLD_MS && userSessions.some((s) => !s.ended_at) : false;
      // Total Minuten: Summe der Session-Dauern (ended_at - started_at,
      // oder last_seen_at - started_at fuer noch laufende). Auto-expirierte
      // Sessions zaehlen nur bis zum letzten Heartbeat.
      const totalMinutes = userSessions.reduce((sum, s) => {
        const start = new Date(s.started_at).getTime();
        const end = s.ended_at ? new Date(s.ended_at).getTime() : new Date(s.last_seen_at).getTime();
        const diff = Math.max(0, end - start);
        return sum + diff / 60_000;
      }, 0);

      return {
        user_id: p.id,
        full_name: p.full_name,
        email: p.email,
        role: p.role,
        is_active: p.is_active,
        lastSeen,
        sessionCount: userSessions.length,
        totalMinutes,
        isOnline,
      };
    });

    // Aktive User zuerst, dann nach lastSeen sortiert (kuerzlich zuletzt aktive vorne).
    stats.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      const aT = a.lastSeen?.getTime() ?? 0;
      const bT = b.lastSeen?.getTime() ?? 0;
      return bT - aT;
    });

    setUsers(stats);
    setLoading(false);
  }, [supabase, scope]);

  useEffect(() => { load(); }, [load]);

  const selected = users.find((u) => u.user_id === selectedUserId) ?? null;
  const selectedSessions = selected
    ? allSessions.filter((s) => s.user_id === selected.user_id).sort((a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      )
    : [];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Wer war wann in der App? Letzte {RETENTION_DAYS} Tage.
          Klick auf einen User für die Session-Historie.
        </p>
      </div>

      {loading ? (
        <Loading />
      ) : users.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Keine User-Daten vorhanden.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <button
              key={u.user_id}
              type="button"
              onClick={() => setSelectedUserId(u.user_id)}
              className="w-full text-left card-hover bg-card border rounded-xl px-4 py-3 transition-colors"
            >
              <div className="grid items-center gap-x-3 gap-y-0.5"
                style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(120px, auto) minmax(80px, auto) minmax(80px, auto)" }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="relative shrink-0">
                    <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white font-bold text-sm">
                      {u.full_name.charAt(0).toUpperCase()}
                    </div>
                    {u.isOnline && (
                      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-card" aria-label="Online" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{u.full_name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {roleLabels[u.role] ?? u.role}
                      {!u.is_active && " · Deaktiviert"}
                    </p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                  <Clock className="inline h-3 w-3 -mt-0.5 mr-1" />
                  {formatRelativeTime(u.lastSeen)}
                </div>
                <div className="text-xs tabular-nums whitespace-nowrap text-right">
                  <span className="font-mono font-semibold">{u.sessionCount}</span>
                  <span className="text-muted-foreground"> Sessions</span>
                </div>
                <div className="text-xs tabular-nums whitespace-nowrap text-right">
                  <span className="font-mono font-semibold">{formatDuration(u.totalMinutes)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Detail-Modal: Session-Liste fuer den ausgewaehlten User */}
      <Modal
        open={selected !== null}
        onClose={() => setSelectedUserId(null)}
        title={selected ? `${selected.full_name} — Session-Historie` : ""}
        icon={<Activity className="h-5 w-5 text-blue-500" />}
        size="lg"
      >
        {selected && (
          <>
            <div className="grid grid-cols-3 gap-3 pb-3 border-b">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Letzte Aktivität</p>
                <p className="font-medium text-sm mt-0.5">{formatRelativeTime(selected.lastSeen)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sessions ({RETENTION_DAYS}T)</p>
                <p className="font-medium text-sm mt-0.5 tabular-nums">{selected.sessionCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gesamt-Zeit</p>
                <p className="font-medium text-sm mt-0.5 tabular-nums">{formatDuration(selected.totalMinutes)}</p>
              </div>
            </div>

            {selectedSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">Keine Sessions in den letzten {RETENTION_DAYS} Tagen.</p>
            ) : (
              <div className="divide-y -mx-2">
                {selectedSessions.map((s) => {
                  const start = new Date(s.started_at);
                  const end = s.ended_at ? new Date(s.ended_at) : new Date(s.last_seen_at);
                  const durationMin = (end.getTime() - start.getTime()) / 60000;
                  return (
                    <div key={s.id} className="px-2 py-2.5 flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0 flex items-center gap-2.5">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="font-mono text-xs tabular-nums">{formatDateTime(s.started_at)}</p>
                          <p className="text-[11px] text-muted-foreground">
                            <Hourglass className="inline h-3 w-3 -mt-0.5 mr-1" />
                            {formatDuration(durationMin)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <LogOut className="h-3 w-3 text-muted-foreground" />
                        <span className={`text-xs font-medium ${endReasonColor(s.end_reason)}`}>
                          {endReasonLabel(s.end_reason)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
