"use client";

/**
 * EingangErfassung — DER eine Schreibort des Auftrags, direkt auf der
 * Uebersicht (Leo 2026-09-24: Eingang-Tab weg, ein Feld statt drei).
 *
 * Alles was hier erfasst wird (Notiz, Mail-Text, Abmachung, Datei) wird
 * ein Eingang-Element und von der KI automatisch einsortiert: Technik-
 * Positionen, Kundenwuensche, Termin-/Datums-Vorschlaege, Zusammenfassung.
 * Der Verlauf (alle Elemente + Verarbeitungsstatus + Mail-Eingaenge ueber
 * auftrag@in…) liegt eingeklappt darunter — Nachvollziehbarkeit ohne
 * Seitenlaenge. Mechanik (KI-Queue, Selbstheilung) unveraendert vom
 * frueheren Eingang-Tab uebernommen.
 *
 * Diktieren (2026-10-02, docs/lokale-ki/SPEC.md V3/V4): zuerst die lokale
 * KI im EVENTLINE-Buero — Aufnahme per MediaRecorder → POST /api/ki/diktat
 * → Warteschlange → Rig (Whisper); nichts geht an Google oder einen
 * KI-Anbieter. Vor jeder Aufnahme zaehlt GET /api/ki/status (Ergebnis 60 s
 * im Modul-Speicher, jede Stoerung = offline). Offline oder kein
 * MediaRecorder (iOS): Browser-Spracherkennung wie bisher, mit sichtbarem
 * Hinweis. Mikrofon verweigert: Abbruch mit Toast (der Browser-Weg
 * scheitert daran genauso). Die fertige Aufnahme bleibt bis zur
 * erfolgreichen Erkennung erreichbar — eine Stoerung (Netz, Serverfehler) wird
 * einmal automatisch wiederholt; danach, und sofort bei «offline» (503) oder
 * «beschaeftigt» (504), «Nochmals senden» im Fehler-Toast (der Toast traegt
 * seine Aufnahme). Nach «Stopp» bleibt der Diktieren-Knopf bis zum Abschluss
 * der Aufnahme (onstop) gesperrt und Erfassen waehrend Aufnahme und
 * Erkennung — sonst startete ein zweites Diktat, bevor das erste erkannt
 * ist, oder der erkannte Text kaeme ins eben geleerte Feld.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { validateFileSize } from "@/lib/file-upload";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Mic, MicOff, Paperclip, Send, Loader2, Check, AlertTriangle, Copy,
  FileText, Image as ImageIcon, Trash2, RefreshCw, ChevronRight,
} from "lucide-react";

type Item = {
  id: string;
  kind: "text" | "datei";
  content: string | null;
  file_name: string | null;
  mime_type: string | null;
  created_at: string;
  ai_status: "neu" | "verarbeitet" | "fehler";
  ai_error: string | null;
  absender?: string | null;
  author?: { full_name: string | null } | null;
};

/** Zentrale Weiterleitungs-Adresse — Mails landen automatisch im Eingang
 *  des passenden Auftrags (/api/inbound/mail ordnet per Nummer/KI zu). */
const EINGANG_MAIL = "auftrag@in.eventline-basel.com";

// Minimale Typung der Web Speech API (nicht in lib.dom enthalten).
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void; stop: () => void;
};

// ─── Lokales Diktat — Schnittstellen laut SPEC (V4) ────────────────
/** Erreichbarkeit der lokalen KI (GET /api/ki/status): das Ergebnis gilt
 *  60 s fuer alle Eingang-Felder (Modul-Speicher, kein Browser-Speicher). */
const KI_STATUS_MERKEN_MS = 60_000;
const KI_STATUS_TIMEOUT_MS = 3_000;
/** Nach 5 Minuten stoppt die Aufnahme von selbst. */
const DIKTAT_MAX_SEK = 5 * 60;
/** Bitrate der Aufnahme: fuer Sprache reichlich, und 5 Minuten bleiben bei
 *  ~2,4 MB — die Route nimmt hoechstens 10 MB, Vercel nur ~4,5 MB pro Anfrage. */
const DIKTAT_BITRATE = 64_000;
/** Die Route wartet bis 60 s auf die lokale KI, gekappt an ihrer Restlaufzeit
 *  (maxDuration 120 s); der Upload kommt obendrauf (langsames Handy-Netz).
 *  Der Client muss die volle Routen-Laufzeit abwarten koennen — 130 s. Danach
 *  ist die Anfrage sicher tot: reine Notbremse gegen haengende Verbindungen. */
