// Automatischer Sicherheits-Check ("Einbruchmelder" in der ehrlichen Form):
// deterministische Pruefungen, die taeglich (Cron) oder auf Knopfdruck (Admin)
// laufen. Schreibt einen security_runs-Lauf + security_findings. Die lokale KI
// haengt spaeter das Klartext-Feld narrative an (siehe docs/sicherheit).
//
// Grundsatz wie bei der lokalen KI: ERKENNEN deterministisch (hier), FORMULIEREN
// die KI. Geprueft wird nur rein LESEND (anon-GET auf Tabellen, anon-RPC nur auf
// get_/list_-Funktionen) — niemals mutierende Funktionen aufrufen.

import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";

const APP_URL = "https://eventline-fsm-usyk.vercel.app";

type Severity = "critical" | "warn" | "info";
type Finding = { severity: Severity; category: string; title: string; detail: Record<string, unknown> };

const ROLLEN_LABELS: Record<string, string> = {
  "role.created": "Rolle angelegt",
  "role.updated": "Rolle bearbeitet",
  "role.deleted": "Rolle gelöscht",
  "user.role_changed": "User-Rolle gewechselt",
  "user.permissions_changed": "User-Rechte geändert",
};

function anonHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** Gesamtzahl aus dem Content-Range-Header ("0-0/13" -> 13, sonst 0). */
function rangeTotal(h: string | null): number {
  if (!h) return 0;
  const m = h.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

export async function runSecurityAudit(source: "cron" | "manuell"): Promise<{ runId: string | null; critical: number; warnings: number }> {
  const admin = createAdminClient();
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const findings: Finding[] = [];
  let checks = 0;

  const { data: runRow, error: runErr } = await admin.from("security_runs").insert({ source }).select("id").single();
  if (runErr || !runRow) {
    logError("security-audit.run-insert", runErr);
    return { runId: null, critical: 0, warnings: 0 };
  }
  const runId = (runRow as { id: string }).id;

  // 1) ANON-LESEZUGRIFF: jede public-Tabelle/View mit dem anon-Key testen.
  try {
    const { data: tables } = await admin.rpc("list_public_tables");
    const list = (tables ?? []) as { name: string; kind: string }[];
    await Promise.all(
      list.map(async (t) => {
        try {
          const res = await fetch(`${url}/rest/v1/${encodeURIComponent(t.name)}?select=*&limit=1`, {
            headers: { ...anonHeaders(anonKey), Prefer: "count=exact" },
            cache: "no-store",
          });
          const total = rangeTotal(res.headers.get("content-range"));
          if ((res.status === 200 || res.status === 206) && total > 0) {
            findings.push({
              severity: "critical",
              category: "anon-read",
              title: `${t.kind === "VIEW" ? "View" : "Tabelle"} „${t.name}" ist ohne Login lesbar`,
              detail: { name: t.name, kind: t.kind, anon_rows: total },
            });
          }
        } catch {
          /* einzelne Tabelle still ueberspringen */
        }
      }),
    );
    checks += list.length;
  } catch (e) {
    logError("security-audit.tables", e);
  }

  // 2) ANON-AUSFUEHRBARE get_/list_-Funktionen: mit anon aufrufen (rein lesend),
  //    flaggen wenn Datenzeilen zurueckkommen (= Leck wie frueher get_assignable_users).
  try {
    const { data: fns } = await admin.rpc("list_anon_definer_functions");
    const candidates = ((fns ?? []) as { name: string }[]).filter((f) => /^(get|list)_/.test(f.name));
    await Promise.all(
      candidates.map(async (f) => {
        try {
          const res = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(f.name)}`, {
            method: "POST",
            headers: anonHeaders(anonKey),
            body: "{}",
            cache: "no-store",
          });
          if (!res.ok) return;
          const body: unknown = await res.json();
          if (Array.isArray(body) && body.length > 0 && typeof body[0] === "object") {
            findings.push({
              severity: "critical",
              category: "anon-exec",
              title: `Funktion „${f.name}" gibt Daten ohne Login preis`,
              detail: { name: f.name, anon_rows: body.length },
            });
          }
        } catch {
          /* still */
        }
      }),
    );
    checks += candidates.length;
  } catch (e) {
    logError("security-audit.functions", e);
  }

  // 3) SICHERHEITS-HEADER der Live-App.
  try {
    const res = await fetch(`${APP_URL}/api/version`, { cache: "no-store" });
    const needed = ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy"];
    const missing = needed.filter((h) => !(res.headers.get(h) ?? "").length);
    if (missing.length) {
      findings.push({ severity: "warn", category: "headers", title: `Sicherheits-Header fehlen: ${missing.join(", ")}`, detail: { missing } });
    } else if (!(res.headers.get("content-security-policy") ?? "").includes("default-src")) {
      findings.push({ severity: "warn", category: "headers", title: "CSP ist nicht scharf (kein default-src)", detail: {} });
    }
    checks += 1;
  } catch (e) {
    logError("security-audit.headers", e);
  }

  // 4) REGISTRIERUNG offen?
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey }, cache: "no-store" });
    if (res.ok) {
      const s = (await res.json()) as { disable_signup?: boolean };
      if (s.disable_signup === false) {
        findings.push({ severity: "warn", category: "signup", title: "Registrierung ist offen (Selbst-Signup aktiv)", detail: {} });
      }
    }
    checks += 1;
  } catch (e) {
    logError("security-audit.signup", e);
  }

  // 5) RECHTE-/ROLLEN-AENDERUNGEN seit dem letzten Lauf (Auffaelligkeit).
  try {
    const { data: prev } = await admin
      .from("security_runs")
      .select("started_at")
      .neq("id", runId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const since = (prev as { started_at: string } | null)?.started_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: changes } = await admin
      .from("permission_audit_log")
      .select("action, target_role_slug, target_profile_label, actor_label, occurred_at, details")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(50);
    for (const c of (changes ?? []) as {
      action: string;
      target_role_slug: string | null;
      target_profile_label: string | null;
      actor_label: string | null;
      occurred_at: string;
      details: Record<string, unknown> | null;
    }[]) {
      const wurdeAdmin = c.action === "user.role_changed" && (c.details as { to?: string } | null)?.to === "admin";
      const ziel = c.target_role_slug ? `Rolle „${c.target_role_slug}"` : c.target_profile_label ? `„${c.target_profile_label}"` : "";
      findings.push({
        severity: wurdeAdmin ? "warn" : "info",
        category: "rollen",
        title: `${ROLLEN_LABELS[c.action] ?? c.action}${ziel ? ` · ${ziel}` : ""}${wurdeAdmin ? " → ADMIN" : ""}`,
        detail: { ...c },
      });
    }
    checks += 1;
  } catch (e) {
    logError("security-audit.rollen", e);
  }

  // Befunde schreiben + Lauf abschliessen.
  if (findings.length) {
    const { error } = await admin.from("security_findings").insert(findings.map((f) => ({ ...f, run_id: runId })));
    if (error) logError("security-audit.findings-insert", error);
  }
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  await admin
    .from("security_runs")
    .update({ finished_at: new Date().toISOString(), ok: critical === 0 && warnings === 0, critical, warnings, checks })
    .eq("id", runId);

  return { runId, critical, warnings };
}
