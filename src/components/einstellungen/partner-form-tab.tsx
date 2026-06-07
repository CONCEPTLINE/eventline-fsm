"use client";

/**
 * Partner-Anfrage-Form Builder (Einstellungen → Partnerportal → Anfrage-Form).
 *
 * Zwei Editoren auf demselben jsonb-Feld:
 *   - Block-Builder: visuelle UI, kennt die 18 KNOWN_BLOCK_TYPES
 *   - JSON-Editor: Raw-Edit fuer Power-User
 *
 * Scope-Auswahl ganz oben:
 *   - "Alle Partner" → globales Template (Default-Fallback fuer alle
 *     Partner-Locations).
 *   - Eine spezifische Location → Override fuer DIESEN Partner. Wenn
 *     noch kein Override existiert, zeigt der Tab einen Banner mit
 *     "Eigenes Form anlegen" (kopiert das globale Form als Startpunkt).
 *
 * Partner-Seite laedt: location-specific override → global → DEFAULT.
 *
 * Workflow:
 *   1. Admin editiert draft_schema (lokal).
 *   2. "Draft speichern" persistiert.
 *   3. "Live veröffentlichen" kopiert draft → live_schema mit Timestamp.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { SearchableSelect } from "@/components/searchable-select";
import { Save, Send, FileCode, LayoutGrid, ExternalLink, RotateCcw, AlertTriangle, Loader2, Plus, Globe, Building2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { VisualBuilder } from "@/components/einstellungen/partner-form-block-editor";
import { DEFAULT_PARTNER_FORM_SCHEMA } from "@/lib/partner-form/default-schema";
import type { FormSchema } from "@/lib/partner-form/types";

type Mode = "blocks" | "json";

interface TemplateRow {
  id: string;
  scope: "global" | "location";
  location_id: string | null;
  draft_schema: FormSchema;
  live_schema: FormSchema | null;
  draft_updated_at: string | null;
  live_published_at: string | null;
}

interface LocationOption {
  id: string;
  name: string;
}

// Sentinel-Wert im SearchableSelect fuer das globale Template.
const GLOBAL_SCOPE_VALUE = "__global__";

export function PartnerFormTab() {
  const supabase = createClient();
  // null = global, string = location_id
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [row, setRow] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState<FormSchema>(DEFAULT_PARTNER_FORM_SCHEMA);
  // Globales live_schema als Fallback-Vorlage fuer "Eigenes Form anlegen"
  // (= neue Location-Override-Form startet mit dem aktuellen Globalen).
  const [globalFallback, setGlobalFallback] = useState<FormSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [mode, setMode] = useState<Mode>("blocks");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Locations einmal laden
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("locations").select("id, name").order("name");
      setLocations((data ?? []) as LocationOption[]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Template laden — aendert sich wenn selectedLocationId wechselt
  useEffect(() => {
    (async () => {
      setLoading(true);
      // Globales Template fetchen (als Fallback fuer "neue Override")
      const { data: globalData } = await supabase
        .from("partner_form_template")
        .select("draft_schema, live_schema")
        .eq("scope", "global")
        .maybeSingle();
      const globalLive = (globalData?.live_schema as FormSchema | null)
        ?? (globalData?.draft_schema as FormSchema | null)
        ?? null;
      setGlobalFallback(globalLive);

      let query = supabase
        .from("partner_form_template")
        .select("id, scope, location_id, draft_schema, live_schema, draft_updated_at, live_published_at");
      if (selectedLocationId === null) {
        query = query.eq("scope", "global");
      } else {
        query = query.eq("scope", "location").eq("location_id", selectedLocationId);
      }
      const { data, error } = await query.maybeSingle();

      if (error) {
        TOAST.supabaseError(error, "Form-Template konnte nicht geladen werden");
        setLoading(false);
        return;
      }
      if (data) {
        setRow(data as TemplateRow);
        setDraft((data.draft_schema as FormSchema) ?? DEFAULT_PARTNER_FORM_SCHEMA);
      } else {
        setRow(null);
        if (selectedLocationId === null) {
          // Global ohne Row → DEFAULT als Editierbasis (Admin kann sofort editieren)
          setDraft(DEFAULT_PARTNER_FORM_SCHEMA);
        } else {
          // Location ohne Override → leer halten, Banner zeigt erst
          // "Eigenes Form anlegen". Erst nach Klick wird draft befuellt.
          setDraft({ version: 1, blocks: [] });
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  // JSON-Editor sync
  useEffect(() => {
    if (mode === "json") {
      setJsonText(JSON.stringify(draft, null, 2));
      setJsonError(null);
    }
  }, [mode, draft]);

  const dirty = useMemo(() => {
    if (!row) return false; // Ohne Row gilt's erst als dirty nach "Override anlegen"
    return JSON.stringify(row.draft_schema) !== JSON.stringify(draft);
  }, [row, draft]);

  const draftDiffersFromLive = useMemo(() => {
    if (!row?.live_schema) return true;
    return JSON.stringify(row.live_schema) !== JSON.stringify(draft);
  }, [row, draft]);

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.blocks)) {
        setJsonError("Schema muss { version, blocks: [...] } enthalten");
        return;
      }
      const ids = new Set<string>();
      for (const b of parsed.blocks) {
        if (typeof b !== "object" || !b || typeof b.id !== "string" || typeof b.type !== "string") {
          setJsonError("Jeder Block braucht string id + type");
          return;
        }
        if (ids.has(b.id)) { setJsonError(`Doppelte Block-ID: ${b.id}`); return; }
        ids.add(b.id);
      }
      setDraft(parsed as FormSchema);
      setJsonError(null);
      toast.success("JSON übernommen — Draft aktualisiert (noch nicht gespeichert)");
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "Parse-Fehler");
    }
  }

  function tryChangeLocation(nextId: string | null) {
    if (dirty) {
      if (!confirm("Ungespeicherte Änderungen verwerfen und Form wechseln?")) return;
    }
    setSelectedLocationId(nextId);
  }

  async function saveDraft() {
    setSavingDraft(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!row) {
      const insertPayload = selectedLocationId === null
        ? { scope: "global" as const, draft_schema: draft, draft_updated_by: user?.id }
        : { scope: "location" as const, location_id: selectedLocationId, draft_schema: draft, draft_updated_by: user?.id };
      const { data, error } = await supabase
        .from("partner_form_template")
        .insert(insertPayload)
        .select("id, scope, location_id, draft_schema, live_schema, draft_updated_at, live_published_at")
        .single();
      setSavingDraft(false);
      if (error || !data) { TOAST.supabaseError(error, "Draft konnte nicht gespeichert werden"); return; }
      setRow(data as TemplateRow);
      toast.success("Draft gespeichert");
    } else {
      const { data, error } = await supabase
        .from("partner_form_template")
        .update({ draft_schema: draft, draft_updated_at: new Date().toISOString(), draft_updated_by: user?.id })
        .eq("id", row.id)
        .select("id, scope, location_id, draft_schema, live_schema, draft_updated_at, live_published_at")
        .single();
      setSavingDraft(false);
      if (error || !data) { TOAST.supabaseError(error, "Draft konnte nicht gespeichert werden"); return; }
      setRow(data as TemplateRow);
      toast.success("Draft gespeichert");
    }
  }

  async function publish() {
    if (!row) { toast.error("Zuerst Draft speichern, dann veröffentlichen"); return; }
    if (dirty) { toast.error("Bitte zuerst Draft speichern"); return; }
    const scopeLabel = row.scope === "global" ? "alle Partner" : (locations.find(l => l.id === row.location_id)?.name ?? "diese Location");
    if (!confirm(`Live veröffentlichen? ${scopeLabel} sehen ab sofort dieses Form.`)) return;
    setPublishing(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("partner_form_template")
      .update({ live_schema: draft, live_published_at: new Date().toISOString(), live_published_by: user?.id })
      .eq("id", row.id)
      .select("id, scope, location_id, draft_schema, live_schema, draft_updated_at, live_published_at")
      .single();
    setPublishing(false);
    if (error || !data) { TOAST.supabaseError(error, "Veröffentlichen fehlgeschlagen"); return; }
    setRow(data as TemplateRow);
    toast.success(`Live — ${scopeLabel} sieht jetzt das neue Form`);
  }

  function discardDraft() {
    if (!row) return;
    if (!confirm("Lokale Änderungen verwerfen und gespeicherten Draft wiederherstellen?")) return;
    setDraft(row.draft_schema);
  }

  function createOverride() {
    // Startet mit globalem Live-Form als Basis (oder DEFAULT wenn auch kein
    // globales Live existiert). Wird NOCH NICHT persistiert — Admin
    // editiert + drueckt dann "Draft speichern" um den Override anzulegen.
    setDraft(globalFallback ?? DEFAULT_PARTNER_FORM_SCHEMA);
    // dirty muss true werden damit "Draft speichern" anschlaegt. Trick:
    // setze einen "virtuellen leeren Row" damit der Vergleich
    // draft != row.draft_schema true ist. Aber dann waere row nicht-null
    // und das Insert-Pfad griffe nicht. Stattdessen: nichts setzen — row
    // bleibt null, und wir machen aus dem "Draft speichern"-Button
    // explizit "Override anlegen". Renderer unten entscheidet.
  }

  const isLocationScope = selectedLocationId !== null;
  const noOverrideYet = isLocationScope && !row;
  const selectedLocationName = locations.find((l) => l.id === selectedLocationId)?.name;

  // Select-Items: Global zuerst, dann Locations alphabetisch
  const selectItems = [
    { id: GLOBAL_SCOPE_VALUE, label: "Alle Partner (Standard)" },
    ...locations.map((l) => ({ id: l.id, label: l.name })),
  ];

  return (
    <div className="space-y-4">
      {/* Scope-Switcher */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 shrink-0">
              {isLocationScope ? <Building2 className="h-4 w-4 text-muted-foreground" /> : <Globe className="h-4 w-4 text-muted-foreground" />}
              <span className="text-xs font-semibold">Form für</span>
            </div>
            <div className="flex-1 min-w-[200px] max-w-sm">
              <SearchableSelect
                value={selectedLocationId ?? GLOBAL_SCOPE_VALUE}
                onChange={(v) => tryChangeLocation(v === GLOBAL_SCOPE_VALUE ? null : v)}
                items={selectItems}
                clearable={false}
                placeholder="…"
              />
            </div>
          </div>

          {/* Status-Zeile + Action-Buttons */}
          {!noOverrideYet && !loading && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-border">
              <div className="min-w-0 pt-2">
                <p className="text-xs text-muted-foreground">
                  {row?.live_published_at
                    ? <>Live seit <strong>{formatTs(row.live_published_at)}</strong></>
                    : isLocationScope
                      ? <>Noch nicht live — {selectedLocationName} sieht das <strong>globale Form</strong></>
                      : <>Noch nie veröffentlicht — Partner sehen das <strong>Default-Schema</strong></>}
                  {row?.draft_updated_at && (
                    <> · Draft zuletzt: <strong>{formatTs(row.draft_updated_at)}</strong></>
                  )}
                </p>
                {dirty && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Ungespeicherte Änderungen
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href="/partner/anfragen/neu" target="_blank" rel="noreferrer" className="kasten kasten-muted text-xs">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Vorschau
                </a>
                {row && dirty && (
                  <button type="button" onClick={discardDraft} disabled={savingDraft || publishing} className="kasten kasten-muted text-xs">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Verwerfen
                  </button>
                )}
                <button type="button" onClick={saveDraft} disabled={savingDraft || publishing || !dirty} className="kasten kasten-muted text-xs">
                  {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {savingDraft ? "Speichert…" : "Draft speichern"}
                </button>
                <button type="button" onClick={publish} disabled={savingDraft || publishing || dirty || !draftDiffersFromLive} className="kasten kasten-red text-xs"
                  data-tooltip={dirty ? "Zuerst Draft speichern" : !draftDiffersFromLive ? "Draft = Live, nichts zu publishen" : undefined}>
                  {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {publishing ? "Veröffentlicht…" : "Live veröffentlichen"}
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* No-Override-Banner (nur bei Location-Scope ohne Row) */}
      {noOverrideYet && !loading && (
        <Card className="bg-card border-blue-200 dark:border-blue-500/30">
          <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">{selectedLocationName} nutzt aktuell das <strong>globale Form</strong>.</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Wenn diese Location ein eigenes Form bekommen soll (= Override), kannst du eines anlegen.
                Es startet als Kopie des globalen Forms und kann frei angepasst werden.
              </p>
            </div>
            <button type="button" onClick={createOverride} className="kasten kasten-red text-xs shrink-0">
              <Plus className="h-3.5 w-3.5" />
              Eigenes Form für {selectedLocationName} anlegen
            </button>
          </CardContent>
        </Card>
      )}

      {/* "Draft speichern" wenn Override frisch angelegt aber noch nicht persistiert */}
      {noOverrideYet && draft.blocks.length > 0 && (
        <Card className="bg-card">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Override für <strong>{selectedLocationName}</strong> — noch nicht gespeichert.</p>
            <button type="button" onClick={saveDraft} disabled={savingDraft} className="kasten kasten-red text-xs">
              {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {savingDraft ? "Speichert…" : "Override speichern"}
            </button>
          </CardContent>
        </Card>
      )}

      {loading && <p className="text-sm text-muted-foreground">Form wird geladen…</p>}

      {/* Mode-Switch + Editoren — nur wenn editierbar */}
      {!loading && (!noOverrideYet || draft.blocks.length > 0) && (
        <>
          <div className="flex gap-1">
            <button type="button" onClick={() => setMode("blocks")} className={mode === "blocks" ? "kasten-active" : "kasten-toggle-off"}>
              <LayoutGrid className="h-3.5 w-3.5" /> Block-Builder
            </button>
            <button type="button" onClick={() => setMode("json")} className={mode === "json" ? "kasten-active" : "kasten-toggle-off"}>
              <FileCode className="h-3.5 w-3.5" /> JSON-Editor
            </button>
          </div>

          {mode === "blocks" && (
            <VisualBuilder
              blocks={draft.blocks}
              onChange={(next) => setDraft({ ...draft, blocks: next })}
            />
          )}

          {mode === "json" && (
            <Card className="bg-card">
              <CardContent className="p-4 space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  Direkter JSON-Edit. „Übernehmen“ überträgt das JSON in den Draft (immer noch lokal). „Draft speichern“ persistiert.
                </p>
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  rows={25}
                  spellCheck={false}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
                {jsonError && (
                  <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" /> {jsonError}
                  </p>
                )}
                <div className="flex gap-2">
                  <button type="button" onClick={applyJson} className="kasten kasten-muted text-xs">
                    JSON übernehmen
                  </button>
                  <button type="button" onClick={() => { setJsonText(JSON.stringify(draft, null, 2)); setJsonError(null); }} className="kasten kasten-muted text-xs">
                    Reset
                  </button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
