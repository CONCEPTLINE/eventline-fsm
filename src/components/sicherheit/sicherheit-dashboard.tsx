"use client";

// App-Sicherheits-Dashboard (Admin-only). Liest alles client-seitig mit dem
// eingeloggten Admin — RLS/is_admin() auf den Tabellen gated den Zugriff.
// Die Kacheln sind LIVE: CSP/Header werden aus den echten Response-Headern
// geprueft (zeigen rot, wenn der Schutz wegbricht), "Jetzt online" zaehlt nur
// Sitzungen mit frischem Heartbeat (nicht "nie beendet"). Leere Quellen zeigen
// einen EmptyState statt eines Fehlers.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTimeFull } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PermissionAuditLogCard } from "@/components/einstellungen/permission-audit-log";
import { SicherheitsCheckCard } from "@/components/sicherheit/check-card";
import { ShieldCheck, ShieldAlert, Lock, UserCog, LogIn, FileClock, Globe } from "lucide-react";

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  return isNaN(t.getTime()) ? "—" : formatDateTimeFull(d);
}

function deviceHint(ua: string | null): string {
  if (!ua) return "";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iOS/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  const br = /Edg/.test(ua)
    ? "Edge"
    : /Chrome/.test(ua)
      ? "Chrome"
      : /Firefox/.test(ua)
        ? "Firefox"
        : /Safari/.test(ua)
          ? "Safari"
          : "";
  return [br, os].filter(Boolean).join(" · ");
}

const END_REASONS: Record<string, string> = {
  logout: "abgemeldet",
  inactive: "inaktiv",
  expired: "abgelaufen",
};

type CspHeaderState = "scharf" | "basis" | "fehlt" | "unbekannt";

type HeaderInfo = { cspHeader: CspHeaderState; headerCount: number; headerTotal: number };

type Posture = {
  admins: number;
  devicesApproved: number;
  devicesPending: number;
  onlineNow: number;
  openSessions: number;
  staleSessions: number;
  cspTotal: number;
  csp7d: number;
  signupOpen: boolean | null;
  header: HeaderInfo;
};

type CspRow = {
  id: string;
  occurred_at: string;
  effective_directive: string | null;
  blocked_uri: string | null;
  document_uri: string | null;
  disposition: string | null;
};

type Session = {
  id: string;
  user_id: string;
  started_at: string;
  last_seen_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  user_agent: string | null;
  name: string;
};

type JobChange = {
  id: string;
  zeitpunkt: string;
  person_name: string | null;
  art: string | null;
  felder: Record<string, unknown> | null;
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

// Liest die echten Sicherheits-Response-Header der laufenden App (same-origin,
// darum vollstaendig lesbar). So prueft die Kachel die Realitaet statt einer
// hartcodierten Annahme.
async function checkHeaders(): Promise<HeaderInfo> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    const csp = res.headers.get("content-security-policy") ?? "";
    const core = ["x-frame-options", "x-content-type-options", "referrer-policy", "content-security-policy"];
    const headerCount = core.filter((h) => (res.headers.get(h) ?? "").length > 0).length;
    const cspHeader: CspHeaderState = csp.includes("default-src") ? "scharf" : csp.length > 0 ? "basis" : "fehlt";
    return { cspHeader, headerCount, headerTotal: core.length };
  } catch {
    return { cspHeader: "unbekannt", headerCount: 0, headerTotal: 4 };
  }
}