const DIKTAT_ANFRAGE_TIMEOUT_MS = 130_000;
const HINWEIS_BROWSER_OFFLINE = "Diktat über den Browser (Google) — lokale KI nicht erreichbar";
const HINWEIS_BROWSER_NICHT_UNTERSTUETZT = "Diktat über den Browser (Google) — lokale Aufnahme wird von diesem Browser nicht unterstützt";
const HINWEIS_BROWSER_KEIN_MIKROFON = "Diktat über den Browser (Google) — Mikrofon für die lokale Aufnahme nicht verfügbar";
const MELDUNG_MIKROFON_VERWEIGERT = "Mikrofon nicht freigegeben — bitte im Browser erlauben";

/** Fertige Aufnahme — haengt bis zur erfolgreichen Erkennung am «Nochmals senden»-Toast. */
type Aufnahme = { blob: Blob; mime: string };
/** Ergebnis des lokalen Starts: laeuft | abgebrochen (Mikrofon verweigert →
 *  Toast, oder Unmount) | kein-mikrofon / nicht-unterstuetzt → Browser-Weg. */
type LokalStart = "laeuft" | "abgebrochen" | "kein-mikrofon" | "nicht-unterstuetzt";
/** Antwort von POST /api/ki/diktat: text (200, "" = nichts erkannt) |
 *  offline (503) | beschaeftigt (504 oder eigene Zeitueberschreitung) |
 *  fehler (Rig meldet Fehler 502, Netz, sonst) — `wiederholen`: ein zweiter
 *  Versuch kann helfen (Netz, Serverfehler), bei 4xx nicht. */
type DiktatAntwort =
  | { art: "text"; text: string }
  | { art: "offline" }
  | { art: "beschaeftigt" }
  | { art: "fehler"; meldung: string | null; wiederholen: boolean };

/** Zuletzt bekannte Erreichbarkeit der lokalen KI (Modul-Speicher). */
let kiOnlineGemerkt: { online: boolean; ts: number } | null = null;

function merkeKiOnline(online: boolean) {
  kiOnlineGemerkt = { online, ts: Date.now() };
}

/** GET /api/ki/status → online, vor jeder lokalen Aufnahme; das Ergebnis
 *  gilt 60 s. Jede Stoerung (Netz, ≠2xx, 3 s ohne Antwort) zaehlt als offline. */
async function pruefeKiOnline(): Promise<boolean> {
  if (kiOnlineGemerkt && Date.now() - kiOnlineGemerkt.ts < KI_STATUS_MERKEN_MS) return kiOnlineGemerkt.online;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KI_STATUS_TIMEOUT_MS);
  let online = false;
  try {
    const res = await fetch("/api/ki/status", { cache: "no-store", signal: ctrl.signal });
    const j = res.ok ? ((await res.json().catch(() => null)) as { online?: unknown } | null) : null;
    online = j?.online === true;
  } catch {
    online = false;
  } finally {
    clearTimeout(timer);
  }
  merkeKiOnline(online);
  return online;
}

