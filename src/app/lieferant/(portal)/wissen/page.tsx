"use client";

// Lieferantenportal → Mein Wissen: Pakete + Hinweise, die EVENTLINE bei
// jeder neuen Technik-Position automatisch angezeigt bekommt.
// Beispiel Paket:  Stichwort «Mikrofon» → 1× Stativ, 1× XLR-Kabel 10m
// Beispiel Hinweis: Stichwort «Outdoor» → «Beschwerung nicht vergessen»

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { Lightbulb, Loader2, Package, Plus, Trash2, X } from "lucide-react";
import type { LieferantRegel } from "@/lib/technik";

export default function LieferantWissenPage() {
  const { confirm, ConfirmModalElement } = useConfirm();
  const [regeln, setRegeln] = useState<LieferantRegel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Neu-Formular
  const [art, setArt] = useState<"paket" | "hinweis">("paket");
  const [trigger, setTrigger] = useState("");
  const [hinweis, setHinweis] = useState("");
  const [paketZeilen, setPaketZeilen] = useState<{ bezeichnung: string; menge: string }[]>([{ bezeichnung: "", menge: "1" }]);

  async function laden() {
    try {
      const res = await fetch("/api/lieferant/wissen");
      const json = await res.json().catch(() => null);
      if (json?.success) setRegeln(json.regeln as LieferantRegel[]);
    } catch {
      toast.error("Laden fehlgeschlagen");
    }
  }
  useEffect(() => { void laden(); }, []);

  async function post(payload: Record<string, unknown>, busyKey: string, erfolg?: string) {
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
      await laden();
      if (erfolg) toast.success(erfolg);
      return true;
    } catch {
      toast.error("Netzwerkfehler");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function anlegen() {
    if (!trigger.trim()) {
      toast.error("Stichwort angeben");
      return;
    }
    const ok = await post({
      aktion: "neu",
      art,
      trigger_text: trigger.trim(),
      hinweis: art === "hinweis" ? hinweis.trim() : undefined,
      paket: art === "paket"
        ? paketZeilen.map((z) => ({ bezeichnung: z.bezeichnung.trim(), menge: Number(z.menge) || 1 })).filter((z) => z.bezeichnung)
        : undefined,
    }, "neu", "Gespeichert");
    if (ok) {
      setTrigger("");
      setHinweis("");
      setPaketZeilen([{ bezeichnung: "", menge: "1" }]);
    }
  }

  return (
    <div className="max-w-3xl mx-auto page-enter space-y-4">
      <div>
        <h1 className="text-xl font-bold">Mein Wissen</h1>
        <p className="text-sm text-muted-foreground">
          Dein Fachwissen als Regeln: Sobald EVENTLINE eine passende Position plant, erscheint dein Paket oder Hinweis automatisch — bevor du überhaupt draufschaust.
        </p>
      </div>

      {/* Neu anlegen */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-2.5">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setArt("paket")} className={`kasten ${art === "paket" ? "kasten-active" : "kasten-muted"}`}>
              <Package className="h-3.5 w-3.5" /> Paket
            </button>
            <button type="button" onClick={() => setArt("hinweis")} className={`kasten ${art === "hinweis" ? "kasten-active" : "kasten-muted"}`}>
              <Lightbulb className="h-3.5 w-3.5" /> Hinweis
            </button>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Stichwort (löst die Regel aus)</p>
            <input
              type="text"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              placeholder='z.B. «Mikrofon» oder «Outdoor»'
              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
            />
          </div>
          {art === "hinweis" ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Hinweis-Text</p>
              <input
                type="text"
                value={hinweis}
                onChange={(e) => setHinweis(e.target.value)}
                placeholder="z.B. «Bei Outdoor immer Beschwerung einplanen»"
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Gehört dazu</p>
              {paketZeilen.map((z, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    value={z.menge}
                    onChange={(e) => setPaketZeilen((prev) => prev.map((p, j) => j === i ? { ...p, menge: e.target.value } : p))}
                    className="w-16 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={z.bezeichnung}
                    onChange={(e) => setPaketZeilen((prev) => prev.map((p, j) => j === i ? { ...p, bezeichnung: e.target.value } : p))}
                    placeholder="z.B. Mikrofon-Stativ"
                    className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
                  />
                  {paketZeilen.length > 1 && (
                    <button type="button" onClick={() => setPaketZeilen((prev) => prev.filter((_, j) => j !== i))} className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={() => setPaketZeilen((prev) => [...prev, { bezeichnung: "", menge: "1" }])} className="kasten kasten-muted">
                <Plus className="h-3.5 w-3.5" /> Weitere Position
              </button>
            </div>
          )}
          <button type="button" onClick={() => void anlegen()} disabled={busy !== null || !trigger.trim()} className="kasten kasten-blue">
            {busy === "neu" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Regel speichern
          </button>
        </CardContent>
      </Card>

      {/* Bestehende Regeln */}
      {!regeln && <Skeleton className="h-32 rounded-xl" />}
      {regeln && regeln.length === 0 && (
        <EmptyState
          icon={Lightbulb}
          title="Noch keine Regeln"
          description="Lege dein erstes Paket oder deinen ersten Hinweis an — EVENTLINE sieht ihn bei der nächsten passenden Planung automatisch."
        />
      )}
      {regeln && regeln.map((r) => (
        <Card key={r.id} className={`bg-card ${r.is_active ? "" : "opacity-60"}`}>
          <CardContent className="p-3.5 flex items-center gap-3">
            {r.art === "paket"
              ? <Package className="h-4 w-4 text-blue-500 shrink-0" />
              : <Lightbulb className="h-4 w-4 text-amber-500 shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-semibold">«{r.trigger_text}»</span>
                {" → "}
                {r.art === "hinweis"
                  ? r.hinweis
                  : r.paket?.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void post({ aktion: "toggle", id: r.id, is_active: !r.is_active }, `t_${r.id}`)}
              disabled={busy !== null}
              className={`kasten ${r.is_active ? "kasten-active" : "kasten-muted"}`}
              data-tooltip={r.is_active ? "Aktiv — klicken zum Pausieren" : "Pausiert — klicken zum Aktivieren"}
            >
              {busy === `t_${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : r.is_active ? "Aktiv" : "Pausiert"}
            </button>
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm({
                  title: "Regel löschen?",
                  message: `«${r.trigger_text}» wird gelöscht — EVENTLINE sieht diesen Hinweis dann nicht mehr.`,
                  confirmLabel: "Löschen",
                  variant: "red",
                });
                if (ok) void post({ aktion: "loeschen", id: r.id }, `d_${r.id}`);
              }}
              disabled={busy !== null}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500 shrink-0"
              data-tooltip="Regel löschen"
            >
              {busy === `d_${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </CardContent>
        </Card>
      ))}
      {ConfirmModalElement}
    </div>
  );
}
