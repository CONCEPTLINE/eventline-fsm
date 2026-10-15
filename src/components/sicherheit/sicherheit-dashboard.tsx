"use client";

// App-Sicherheits-Dashboard (Admin-only). Liest alles client-seitig mit dem
// eingeloggten Admin — RLS/is_admin() auf den Tabellen bzw. Funktionen gated
// den Zugriff. Leere Quellen zeigen einen EmptyState statt eines Fehlers.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTimeFull } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PermissionAuditLogCard } from "@/components/einstellungen/permission-audit-log";
import { ShieldCheck, ShieldAlert, Lock, UserCog, LogIn, FileClock, Globe } from "lucide-react";

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  return isNaN(t.getTime()) ? "—" : formatDateTimeFull(d);
}

type Posture = {
  admins: number;
  devicesApproved: number;
  devicesPending: number;
  sessionsActive: number;
  cspTotal: number;
  csp7d: number;
  signupOpen: boolean | null;
};

type CspRow = {
  id: string;
  occurred_at: string;
  effective_directive: string | null;
  blocked_uri: string | null;
  document_uri: string | null;
  disposition: string | null;
};

type AuthEvent = { id: string; occurred_at: string; action: string | null; actor: string | null; ip: string | null };

type JobChange = {
  id: string;
  zeitpunkt: string;
  person_name: string | null;
  art: string | null;
  felder: Record<string, unknown> | null;
};

const AUTH_LABELS: Record<string, string> = {
  login: "Anmeldung",
  logout: "Abmeldung",
  token_refreshed: "Sitzung erneuert",
  token_revoked: "Sitzung beendet",
  user_signedup: "Registrierung",
  user_modified: "Konto geändert",
  user_recovery_requested: "Passwort-Reset angefragt",
  user_reauthenticate_requested: "Re-Auth angefragt",
  user_confirmation_requested: "Bestätigung angefragt",
  login_failed: "Anmeldung fehlgeschlagen",
};

type Tone = "ok" | "warn" | "bad" | "muted";

function toneClass(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "text-emerald-600 dark:text-emerald-400";
    case "warn":
      return "text-amber-600 dark:text-amber-400";
    case "bad":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-foreground";
  }
}

