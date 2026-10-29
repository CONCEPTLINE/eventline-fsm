#!/usr/bin/env node
// Testumgebung: PDFs des ALTEN Generators (Phase 1, vor dem Rechenkern) aus den
// Testdaten erzeugen — Grundlage für den Altbestand-Test in pruefen-phase2.mjs.
// NUR LOKAL. Erzeugt nichts auf Live.
//
// Vorgehen (einmalig, Ergebnis liegt dann in supabase/lokal/ausgabe/altbestand/):
//   1. git worktree add --detach C:\tmp\eventline-alt-generator 8e526d2c   (main vor Phase 2)
//      dort: .env.local aus diesem Worktree kopieren, npm ci,
//      npx next dev -p 3101 -H 127.0.0.1
//   2. bash supabase/lokal/aufbauen.sh --nur-seed
//   3. node supabase/lokal/altbestand-erzeugen.mjs
//   4. Server auf 3101 stoppen; Worktree entfernen (git worktree remove --force …)
//
// Das Skript meldet sich als Test-Admin am ALTEN Server an, erzeugt die Lohn-
// abrechnungen der Liste FAELLE und legt PDF + Angaben (manifest.json) ab.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ALT = process.env.ALT_APP ?? "http://127.0.0.1:3101";
const ZIEL = path.join(here, "ausgabe", "altbestand");
const env = Object.fromEntries(fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("ABBRUCH: .env.local zeigt nicht auf das lokale Supabase.");
  process.exit(1);
}

const P = (n) => `a0000000-0000-4000-8000-0000000000${n}`;
// Person, Monat — je ein Sonderfall der Testdaten
export const FAELLE = [
  [P("17"), 2026, 9],  // Lara: Lohnerhöhung 15.09. (alter Generator: alles zu 28.00)
  [P("12"), 2026, 8],  // Noah: Sa 21–So 05, So 20–Mo 00:30, Override 10.64 %
  [P("12"), 2026, 5],  // Noah: über Mitternacht und Monatsende
  [P("11"), 2026, 7],  // Lena: Monat des 20. Geburtstags
  [P("11"), 2026, 8],  // Lena: 1. August gearbeitet
  [P("18"), 2026, 8],  // Luca: Quellensteuer, 1. August
  [P("13"), 2026, 6],  // Mia: NBU Ø 7.75 h
  [P("14"), 2026, 6],  // Elias: NBU Ø 8.25 h, keine Anstellung erfasst
  [P("15"), 2026, 6],  // Sara: sporadisch + grosse Woche
  [P("19"), 2026, 6],  // Ben: Austrittsmonat
  [P("16"), 2026, 9],  // Jonas: 2'500 knapp darunter
];

async function main() {
  const jar = new Map();
  const supa = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await supa.auth.signInWithPassword({ email: "lohn-admin@example.com", password: "LohnTest-2026!" });
  if (error) throw new Error(error.message);
  const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).concat(["eventline_trusted_device=lokal-testgeraet-admin"]).join("; ");
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  fs.mkdirSync(ZIEL, { recursive: true });
  const manifest = [];
  for (const [pid, jahr, monat] of FAELLE) {
    const res = await fetch(`${ALT}/api/hr/wage-documents/generate`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ profile_id: pid, year: jahr, month: monat }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.success) { console.log(`FEHLER ${pid} ${jahr}-${monat}: ${res.status} ${j?.error ?? ""}`); continue; }
    const { data: doc } = await service.from("wage_documents").select("storage_path").eq("profile_id", pid).eq("year", jahr).eq("period_month", monat).eq("doc_type", "lohnabrechnung").single();
    const { data: blob, error: dErr } = await service.storage.from("lohndokumente").download(doc.storage_path);
    if (dErr) throw new Error(dErr.message);
    const datei = `${pid}_${jahr}-${String(monat).padStart(2, "0")}.pdf`;
    fs.writeFileSync(path.join(ZIEL, datei), Buffer.from(await blob.arrayBuffer()));
    manifest.push({ profile_id: pid, jahr, monat, datei });
    console.log(`OK  ${datei}`);
  }
  fs.writeFileSync(path.join(ZIEL, "manifest.json"), JSON.stringify(manifest, null, 2));
  await supa.auth.signOut({ scope: "local" });
  console.log(`${manifest.length} PDFs des alten Generators in ${ZIEL}`);
}

main().catch((e) => { console.error(`ABBRUCH: ${e.message}`); process.exit(1); });