/** Opus in WebM (Chrome/Firefox/Edge), sonst MP4 (Safari/iOS); null = Browser-Standard. */
function waehleAufnahmeMime(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function dateiEndung(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Ein Versuch: Audio an POST /api/ki/diktat (Warteschlange → lokale KI,
 *  SPEC V4) → erkannter Text (getrimmt) oder die Art der Stoerung. */
async function sendeDiktat({ blob, mime }: Aufnahme, extern?: AbortSignal): Promise<DiktatAntwort> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIKTAT_ANFRAGE_TIMEOUT_MS);
  // Unmount der Komponente bricht den Upload ab (sonst liefe er samt
  // Rig-Verarbeitung bis 60 s umsonst weiter).
  if (extern?.aborted) ctrl.abort();
  else extern?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const fd = new FormData();
    fd.append("audio", blob, `diktat.${dateiEndung(mime)}`);
    const res = await fetch("/api/ki/diktat", { method: "POST", body: fd, signal: ctrl.signal });
    const j = (await res.json().catch(() => null)) as
      { success?: unknown; text?: unknown; offline?: unknown; zeitueberschreitung?: unknown; error?: unknown } | null;
    if (res.ok && j?.success === true && typeof j.text === "string") return { art: "text", text: j.text.trim() };
    if (res.status === 503 && j?.offline === true) return { art: "offline" };
    if (res.status === 504 || j?.zeitueberschreitung === true) return { art: "beschaeftigt" };
    const meldung = typeof j?.error === "string" && j.error.trim()
      ? j.error.trim()
      : res.status === 413 ? "Aufnahme zu gross für die lokale KI — bitte kürzer diktieren" : null;
    return { art: "fehler", meldung, wiederholen: res.status >= 500 };
  } catch {
    // Eigene Zeitueberschreitung = die lokale KI war zu lange belegt; sonst Netzfehler.
    return ctrl.signal.aborted ? { art: "beschaeftigt" } : { art: "fehler", meldung: null, wiederholen: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Erkannten Text sauber anhaengen — endet der bestehende Text mit
 *  Leerzeichen oder Absatz, bleibt das so; sonst ein Leerzeichen dazwischen. */
function haengeAn(bestehend: string, neu: string): string {
  if (!bestehend.trim()) return neu;
  if (/\s$/.test(bestehend)) return bestehend + neu;
  return bestehend + " " + neu;
}

function fmtDauer(sek: number): string {
  const m = Math.floor(sek / 60), s = sek % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtWann(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function EingangErfassung({ jobId, onJobChanged }: { jobId: string; onJobChanged?: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  // Diktat: Status-Pruefung/Mikrofon laeuft (Spinner im Knopf, noch keine Aufnahme).
  const [startet, setStartet] = useState(false);
  // Audio ist bei der lokalen KI, Text folgt («Wird erkannt…»).
  const [erkennen, setErkennen] = useState(false);
  // «Stopp» gedrueckt, onstop noch nicht da (letzter Datenblock) — der
  // Diktieren-Knopf bleibt bis dahin gesperrt, sonst startete ein zweites
  // Diktat, bevor die Aufnahme abgeschlossen und erkannt ist.
  const [stoppt, setStoppt] = useState(false);
  const [diktatModus, setDiktatModus] = useState<"lokal" | "browser" | null>(null);
  const [dauerSek, setDauerSek] = useState(0);
  // Hinweiszeile unter dem Feld, solange der Browser-Weg (Google) laeuft.
  const [browserHinweis, setBrowserHinweis] = useState<string | null>(null);
  const [verlaufOffen, setVerlaufOffen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");
  // Aktueller Feldtext fuer den Browser-Weg — startDiktat wartet vorher auf
  // die Erreichbarkeits-Pruefung, die Closure waere sonst veraltet.
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  // true nach Unmount: laufende lokale Aufnahme wird verworfen, nicht hochgeladen.
  const verworfenRef = useRef(false);
  // Erkennungsversuch laeuft (Ref statt State: «Nochmals senden» im Toast
  // muss den aktuellen Stand sehen, nicht den der Render-Closure).
  const erkennenLaeuftRef = useRef(false);
  // Startphase eines Diktats (Status-Pruefung, Mikrofon-Prompt) — Ref,
  // damit «Nochmals senden» im Toast sie sieht, bevor ein Recorder existiert.
  const startetRef = useRef(false);
  // Laufender Upload an /api/ki/diktat — beim Unmount abbrechen.
  const diktatAbortRef = useRef<AbortController | null>(null);
  // Offener Fehler-Toast «Nochmals senden» — bei neuem Versuch/Unmount schliessen.
  const fehlerToastRef = useRef<string | number | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_inbox_items")
      .select("id, kind, content, file_name, mime_type, created_at, ai_status, ai_error, absender, author:profiles!job_inbox_items_created_by_fkey(full_name)")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });
    if (error) { toast.error("Verlauf konnte nicht geladen werden"); setItems([]); return; }
    setItems((data ?? []) as unknown as Item[]);
  }, [supabase, jobId]);

  useEffect(() => { load(); }, [load]);

  // Selbstheilung: Elemente, die laenger als 90s auf "neu" stehen, sind
  // haengengeblieben (z.B. Ablegen genau waehrend eines Deploys) — die
  // Verarbeitung ist synchron und dauert nie so lange. Beim Mount einmalig
  // neu anstossen (Ref verhindert Doppel-Trigger).
  const retriggeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!items) return;
    // AELTESTE zuerst nachverarbeiten (Chronologie-Schutz, Vorfall INT-26309).
    const nachzuholen = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    // Auf die aeltesten 3 gedeckelt — mehr wuerde die serielle KI-Kette
    // minutenlang blockieren; der Rest zieht der Cron nach.
    let angestossen = 0;
    for (const i of nachzuholen) {
      if (angestossen >= 3) break;
      if (i.ai_status !== "neu") continue;
      if (Date.now() - new Date(i.created_at).getTime() < 90_000) continue;
      if (retriggeredRef.current.has(i.id)) continue;
      retriggeredRef.current.add(i.id);
      angestossen++;
      verarbeite(i.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Alle KI-Verarbeitungen strikt NACHEINANDER (parallele Laeufe
  // ueberschreiben sich gegenseitig die Zusammenfassung — Vorfall
  // "6 Podeste" ging verloren).
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const verarbeite = useCallback(async (itemId: string) => {
    const lauf = queueRef.current.then(() => verarbeiteJetzt(itemId));
    queueRef.current = lauf.catch(() => {});
    return lauf;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, supabase, onJobChanged]);

  const verarbeiteJetzt = useCallback(async (itemId: string) => {
    try {
      const res = await fetch("/api/ai/eingang", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, item_id: itemId }),
      });
      const j = await res.json().catch(() => ({}));
      setItems((prev) => (prev ?? []).map((i) =>
        i.id === itemId
          ? { ...i, ai_status: res.ok && j.success ? "verarbeitet" : "fehler", ai_error: res.ok && j.success ? null : (j.error ?? "Fehler") }
          : i,
      ));
      if (!res.ok || !j.success) toast.error(j.error ?? "KI-Verarbeitung fehlgeschlagen");
      else {
        if (j.datum_vorschlag) {
          toast.info("Die KI schlägt ein neues Event-Datum vor — siehe Vorschläge.", { duration: 8000 });
        }
        if (j.termin_vorschlaege > 0) {
          toast.info(`Die KI schlägt ${j.termin_vorschlaege === 1 ? "einen Termin" : `${j.termin_vorschlaege} Termine`} vor.`, { duration: 8000 });
        }
        // Uebersicht auffrischen — Zusammenfassung und Vorschlaege
        // entstehen direkt daneben.
        onJobChanged?.();
      }
    } catch {
      setItems((prev) => (prev ?? []).map((i) => (i.id === itemId ? { ...i, ai_status: "fehler", ai_error: "Netzwerkfehler" } : i)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, supabase, onJobChanged]);

  async function erfassen() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    stopDiktat();
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("job_inbox_items")
      .insert({ job_id: jobId, kind: "text", content: t, created_by: user?.id })
      .select("id, kind, content, file_name, mime_type, created_at, ai_status, ai_error")
      .single();
    setSending(false);
    if (error || !data) { toast.error("Erfassen fehlgeschlagen" + (error ? ": " + error.message : "")); return; }
    setText("");
    setItems((prev) => [{ ...(data as unknown as Item), author: null }, ...(prev ?? [])]);
    verarbeite(data.id);
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    for (const file of Array.from(files)) {
      if (!validateFileSize(file)) continue;
      const path = `auftraege/${jobId}/eingang/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { contentType: file.type });
      if (upErr) { toast.error(`Upload «${file.name}» fehlgeschlagen: ` + upErr.message); continue; }
      const { data, error } = await supabase
        .from("job_inbox_items")
        .insert({ job_id: jobId, kind: "datei", file_path: path, file_name: file.name, mime_type: file.type || null, created_by: user?.id })
        .select("id, kind, content, file_name, mime_type, created_at, ai_status, ai_error")
        .single();
      if (error || !data) { toast.error(`«${file.name}» konnte nicht abgelegt werden`); continue; }
      // Zusaetzlich als Dokument am Auftrag registrieren (gleiche Storage-
      // Datei) — erfasste Dateien gehoeren auch in den Dokumente-Tab.
      if (user?.id) {
        await supabase.from("documents").insert({
          name: file.name, storage_path: path, file_size: file.size,
          mime_type: file.type || null, job_id: jobId, uploaded_by: user.id,
        });
      }
      setItems((prev) => [{ ...(data as unknown as Item), author: null }, ...(prev ?? [])]);
      verarbeite(data.id);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function loeschen(item: Item) {
    const ok = await confirm({
      title: "Element löschen?",
      message: "Bereits daraus entstandene Positionen und Kundenwünsche bleiben bestehen.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("job_inbox_items").delete().eq("id", item.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    setItems((prev) => (prev ?? []).filter((i) => i.id !== item.id));
  }

  // ─── Diktat: lokale KI zuerst, Browser (Google) als Rueckfall ────
  async function startDiktat() {
    // State UND synchrone Refs pruefen: nach «Stopp» ist recording schon
    // false, der Recorder aber bis zum onstop noch da.
    if (startet || recording || erkennen || stoppt || !erkennenMoeglich()) return;
    setStartet(true);
    startetRef.current = true;
    verworfenRef.current = false;
    // Ein neues Diktat ersetzt den offenen «Nochmals senden»-Toast ab Klick,
    // nicht erst ab Aufnahmestart (sonst Race mit der Startphase).
    schliesseFehlerToast();
    try {
      // Nach jedem await: Komponente inzwischen abgebaut? Dann nichts mehr starten.
      const lokal = await pruefeKiOnline();
      if (verworfenRef.current) return;
      if (!lokal) { startBrowserDiktat(HINWEIS_BROWSER_OFFLINE); return; }
      // iOS/aeltere Safari: ohne MediaRecorder gibt es keinen lokalen Weg.
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        startBrowserDiktat(HINWEIS_BROWSER_NICHT_UNTERSTUETZT);
        return;
      }
      const ergebnis = await startLokaleAufnahme();
      if (verworfenRef.current) return;
      if (ergebnis === "kein-mikrofon") startBrowserDiktat(HINWEIS_BROWSER_KEIN_MIKROFON);
      else if (ergebnis === "nicht-unterstuetzt") startBrowserDiktat(HINWEIS_BROWSER_NICHT_UNTERSTUETZT);
    } finally {
      startetRef.current = false;
      setStartet(false);
    }
  }

  /** Aufnahme per MediaRecorder. Mikrofon verweigert → Toast und Abbruch (der
   *  Browser-Weg scheitert daran genauso); Recorder nicht baubar/startbar →
   *  Aufrufer nimmt den Browser-Weg mit Hinweis. */
  async function startLokaleAufnahme(): Promise<LokalStart> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError") {
        toast.error(MELDUNG_MIKROFON_VERWEIGERT);
        return "abgebrochen";
      }
      // z.B. NotReadableError (Mikrofon anderweitig belegt)
      return "kein-mikrofon";
    }
    if (verworfenRef.current) { stream.getTracks().forEach((t) => t.stop()); return "abgebrochen"; }
    const mime = waehleAufnahmeMime();
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: DIKTAT_BITRATE });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      return "nicht-unterstuetzt";
    }
    const chunks: Blob[] = [];
    let abgeschlossen = false;
    // Sekundenzaehler + 5-Minuten-Stopp; erst NACH erfolgreichem start() gesetzt.
    let timer: ReturnType<typeof setInterval> | null = null;
    // Genau einmal abschliessen — ob per Stopp, Fehler oder Unmount.
    const abschliessen = (ok: boolean) => {
      if (abgeschlossen) return;
      abgeschlossen = true;
      if (timer) clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (mediaRecRef.current === mr) mediaRecRef.current = null;
      setRecording(false);
      setStoppt(false);
      setDauerSek(0);
      if (verworfenRef.current) return;
      if (!ok || chunks.length === 0) {
        toast.error("Lokale Erkennung fehlgeschlagen — Text bitte tippen");
        return;
      }
      const effektiv = mr.mimeType || mime || "audio/webm";
      void erkenneLokal({ blob: new Blob(chunks, { type: effektiv }), mime: effektiv });
    };
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onerror = () => {
      abschliessen(false);
      if (mr.state !== "inactive") { try { mr.stop(); } catch { /* bereits gestoppt */ } }
    };
    mr.onstop = () => abschliessen(true);
    mediaRecRef.current = mr;
    try {
      mr.start(1000);
    } catch {
      // Safari: Zeitscheibe/Codec nicht unterstuetzt (NotSupportedError) —
      // Mikrofon sofort freigeben, kein Zaehler, Aufrufer nimmt den Browser-Weg.
      abgeschlossen = true;
      stream.getTracks().forEach((t) => t.stop());
      mediaRecRef.current = null;
      setDauerSek(0);
      return "nicht-unterstuetzt";
    }
    const startTs = Date.now();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - startTs) / 1000);
      setDauerSek(s);
      if (s >= DIKTAT_MAX_SEK && mr.state === "recording") {
        toast.info("Aufnahme nach 5 Minuten automatisch beendet — Text wird erkannt.");
        stopDiktat(); // wie ein Druck auf «Stopp» (Knopf bleibt bis onstop gesperrt)
      }
    }, 500);
    // Ein offener «Nochmals senden»-Toast gehoert zur vorigen Aufnahme — weg damit.
    schliesseFehlerToast();
    setDiktatModus("lokal");
    setBrowserHinweis(null);
    setDauerSek(0);
    setRecording(true);
    return "laeuft";
  }

  function schliesseFehlerToast() {
    if (fehlerToastRef.current === null) return;
    toast.dismiss(fehlerToastRef.current);
    fehlerToastRef.current = null;
  }

  /** Nichts in Arbeit: kein Erkennungsversuch, kein Recorder (auch keiner,
   *  der nach «Stopp» noch auf onstop wartet), kein Browser-Diktat, keine
   *  Startphase — Voraussetzung fuer einen Erkennungsversuch wie fuer ein
   *  neues Diktat. Synchrone Refs statt State: Toast-Klicks und onstop
   *  saehen sonst eine veraltete Render-Closure. */
  function erkennenMoeglich() {
    return !erkennenLaeuftRef.current && !mediaRecRef.current && !recRef.current && !startetRef.current;
  }

  /** Fehler-Toast mit «Nochmals senden». Die Aufnahme haengt am Toast, bis
   *  sie erkannt ist — nicht an einem geteilten Merker, den die naechste
   *  Aufnahme ueberschreiben koennte. */
  function zeigeNochmalsSenden(titel: string, aufnahme: Aufnahme) {
    fehlerToastRef.current = toast.error(titel, {
      duration: Infinity,
      action: {
        label: "Nochmals senden",
        onClick: (e) => {
          // sonner schliesst den Toast bei jedem Klick — bleibt der Klick
          // ohne Wirkung (Diktat laeuft gerade), Toast offen lassen.
          if (!erkennenMoeglich()) { e.preventDefault(); return; }
          void erkenneLokal(aufnahme);
        },
      },
    });
  }

  /** Aufnahme an die lokale KI (POST /api/ki/diktat) → erkannter Text ans
   *  Feld. Das Feld bleibt waehrenddessen bedienbar — darum funktionales
   *  setText. Eine Stoerung (Netz, Serverfehler) wird EINMAL automatisch
   *  wiederholt; «offline» (503) und «beschaeftigt» (504) nicht — ein
   *  sofortiger zweiter Versuch aendert daran nichts. Danach bietet der
   *  Fehler-Toast «Nochmals senden» an. */
  async function erkenneLokal(aufnahme: Aufnahme) {
    // Laeuft gerade ein Versuch, eine Aufnahme oder ein Diktat, die Aufnahme
    // NICHT still verwerfen — sie bleibt ueber «Nochmals senden» erreichbar.
    if (!erkennenMoeglich()) {
      zeigeNochmalsSenden("Aufnahme noch nicht erkannt — ein anderes Diktat ist noch in Arbeit", aufnahme);
      return;
    }
    erkennenLaeuftRef.current = true;
    // Gleiches Ladefeedback wie direkt nach der Aufnahme (Chip «lokal» + «Wird erkannt…»).
    setDiktatModus("lokal");
    setErkennen(true);
    const abbruch = new AbortController();
    diktatAbortRef.current = abbruch;
    try {
      let antwort = await sendeDiktat(aufnahme, abbruch.signal);
      if (antwort.art === "fehler" && antwort.wiederholen && !verworfenRef.current) antwort = await sendeDiktat(aufnahme, abbruch.signal);
      if (verworfenRef.current) return;
      if (antwort.art !== "text") {
        // Offline: das NAECHSTE Diktat geht gleich ueber den Browser (mit
        // Hinweiszeile) — diese Aufnahme bleibt fuer «Nochmals senden».
        if (antwort.art === "offline") merkeKiOnline(false);
        zeigeNochmalsSenden(
          antwort.art === "offline"
            ? "Lokale KI nicht erreichbar"
            : antwort.art === "beschaeftigt"
              ? "Lokale KI ist gerade beschäftigt"
              : (antwort.meldung ?? "Lokale Erkennung fehlgeschlagen"),
          aufnahme,
        );
        return;
      }
      merkeKiOnline(true);
      const neu = antwort.text;
      if (!neu) { toast.info("Nichts erkannt — bitte nochmals diktieren oder tippen."); return; }
      setText((prev) => haengeAn(prev, neu));
    } finally {
      erkennenLaeuftRef.current = false;
      setErkennen(false);
    }
  }

  // Browser-Weg (Web Speech API, Chrome → Google) — Mechanik wie bisher,
  // neu nur die Hinweiszeile unter dem Feld.
  function startBrowserDiktat(hinweis: string) {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { toast.error("Diktat wird von diesem Browser nicht unterstützt — bitte tippen oder die Diktierfunktion der Handy-Tastatur nutzen."); return; }
    const rec = new Ctor();
    rec.lang = "de-CH";
    rec.continuous = true;
    rec.interimResults = true;
    const aktuell = textRef.current;
    baseTextRef.current = aktuell ? aktuell.trimEnd() + " " : "";
    rec.onresult = (e) => {
      let final = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      setText(baseTextRef.current + final + interim);
    };
    rec.onerror = (e) => {
      setRecording(false); setBrowserHinweis(null); recRef.current = null;
      const grund = e.error ?? "";
      // Nutzer-Abbruch bzw. nichts gesagt → kein Fehler fuer den Nutzer.
      if (grund === "aborted" || grund === "no-speech") return;
      if (grund === "not-allowed") { toast.error(MELDUNG_MIKROFON_VERWEIGERT); return; }
      toast.error(`Diktat über den Browser fehlgeschlagen${grund ? ` (${grund})` : ""} — bitte tippen`);
    };
    rec.onend = () => { setRecording(false); setBrowserHinweis(null); recRef.current = null; };
    recRef.current = rec;
    setDiktatModus("browser");
    setBrowserHinweis(hinweis);
    setRecording(true);
    rec.start();
  }

  function stopDiktat() {
    // Browser-Weg
    recRef.current?.stop();
    recRef.current = null;
    // Lokaler Weg: stop() loest (asynchron, nach dem letzten Datenblock)
    // onstop aus → abschliessen() startet die Erkennung. Bis dahin bleibt
    // der Diktieren-Knopf gesperrt (stoppt). Nur Refs und Setter anfassen —
    // so braucht der Unmount-Effekt diese Funktion nicht als Abhaengigkeit.
    const mr = mediaRecRef.current;
    if (mr && mr.state !== "inactive") {
      setStoppt(true);
      try { mr.stop(); } catch { setStoppt(false); /* bereits gestoppt — onstop kommt */ }
    }
    setRecording(false);
    setBrowserHinweis(null);
  }

  // Unmount: laufende Aufnahme verwerfen (Mikrofon freigeben, kein Upload),
  // offenen «Nochmals senden»-Toast samt seiner Aufnahme loslassen.
  useEffect(() => () => {
    verworfenRef.current = true;
    diktatAbortRef.current?.abort();
    schliesseFehlerToast();
    stopDiktat();
  }, []);

  const inVerarbeitung = (items ?? []).filter((i) => i.ai_status === "neu").length;
  const fehler = (items ?? []).filter((i) => i.ai_status === "fehler").length;
  // Erkennungsphase: Aufnahme wird abgeschlossen (bis onstop) oder liegt bei der lokalen KI.
  const erkennung = stoppt || erkennen;
  // Erfassen waehrend lokaler Aufnahme/Erkennung gesperrt: es leerte das
  // Feld, der erkannte Text kaeme danach ins leere Feld.
  const diktatSperrt = diktatModus === "lokal" && (recording || erkennung);

  return (
    // EINE Karte (2026-10-02, cleaner — vorher Karte in Karte + loser Link):
    // Eingabe + Werkzeuge, darunter eine dezente Fusszeile mit dem Verlauf
    // (bewusst nur ein kleiner Text-Link, Leo 2026-09-26) und der
    // Weiterleitungs-Adresse.
    // flex-col + Textfeld flex-1: steht die Karte neben den KI-Vorschlaegen,
    // waechst das Feld auf deren Hoehe — beide Karten enden buendig.
    <section className="rounded-2xl border border-border bg-card flex flex-col min-w-0">
      <div className="flex-1 flex flex-col gap-2.5 p-3">
      {/* Feld im selben Stil wie das Notizen-Feld (die globale Dark-Regel
          fuer Eingabefelder setzt Grund und Rahmen mit !important — darum
          zeigt ein Ring statt des Rahmens das laufende Diktat). */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          recording
            ? (diktatModus === "lokal" ? "Sprich jetzt — Aufnahme läuft…" : "Sprich jetzt — Diktat läuft…")
            : erkennung ? "Lokale KI erkennt den Text…" : "Notiz, Mail-Text oder Abmachung erfassen…"
        }
        rows={2}
        style={{ fieldSizing: "content" } as React.CSSProperties}
        className={`block w-full flex-1 min-h-[4rem] max-h-[28rem] px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring ${recording ? "ring-2 ring-red-500/60" : ""}`}
      />
      {/* Browser-Weg sichtbar machen — der Nutzer soll wissen, dass der Ton
          jetzt zu Google geht und nicht zur lokalen KI. */}
      {recording && browserHinweis && (
        <p className="-mt-1 text-[11px] text-muted-foreground">{browserHinweis}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={recording ? stopDiktat : startDiktat}
            disabled={startet || erkennung}
            className={`kasten ${recording ? "kasten-red" : "kasten-muted"}`}
            data-tooltip={recording ? "Diktat beenden" : "Diktieren"}
          >
            {startet || erkennung
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : recording ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            {erkennung ? "Wird erkannt…" : recording ? "Stopp" : "Diktieren"}
            {recording && diktatModus === "lokal" && (
              <span className="tabular-nums font-normal opacity-80">{fmtDauer(dauerSek)}</span>
            )}
          </button>
          {diktatModus === "lokal" && (recording || erkennung) && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300 shrink-0"
              data-tooltip="Diktat läuft über die lokale KI im EVENTLINE-Büro — nichts geht an Google oder einen KI-Anbieter. Ist sie nicht erreichbar, übernimmt die Spracherkennung des Browsers (Google)."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />lokal
            </span>
          )}
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="kasten kasten-muted">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Datei
          </button>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => uploadFiles(e.target.files)} />
        </div>
        {/* Tooltip am Wrapper: ein deaktivierter Kasten-Knopf bekommt keine
            Maus-Ereignisse (.kasten:disabled = pointer-events-none), der
            TooltipLayer saehe ihn nicht. */}
        <span className="inline-flex" data-tooltip={diktatSperrt ? "Zuerst das Diktat beenden" : undefined}>
          <button type="button" onClick={erfassen} disabled={!text.trim() || sending || diktatSperrt} className="kasten kasten-red">
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Erfassen
          </button>
        </span>
      </div>
      </div>

      <div className="flex items-center justify-between gap-x-3 gap-y-1 flex-wrap border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setVerlaufOffen((o) => !o)}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${verlaufOffen ? "rotate-90" : ""}`} />
          Verlauf
          {items === null
            ? " …"
            : items.length === 0
              ? <span className="text-muted-foreground/70">· noch nichts erfasst</span>
              : (
                <>
                  <span>· {items.length} {items.length === 1 ? "Element" : "Elemente"}</span>
                  {inVerarbeitung > 0 && <> · <Loader2 className="inline h-3 w-3 animate-spin" /> {inVerarbeitung} in Verarbeitung</>}
                  {fehler > 0 && <span className="text-amber-600 dark:text-amber-400">· {fehler} Fehler</span>}
                </>
              )}
        </button>
        <span
          className="inline-flex items-center gap-1.5 min-w-0"
          data-tooltip="Kunden-Mails an diese Adresse weiterleiten (Auftragsnummer im Betreff) — sie landen hier"
        >
          Mails an
          <button
            type="button"
            onClick={() => { navigator.clipboard.writeText(EINGANG_MAIL).then(() => toast.success("Adresse kopiert")); }}
            className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground bg-muted/50 border border-border rounded-md px-1.5 py-0.5 hover:border-foreground/40"
            data-tooltip="Adresse kopieren"
            data-tooltip-side="bottom"
          >
            {EINGANG_MAIL}
            <Copy className="h-3 w-3 text-muted-foreground" />
          </button>
        </span>
      </div>

      {verlaufOffen && (
        <div className="border-t border-border/60 px-3">
        {items === null || items.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-3 px-1">Noch nichts erfasst.</p>
        ) : (
          <ul className="divide-y divide-border max-h-96 overflow-y-auto">
            {items.map((i) => (
              <li key={i.id} className="px-1 py-2.5 flex items-start gap-2.5 group">
                <span className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  {i.kind === "text" ? <FileText className="h-3.5 w-3.5 text-muted-foreground" /> : <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                </span>
                <div className="flex-1 min-w-0">
                  {i.kind === "text" ? (
                    <p className="text-sm whitespace-pre-wrap break-words line-clamp-4">{i.content}</p>
                  ) : (
                    <p className="text-sm font-medium truncate">{i.file_name}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {fmtWann(i.created_at)}{i.author?.full_name ? ` · ${i.author.full_name}` : i.absender ? ` · per Mail von ${i.absender}` : ""}
                  </p>
                </div>
                <span className="shrink-0 mt-0.5 flex items-center gap-1">
                  {i.ai_status === "neu" && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> wird einsortiert…</span>
                  )}
                  {i.ai_status === "verarbeitet" && (
                    <span className="text-[10px] text-green-700 dark:text-green-400 flex items-center gap-1"><Check className="h-3 w-3" /> Verarbeitet</span>
                  )}
                  {i.ai_status === "fehler" && (
                    <>
                      <span className="text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1" data-tooltip={i.ai_error ?? undefined}>
                        <AlertTriangle className="h-3 w-3" /> KI-Fehler
                      </span>
                      <button
                        type="button"
                        onClick={() => { setItems((prev) => (prev ?? []).map((x) => x.id === i.id ? { ...x, ai_status: "neu" } : x)); verarbeite(i.id); }}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
                        data-tooltip="Nochmals verarbeiten"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => loeschen(i)}
                    className="p-1 rounded text-muted-foreground/40 hover:text-red-600 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                    data-tooltip="Löschen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        </div>
      )}
      {ConfirmModalElement}
    </section>
  );
}
