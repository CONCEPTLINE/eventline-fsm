"use client";

/**
 * Verrechnungssaetze-Section fuer /standorte/[id] (Admin-only).
 *
 * Modell: pro Standort beliebig viele Modus-Tiers (Normal/Pikett/Admin/...),
 * genau einer ist Default. Pro Tier eine PREIS-HISTORIE (effective_from) —
 * neue Preise werden nicht ueberschrieben, sondern zeit-basiert angelegt.
 * Alte Stempelungen behalten ihren historischen Preis.
 *
 * UI:
 *   - Kompakte Zeile pro Tier: Icon | Label | aktueller Preis + Guelt-ab |
 *     next-price-Hinweis | Standard-Badge | Aktionen (expand, standard,
 *     archivieren)
 *   - Expand: Preis-Historie (alle Rows) + Formular "Neuer Preis ab XX.XX"
 *   - Empty-State: 3 Preset-Kacheln zum 1-Klick-Anlegen
 *
 * Aenderungen laufen ueber RPCs: upsert_tier_price (setzt neue Preis-Row
 * + schliesst vorherige) + set_default_rate_tier (atomare Default-Umschaltung).
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Clock, PhoneCall, FileText, Wrench, Star, Trash2, Plus, Check, X,
  Calendar as CalendarIcon, ChevronDown, ChevronUp, History,
} from "lucide-react";

interface TierRow {
  id: string;
  location_id: string;
  key: string;
  label: string;
  is_default: boolean;
  sort_order: number;
  is_archived: boolean;
  current_chf_per_hour: number | null;
  current_effective_from: string | null;
  next_chf_per_hour: number | null;
  next_effective_from: string | null;
}

interface PriceRow {
  id: string;
  tier_id: string;
  chf_per_hour: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string;
}

interface Preset {
  key: string;
  label: string;
  suggestedChf: number;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}

const PRESETS: Preset[] = [
  { key: "normal",  label: "Normal",         suggestedChf: 85,  icon: Clock,     hint: "Standard-Einsatz" },
  { key: "pikett",  label: "Pikett",         suggestedChf: 120, icon: PhoneCall, hint: "Rufbereitschaft" },
  { key: "admin",   label: "Administration", suggestedChf: 65,  icon: FileText,  hint: "Büro-Arbeit" },
  { key: "aufbau",  label: "Aufbau/Abbau",   suggestedChf: 75,  icon: Wrench,    hint: "Setup / Teardown" },
];

function iconForKey(key: string) {
  return PRESETS.find((p) => p.key === key)?.icon ?? Clock;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// YYYY-MM-DD in Europe/Zurich (fuer date-Inputs).
const zurichDateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" });
function todayZurich(): string { return zurichDateFmt.format(new Date()); }

export function RateTiersSection({ locationId }: { locationId: string }) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTierId, setExpandedTierId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);

  useEffect(() => { load(); }, [locationId]);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("v_location_rate_tiers_current")
      .select("*")
      .eq("location_id", locationId)
      .eq("is_archived", false)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) toast.error("Sätze laden fehlgeschlagen: " + error.message);
    setTiers((data as TierRow[]) ?? []);
    setLoading(false);
  }

  async function createTierWithPrice(key: string, label: string, chf: number) {
    // Erster Tier wird Default. Neuer sort_order = max + 1.
    const isFirst = tiers.length === 0;
    const nextOrder = tiers.length === 0 ? 0 : Math.max(...tiers.map((t) => t.sort_order)) + 1;
    const { data: newTier, error: e1 } = await supabase
      .from("location_rate_tiers")
      .insert({
        location_id: locationId,
        key, label,
        is_default: isFirst,
        sort_order: nextOrder,
      })
      .select("id")
      .single();
    if (e1) {
      if (e1.code === "23505") toast.error(`Ein Tier "${label}" existiert bereits an diesem Standort.`);
      else toast.error("Anlegen fehlgeschlagen: " + e1.message);
      return false;
    }
    // Ur-Preis heute
    const { error: e2 } = await supabase.rpc("upsert_tier_price", {
      p_tier_id: newTier.id,
      p_chf_per_hour: chf,
      p_effective_from: todayZurich(),
      p_note: "Initial-Preis",
    });
    if (e2) {
      toast.error("Preis anlegen fehlgeschlagen: " + e2.message);
      return false;
    }
    toast.success(`"${label}" angelegt (CHF ${chf}/h)`);
    load();
    return true;
  }

  async function addPreset(preset: Preset) {
    await createTierWithPrice(preset.key, preset.label, preset.suggestedChf);
  }

  async function addCustom(label: string, chf: number) {
    const key = label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `custom-${Date.now()}`;
    const ok = await createTierWithPrice(key, label, chf);
    if (ok) setShowNewModal(false);
  }

  async function makeDefault(id: string) {
    const { error } = await supabase.rpc("set_default_rate_tier", { p_tier_id: id });
    if (error) return toast.error("Standard setzen fehlgeschlagen: " + error.message);
    toast.success("Standard-Satz umgesetzt");
    load();
  }

  async function archiveTier(tier: TierRow) {
    // Wenn dies der Default UND der einzige verbleibende aktive Satz ist,
    // wird der Standort danach GAR KEINE Verrechnungssaetze mehr haben —
    // das ist erlaubt (Report blendet dann Umsatz/Marge einfach aus, wie
    // bei einem frisch angelegten Standort).
    const otherActive = tiers.filter((t) => t.id !== tier.id);
    const message = tier.is_default && otherActive.length === 0
      ? "Danach hat der Standort keine Verrechnungssätze mehr — Umsatz und Marge werden im Report nicht mehr angezeigt. Bestehende Rapporte behalten ihren historischen Preis."
      : tier.is_default
      ? `Standard-Satz wird automatisch an „${otherActive[0]?.label ?? "…"}" weitergereicht. Bereits gestempelte Einträge mit diesem Modus behalten ihren historischen Preis im Report.`
      : "Bereits gestempelte Einträge mit diesem Modus behalten ihren historischen Preis im Report. Der Modus verschwindet nur aus der Auswahl beim Stempeln.";
    const ok = await confirm({
      title: `"${tier.label}" entfernen?`,
      message,
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    // Wenn Default archiviert wird und noch andere existieren: nachsten
    // (sort_order asc) zum neuen Default machen — sonst waer die Auswahl
    // ohne Default nach dem Reload verwirrend.
    if (tier.is_default && otherActive.length > 0) {
      const nextDefault = [...otherActive].sort((a, b) => a.sort_order - b.sort_order)[0];
      const { error: e1 } = await supabase.rpc("set_default_rate_tier", { p_tier_id: nextDefault.id });
      if (e1) return toast.error("Standard-Übergabe fehlgeschlagen: " + e1.message);
    }
    const { error } = await supabase.from("location_rate_tiers").update({ is_archived: true }).eq("id", tier.id);
    if (error) return toast.error("Speichern fehlgeschlagen: " + error.message);
    load();
  }

  const unusedPresets = PRESETS.filter((p) => !tiers.some((t) => t.key === p.key));

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="p-4 sm:p-5 flex items-center justify-between gap-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider">Verrechnungssätze</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Was du dem Kunden pro Stunde verrechnest. Der Standard-Satz wird beim Stempeln automatisch gewählt. Preisänderungen sind terminierbar — bestehende Rapporte behalten ihren historischen Preis.
          </p>
        </div>
        {tiers.length > 0 && (
          <button type="button" onClick={() => setShowNewModal(true)} className="kasten kasten-red shrink-0">
            <Plus className="h-3.5 w-3.5" />
            Neuer Satz
          </button>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {loading ? (
          <div className="text-xs text-muted-foreground py-4">Lade Sätze…</div>
        ) : tiers.length === 0 ? (
          <EmptyState presets={PRESETS} onAdd={addPreset} onCustom={() => setShowNewModal(true)} />
        ) : (
          <div className="space-y-1">
            {tiers.map((t) => (
              <TierBlock
                key={t.id}
                tier={t}
                expanded={expandedTierId === t.id}
                onToggle={() => setExpandedTierId((cur) => (cur === t.id ? null : t.id))}
                onMakeDefault={() => makeDefault(t.id)}
                onArchive={() => archiveTier(t)}
                onPriceChanged={load}
              />
            ))}

            {unusedPresets.length > 0 && (
              <div className="pt-3 mt-3 border-t border-border">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Weitere Modi hinzufügen
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                  {unusedPresets.map((p) => {
                    const Icon = p.icon;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => addPreset(p)}
                        className="group flex flex-col items-start p-3.5 rounded-xl border-2 border-dashed border-border bg-muted/20 hover:border-foreground/40 hover:bg-muted/50 transition-all text-left"
                      >
                        <div className="w-9 h-9 rounded-lg bg-foreground/[0.06] group-hover:bg-foreground/10 flex items-center justify-center mb-2 transition-colors">
                          <Icon className="h-4 w-4 text-foreground/70" />
                        </div>
                        <p className="font-semibold text-sm">{p.label}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{p.hint}</p>
                        <p className="text-[11px] text-muted-foreground mt-1.5">
                          Vorschlag: <span className="font-medium text-foreground/80">CHF {p.suggestedChf}/h</span>
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showNewModal && (
        <NewCustomTierModal onCancel={() => setShowNewModal(false)} onSave={addCustom} />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/* --------------------------------------------------------------- */
