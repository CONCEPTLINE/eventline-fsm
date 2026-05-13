// One-off: vollstaendige Loeschung des Test-Auftrags INT-26259.
// Reihenfolge:
//   1. Storage-Datei (Test_SwissSign.pdf) aus dem documents-Bucket
//   2. documents-Row
//   3. notifications die auf den Job verlinken
//   4. job_appointments
//   5. der Job selbst
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

const JOB_ID = "be8dc608-45c0-4b0b-b4de-3139ed6eb5e0";
const STORAGE_PATH = "partner-anfragen/be8dc608-45c0-4b0b-b4de-3139ed6eb5e0/1778612917550_Test_SwissSign.pdf";

console.log("1) Storage-File loeschen…");
{
  const { error } = await supabase.storage.from("documents").remove([STORAGE_PATH]);
  if (error) console.error("  storage error:", error);
  else console.log("  OK");
}

console.log("2) documents-Row loeschen…");
{
  const { error, count } = await supabase.from("documents").delete({ count: "exact" }).eq("job_id", JOB_ID);
  if (error) console.error("  error:", error);
  else console.log(`  ${count} Row(s) geloescht`);
}

console.log("3) notifications loeschen (link enthaelt job-id)…");
{
  const { error, count } = await supabase
    .from("notifications")
    .delete({ count: "exact" })
    .like("link", `%${JOB_ID}%`);
  if (error) console.error("  error:", error);
  else console.log(`  ${count} Row(s) geloescht`);
}

console.log("4) job_appointments loeschen…");
{
  const { error, count } = await supabase.from("job_appointments").delete({ count: "exact" }).eq("job_id", JOB_ID);
  if (error) console.error("  error:", error);
  else console.log(`  ${count} Row(s) geloescht`);
}

console.log("5) Job loeschen…");
{
  const { error, count } = await supabase.from("jobs").delete({ count: "exact" }).eq("id", JOB_ID);
  if (error) console.error("  error:", error);
  else console.log(`  ${count} Row(s) geloescht`);
}

console.log("\n--- Verifikation ---");
{
  const { data: j } = await supabase.from("jobs").select("id").eq("id", JOB_ID).maybeSingle();
  console.log("jobs:", j ? "STILL EXISTS" : "weg");
  const { count: cAppts } = await supabase.from("job_appointments").select("*", { count: "exact", head: true }).eq("job_id", JOB_ID);
  console.log("appointments:", cAppts);
  const { count: cDocs } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("job_id", JOB_ID);
  console.log("documents:", cDocs);
  const { count: cNotif } = await supabase.from("notifications").select("*", { count: "exact", head: true }).like("link", `%${JOB_ID}%`);
  console.log("notifications:", cNotif);
}