function Tile({ label, value, tone = "muted", hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`font-semibold text-lg mt-0.5 tabular-nums ${toneClass(tone)}`}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

export function SicherheitDashboard() {
  const supabase = createClient();
  const [posture, setPosture] = useState<Posture | null>(null);
  const [csp, setCsp] = useState<CspRow[]>([]);
  const [authEvents, setAuthEvents] = useState<AuthEvent[]>([]);
  const [jobs, setJobs] = useState<JobChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const settingsUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/auth/v1/settings`;
      const [adminsRes, devRes, sessRes, cspTotalRes, csp7Res, cspListRes, authRes, jobRes, settings] = await Promise.all([
        supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "admin"),
        supabase.from("trusted_devices").select("status"),
        supabase.from("user_sessions").select("*", { count: "exact", head: true }).is("ended_at", null),
        supabase.from("csp_reports").select("*", { count: "exact", head: true }),
        supabase.from("csp_reports").select("*", { count: "exact", head: true }).gte("occurred_at", since),
        supabase
          .from("csp_reports")
          .select("id, occurred_at, effective_directive, blocked_uri, document_uri, disposition")
          .order("occurred_at", { ascending: false })
          .limit(50),
        supabase.rpc("get_auth_events", { p_limit: 100 }),
        supabase
          .from("job_aenderungen")
          .select("id, zeitpunkt, person_name, art, felder")
          .order("zeitpunkt", { ascending: false })
          .limit(50),
        fetch(settingsUrl, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (!active) return;

      const devices = (devRes.data ?? []) as { status: string }[];
      const settingsObj = settings as { disable_signup?: boolean } | null;
      setPosture({
        admins: adminsRes.count ?? 0,
        devicesApproved: devices.filter((d) => d.status === "approved").length,
        devicesPending: devices.filter((d) => d.status === "pending").length,
        sessionsActive: sessRes.count ?? 0,
        cspTotal: cspTotalRes.count ?? 0,
        csp7d: csp7Res.count ?? 0,
        signupOpen: settingsObj ? settingsObj.disable_signup === false : null,
      });
      setCsp((cspListRes.data ?? []) as CspRow[]);
      setAuthEvents((authRes.data ?? []) as AuthEvent[]);
      setJobs((jobRes.data ?? []) as JobChange[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  const signupTone: Tone = posture?.signupOpen === false ? "ok" : posture?.signupOpen === true ? "bad" : "muted";
  const signupValue = posture?.signupOpen === false ? "Gesperrt" : posture?.signupOpen === true ? "Offen" : "—";

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto page-enter">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold leading-tight">Sicherheit</h1>
          <p className="text-sm text-muted-foreground">Status, CSP-Verstösse und Protokolle der App.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Content-Security-Policy" value="Scharf" tone="ok" hint="enforcing" />
        <Tile label="Sicherheits-Header" value="Aktiv" tone="ok" hint="HSTS · X-Frame · nosniff" />
        <Tile label="Registrierung" value={signupValue} tone={signupTone} hint="Selbst-Signup" />
        <Tile
          label="CSP-Verstösse (7 Tage)"
          value={posture ? String(posture.csp7d) : "…"}
          tone={posture && posture.csp7d > 0 ? "warn" : "ok"}
          hint={posture ? `${posture.cspTotal} gesamt` : undefined}
        />
        <Tile label="Admins" value={posture ? String(posture.admins) : "…"} hint="mit Vollzugriff" />
        <Tile
          label="Vertraute Geräte"
          value={posture ? String(posture.devicesApproved) : "…"}
          tone={posture && posture.devicesPending > 0 ? "warn" : "muted"}
          hint={posture ? `${posture.devicesPending} offen` : undefined}
        />
        <Tile label="Aktive Sitzungen" value={posture ? String(posture.sessionsActive) : "…"} hint="gerade online" />
      </div>

      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">CSP-Verstösse</h2>
            <span className="text-[10px] text-muted-foreground">(blockierte Ressourcen, letzte 50)</span>
          </div>
          {loading ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Lädt…</p>
          ) : csp.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Keine CSP-Verstösse" description="Der Browser hat nichts blockiert — der CSP passt zur App." />
          ) : (
            <div className="divide-y divide-border max-h-96 overflow-y-auto">
              {csp.map((r) => (
                <div key={r.id} className="py-2 flex items-start gap-3 text-xs">
                  <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="font-medium truncate">
                      {r.effective_directive ?? "—"}
                      {r.disposition ? <span className="text-muted-foreground font-normal"> · {r.disposition}</span> : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate" title={r.blocked_uri ?? ""}>
                      blockiert: {r.blocked_uri ?? "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 truncate" title={r.document_uri ?? ""}>
                      auf: {r.document_uri ?? "—"}
                    </p>
                  </div>
                  <p className="text-[10px] text-muted-foreground text-right shrink-0">{fmt(r.occurred_at)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="bg-card">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <LogIn className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Login-Protokoll</h2>
              <span className="text-[10px] text-muted-foreground">(Supabase Auth)</span>
            </div>
            {loading ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Lädt…</p>
            ) : authEvents.length === 0 ? (
              <EmptyState icon={LogIn} title="Kein Login-Protokoll" description="Noch keine Auth-Ereignisse sichtbar." />
            ) : (
              <div className="divide-y divide-border max-h-96 overflow-y-auto">
                {authEvents.map((e) => {
                  const failed = e.action === "login_failed";
                  const label = (e.action ? AUTH_LABELS[e.action] : undefined) ?? e.action ?? "Ereignis";
                  return (
                    <div key={e.id} className="py-2 flex items-start gap-3 text-xs">
                      {failed ? (
                        <ShieldAlert className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                      ) : (
                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <p className={`font-medium truncate ${failed ? "text-red-600 dark:text-red-400" : ""}`}>{label}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {e.actor ?? "—"}
                          {e.ip ? <span className="text-muted-foreground/70"> · {e.ip}</span> : null}
                        </p>
                      </div>
                      <p className="text-[10px] text-muted-foreground text-right shrink-0">{fmt(e.occurred_at)}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <PermissionAuditLogCard />
      </div>

      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Auftrags-Änderungen</h2>
            <span className="text-[10px] text-muted-foreground">(Stammdaten-Historie, letzte 50)</span>
          </div>
          {loading ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Lädt…</p>
          ) : jobs.length === 0 ? (
            <EmptyState icon={FileClock} title="Keine Änderungen" description="Noch keine Auftrags-Änderungen protokolliert." />
          ) : (
            <div className="divide-y divide-border max-h-96 overflow-y-auto">
              {jobs.map((j) => {
                const felder = j.felder ? Object.keys(j.felder) : [];
                const rueck = j.art === "rueckgaengig";
                return (
                  <div key={j.id} className="py-2 flex items-start gap-3 text-xs">
                    <UserCog className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <p className="font-medium truncate">
                        {rueck ? "Rückgängig" : "Änderung"}
                        {felder.length ? (
                          <span className="text-muted-foreground font-normal">
                            {" · "}
                            {felder.slice(0, 4).join(", ")}
                            {felder.length > 4 ? "…" : ""}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">{j.person_name ?? "—"}</p>
                    </div>
                    <p className="text-[10px] text-muted-foreground text-right shrink-0">{fmt(j.zeitpunkt)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Zeiten in Europe/Zürich. Diese Seite ist Admins vorbehalten; die Daten sind per RLS geschützt.
      </p>
    </div>
  );
}