function EmptyState({
  presets, onAdd, onCustom,
}: {
  presets: Preset[];
  onAdd: (p: Preset) => void;
  onCustom: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        Noch keine Sätze für diesen Standort. Wähle die passenden Modi — die Sätze kannst du anpassen.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
        {presets.map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onAdd(p)}
              className="group flex flex-col items-start p-3.5 rounded-xl border-2 border-dashed border-border bg-muted/20 hover:border-foreground/40 hover:bg-muted/50 transition-all text-left"
            >
              <div className="w-9 h-9 rounded-lg bg-foreground/[0.06] group-hover:bg-foreground/10 flex items-center justify-center mb-2 transition-colors">
                <Icon className="h-4 w-4 text-foreground/70" />
              </div>
              <p className="font-semibold text-sm">{p.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{p.hint}</p>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Vorschlag: <span className="font-medium text-foreground/80">CHF {p.suggestedChf}/h</span>
              </p>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onCustom}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <Plus className="h-3 w-3" />
        Eigener Satz statt Preset
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- */
function TierBlock({
  tier, expanded, onToggle, onMakeDefault, onArchive, onPriceChanged,
}: {
  tier: TierRow;
  expanded: boolean;
  onToggle: () => void;
  onMakeDefault: () => void;
  onArchive: () => void;
  onPriceChanged: () => void;
}) {
  const Icon = iconForKey(tier.key);
  const hasNext = tier.next_chf_per_hour !== null && tier.next_effective_from !== null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header-Zeile — kompakt, neutral. Standard nur als kleiner Star vor
          dem Label, kein farbiger Container. */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          {tier.is_default && (
            <Star
              className="h-3 w-3 fill-foreground text-foreground shrink-0"
              aria-label="Standard-Satz"
            />
          )}
          <span className="text-sm font-medium truncate">{tier.label}</span>
          {tier.current_chf_per_hour !== null ? (
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              CHF {Number(tier.current_chf_per_hour).toFixed(2)}/h
            </span>
          ) : (
            <span className="text-xs italic text-amber-600 dark:text-amber-400">kein Preis</span>
          )}
          {hasNext && (
            <span
              className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5 whitespace-nowrap"
              data-tooltip={`ab ${fmtDate(tier.next_effective_from)}: CHF ${Number(tier.next_chf_per_hour).toFixed(2)}/h`}
            >
              <CalendarIcon className="h-2.5 w-2.5" />
              geplant
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {!tier.is_default && (
            <button
              type="button"
              onClick={onMakeDefault}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
              data-tooltip="Als Standard setzen"
              aria-label="Als Standard setzen"
            >
              <Star className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] inline-flex items-center gap-0.5"
            aria-label={expanded ? "Historie schliessen" : "Preis & Historie"}
          >
            <History className="h-3.5 w-3.5" />
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
            data-tooltip="Aus Auswahl entfernen"
            aria-label="Entfernen"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <PriceHistoryPanel tierId={tier.id} onChanged={onPriceChanged} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- */
function PriceHistoryPanel({ tierId, onChanged }: { tierId: string; onChanged: () => void }) {
  const supabase = createClient();
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChf, setNewChf] = useState("");
  const [newFrom, setNewFrom] = useState(() => {
    // Default: erster Tag nächsten Monat.
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 1);
    return zurichDateFmt.format(d);
  });
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadPrices(); }, [tierId]);

  async function loadPrices() {
    setLoading(true);
    const { data, error } = await supabase
      .from("location_rate_tier_prices")
      .select("*")
      .eq("tier_id", tierId)
      .order("effective_from", { ascending: false });
    if (error) toast.error("Historie laden fehlgeschlagen: " + error.message);
    setPrices((data as PriceRow[]) ?? []);
    setLoading(false);
  }

  async function savePrice() {
    const chf = Number(newChf);
    if (!newChf || Number.isNaN(chf) || chf < 0) return toast.error("Bitte einen gültigen Preis eingeben");
    if (!newFrom) return toast.error("Bitte ein Startdatum wählen");
    setSaving(true);
    const { error } = await supabase.rpc("upsert_tier_price", {
      p_tier_id: tierId,
      p_chf_per_hour: chf,
      p_effective_from: newFrom,
      p_note: newNote.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error("Speichern fehlgeschlagen: " + error.message);
    toast.success(`Neuer Satz gespeichert (CHF ${chf.toFixed(2)}/h ab ${fmtDate(newFrom)})`);
    setNewChf(""); setNewNote("");
    loadPrices();
    onChanged();
  }

  async function deletePrice(row: PriceRow) {
    if (prices.length <= 1) return toast.error("Der einzige Preis kann nicht gelöscht werden.");
    const { error } = await supabase.from("location_rate_tier_prices").delete().eq("id", row.id);
    if (error) return toast.error("Löschen fehlgeschlagen: " + error.message);
    toast.success("Preis-Eintrag entfernt");
    loadPrices();
    onChanged();
  }

  const today = todayZurich();
  const upcoming = prices.filter((p) => p.effective_from > today);
  const past = prices.filter((p) => p.effective_from <= today);

  return (
    <div className="border-t border-border px-3 py-2.5 bg-muted/20">
      {/* Neuer Preis anlegen — kompaktes Inline-Formular */}
      <div className="flex flex-wrap items-end gap-1.5 mb-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">CHF</span>
          <input
            type="number"
            step="0.5"
            min="0"
            value={newChf}
            onChange={(e) => setNewChf(e.target.value)}
            placeholder="0.00"
            className="w-20 px-1.5 py-1 text-xs rounded border bg-background tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-ring/40"
          />
          <span className="text-[10px] text-muted-foreground">/h ab</span>
        </div>
        <input
          type="date"
          value={newFrom}
          min={today}
          onChange={(e) => setNewFrom(e.target.value)}
          className="w-32 px-1.5 py-1 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring/40"
        />
        <input
          type="text"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Notiz (optional)"
          className="flex-1 min-w-[100px] px-1.5 py-1 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring/40"
        />
        <button
          type="button"
          onClick={savePrice}
          disabled={saving || !newChf}
          className="px-2 py-1 text-xs rounded border border-foreground/20 text-foreground hover:bg-foreground/[0.06] disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Check className="h-3 w-3" />
          {saving ? "…" : "Speichern"}
        </button>
      </div>

      {/* Historie: alles in einer Liste, chronologisch. Zukunft leicht
          hervorgehoben durch kleines Kalender-Icon vorne. */}
      {loading ? (
        <p className="text-[10px] text-muted-foreground italic">Lade…</p>
      ) : (
        <div className="space-y-0.5">
          {upcoming.map((p) => (
            <PriceRowUI key={p.id} row={p} upcoming onDelete={() => deletePrice(p)} />
          ))}
          {past.map((p) => (
            <PriceRowUI key={p.id} row={p} current={p.effective_to === null} onDelete={() => deletePrice(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- */
function PriceRowUI({
  row, current, upcoming, onDelete,
}: {
  row: PriceRow;
  current?: boolean;
  upcoming?: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 px-1 py-1 text-[11px] hover:bg-foreground/[0.03] rounded">
      {upcoming ? (
        <CalendarIcon className="h-3 w-3 text-muted-foreground shrink-0" data-tooltip="Geplant" />
      ) : (
        <span className="w-3 h-3 shrink-0" />
      )}
      <span
        className={`tabular-nums shrink-0 ${current ? "font-semibold text-foreground" : "text-muted-foreground"}`}
      >
        CHF {Number(row.chf_per_hour).toFixed(2)}/h
      </span>
      <span className="text-muted-foreground shrink-0">
        {fmtDate(row.effective_from)}
        {row.effective_to ? ` — ${fmtDate(row.effective_to)}` : ""}
      </span>
      {row.note && (
        <span className="text-muted-foreground/70 italic truncate flex-1">· {row.note}</span>
      )}
      {!row.note && <span className="flex-1" />}
      <button
        type="button"
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-600 shrink-0"
        aria-label="Eintrag löschen"
        data-tooltip="Eintrag löschen"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- */
function NewCustomTierModal({
  onCancel, onSave,
}: {
  onCancel: () => void;
  onSave: (label: string, chf: number) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [chf, setChf] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!label.trim() || Number(chf) < 0 || !chf) return;
    setSaving(true);
    await onSave(label.trim(), Number(chf));
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-base mb-1">Neuer Verrechnungssatz</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Für einen Modus der nicht in den Presets ist (z.B. „Nachtzuschlag", „Sonntag", „Servicetechnik").
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium block mb-1">Bezeichnung</label>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z.B. Nachtzuschlag" autoFocus
              className="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40" />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Initial-Preis CHF/h</label>
            <div className="flex items-center gap-2">
              <input type="number" step="0.5" min="0" value={chf} onChange={(e) => setChf(e.target.value)} placeholder="120.00"
                className="flex-1 px-3 py-2 text-sm rounded-lg border bg-background tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/40" />
              <span className="text-sm text-muted-foreground">CHF/h</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Spätere Preisänderungen laufen über die Historie im Tier-Panel.</p>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onCancel} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="button" onClick={handleSave} disabled={saving || !label.trim() || !chf || Number(chf) < 0} className="kasten kasten-red flex-1">
            {saving ? "Speichert…" : "Anlegen"}
          </button>
        </div>
      </div>
    </div>
  );
}
