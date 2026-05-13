// Playwright-Test fuer Scroll-Restauration mit Service-Role-Session-Generierung.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter((l) => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;

// Admin-Client zum Tokens-Erzeugen
const admin = createClient(SUPA_URL, SRK, { auth: { autoRefreshToken: false, persistSession: false } });

// Direkt eine Auth-Token-Pair via admin.signInWithPassword waere noetig, aber
// wir haben kein Passwort. Stattdessen: admin.createUser oder
// admin.generateLink type=magic + den Token-Hash aus dem Link rausziehen
// und damit verifyOtp aufrufen.
const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email: "leo@eventline-basel.com",
});
if (linkErr) { console.error(linkErr); process.exit(1); }

// Der returned action_link enthaelt einen token_hash. Wir extrahieren ihn
// und rufen verifyOtp damit auf — gibt uns ein Session-Pair.
const tokenHash = linkData.properties.hashed_token;
const userClient = createClient(SUPA_URL, SUPA_ANON);
const { data: sess, error: sessErr } = await userClient.auth.verifyOtp({
  token_hash: tokenHash,
  type: "magiclink",
});
if (sessErr || !sess.session) { console.error("verifyOtp failed:", sessErr); process.exit(1); }
console.log("Got session for", sess.user.email);

const accessToken = sess.session.access_token;
const refreshToken = sess.session.refresh_token;

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// Supabase-SSR liest Session aus Cookies. Cookie-Name folgt sb-<ref>-auth-token Format.
const ref = SUPA_URL.replace("https://", "").split(".")[0];
const cookieName = `sb-${ref}-auth-token`;
// Base64-encoded JSON-Object form (Supabase SSR)
const cookieValue = "base64-" + Buffer.from(JSON.stringify({
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_in: sess.session.expires_in,
  expires_at: sess.session.expires_at,
  token_type: "bearer",
  user: sess.user,
})).toString("base64");

await ctx.addCookies([{
  name: cookieName,
  value: cookieValue,
  domain: "localhost",
  path: "/",
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
}]);

const page = await ctx.newPage();

page.on("console", (m) => {
  if (m.type() === "error") console.log(`[browser ${m.type()}]`, m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

console.log("\n=== STEP 1: Navigate to /vertrieb ===");
await page.goto("http://localhost:3000/vertrieb", { waitUntil: "networkidle", timeout: 60000 });
console.log("Landed on:", page.url());
await page.waitForTimeout(2000);

console.log("\n=== STEP 2: Scroll-Container Diagnose ===");
const diag = await page.evaluate(() => {
  const find = (el) => el ? {
    tag: el.tagName, id: el.id || null,
    cls: el.className?.toString?.().slice(0, 80) || null,
    overflowY: getComputedStyle(el).overflowY,
    overflowX: getComputedStyle(el).overflowX,
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  } : null;
  return {
    pageHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    html: find(document.documentElement),
    body: find(document.body),
    appScroll: find(document.getElementById("app-scroll")),
    scrollingElement: find(document.scrollingElement),
    windowScrollY: window.scrollY,
  };
});
console.log(JSON.stringify(diag, null, 2));

console.log("\n=== STEP 3: Scroll runter ===");
await page.mouse.wheel(0, 800);
await page.waitForTimeout(500);
await page.mouse.wheel(0, 800);
await page.waitForTimeout(500);

const afterScroll = await page.evaluate(() => ({
  windowScrollY: window.scrollY,
  htmlScrollTop: document.documentElement.scrollTop,
  bodyScrollTop: document.body.scrollTop,
  appScrollTop: document.getElementById("app-scroll")?.scrollTop ?? null,
  scrollingElementScrollTop: document.scrollingElement?.scrollTop ?? null,
  debug: window.__scrollDebug || null,
  storage: sessionStorage.getItem("scroll:/vertrieb"),
}));
console.log("After scroll:", JSON.stringify(afterScroll, null, 2));

console.log("\n=== STEP 4: Klick auf eine Karte die im VIEWPORT sichtbar ist ===");
// Realistisches User-Verhalten: klick auf eine Karte die der User
// gerade sehen kann (in viewport). Nicht auto-scroll-to-first.
const targetLead = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll("[class*='cursor-pointer']"));
  const viewport = { top: 0, bottom: window.innerHeight };
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top >= viewport.top && rect.bottom <= viewport.bottom) {
      // klick ohne scrollIntoView
      (card).click();
      return { found: true, top: rect.top };
    }
  }
  return { found: false };
});
console.log("Click attempt:", targetLead);
if (!targetLead.found) {
  console.log("Keine sichtbare Karte gefunden, abbrechen");
  await browser.close();
  process.exit(0);
}
await page.waitForURL(/\/vertrieb\/[a-f0-9-]+/, { timeout: 10000 });
console.log("URL nach Klick:", page.url());
await page.waitForTimeout(2000);

