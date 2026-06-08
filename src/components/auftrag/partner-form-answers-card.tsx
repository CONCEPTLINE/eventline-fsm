"use client";

/**
 * Zeigt die Antworten des Partners auf Custom-Form-Felder (jobs.form_answers).
 *
 * Custom-Felder = alle Block-Werte aus dem Partner-Anfrage-Form, die NICHT
 * via mapTo in eine Core-Job-Spalte gehen (title, dates, contact_*). Diese
 * landen in jobs.form_answers (jsonb, keyed by block.id).
 *
 * Damit der Office-User die Antworten lesbar sieht, lookups wir das passende
 * Schema (Location-Override → global → Default) und matched die block.id
 * gegen das Schema um Block-Label, Type und Options aufzuloesen.
 *
 * Card wird nicht gerendert wenn form_answers leer/null.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { DEFAULT_PARTNER_FORM_SCHEMA } from "@/lib/partner-form/default-schema";
import type { FormSchema, FormBlock, DropdownOption } from "@/lib/partner-form/types";

interface Props {
  formAnswers: Record<string, unknown> | null;
  formSchemaSnapshot: FormSchema | null;
  locationId: string | null;
}

export function PartnerFormAnswersCard({ formAnswers, formSchemaSnapshot, locationId }: Props) {
  const supabase = createClient();
  const [schema, setSchema] = useState<FormSchema | null>(formSchemaSnapshot);

  useEffect(() => {
    if (!formAnswers || Object.keys(formAnswers).length === 0) return;
    // Snapshot bevorzugen — friert die Schema-Version vom Submit-Zeitpunkt
    // ein. Verhindert dass Schema-Aenderungen nach dem Submit die Labels
    // dieser konkreten Anfrage veraendern.
    if (formSchemaSnapshot) {
      setSchema(formSchemaSnapshot);
      return;
    }
    // Fallback fuer Alt-Daten ohne Snapshot: Location-Override → Global → Default.
    (async () => {
      let resolved: FormSchema = DEFAULT_PARTNER_FORM_SCHEMA;
      if (locationId) {
        const { data: rows } = await supabase
          .from("partner_form_template")
          .select("scope, location_id, live_schema")
          .or(`scope.eq.global,and(scope.eq.location,location_id.eq.${locationId})`);
        const locRow = rows?.find((r) => r.scope === "location" && r.location_id === locationId);
        const globRow = rows?.find((r) => r.scope === "global");
        resolved = (locRow?.live_schema as FormSchema | null)
          ?? (globRow?.live_schema as FormSchema | null)
          ?? DEFAULT_PARTNER_FORM_SCHEMA;
      } else {
        const { data: globRow } = await supabase
          .from("partner_form_template")
          .select("live_schema")
          .eq("scope", "global")
          .maybeSingle();
        resolved = (globRow?.live_schema as FormSchema | null) ?? DEFAULT_PARTNER_FORM_SCHEMA;
      }
      setSchema(resolved);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, formSchemaSnapshot, formAnswers ? Object.keys(formAnswers).join(",") : ""]);

  if (!formAnswers || Object.keys(formAnswers).length === 0) return null;

  const blockById = new Map<string, FormBlock>();
  schema?.blocks.forEach((b) => blockById.set(b.id, b));

  // Schema-Reihenfolge als Sort-Key (Position-Index pro ID). Keys die nicht
  // im Schema sind kriegen Infinity = ans Ende. Jeder formAnswer-Key
  // erscheint dabei GENAU EINMAL — vorher haben wir orderedKeys und
  // orphanKeys getrennt gebaut und konkateniert, was bei nicht geladenem
  // Schema dazu fuehrte dass alle Keys doppelt im Array landeten.
  const schemaOrder = new Map<string, number>();
  schema?.blocks.forEach((b, i) => schemaOrder.set(b.id, i));
  const entries = Object.entries(formAnswers).sort(
    ([a], [b]) => (schemaOrder.get(a) ?? Infinity) - (schemaOrder.get(b) ?? Infinity)
  );

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4" />
          Anfrage-Details
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map(([key, value]) => {
          const block = blockById.get(key);
          const label = block ? getBlockLabel(block) : key;
          const formatted = formatAnswer(value, block);
          // Orphan-Tag nur zeigen wenn Schema GELADEN ist UND Key dort
          // fehlt — sonst zeigen wir bei noch-ladend faelschlich alle
          // Keys als "Feld gelöscht".
          const isOrphan = schema !== null && !block;
          return (
            <div key={key} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-3 py-1 border-b border-border last:border-0">
              <div className="text-xs font-medium text-muted-foreground">
                {label}
                {isOrphan && <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">(Feld gelöscht)</span>}
              </div>
              <div className="text-sm whitespace-pre-line break-words">{formatted}</div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function getBlockLabel(b: FormBlock): string {
  if ("label" in b && b.label) return b.label;
  if ("title" in b && typeof b.title === "string") return b.title;
  return b.id;
}

function formatAnswer(value: unknown, block: FormBlock | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    // toggle-group multi: array von values → labels via Options-Lookup
    if (block && (block.type === "toggle-group" || block.type === "dropdown" || block.type === "radio")) {
      const opts = (block as { options?: DropdownOption[] }).options ?? [];
      return value.map((v) => opts.find((o) => o.value === v)?.label ?? String(v)).join(", ");
    }
    return value.map((v) => String(v)).join(", ");
  }
  if (typeof value === "object") {
    const obj = value as { start?: string; end?: string };
    if ("start" in obj || "end" in obj) {
      const s = obj.start || "—";
      const e = obj.end || "—";
      return `${s} – ${e}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
