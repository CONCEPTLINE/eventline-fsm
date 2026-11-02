"use client";

// Einstellungen → Firmenportal → «Catering»: Grundwerte der Kalkulation und die Getränkekarte des
// Getränke-Caterings (Tabellen catering_einstellungen / catering_getraenke, Migration 372). Nur Admins.
// Die Karte steckt in der Karten-PDF und im Mix der Kalkulation — hier ändern wirkt auf neue Kalkulationen;
// gespeicherte Auftragskalkulationen bleiben bis zum erneuten Speichern unverändert.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { KATEGORIE_REIHENFOLGE, KATEGORIE_TITEL, type KartenKategorie } from "@/lib/catering/kategorien";
import { pruefeStammdaten, type EinstellungenEingabe, type KartenEingabe } from "@/lib/catering/pruefen";

type Zeile = { id?: string; kategorie: KartenKategorie; name: string; einheit: string; verkauf: string; einkauf: string; mix: string; aktiv: boolean };

const prozent = (v: number) => String(Math.round(v * 10000) / 100);
const eingabeKlasse = "w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30";

function nummer(v: string): number {
  const n = Number(v.replace(",", "."));
  return v.trim() === "" || !Number.isFinite(n) ? NaN : n;
}

export function CateringEinstellungenTab() {
  const [e, setE] = useState<Record<keyof EinstellungenEingabe, string> | null>(null);
  const [zeilen, setZeilen] = useState<Zeile[]>([]);
  const [saving, setSaving] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neu, setNeu] = useState(0);

  useEffect(() => {
    let aktiv = true;
    (async () => {
      try {
        const res = await fetch("/api/catering/stammdaten", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? "Laden fehlgeschlagen");
        if (!aktiv) return;
        const d = json.einstellungen as EinstellungenEingabe;
        setE({
          lohnProStunde: String(d.lohnProStunde), gaesteProKraft: String(d.gaesteProKraft), puffer: prozent(d.puffer),
          anteilVor: prozent(d.anteilVor), rateVor: String(d.rateVor), anteilPause: prozent(d.anteilPause), ratePause: String(d.ratePause),
          anteilNach: prozent(d.anteilNach), rateNach: String(d.rateNach),
        });
        setZeilen((json.karte as KartenEingabe[]).map((z) => ({
          id: z.id, kategorie: z.kategorie as KartenKategorie, name: z.name, einheit: z.einheit, verkauf: String(z.verkauf),
          einkauf: String(Math.round(z.einkauf * 10000) / 10000), mix: z.mixAnteil == null ? "" : prozent(z.mixAnteil), aktiv: z.aktiv,
        })));
        setFehler(null);
      } catch (err) {
        if (!aktiv) return;
        const msg = err instanceof Error ? err.message : "Laden fehlgeschlagen";
        setFehler(msg);
        toast.error(msg);
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [neu]);

  const eingabe = useMemo(() => {
    if (!e) return null;
    const einstellungen: EinstellungenEingabe = {
      lohnProStunde: nummer(e.lohnProStunde), gaesteProKraft: nummer(e.gaesteProKraft), puffer: nummer(e.puffer) / 100,
      anteilVor: nummer(e.anteilVor) / 100, rateVor: nummer(e.rateVor), anteilPause: nummer(e.anteilPause) / 100, ratePause: nummer(e.ratePause),
      anteilNach: nummer(e.anteilNach) / 100, rateNach: nummer(e.rateNach),
    };
    const karte: KartenEingabe[] = zeilen.map((z) => ({
      id: z.id, kategorie: z.kategorie, name: z.name, einheit: z.einheit, verkauf: nummer(z.verkauf), einkauf: nummer(z.einkauf),
      mixAnteil: z.mix.trim() === "" ? null : nummer(z.mix) / 100, aktiv: z.aktiv,
    }));
    return { einstellungen, karte, meldung: pruefeStammdaten(einstellungen, karte) };
  }, [e, zeilen]);

  const mixSumme = zeilen.filter((z) => z.aktiv && z.mix.trim() !== "").reduce((s, z) => s + (nummer(z.mix) || 0), 0);

  async function speichern() {
    if (!eingabe || eingabe.meldung) return;
    setSaving(true);
    try {
      const res = await fetch("/api/catering/stammdaten", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ einstellungen: eingabe.einstellungen, karte: eingabe.karte }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Speichern fehlgeschlagen");
      toast.success("Catering-Einstellungen gespeichert");
      setNeu((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  const feld = (k: keyof EinstellungenEingabe, label: string, einheit?: string) => (
    <label className="block text-xs text-muted-foreground">
      {label}
      <div className="mt-1 flex items-center gap-1.5">
        <input value={e?.[k] ?? ""} onChange={(ev) => setE((s) => (s ? { ...s, [k]: ev.target.value } : s))} className={eingabeKlasse} inputMode="decimal" />
        {einheit && <span className="text-xs">{einheit}</span>}
      </div>
    </label>
  );

  if (fehler && !e) {
    return (
      <Card className="bg-card"><CardContent className="p-5 text-sm">
        <p className="text-red-500">{fehler}</p>
        <button type="button" onClick={() => setNeu((n) => n + 1)} className="kasten kasten-muted mt-3">Erneut laden</button>
      </CardContent></Card>
    );
  }
  if (!e) return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Wird geladen …</div>;

  return (
    <div className="space-y-4">
      <Card className="bg-card">
        <CardContent className="space-y-3 p-4">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Kalkulation</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {feld("lohnProStunde", "Personalkosten pro Servicekraft und Stunde", "CHF")}
            {feld("gaesteProKraft", "Gäste pro Servicekraft")}
            {feld("puffer", "Puffer auf die Kosten", "%")}
          </div>
          <p className="pt-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Wie viel wird getrunken?</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            {feld("anteilVor", "Vorzeit: Anteil Trinkende", "%")}
            {feld("rateVor", "Vorzeit: Getränke pro Person und Std")}
            {feld("anteilPause", "Pause: Anteil Trinkende", "%")}
            {feld("ratePause", "Pause: Getränke pro Person und Std")}
            {feld("anteilNach", "Nachzeit: Anteil Trinkende", "%")}
            {feld("rateNach", "Nachzeit: Getränke pro Person und Std")}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Getränkekarte</p>
            <p className={`text-xs ${Math.abs(mixSumme - 100) < 0.1 ? "text-emerald-600" : "text-red-500"}`}>Mix: {Math.round(mixSumme * 10) / 10} % (muss 100 % sein)</p>
          </div>
          <p className="text-xs text-muted-foreground">
            «Mix %» zählt im Durchschnitt der Kalkulation, je Kategorie eine Zeile (z. B. das Glas, nicht die Flasche). Einkauf je Verkaufseinheit; bei Wein im Glas der Flaschenpreis ÷ 7.5.
          </p>
          {KATEGORIE_REIHENFOLGE.map((kat) => (
            <div key={kat} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{KATEGORIE_TITEL[kat]}</p>
                <button type="button" className="kasten kasten-muted" onClick={() => setZeilen((s) => [...s, { kategorie: kat, name: "", einheit: "", verkauf: "", einkauf: "", mix: "", aktiv: true }])}>
                  <Plus className="h-4 w-4" /> Zeile
                </button>
              </div>
              <div className="hidden grid-cols-[2fr_1.4fr_0.7fr_0.7fr_0.6fr_auto_auto] gap-2 px-1 text-[0.6875rem] text-muted-foreground md:grid">
                <span>Name</span><span>Einheit</span><span>Verkauf</span><span>Einkauf</span><span>Mix %</span><span>Aktiv</span><span />
              </div>
              {zeilen.map((z, i) => z.kategorie !== kat ? null : (
                <div key={z.id ?? `neu-${i}`} className="grid grid-cols-2 items-center gap-2 md:grid-cols-[2fr_1.4fr_0.7fr_0.7fr_0.6fr_auto_auto]">
                  <input value={z.name} placeholder="Name" onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, name: ev.target.value } : x))} className={eingabeKlasse} />
                  <input value={z.einheit} placeholder="z. B. Glas · 1 dl" onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, einheit: ev.target.value } : x))} className={eingabeKlasse} />
                  <input value={z.verkauf} inputMode="decimal" placeholder="Verkauf" onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, verkauf: ev.target.value } : x))} className={eingabeKlasse} />
                  <input value={z.einkauf} inputMode="decimal" placeholder="Einkauf" onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, einkauf: ev.target.value } : x))} className={eingabeKlasse} />
                  <input value={z.mix} inputMode="decimal" placeholder="—" onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, mix: ev.target.value } : x))} className={eingabeKlasse} />
                  <input type="checkbox" checked={z.aktiv} onChange={(ev) => setZeilen((s) => s.map((x, j) => j === i ? { ...x, aktiv: ev.target.checked } : x))} className="h-4 w-4" aria-label="Aktiv" />
                  <button type="button" className="kasten kasten-red" data-tooltip="Zeile löschen" onClick={() => setZeilen((s) => s.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void speichern()} disabled={saving || !eingabe || !!eingabe.meldung} className="kasten kasten-blue">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Wird gespeichert …" : "Speichern"}
        </button>
        {eingabe?.meldung && <span className="text-xs text-red-500">{eingabe.meldung}</span>}
      </div>
    </div>
  );
}