console.log("\n=== STEP 5: Trace setup BEFORE back, dann zurueck ===");
await page.evaluate(() => {
  window.__scrollTrace = [];
  const t0 = performance.now();
  // Sync scroll-Listener (capture phase, fires sofort bei jedem Scroll-
  // Event egal welcher Container)
  document.addEventListener("scroll", () => {
    window.__scrollTrace.push({
      t: Math.round(performance.now() - t0),
      kind: "scroll-event",
      y: window.scrollY,
      url: window.location.pathname,
    });
  }, { capture: true, passive: true });
  // RAF-Polling: jeder Frame y check
  let last = window.scrollY;
  const poll = () => {
    if (window.scrollY !== last) {
      window.__scrollTrace.push({
        t: Math.round(performance.now() - t0),
        kind: "raf-diff",
        y: window.scrollY,
        url: window.location.pathname,
      });
      last = window.scrollY;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
});

console.log("Trace setup. y BEFORE back:", await page.evaluate(() => window.scrollY));

// Page-Height tracker — falls Page kuerzer wird, kann scroll-Y nicht
// hochgehen. RAF-Polling jeder Frame.
await page.evaluate(() => {
  const t0 = performance.now();
  window.__heightTrace = [];
  let lastH = document.documentElement.scrollHeight;
  const pollH = () => {
    const h = document.documentElement.scrollHeight;
    if (h !== lastH) {
      window.__heightTrace.push({ t: Math.round(performance.now() - t0), h });
      lastH = h;
    }
    requestAnimationFrame(pollH);
  };
  requestAnimationFrame(pollH);
});

await page.evaluate(() => window.history.back());
await page.waitForTimeout(3500);

const trace = await page.evaluate(() => window.__scrollTrace || []);
const hTrace = await page.evaluate(() => window.__heightTrace || []);
const hookHistory = await page.evaluate(() => window.__scrollHistory || []);
console.log(`\nScroll-Trace (${trace.length} events):`);
for (const e of trace) {
  console.log(`  +${e.t}ms  ${e.kind.padEnd(12)} y=${Math.round(e.y).toString().padStart(5)}  ${e.url}`);
}
console.log(`\nHeight-Trace (${hTrace.length} events):`);
for (const e of hTrace) {
  console.log(`  +${e.t}ms  h=${e.h}`);
}
console.log(`\nHook-History (${hookHistory.length} events):`);
for (const e of hookHistory) {
  console.log(`  t=${e.t} ${e.kind}: ${JSON.stringify(e).slice(0, 200)}`);
}

const afterBack = await page.evaluate(() => ({
  url: window.location.pathname,
  windowScrollY: window.scrollY,
  htmlScrollTop: document.documentElement.scrollTop,
  bodyScrollTop: document.body.scrollTop,
  appScrollTop: document.getElementById("app-scroll")?.scrollTop ?? null,
  scrollingElementScrollTop: document.scrollingElement?.scrollTop ?? null,
  debug: window.__scrollDebug || null,
  storage: sessionStorage.getItem("scroll:/vertrieb"),
}));
console.log("After back:", JSON.stringify(afterBack, null, 2));

const expectedY = afterScroll.windowScrollY || afterScroll.htmlScrollTop || afterScroll.bodyScrollTop || afterScroll.appScrollTop || 0;
const actualY = afterBack.windowScrollY || afterBack.htmlScrollTop || afterBack.bodyScrollTop || afterBack.appScrollTop || 0;
console.log(`\nExpected scroll Y: ${expectedY}`);
console.log(`Actual scroll Y:   ${actualY}`);
console.log(actualY > expectedY * 0.8 ? "OK RESTORATION WORKS" : "FAIL RESTORATION FAILED");

await browser.close();
