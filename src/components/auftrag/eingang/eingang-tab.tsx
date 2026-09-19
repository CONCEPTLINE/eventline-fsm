"use client";

/**
 * EingangTab — das Rohmaterial-Postfach eines Auftrags: hier wirft das Team
 * alles Unsortierte rein (diktierte/getippte Notiz, weitergeleitete Mail als
 * Text, Screenshot, Foto, PDF). Jedes Element wird sofort von der KI gelesen
 * (/api/ai/eingang) — sie pflegt daraus Zusammenfassung + Zusagen auf der
 * Uebersicht. Diktat via Web Speech API (Handy/Chrome), Fallback: tippen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { validateFileSize } from "@/lib/file-upload";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Inbox, Mic, MicOff, Paperclip, Send, Loader2, Check, AlertTriangle, Copy,
  FileText, Image as ImageIcon, Trash2, RefreshCw,
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

function fmtWann(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function EingangTab({ jobId, onJobChanged }: { jobId: string; onJobChanged?: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_inbox_items")
      .select("id, kind, content, file_name, mime_type, created_at, ai_status, ai_error, absender, author:profiles!job_inbox_items_created_by_fkey(full_name)")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });
    if (error) { toast.error("Eingang konnte nicht geladen werden"); setItems([]); return; }
    setItems((data ?? []) as unknown as Item[]);
  }, [supabase, jobId]);

  useEffect(() => { load(); }, [load]);

  // Selbstheilung: Elemente, die laenger als 90s auf "neu" stehen, sind
  // haengengeblieben (z.B. Ablegen genau waehrend eines Deploys) — die
  // Verarbeitung ist synchron und dauert nie so lange. Beim Oeffnen des
  // Tabs einmalig neu anstossen (Ref verhindert Doppel-Trigger).
  const retriggeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!items) return;
    for (const i of items) {
      if (i.ai_status !== "neu") continue;
      if (Date.now() - new Date(i.created_at).getTime() < 90_000) continue;
      if (retriggeredRef.current.has(i.id)) continue;
      retriggeredRef.current.add(i.id);
      verarbeite(i.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /** KI auf ein Element loslassen; Status-Updates landen in der Liste. */
  const verarbeite = useCallback(async (itemId: string) => {
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
        if (j.neue_zusagen > 0) toast.success(`${j.neue_zusagen} neue Zusage${j.neue_zusagen === 1 ? "" : "n"} erkannt — siehe Übersicht`);
        // Datum wird NIE automatisch geaendert — der Vorschlag liegt jetzt
        // PERSISTENT am Auftrag (Banner auf der Uebersicht, bis Umdatieren/
        // Verwerfen). Hier nur der Hinweis.
        if (j.datum_vorschlag) {
          toast.info("Die KI schlägt ein neues Event-Datum vor — Entscheidung auf der Übersicht.", { duration: 8000 });
          onJobChanged?.();
        }
      }
    } catch {
      setItems((prev) => (prev ?? []).map((i) => (i.id === itemId ? { ...i, ai_status: "fehler", ai_error: "Netzwerkfehler" } : i)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, supabase, onJobChanged]);

  async function ablegen() {
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
    if (error || !data) { toast.error("Ablegen fehlgeschlagen" + (error ? ": " + error.message : "")); return; }
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
      setItems((prev) => [{ ...(data as unknown as Item), author: null }, ...(prev ?? [])]);
      verarbeite(data.id);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function loeschen(item: Item) {
    const ok = await confirm({
      title: "Eingang-Element löschen?",
      message: "Bereits daraus entstandene Zusagen/Zusammenfassung bleiben bestehen.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("job_inbox_items").delete().eq("id", item.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    setItems((prev) => (prev ?? []).filter((i) => i.id !== item.id));
  }

  // ─── Diktat (Web Speech API) ────────────────────────────────────
  function startDiktat() {
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { toast.error("Diktat wird von diesem Browser nicht unterstützt — bitte tippen oder die Diktierfunktion der Handy-Tastatur nutzen."); return; }
    const rec = new Ctor();
    rec.lang = "de-CH";
    rec.continuous = true;
    rec.interimResults = true;
    baseTextRef.current = text ? text.trimEnd() + " " : "";
    rec.onresult = (e) => {
      let final = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      setText(baseTextRef.current + final + interim);
    };
    rec.onerror = () => { setRecording(false); recRef.current = null; };
    rec.onend = () => { setRecording(false); recRef.current = null; };
    recRef.current = rec;
    setRecording(true);
    rec.start();
  }

  function stopDiktat() {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
  }

  useEffect(() => () => stopDiktat(), []);

  return (
    <div className="space-y-4">
      {/* ── Einwurf ────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold flex items-center gap-2 mb-1">
          <Inbox className="h-4 w-4 text-muted-foreground" /> Eingang
        </h2>
        <p className="text-[11px] text-muted-foreground mb-1.5">
          Alles hier ablegen — Telefonat-Notiz diktieren, Kunden-Mail einfügen, Screenshot oder PDF hochladen.
          Die KI liest mit und pflegt Zusammenfassung &amp; Zusagen auf der Übersicht.
        </p>
        <p className="text-[11px] text-muted-foreground mb-2.5 flex items-center gap-1.5 flex-wrap">
          Oder Mail weiterleiten an
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
          — mit der Auftragsnummer (z.B. INT-26308) im Betreff landet sie automatisch hier.
        </p>
        <div className={`rounded-xl border bg-muted/20 p-2.5 transition-colors ${recording ? "border-red-500" : "border-border focus-within:border-foreground/40"}`}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={recording ? "Sprich jetzt — Diktat läuft…" : "Notiz tippen oder Kunden-Mail hier einfügen…"}
            rows={3}
            className="w-full px-1 py-0.5 text-sm bg-transparent resize-y focus:outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-border/50">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={recording ? stopDiktat : startDiktat}
                className={`kasten ${recording ? "kasten-red" : "kasten-muted"}`}
                data-tooltip={recording ? "Diktat beenden" : "Diktieren"}
              >
                {recording ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {recording ? "Stopp" : "Diktieren"}
              </button>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="kasten kasten-muted">
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Datei
              </button>
              <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => uploadFiles(e.target.files)} />
            </div>
            <button type="button" onClick={ablegen} disabled={!text.trim() || sending} className="kasten kasten-red">
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Ablegen
            </button>
          </div>
        </div>
      </section>

      {/* ── Liste ──────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        {items === null ? (
          <div className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Laden…</div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Noch nichts abgelegt.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.id} className="px-4 py-2.5 flex items-start gap-2.5 group">
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
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> KI liest…</span>
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
      </section>
      {ConfirmModalElement}
    </div>
  );
}
