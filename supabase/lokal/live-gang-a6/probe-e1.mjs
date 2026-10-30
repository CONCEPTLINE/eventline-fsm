#!/usr/bin/env node
// Probe E1 (Mail-Eingang → Trust flow, «TFD1») auf der ERP-Preview — siehe LIVE-GANG.md, Abschnitt E1.
//
// Schickt der Preview einen signierten Resend-Webhook «email.received» für eine ECHTE Test-Mail an ablage@…
// (die Produktion hat dieselbe Mail schon an trust one geleitet — die Test-Datei liegt danach in beiden Eingängen).
// Die Preview (ABLAGE_ZIEL=trust-flow) lädt die Mail bei Resend, verschlüsselt jeden Anhang für den Rig und liefert
// ihn an Trust flow. Ausgabe: HTTP-Status und Antwort der Route (ohne Inhalt, ohne Geheimnis).
//
//   RESEND_WEBHOOK_SECRET=whsec_… [VERCEL_BYPASS=…] node supabase/lokal/live-gang-a6/probe-e1.mjs <preview-url> <email_id>
//
// RESEND_WEBHOOK_SECRET = derselbe Wert wie in Vercel (Preview). VERCEL_BYPASS = «Protection Bypass for Automation»
// des Vercel-Projekts, falls die Preview geschützt ist. Werte werden nie ausgegeben.

import { createHmac, randomUUID } from "node:crypto";

const [basis, emailId] = process.argv.slice(2);
const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
if (!basis || !emailId || !secret) {
  console.error("Aufruf: RESEND_WEBHOOK_SECRET=… [VERCEL_BYPASS=…] node probe-e1.mjs <preview-url> <email_id>");
  process.exit(2);
}
const url = new URL("/api/inbound/mail", basis);
if (url.hostname === "eventline-fsm-usyk.vercel.app") {
  console.error("Das ist die Produktion — die Probe gehört auf die Preview-URL.");
  process.exit(2);
}

const payload = JSON.stringify({ type: "email.received", data: { email_id: emailId } });
const id = `msg_probe_${randomUUID()}`;
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${payload}`).digest("base64");
const headers = { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
if (process.env.VERCEL_BYPASS?.trim()) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS.trim();

const res = await fetch(url, { method: "POST", headers, body: payload });
const text = await res.text();
console.log(`HTTP ${res.status} ${text.slice(0, 500)}`);
// 200 {"ok":true,"ablage":N,"abgewiesen":0}  = alle Anhänge in Trust flow
// 502 {"ok":false,…,"fehler":N}               = vorübergehend (Vercel-Log «inbound.ablage.weiterleitung» zeigt den Grund)
// 503                                          = Ablage-Weiterleitung nicht eingerichtet (TRUST_ONE_ABLAGE_TOKEN fehlt)
process.exit(res.ok ? 0 : 1);
