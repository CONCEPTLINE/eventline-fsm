// POST /api/admin/users/[id]/dossier — komplettes Datenpaket fuer einen
// Mitarbeiter generieren.
//
// Sammelt alle Daten die der User produziert / haette / besitzt + bundelt
// sie als ZIP in den personal-dossiers-Bucket. Returnt eine signed URL
// (1 Stunde gueltig) damit der Admin runterladen kann.
//
// Inhalt:
//   profile.json              — Stammdaten
//   compensation.json         — Lohn-Historie alle Zeilen
//   jobs.json                 — alle Jobs wo User created_by oder project_lead
//   assignments.json          — job_assignments-Eintraege
//   appointments.json         — job_appointments mit assigned_to=user
//   time_entries.json         — alle Stempel
//   service_reports.json      — alle Rapporte
//   notifications.json        — letzte ~1000 Benachrichtigungen
//   wage_documents/           — Lohnabrechnungen + Lohnausweise als PDFs
//   uploaded_documents/       — Dateien die der User hochgeladen hat
//   README.txt                — Beschreibung des Pakets + Generierungsdatum
//
// Admin-only.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import JSZip from "jszip";

const DOSSIER_BUCKET = "personal-dossiers";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { id: profileId } = await params;

  const admin = createAdminClient();

  // 1. Stammdaten
  const { data: profile } = await admin.from("profiles").select("*").eq("id", profileId).maybeSingle();
  if (!profile) return NextResponse.json({ success: false, error: "Mitarbeiter nicht gefunden" }, { status: 404 });

  // 2. Compensation-Historie
  const { data: comp } = await admin
    .from("employee_compensation")
    .select("*")
    .eq("profile_id", profileId)
    .order("effective_from", { ascending: false });

  // 3. Jobs (created_by ODER project_lead_id)
  const { data: jobsCreated } = await admin
    .from("jobs")
    .select("id, job_number, title, status, start_date, end_date, created_at, created_by, project_lead_id")
    .or(`created_by.eq.${profileId},project_lead_id.eq.${profileId}`);

  // 4. Job-Assignments
  const { data: assignments } = await admin
    .from("job_assignments")
    .select("*")
    .eq("profile_id", profileId);

  // 5. Job-Appointments (zugewiesen)
  const { data: appts } = await admin
    .from("job_appointments")
    .select("*")
    .eq("assigned_to", profileId);

  // 6. Time-Entries (alle Stempel)
  const { data: stempel } = await admin
    .from("time_entries")
    .select("*")
    .eq("user_id", profileId)
    .order("clock_in", { ascending: false });

  // 7. Service-Reports
  const { data: reports } = await admin
    .from("service_reports")
    .select("*")
    .eq("created_by", profileId)
    .order("created_at", { ascending: false });

  // 8. Notifications (last 1000)
  const { data: notifs } = await admin
    .from("notifications")
    .select("*")
    .eq("user_id", profileId)
    .order("created_at", { ascending: false })
    .limit(1000);

  // 9. Wage-Documents Metadata + Files
  const { data: wageDocs } = await admin
    .from("wage_documents")
    .select("*")
    .eq("profile_id", profileId);

  // 10. Hochgeladene Documents (documents.uploaded_by)
  const { data: uploadedDocs } = await admin
    .from("documents")
    .select("*")
    .eq("uploaded_by", profileId);

  // ZIP bauen
  const zip = new JSZip();

  zip.file("README.txt",
    `Personal-Dossier fuer ${profile.full_name} (${profile.email ?? "—"})\n` +
    `Profile-ID: ${profileId}\n` +
    `Generiert am: ${new Date().toISOString()}\n` +
    `Generiert von: ${auth.user.id}\n\n` +
    `\n→ Zum bequemen Ansehen: index.html im Browser oeffnen (Doppelklick)\n\n` +
    `Inhalt:\n` +
    `  index.html — uebersichtliche Tabellen-Ansicht aller Daten\n` +
    `  profile.json — Stammdaten\n` +
    `  compensation.json — Lohn-Historie (${comp?.length ?? 0} Zeilen)\n` +
    `  jobs.json — Jobs als created_by/project_lead (${jobsCreated?.length ?? 0})\n` +
    `  assignments.json — Job-Zuweisungen (${assignments?.length ?? 0})\n` +
    `  appointments.json — Termin-Zuweisungen (${appts?.length ?? 0})\n` +
    `  time_entries.json — Stempel-Eintraege (${stempel?.length ?? 0})\n` +
    `  service_reports.json — Rapporte (${reports?.length ?? 0})\n` +
    `  notifications.json — Benachrichtigungen (${notifs?.length ?? 0})\n` +
    `  wage_documents/ — Lohnabrechnungen + Lohnausweise PDFs (${wageDocs?.length ?? 0})\n` +
    `  uploaded_documents/ — Hochgeladene Dateien (${uploadedDocs?.length ?? 0})\n`
  );

  // HTML-Index zum bequemen Ansehen — User oeffnet index.html im Browser
  // und sieht alles als lesbare Tabellen. Self-contained (inline CSS),
  // PDF-Links relativ zum Folder.
  zip.file("index.html", buildHtmlIndex({
    profile,
    comp: comp ?? [],
    jobs: jobsCreated ?? [],
    assignments: assignments ?? [],
    appointments: appts ?? [],
    stempel: stempel ?? [],
    reports: reports ?? [],
    notifs: notifs ?? [],
    wageDocs: wageDocs ?? [],
    uploadedDocs: uploadedDocs ?? [],
    generatedAt: new Date().toISOString(),
  }));

  zip.file("profile.json", JSON.stringify(profile, null, 2));
  zip.file("compensation.json", JSON.stringify(comp ?? [], null, 2));
  zip.file("jobs.json", JSON.stringify(jobsCreated ?? [], null, 2));
  zip.file("assignments.json", JSON.stringify(assignments ?? [], null, 2));
  zip.file("appointments.json", JSON.stringify(appts ?? [], null, 2));
  zip.file("time_entries.json", JSON.stringify(stempel ?? [], null, 2));
  zip.file("service_reports.json", JSON.stringify(reports ?? [], null, 2));
  zip.file("notifications.json", JSON.stringify(notifs ?? [], null, 2));
  zip.file("wage_documents.json", JSON.stringify(wageDocs ?? [], null, 2));
  zip.file("uploaded_documents.json", JSON.stringify(uploadedDocs ?? [], null, 2));

  // Wage-Documents PDFs aus Storage ziehen
  if (wageDocs && wageDocs.length > 0) {
    const wageFolder = zip.folder("wage_documents")!;
    for (const doc of wageDocs) {
      const { data: blob } = await admin.storage.from("lohndokumente").download(doc.storage_path);
      if (!blob) continue;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const filename = doc.doc_type === "lohnausweis"
        ? `Lohnausweis_${doc.year}.pdf`
        : `Lohnabrechnung_${doc.year}-${String(doc.period_month).padStart(2, "0")}.pdf`;
      wageFolder.file(filename, buffer);
    }
  }

  // Uploaded Documents aus Storage ziehen
  if (uploadedDocs && uploadedDocs.length > 0) {
    const uploadFolder = zip.folder("uploaded_documents")!;
    for (const doc of uploadedDocs) {
      if (!doc.storage_path) continue;
      // documents-Bucket ist anders je nach Pfad; default 'documents'
      const bucket = doc.storage_path.startsWith("partner-anfragen/") ? "documents" : "documents";
      const { data: blob } = await admin.storage.from(bucket).download(doc.storage_path);
      if (!blob) continue;
      const buffer = Buffer.from(await blob.arrayBuffer());
      // Datei-Name sicher machen (kein /, kein ..)
      const safe = (doc.name ?? `doc_${doc.id}`).replace(/[\\/:*?"<>|]/g, "_");
      uploadFolder.file(safe, buffer);
    }
  }

  // ZIP erstellen + hochladen
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = (profile.full_name ?? "user").replace(/[\\/:*?"<>|]/g, "_").substring(0, 50);
  const path = `${profileId}/dossier_${safeName}_${timestamp}.zip`;

  const { error: upErr } = await admin.storage.from(DOSSIER_BUCKET).upload(path, zipBuffer, {
    contentType: "application/zip",
    upsert: false,
  });
  if (upErr) {
    return NextResponse.json({ success: false, error: `Dossier-Upload fehlgeschlagen: ${upErr.message}` }, { status: 500 });
  }

  // Signed-URL (1 Stunde) zum Download zurueck
  const { data: signed } = await admin.storage.from(DOSSIER_BUCKET).createSignedUrl(path, 3600);

  return NextResponse.json({
    success: true,
    profile_name: profile.full_name,
    file_size: zipBuffer.length,
    download_url: signed?.signedUrl,
    storage_path: path,
    summary: {
      compensation_rows: comp?.length ?? 0,
      jobs: jobsCreated?.length ?? 0,
      assignments: assignments?.length ?? 0,
      appointments: appts?.length ?? 0,
      time_entries: stempel?.length ?? 0,
      service_reports: reports?.length ?? 0,
      notifications: notifs?.length ?? 0,
      wage_documents: wageDocs?.length ?? 0,
      uploaded_documents: uploadedDocs?.length ?? 0,
    },
  });
}

// ============================================================================
// HTML-Index Generator
// ============================================================================

interface DossierData {
  profile: Record<string, unknown>;
  comp: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
  appointments: Record<string, unknown>[];
  stempel: Record<string, unknown>[];
  reports: Record<string, unknown>[];
  notifs: Record<string, unknown>[];
  wageDocs: Record<string, unknown>[];
  uploadedDocs: Record<string, unknown>[];
  generatedAt: string;
}

function esc(s: unknown): string {
  if (s == null) return "—";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(s: unknown): string {
  if (!s || typeof s !== "string") return "—";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    return d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return esc(s); }
}

function fmtMin(min: number): string {
  if (!min) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtChf(n: unknown): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

function buildHtmlIndex(d: DossierData): string {
  const p = d.profile;
  const totalStempelMin = d.stempel.reduce((s, e) => {
    const ci = e.clock_in as string | null;
    const co = e.clock_out as string | null;
    if (!ci || !co) return s;
    return s + Math.max(0, Math.floor((new Date(co).getTime() - new Date(ci).getTime()) / 60000));
  }, 0);

  // Stempel-Tabelle
  const stempelRows = d.stempel.slice(0, 500).map((e) => {
    const ci = e.clock_in as string | null;
    const co = e.clock_out as string | null;
    const minutes = ci && co ? Math.max(0, Math.floor((new Date(co).getTime() - new Date(ci).getTime()) / 60000)) : 0;
    return `<tr>
      <td><code>STM-${String(e.entry_number ?? "—").padStart(5, "0")}</code></td>
      <td>${fmtDate(ci)}</td>
      <td>${fmtDate(co)}</td>
      <td>${fmtMin(minutes)}</td>
      <td>${esc(e.job_id ?? "—")}</td>
    </tr>`;
  }).join("");

  // Comp-Historie
  const compRows = d.comp.map((c) => `<tr>
    <td>${fmtDate(c.effective_from)}</td>
    <td>${c.effective_to ? fmtDate(c.effective_to) : "<i>aktiv</i>"}</td>
    <td>CHF ${fmtChf(c.hourly_wage_chf)}</td>
    <td>${c.employer_pct == null ? "<i>Standard</i>" : `${fmtChf(c.employer_pct)}%`}</td>
    <td>${[c.ahv_iv_eo_pct, c.alv_pct, c.nbu_pct, c.bvg_pct, c.ktg_pct, c.quellensteuer_pct].map((p) => p == null ? "<i>Std</i>" : `${fmtChf(p)}%`).join(" / ")}</td>
    <td>${esc(c.notes ?? "—")}</td>
  </tr>`).join("");

  // Jobs
  const jobRows = d.jobs.map((j) => `<tr>
    <td><code>INT-${esc(j.job_number ?? "—")}</code></td>
    <td>${esc(j.title)}</td>
    <td><span class="tag">${esc(j.status)}</span></td>
    <td>${fmtDate(j.start_date)}</td>
    <td>${j.created_by === p.id ? "✔" : ""}</td>
    <td>${j.project_lead_id === p.id ? "✔" : ""}</td>
  </tr>`).join("");

  // Appointments
  const apptRows = d.appointments.map((a) => `<tr>
    <td>${esc(a.title)}</td>
    <td>${fmtDate(a.start_time)}</td>
    <td>${fmtDate(a.end_time)}</td>
    <td>${esc(a.job_id)}</td>
  </tr>`).join("");

  // Service-Reports
  const reportRows = d.reports.map((r) => `<tr>
    <td>${fmtDate(r.report_date)}</td>
    <td><span class="tag">${esc(r.status)}</span></td>
    <td>${esc(r.client_name ?? "—")}</td>
    <td>${esc(r.work_description ?? "—").slice(0, 100)}${(r.work_description as string ?? "").length > 100 ? "…" : ""}</td>
  </tr>`).join("");

  // Wage-Documents Links
  const wageRows = d.wageDocs.map((w) => {
    const filename = w.doc_type === "lohnausweis"
      ? `Lohnausweis_${w.year}.pdf`
      : `Lohnabrechnung_${w.year}-${String(w.period_month).padStart(2, "0")}.pdf`;
    return `<tr>
      <td>${esc(w.doc_type)}</td>
      <td>${esc(w.year)}${w.period_month ? `-${String(w.period_month).padStart(2, "0")}` : ""}</td>
      <td>${fmtDate(w.uploaded_at)}</td>
      <td><a href="wage_documents/${esc(filename)}" target="_blank">📄 ${esc(filename)}</a></td>
    </tr>`;
  }).join("");

  // Uploaded-Documents Links
  const uploadRows = d.uploadedDocs.map((u) => {
    const safe = (u.name as string ?? `doc_${u.id}`).replace(/[\\/:*?"<>|]/g, "_");
    return `<tr>
      <td>${esc(u.name ?? safe)}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td>${esc(u.mime_type ?? "—")}</td>
      <td><a href="uploaded_documents/${esc(safe)}" target="_blank">📎 öffnen</a></td>
    </tr>`;
  }).join("");

  // Notifications (last 100 only)
  const notifRows = d.notifs.slice(0, 100).map((n) => `<tr>
    <td>${fmtDate(n.created_at)}</td>
    <td>${esc(n.type ?? "—")}</td>
    <td>${esc(n.body ?? n.title ?? "—").slice(0, 120)}</td>
  </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <title>Dossier — ${esc(p.full_name)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5; line-height: 1.4; }
    h1 { font-size: 28px; margin: 0 0 4px; }
    h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #dc2626; color: #dc2626; }
    .subtitle { color: #888; font-size: 13px; margin-bottom: 24px; }
    .kpi-row { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .kpi { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px 16px; min-width: 140px; }
    .kpi .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
    .kpi .value { font-size: 20px; font-weight: 600; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: #111; border-radius: 8px; overflow: hidden; }
    th { text-align: left; padding: 10px 12px; background: #1a1a1a; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #2a2a2a; }
    td { padding: 8px 12px; border-bottom: 1px solid #1f1f1f; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1a1a1a; }
    code { font-family: "SF Mono", Consolas, monospace; font-size: 11px; color: #fca5a5; background: rgba(220, 38, 38, 0.1); padding: 1px 5px; border-radius: 3px; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: #2a2a2a; color: #ccc; }
    .empty { color: #555; font-style: italic; padding: 16px; text-align: center; background: #111; border-radius: 8px; }
    .note { background: #1e1b4b; border: 1px solid #312e81; color: #c7d2fe; padding: 12px 16px; border-radius: 8px; margin: 16px 0; font-size: 13px; }
    .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; }
    .meta dt { color: #888; }
    .meta dd { margin: 0; }
    @media print {
      body { color: #000; background: #fff; max-width: none; }
      h2 { color: #dc2626; }
      table { background: #fff; }
      th { background: #f5f5f5; color: #555; }
      tr:hover td { background: transparent; }
      code { color: #dc2626; background: #fee; }
    }
  </style>
</head>
<body>
  <h1>Personal-Dossier</h1>
  <div class="subtitle">Generiert am ${fmtDate(d.generatedAt)} · EVENTLINE GmbH</div>

  <h2>Stammdaten</h2>
  <dl class="meta">
    <dt>Name</dt><dd><strong>${esc(p.full_name)}</strong></dd>
    <dt>Profile-ID</dt><dd><code>${esc(p.id)}</code></dd>
    <dt>E-Mail</dt><dd>${esc(p.email)}</dd>
    <dt>Telefon</dt><dd>${esc(p.phone ?? "—")}</dd>
    <dt>Rolle</dt><dd>${esc(p.role)}</dd>
    <dt>Aktiv</dt><dd>${p.is_active ? "✔ Ja" : "✘ Deaktiviert"}</dd>
    <dt>Erstellt</dt><dd>${fmtDate(p.created_at)}</dd>
  </dl>

  <h2>Zusammenfassung</h2>
  <div class="kpi-row">
    <div class="kpi"><div class="label">Stempel-Stunden total</div><div class="value">${fmtMin(totalStempelMin)}</div></div>
    <div class="kpi"><div class="label">Stempel-Einträge</div><div class="value">${d.stempel.length}</div></div>
    <div class="kpi"><div class="label">Jobs als Lead/Creator</div><div class="value">${d.jobs.length}</div></div>
    <div class="kpi"><div class="label">Termin-Zuweisungen</div><div class="value">${d.appointments.length}</div></div>
    <div class="kpi"><div class="label">Service-Rapporte</div><div class="value">${d.reports.length}</div></div>
    <div class="kpi"><div class="label">Lohn-Dokumente</div><div class="value">${d.wageDocs.length}</div></div>
  </div>

  <h2>Lohn-Historie (${d.comp.length})</h2>
  ${d.comp.length === 0 ? '<div class="empty">Keine Lohn-Daten hinterlegt.</div>' : `<table>
    <thead><tr><th>Gültig ab</th><th>Gültig bis</th><th>Brutto/h</th><th>AG-Anteil %</th><th>Abzüge AHV/ALV/NBU/BVG/KTG/QST</th><th>Notiz</th></tr></thead>
    <tbody>${compRows}</tbody>
  </table>`}

  <h2>Stempel-Einträge (${d.stempel.length})</h2>
  ${d.stempel.length === 0 ? '<div class="empty">Keine Stempel-Einträge.</div>' : `${d.stempel.length > 500 ? '<div class="note">Zeigt die letzten 500 Einträge. Vollständige Liste in <code>time_entries.json</code>.</div>' : ''}<table>
    <thead><tr><th>Nr</th><th>Clock-In</th><th>Clock-Out</th><th>Dauer</th><th>Job-ID</th></tr></thead>
    <tbody>${stempelRows}</tbody>
  </table>`}

  <h2>Jobs als Creator/Lead (${d.jobs.length})</h2>
  ${d.jobs.length === 0 ? '<div class="empty">Keine Jobs.</div>' : `<table>
    <thead><tr><th>INT</th><th>Titel</th><th>Status</th><th>Startdatum</th><th>Creator</th><th>Lead</th></tr></thead>
    <tbody>${jobRows}</tbody>
  </table>`}

  <h2>Termin-Zuweisungen (${d.appointments.length})</h2>
  ${d.appointments.length === 0 ? '<div class="empty">Keine Termin-Zuweisungen.</div>' : `<table>
    <thead><tr><th>Titel</th><th>Start</th><th>Ende</th><th>Job-ID</th></tr></thead>
    <tbody>${apptRows}</tbody>
  </table>`}

  <h2>Service-Rapporte (${d.reports.length})</h2>
  ${d.reports.length === 0 ? '<div class="empty">Keine Rapporte.</div>' : `<table>
    <thead><tr><th>Datum</th><th>Status</th><th>Kunde</th><th>Beschreibung</th></tr></thead>
    <tbody>${reportRows}</tbody>
  </table>`}

  <h2>Lohndokumente (${d.wageDocs.length})</h2>
  ${d.wageDocs.length === 0 ? '<div class="empty">Keine Lohndokumente.</div>' : `<div class="note">PDFs sind im Unterordner <code>wage_documents/</code> — klick auf den Link öffnet das PDF direkt.</div><table>
    <thead><tr><th>Typ</th><th>Zeitraum</th><th>Hochgeladen</th><th>Download</th></tr></thead>
    <tbody>${wageRows}</tbody>
  </table>`}

  <h2>Hochgeladene Dateien (${d.uploadedDocs.length})</h2>
  ${d.uploadedDocs.length === 0 ? '<div class="empty">Keine hochgeladenen Dateien.</div>' : `<div class="note">Dateien sind im Unterordner <code>uploaded_documents/</code>.</div><table>
    <thead><tr><th>Name</th><th>Hochgeladen</th><th>Typ</th><th>Öffnen</th></tr></thead>
    <tbody>${uploadRows}</tbody>
  </table>`}

  <h2>Benachrichtigungen (${d.notifs.length})</h2>
  ${d.notifs.length === 0 ? '<div class="empty">Keine Benachrichtigungen.</div>' : `${d.notifs.length > 100 ? '<div class="note">Zeigt die letzten 100. Vollständige Liste in <code>notifications.json</code>.</div>' : ''}<table>
    <thead><tr><th>Datum</th><th>Typ</th><th>Nachricht</th></tr></thead>
    <tbody>${notifRows}</tbody>
  </table>`}

  <h2 style="margin-top:48px;color:#888;font-size:14px;border-bottom:1px solid #2a2a2a">Rohdaten</h2>
  <div class="note">Alle Daten zusätzlich als JSON: <code>profile.json</code>, <code>compensation.json</code>, <code>jobs.json</code>, <code>assignments.json</code>, <code>appointments.json</code>, <code>time_entries.json</code>, <code>service_reports.json</code>, <code>notifications.json</code>, <code>wage_documents.json</code>, <code>uploaded_documents.json</code>.</div>
</body>
</html>`;
}
