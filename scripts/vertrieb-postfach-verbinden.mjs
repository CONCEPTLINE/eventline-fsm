#!/usr/bin/env node
// Vertrieb: Leos Microsoft-365-Postfach mit dem FSM verbinden (Audit M4).
//
//   node scripts/vertrieb-postfach-verbinden.mjs [--postfach leo@eventline-basel.com]
//
// Ablauf (Device-Code-Anmeldung, kein Passwort im Skript):
//   1. Das Skript zeigt eine Adresse und einen Code an.
//   2. Im Browser mit dem Postfach anmelden und den Code eingeben.
//   3. Das Skript prüft den Zugriff auf das Postfach und speichert den
//      Refresh-Token VERSCHLÜSSELT (AES-256-GCM, gleiche Ableitung wie
//      src/lib/vertrieb/token-krypto.ts) in vertrieb_m365_verbindung.
// Client, Recht (Scope) und URLs: src/lib/vertrieb/m365-konstanten.json —
// dieselbe Quelle wie der Abgleich in der App.
// Liest .env.local selbst (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
// Gibt NIE einen Token aus. Die Datenbank ist Live (B1).

import { readFileSync } from "node:fs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const K = JSON.parse(readFileSync(new URL("../src/lib/vertrieb/m365-konstanten.json", import.meta.url), "utf-8"));

function stop(text) {
  console.error(text);
  process.exit(2);
}

const argv = process.argv.slice(2);
const iPost = argv.indexOf("--postfach");
const postfach = (iPost >= 0 ? argv[iPost + 1] : "leo@eventline-basel.com")?.trim().toLowerCase();
if (!postfach || !postfach.includes("@")) stop("--postfach braucht eine Mailadresse");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1")]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) stop("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY fehlen in .env.local");

function verschluessele(klar) {
  const schluessel = createHash("sha256").update(`${serviceKey}|${K.schluesselKontext}`, "utf8").digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", schluessel, iv);
  const geheim = Buffer.concat([c.update(klar, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), geheim]).toString("base64");
}

async function formPost(ziel, felder) {
  const res = await fetch(ziel, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(felder),
  });
  return { ok: res.ok, json: await res.json().catch(() => ({})) };
}

// 1. Gerätecode anfordern
const start = await formPost(K.deviceCodeUrl, { client_id: K.clientId, scope: K.scope });
if (!start.ok || !start.json.device_code) {
  stop(`Anmeldung konnte nicht starten: ${start.json.error ?? "unbekannt"} ${start.json.error_description?.split(/\r?\n/)[0] ?? ""}`);
}
console.log(`\nBitte im Browser ${start.json.verification_uri} öffnen und den Code ${start.json.user_code} eingeben.`);
console.log(`Mit dem Postfach ${postfach} anmelden. Das Skript wartet …\n`);

// 2. Warten, bis die Anmeldung bestätigt ist
let intervall = (start.json.interval ?? 5) * 1000;
const bis = Date.now() + (start.json.expires_in ?? 900) * 1000;
let token = null;
while (Date.now() < bis) {
  await new Promise((r) => setTimeout(r, intervall));
  const r = await formPost(K.tokenUrl, {
    client_id: K.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: start.json.device_code,
  });
  if (r.ok && r.json.refresh_token) { token = r.json; break; }
  if (r.json.error === "authorization_pending") continue;
  if (r.json.error === "slow_down") { intervall += 5000; continue; }
  stop(`Anmeldung fehlgeschlagen: ${r.json.error ?? "unbekannt"} ${r.json.error_description?.split(/\r?\n/)[0] ?? ""}`);
}
if (!token) stop("Zeit abgelaufen — bitte nochmals starten.");

// 3. Zugriff prüfen (liest nur die ID des Posteingangs)
const probe = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id", {
  headers: { Authorization: `Bearer ${token.access_token}` },
});
if (!probe.ok) stop(`Postfach nicht lesbar (HTTP ${probe.status}) — richtiges Konto? Recht ${K.scope} erteilt?`);

// 4. Verschlüsselt speichern
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { error } = await db.from("vertrieb_m365_verbindung").upsert({
  id: 1,
  postfach,
  refresh_token: verschluessele(token.refresh_token),
  aktualisiert_am: new Date().toISOString(),
  letzter_sync_fehler: null,
});
if (error) stop(`Speichern fehlgeschlagen: ${error.message}`);
console.log(`Postfach ${postfach} verbunden (Recht: ${K.scope}). Der Schlüssel liegt verschlüsselt in der Datenbank.`);
