"use client";

// /bildschirm — Buero-Monitor verbinden, ohne Login (Leo 2026-10-02):
// Code anfordern → Mail an admin@eventline-basel.com → Code eintippen →
// Bildschirm ist verbunden (langlebiges Cookie) und zeigt das Wand-Dashboard.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { ArrowLeft, Loader2, Mail, Monitor } from "lucide-react";
import { toast } from "sonner";

const EMPFAENGER = "admin@eventline-basel.com";

export default function BildschirmVerbindenPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"pruefen" | "start" | "code">("pruefen");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [fehler, setFehler] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pruefLaeuft = useRef(false);

  // Schon verbunden? Dann direkt aufs Dashboard.
  useEffect(() => {
    let aktiv = true;
    fetch("/api/bildschirm/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!aktiv) return;
        if (j?.aktiv) router.replace("/bildschirm/dashboard");
        else setPhase("start");
      })
      .catch(() => { if (aktiv) setPhase("start"); });
    return () => { aktiv = false; };
  }, [router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function codeAnfordern() {
    setBusy(true);
    setFehler("");
    try {
      const res = await fetch("/api/bildschirm/code", { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setFehler(json?.error ?? "Code konnte nicht angefordert werden.");
        if (res.status === 429) { setPhase("code"); setCooldown(60); }
        return;
      }
      setPhase("code");
      setCooldown(60);
      setCode("");
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      setFehler("Keine Verbindung — bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  async function pruefen(c: string) {
    if (pruefLaeuft.current) return;
    pruefLaeuft.current = true;
    setBusy(true);
    setFehler("");
    try {
      const res = await fetch("/api/bildschirm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setFehler(json?.error ?? "Code konnte nicht geprüft werden.");
        setCode("");
        setTimeout(() => inputRef.current?.focus(), 50);
        return;
      }
      toast.success("Bildschirm verbunden");
      router.replace("/bildschirm/dashboard");
    } catch {
      setFehler("Keine Verbindung — bitte erneut versuchen.");
    } finally {
      setBusy(false);
      pruefLaeuft.current = false;
    }
  }

  // 6 Ziffern = sofort pruefen (kein Extra-Klick am Fernseher).
  useEffect(() => {
    if (code.length === 6) void pruefen(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-foreground/[0.04]">
      <Card className="w-full max-w-md border-foreground/10 shadow-xl">
        <CardHeader className="text-center pb-4 pt-12">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground inline-flex items-center justify-center gap-1.5">
            <Monitor className="h-3.5 w-3.5" /> Büro-Bildschirm
          </p>
        </CardHeader>
        <CardContent className="px-8 pb-10">
          {phase === "pruefen" && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {phase === "start" && (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground text-center">
                Für den Bildschirm im Büro braucht es kein Passwort. Ein Bestätigungscode wird an{" "}
                <strong className="text-foreground">{EMPFAENGER}</strong> geschickt — nach der Eingabe bleibt der Bildschirm dauerhaft verbunden.
              </p>
              {fehler && <p className="text-sm text-red-600 text-center">{fehler}</p>}
              <button type="button" onClick={codeAnfordern} disabled={busy} className="kasten kasten-red w-full !py-2.5 !text-sm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {busy ? "Wird gesendet…" : "Code anfordern"}
              </button>
            </div>
          )}

          {phase === "code" && (
            <div className="space-y-5">
              <div className="text-center">
                <h3 className="font-semibold">Code eingeben</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Der Code ist unterwegs an <strong className="text-foreground">{EMPFAENGER}</strong> und 10 Minuten gültig.
                </p>
              </div>
              <input
                ref={inputRef}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (code.length === 6) void pruefen(code); } }}
                placeholder="······"
                aria-label="Bestätigungscode"
                className="w-full h-16 rounded-xl border bg-background text-center font-mono text-3xl tracking-[0.45em] focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring disabled:opacity-60"
                autoFocus
              />
              <div className="h-5 flex items-center justify-center">
                {busy ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird geprüft…</span>
                ) : fehler ? (
                  <p className="text-sm text-red-600">{fehler}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={codeAnfordern}
                disabled={busy || cooldown > 0}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
              >
                {cooldown > 0 ? `Neuen Code senden (in ${cooldown} s möglich)` : "Neuen Code senden"}
              </button>
            </div>
          )}

          {phase !== "pruefen" && (
            <Link href="/login" className="mt-6 flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Zurück zum Login
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