export function SicherheitDashboard() {
  const supabase = createClient();
  const [posture, setPosture] = useState<Posture | null>(null);
  const [csp, setCsp] = useState<CspRow[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [jobs, setJobs] = useState<JobChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const now = Date.now();
      const t7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const t15 = new Date(now - 15 * 60 * 1000).toISOString();
      const t24 = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const settingsUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/auth/v1/settings`;

      const [
        adminsRes,
        devRes,
        onlineRes,
        openRes,
        staleRes,
        cspTotalRes,
        csp7Res,
        cspListRes,
        sessListRes,
        profRes,
        jobRes,
        settings,
        header,
      ] = await Promise.all([
        supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "admin"),
        supabase.from("trusted_devices").select("status"),
        supabase.from("user_sessions").select("*", { count: "exact", head: true }).is("ended_at", null).gte("last_seen_at", t15),
        supabase.from("user_sessions").select("*", { count: "exact", head: true }).is("ended_at", null),
        supabase.from("user_sessions").select("*", { count: "exact", head: true }).is("ended_at", null).lt("last_seen_at", t24),
        supabase.from("csp_reports").select("*", { count: "exact", head: true }),
        supabase.from("csp_reports").select("*", { count: "exact", head: true }).gte("occurred_at", t7),
        supabase
          .from("csp_reports")
          .select("id, occurred_at, effective_directive, blocked_uri, document_uri, disposition")
          .order("occurred_at", { ascending: false })
          .limit(50),
        supabase
          .from("user_sessions")
          .select("id, user_id, started_at, last_seen_at, ended_at, end_reason, user_agent")
          .order("started_at", { ascending: false })
          .limit(50),
        supabase.from("profiles").select("id, full_name"),
        supabase
          .from("job_aenderungen")
          .select("id, zeitpunkt, person_name, art, felder")
          .order("zeitpunkt", { ascending: false })
          .limit(50),
        fetch(settingsUrl, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        checkHeaders(),
      ]);

      if (!active) return;

      const devices = (devRes.data ?? []) as { status: string }[];
      const settingsObj = settings as { disable_signup?: boolean } | null;
      setPosture({
        admins: adminsRes.count ?? 0,
        devicesApproved: devices.filter((d) => d.status === "approved").length,
        devicesPending: devices.filter((d) => d.status === "pending").length,
        onlineNow: onlineRes.count ?? 0,
        openSessions: openRes.count ?? 0,
        staleSessions: staleRes.count ?? 0,
        cspTotal: cspTotalRes.count ?? 0,
        csp7d: csp7Res.count ?? 0,
        signupOpen: settingsObj ? settingsObj.disable_signup === false : null,
        header,
      });
      setCsp((cspListRes.data ?? []) as CspRow[]);

      const profiles = (profRes.data ?? []) as { id: string; full_name: string | null }[];
      const nameMap = new Map(profiles.map((p) => [p.id, p.full_name ?? "—"]));
      const sessRows = (sessListRes.data ?? []) as Omit<Session, "name">[];
      setSessions(sessRows.map((s) => ({ ...s, name: nameMap.get(s.user_id) ?? "—" })));

      setJobs((jobRes.data ?? []) as JobChange[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  // CSP-Kachel (live aus dem echten Header)
  const cspState = posture?.header.cspHeader;
  const cspValue =
    cspState === "scharf" ? "Scharf" : cspState === "basis" ? "Nur Basis" : cspState === "fehlt" ? "Fehlt!" : "—";
  const cspTileTone: Tone = cspState === "scharf" ? "ok" : cspState === "basis" ? "warn" : cspState === "fehlt" ? "bad" : "muted";

  // Header-Kachel (live: wie viele der gesetzten Schutz-Header kommen an)
  const hc = posture?.header.headerCount ?? 0;
  const ht = posture?.header.headerTotal ?? 4;
  const headerTone: Tone = !posture ? "muted" : hc >= ht ? "ok" : hc >= ht - 1 ? "warn" : "bad";

  const signupTone: Tone = posture?.signupOpen === false ? "ok" : posture?.signupOpen === true ? "bad" : "muted";
  const signupValue = posture?.signupOpen === false ? "Gesperrt" : posture?.signupOpen === true ? "Offen" : "—";

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto page-enter">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold leading-tight">Sicherheit</h1>
          <p className="text-sm text-muted-foreground">Live-Status, CSP-Verstösse und Protokolle der App.</p>
        </div>
      </div>

      <SicherheitsCheckCard />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Content-Security-Policy" value={posture ? cspValue : "…"} tone={cspTileTone} hint="live aus dem Header" />
        <Tile
          label="Sicherheits-Header"
          value={posture ? `${hc}/${ht}` : "…"}
          tone={headerTone}
          hint="X-Frame · nosniff · Referrer · CSP"
        />
        <Tile label="Registrierung" value={signupValue} tone={signupTone} hint="Selbst-Signup" />
        <Tile
          label="CSP-Verstösse (7 Tage)"
          value={posture ? String(posture.csp7d) : "…"}
          tone={posture && posture.csp7d > 0 ? "warn" : "ok"}
          hint={posture ? `${posture.cspTotal} gesamt` : undefined}
        />
        <Tile
          label="Jetzt online"
          value={posture ? String(posture.onlineNow) : "…"}
          hint={posture ? `${posture.openSessions} offen · ${posture.staleSessions} alt (>24h)` : undefined}
        />
        <Tile
          label="Geräte-Freigaben offen"
          value={posture ? String(posture.devicesPending) : "…"}
          tone={posture && posture.devicesPending > 0 ? "warn" : "ok"}
          hint={posture ? `${posture.devicesApproved} freigegeben` : undefined}
        />
        <Tile label="Admins" value={posture ? String(posture.admins) : "…"} hint="mit Vollzugriff" />
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
              <h2 className="text-sm font-semibold">Anmeldungen</h2>
              <span className="text-[10px] text-muted-foreground">(Sitzungen, letzte 50)</span>
            </div>
            {loading ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Lädt…</p>
            ) : sessions.length === 0 ? (
              <EmptyState icon={LogIn} title="Keine Anmeldungen" description="Noch keine Sitzungen protokolliert." />
            ) : (
              <div className="divide-y divide-border max-h-96 overflow-y-auto">
                {sessions.map((s) => {
                  const aktiv = !s.ended_at;
                  const dev = deviceHint(s.user_agent);
                  return (
                    <div key={s.id} className="py-2 flex items-start gap-3 text-xs">
                      <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <p className="font-medium truncate">
                          {s.name}
                          {dev ? <span className="text-muted-foreground font-normal"> · {dev}</span> : null}
                        </p>
                        <p className={`text-[11px] ${aktiv ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                          {aktiv ? "aktiv" : `beendet${s.end_reason ? ` · ${END_REASONS[s.end_reason] ?? s.end_reason}` : ""}`}
                        </p>
                      </div>
                      <p className="text-[10px] text-muted-foreground text-right shrink-0">{fmt(s.started_at)}</p>
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
