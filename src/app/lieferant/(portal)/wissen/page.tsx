"use client";

// Lieferantenportal › Mein Wissen: Regeln aus einem Stichwort plus Paket
// (Material, das immer dazugehoert) oder Hinweis (ein Satz zum Mitdenken).
// EVENTLINE bekommt eine Regel automatisch angezeigt, sobald eine geplante
// Technik-Position das Stichwort enthaelt (passendeRegeln, src/lib/technik.ts).
// Laden/Speichern ueber /api/lieferant/wissen (eigene Firma, Grenzen aus
// WISSEN_GRENZEN). Ab Laptop-Breite zweispaltig: links Erklaerung + neue
// Regel, rechts die bestehenden Regeln.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { AlertTriangle, Lightbulb, Loader2, Package, Plus, RotateCw, Trash2, X } from "lucide-react";
import type { LieferantRegel } from "@/lib/technik";
import { WISSEN_GRENZEN as G } from "@/lib/lieferant-wissen";

type Laden = { status: "laedt" } | { status: "fehler" } | { status: "ok"; regeln: LieferantRegel[] };

const LEERE_ZEILE = { bezeichnung: "", menge: "1" };

export default function LieferantWissenPage() {
  const { confirm, ConfirmModalElement } = useConfirm();
  const [laden, setLaden] = useState<Laden>({ status: "laedt" });
  const [busy, setBusy] = useState<string | null>(null);

  // Neue Regel
  const [art, setArt] = useState<"paket" | "hinweis">("paket");
  const [stichwort, setStichwort] = useState("");
  const [hinweis, setHinweis] = useState("");
  const [paketZeilen, setPaketZeilen] = useState<{ bezeichnung: string; menge: string }[]>([LEERE_ZEILE]);

  // Setzt nur Ergebnis/Fehler; den Lade-Zustand setzt der Aufrufer (Start =
  // Initialwert, «Erneut laden» = Klick) — kein synchrones setState im Effekt.
  const regelnLaden = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/lieferant/wissen", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.error ?? "Dein Wissen konnte nicht geladen werden");
      setLaden({ status: "ok", regeln: json.regeln as LieferantRegel[] });
      return true;
    } catch (e) {
      setLaden({ status: "fehler" });
      toast.error(e instanceof Error ? e.message : "Dein Wissen konnte nicht geladen werden");
      return false;
    }
  }, []);
  useEffect(() => { void regelnLaden(); }, [regelnLaden]);

  async function post(payload: Record<string, unknown>, busyKey: string, erfolg?: string): Promise<boolean> {
    setBusy(busyKey);
    try {
      const res = await fetch("/api/lieferant/wissen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Speichern fehlgeschlagen");
        return false;
      }
      await regelnLaden();
      if (erfolg) toast.success(erfolg);
      return true;
    } catch {
      toast.error("Keine Verbindung — bitte nochmals versuchen");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function anlegen() {
    const s = stichwort.trim();
    if (s.length < G.stichwortMin) {
      toast.error(`Stichwort: mindestens ${G.stichwortMin} Zeichen`);
      return;
    }
    const ok = await post({
      aktion: "neu",
      art,
      trigger_text: s,
      hinweis: art === "hinweis" ? hinweis.trim() : undefined,
      paket: art === "paket"
        // Leeres Mengenfeld = 1 (wie vorbelegt); alles andere prueft der Server.
        ? paketZeilen.map((z) => ({ bezeichnung: z.bezeichnung.trim(), menge: z.menge.trim() === "" ? 1 : Number(z.menge) })).filter((z) => z.bezeichnung)
        : undefined,
    }, "neu", "Regel gespeichert");
    if (ok) {
      setStichwort("");
      setHinweis("");
      setPaketZeilen([LEERE_ZEILE]);
    }
  }

  async function loeschen(r: LieferantRegel) {
    const ok = await confirm({
      title: "Regel löschen?",
      message: `«${r.trigger_text}» wird gelöscht — EVENTLINE sieht diesen Vorschlag danach nicht mehr.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (ok) await post({ aktion: "loeschen", id: r.id }, `d_${r.id}`, "Regel gelöscht");
  }

  const regeln = laden.status === "ok" ? laden.regeln : [];

  return (
    <div className="space-y-4 page-enter">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mein Wissen</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Halte fest, was bei bestimmten Geräten immer dazugehört. Plant EVENTLINE eine passende Position, sieht das Team deinen Vorschlag sofort — noch bevor die Anfrage bei dir ankommt.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start">
        {/* Links: Erklaerung + neue Regel */}
        <Card className="bg-card">
          <CardContent className="p-4 space-y-3">
            <div className="rounded-lg bg-foreground/[0.04] dark:bg-foreground/[0.08] px-3 py-2.5 space-y-1.5 text-[13px] leading-snug">
              <p>
                Eine <strong>Regel</strong> besteht aus einem <strong>Stichwort</strong> und entweder einem <strong>Paket</strong> oder einem <strong>Hinweis</strong>.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">Stichwort</strong> — das Wort, auf das wir achten. Steht es in einer geplanten Position (z. B. «Mikrofon» in «Funkmikrofon Shure SM58»), erscheint deine Regel.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">Paket</strong> — Material, das immer dazugehört. EVENTLINE übernimmt es mit einem Klick. Beispiel: «Mikrofon» → 1× Mikrofonstativ, 1× XLR-Kabel 10 m.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">Hinweis</strong> — ein Satz zum Mitdenken, ohne Material. Beispiel: «Outdoor» → «Bei Outdoor immer Beschwerung für die Stative einplanen.»
              </p>
            </div>

            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Art der Regel">
              <button type="button" role="radio" aria-checked={art === "paket"} onClick={() => setArt("paket")} className={art === "paket" ? "kasten-active" : "kasten-toggle-off"}>
                <Package className="h-3.5 w-3.5" /> Paket
              </button>
              <button type="button" role="radio" aria-checked={art === "hinweis"} onClick={() => setArt("hinweis")} className={art === "hinweis" ? "kasten-active" : "kasten-toggle-off"}>
                <Lightbulb className="h-3.5 w-3.5" /> Hinweis
              </button>
            </div>

            <div>
              <label htmlFor="wissen-stichwort" className="text-xs font-medium text-muted-foreground mb-1 block">Stichwort</label>
              <Input
                id="wissen-stichwort"
                value={stichwort}
                onChange={(e) => setStichwort(e.target.value)}
                maxLength={G.stichwortMax}
                placeholder="z. B. Mikrofon"
                className="h-9"
              />
            </div>

            {art === "hinweis" ? (
              <div>
                <label htmlFor="wissen-hinweis" className="text-xs font-medium text-muted-foreground mb-1 block">Dein Hinweis</label>
                <Input
                  id="wissen-hinweis"
                  value={hinweis}
                  onChange={(e) => setHinweis(e.target.value)}
                  maxLength={G.hinweisMax}
                  placeholder="z. B. Bei Outdoor immer Beschwerung einplanen"
                  className="h-9"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Was gehört dazu?</p>
                {paketZeilen.map((z, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={G.mengeMax}
                      step={1}
                      value={z.menge}
                      onChange={(e) => setPaketZeilen((prev) => prev.map((p, j) => (j === i ? { ...p, menge: e.target.value } : p)))}
                      className="h-9 w-20 tabular-nums"
                      aria-label="Menge"
                    />
                    <Input
                      value={z.bezeichnung}
                      onChange={(e) => setPaketZeilen((prev) => prev.map((p, j) => (j === i ? { ...p, bezeichnung: e.target.value } : p)))}
                      maxLength={G.bezeichnungMax}
                      placeholder="z. B. Mikrofonstativ"
                      className="h-9 flex-1 min-w-0"
                      aria-label="Bezeichnung"
                    />
                    {paketZeilen.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setPaketZeilen((prev) => prev.filter((_, j) => j !== i))}
                        className="icon-btn icon-btn-red shrink-0"
                        data-tooltip="Position entfernen"
                        aria-label="Position entfernen"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {paketZeilen.length < G.positionenMax && (
                  <button type="button" onClick={() => setPaketZeilen((prev) => [...prev, LEERE_ZEILE])} className="kasten kasten-muted">
                    <Plus className="h-3.5 w-3.5" /> Weitere Position
                  </button>
                )}
              </div>
            )}

            <div className="pt-1">
              <button type="button" onClick={() => void anlegen()} disabled={busy !== null || !stichwort.trim()} className="kasten kasten-blue">
                {busy === "neu" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {busy === "neu" ? "Wird gespeichert…" : "Regel speichern"}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Rechts: bestehende Regeln */}
        <div className="space-y-2 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Deine Regeln{laden.status === "ok" && regeln.length > 0 ? ` · ${regeln.length}` : ""}
          </p>
          {laden.status === "laedt" ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
            </div>
          ) : laden.status === "fehler" ? (
            <Card className="bg-card">
              <EmptyState
                icon={AlertTriangle}
                title="Dein Wissen konnte nicht geladen werden"
                description="Bitte versuche es nochmals. Bleibt der Fehler, melde dich bei EVENTLINE."
                action={
                  <button type="button" onClick={() => { setLaden({ status: "laedt" }); void regelnLaden(); }} className="kasten kasten-muted">
                    <RotateCw className="h-3.5 w-3.5" /> Erneut laden
                  </button>
                }
              />
            </Card>
          ) : regeln.length === 0 ? (
            <Card className="bg-card">
              <EmptyState
                icon={Lightbulb}
                title="Noch keine Regeln"
                description="Lege dein erstes Paket oder deinen ersten Hinweis an — EVENTLINE sieht ihn bei der nächsten passenden Planung."
              />
            </Card>
          ) : (
            regeln.map((r) => (
              <Card key={r.id} className={`bg-card ${r.is_active ? "" : "opacity-60"}`}>
                <CardContent className="p-3.5 flex items-center gap-3">
                  {r.art === "paket"
                    ? <Package className="h-4 w-4 text-blue-500 shrink-0" aria-label="Paket" />
                    : <Lightbulb className="h-4 w-4 text-amber-500 shrink-0" aria-label="Hinweis" />}
                  <p className="min-w-0 flex-1 text-sm break-words">
                    <span className="font-semibold">«{r.trigger_text}»</span>
                    {" → "}
                    {r.art === "hinweis"
                      ? r.hinweis
                      : r.paket?.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void post({ aktion: "toggle", id: r.id, is_active: !r.is_active }, `t_${r.id}`, r.is_active ? "Regel pausiert" : "Regel aktiviert")}
                    disabled={busy !== null}
                    className={`shrink-0 ${r.is_active ? "kasten-active" : "kasten-toggle-off"}`}
                    data-tooltip={r.is_active ? "Aktiv — EVENTLINE sieht die Regel. Klicken zum Pausieren." : "Pausiert — EVENTLINE sieht die Regel nicht. Klicken zum Aktivieren."}
                  >
                    {busy === `t_${r.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {r.is_active ? "Aktiv" : "Pausiert"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void loeschen(r)}
                    disabled={busy !== null}
                    className="icon-btn icon-btn-red shrink-0"
                    data-tooltip="Regel löschen"
                    aria-label="Regel löschen"
                  >
                    {busy === `d_${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
      {ConfirmModalElement}
    </div>
  );
}
