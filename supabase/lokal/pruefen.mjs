#!/usr/bin/env node
// Rauchtest der lokalen Testumgebung (NUR LOKAL):
//   1. Login mit dem Test-Admin (lokales Supabase)
//   2. Seite /lohn und /api/hr/monthly-stats mit registriertem Testgerät
//   3. Lohnabrechnung über die bestehende Route POST /api/hr/wage-documents/generate
//   4. PDF aus dem lokalen Storage (Bucket lohndokumente) holen und ablegen
//   5. Abmelden NUR lokal (signOut scope "local")
//
// Voraussetzung: Supabase lokal läuft (bash supabase/lokal/aufbauen.sh) und
// der Dev-Server läuft auf Port 3100 (npm run dev -- -p 3100).
// Aufruf: node supabase/lokal/pruefen.mjs [profil-id] [jahr] [monat]
//   Standard: Lara Steiner, September 2026 (Lohnerhöhung mitten im Monat)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const APP = "http://localhost:3100";

// .env.local lesen (nur die lokalen Supabase-Werte)
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(URL_ ?? "")) {
  console.error(`ABBRUCH: .env.local zeigt nicht auf das lokale Supabase (${URL_}).`);
  process.exit(1);
}

const [profileId = "a0000000-0000-4000-8000-000000000017", jahr = "2026", monat = "9"] = process.argv.slice(2);

const jar = new Map();
const supa = createServerClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
  },
});

const ok = (b, msg) => { console.log(`${b ? "OK  " : "FEHLER"} ${msg}`); if (!b) process.exitCode = 1; return b; };

const { error: loginErr } = await supa.auth.signInWithPassword({ email: "lohn-admin@example.com", password: "LohnTest-2026!" });
ok(!loginErr, `Login lohn-admin@example.com${loginErr ? ": " + loginErr.message : ""}`);

const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).concat("eventline_trusted_device=lokal-testgeraet-admin").join("; ");

try {
  const seite = await fetch(`${APP}/lohn`, { headers: { cookie: cookie() }, redirect: "manual" });
  ok(seite.status === 200, `GET /lohn -> HTTP ${seite.status}${seite.headers.get("location") ? " -> " + seite.headers.get("location") : ""}`);

  const mm = `${jahr}-${String(monat).padStart(2, "0")}`;
  const stats = await fetch(`${APP}/api/hr/monthly-stats?month=${mm}`, { headers: { cookie: cookie() } });
  const statsJson = await stats.json().catch(() => ({}));
  const rows = statsJson.employees ?? [];
  ok(stats.status === 200 && rows.length > 0, `GET /api/hr/monthly-stats?month=${mm} -> HTTP ${stats.status}, ${rows.length} Mitarbeitende, BVG-Schwelle ${statsJson.bvgThresholdChf}`);

  const gen = await fetch(`${APP}/api/hr/wage-documents/generate`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify({ profile_id: profileId, year: Number(jahr), month: Number(monat) }),
  });
  const genJson = await gen.json().catch(() => ({}));
  ok(gen.status === 200 && genJson.success !== false, `POST /api/hr/wage-documents/generate -> HTTP ${gen.status} ${JSON.stringify(genJson).slice(0, 200)}`);

  // Kontrolle direkt im lokalen Storage (Service-Rolle, nur lokal)
  const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: doc } = await admin.from("wage_documents").select("storage_path, file_size, source")
    .eq("profile_id", profileId).eq("doc_type", "lohnabrechnung").eq("year", Number(jahr)).eq("period_month", Number(monat)).maybeSingle();
  if (ok(!!doc, `wage_documents-Zeile ${doc ? doc.storage_path + " (" + doc.file_size + " Bytes, " + doc.source + ")" : "fehlt"}`)) {
    const { data: blob, error } = await admin.storage.from("lohndokumente").download(doc.storage_path);
    const buf = blob ? Buffer.from(await blob.arrayBuffer()) : null;
    if (ok(!error && buf && buf.subarray(0, 5).toString() === "%PDF-", `PDF im lokalen Storage (Bucket lohndokumente), ${buf?.length ?? 0} Bytes`)) {
      const ziel = path.join(here, "ausgabe", path.basename(doc.storage_path));
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      fs.writeFileSync(ziel, buf);
      console.log(`     abgelegt: ${ziel}`);
    }
  }
} finally {
  // Nur diese Sitzung abmelden — nie global (würde alle Sitzungen des Kontos beenden).
  const { error } = await supa.auth.signOut({ scope: "local" });
  ok(!error, "Abmelden (scope local)");
}
