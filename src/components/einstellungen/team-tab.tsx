"use client";

/**
 * Team-Tab in /einstellungen — admin-only.
 *
 * Listet alle User mit Name, Email, Rolle, Status. Pro Zeile drei Aktionen:
 *   - Passwort zuruecksetzen (Mail-Link an die User-Mail)
 *   - Bearbeiten (Name + Rolle)
 *   - Deaktivieren / Aktivieren (Soft-Delete via is_active + auth-ban)
 *
 * "Neuer Benutzer"-Button oeffnet ein Modal mit Email + Name + Rolle.
 * Beim Submit wird der User angelegt und kriegt sofort eine Reset-Mail
 * damit er sich selbst ein Passwort setzen kann — Admin sieht das
 * Passwort nie.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { Plus, KeyRound, Pencil, UserX, UserCheck, Trash2, Mail, Wallet, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

type EditState = { id: string; full_name: string; role: string } | null;
interface CompOriginal {
  hourly_wage_chf: number;
  /** All-or-Nothing: true = alle Pcts kommen aus dem Firmen-Standard,
   *  false = die expliziten Pct-Felder gelten. (Migration 156) */
  uses_standard_lohn: boolean;
  effective_from: string;
  notes: string | null;
  // Mitarbeiter-Abzuege (% vom Brutto). NULL bei standard-row, sonst Number.
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
  // Arbeitgeber-Anteil (% vom Brutto). Gleiche NULL-Logik.
  employer_ahv_pct: number | null;
  employer_alv_pct: number | null;
  employer_fak_pct: number | null;
  employer_bu_pct: number | null;
  employer_bvg_pct: number | null;
  employer_verwaltung_pct: number | null;
}
const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Pct-Anzeige: min 2 Nachkommastellen (Stability), max 4 (Praezision). Strip
// trailing zeros oberhalb der 2-Decimal-Baseline. 5.3 -> '5.30', 0.5742 ->
// '0.5742', 1.234 -> '1.234'.
function fmtPct(n: number): string {
  const fixed4 = n.toFixed(4);
  const trimmed = fixed4.replace(/0+$/, "");
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx < 0) return trimmed + ".00";
  const after = trimmed.length - dotIdx - 1;
  if (after < 2) return trimmed + "0".repeat(2 - after);
  return trimmed.replace(/\.$/, "");
}
interface RoleOption { slug: string; label: string }

export function TeamTab() {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", full_name: "", role: "techniker" });
  const [edit, setEdit] = useState<EditState>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Lohn-Felder im Edit-Modal — werden lazy beim Open via /api/hr/compensation
  // geladen. Trusted-Gate im Modal verhindert ungeschuetzten Zugriff.
  // Sektion ist standardmaessig zugeklappt damit das Modal nicht ueberfordert.
  const [lohnOpen, setLohnOpen] = useState(false);
  const [editWage, setEditWage] = useState("");
  // All-or-Nothing-Toggle im Edit-Modal: true = alle Pcts kommen aus
  // dem Firmen-Standard, false = die expliziten Inputs greifen.
  const [editUsesStandard, setEditUsesStandard] = useState(true);
  const [editFrom, setEditFrom] = useState("");
  const [editNotes, setEditNotes] = useState("");
  // Alle 12 Pcts pro Mitarbeiter als Strings (UI-Inputs). Bei
  // uses_standard_lohn=true werden sie nicht persistiert sondern beim
  // Speichern als NULL gesendet (sauberes DB-State).
  const PCT_KEYS = [
    "ahv_iv_eo_pct", "alv_pct", "nbu_pct", "bvg_pct", "ktg_pct", "quellensteuer_pct",
    "employer_ahv_pct", "employer_alv_pct", "employer_fak_pct", "employer_bu_pct", "employer_bvg_pct", "employer_verwaltung_pct",
  ] as const;
  type PctKey = typeof PCT_KEYS[number];
  type PctMap = Record<PctKey, string>;
  const PCT_EMPTY: PctMap = {
    ahv_iv_eo_pct: "", alv_pct: "", nbu_pct: "", bvg_pct: "", ktg_pct: "", quellensteuer_pct: "",
    employer_ahv_pct: "", employer_alv_pct: "", employer_fak_pct: "", employer_bu_pct: "", employer_bvg_pct: "", employer_verwaltung_pct: "",
  };
  const [editPcts, setEditPcts] = useState<PctMap>(PCT_EMPTY);
  // Firmen-Standards — alle 12 Pcts. Geladen via /api/hr/lohn-defaults.
  // Editierbar im oben gerenderten Standardwerte-Block, gleichzeitig als
  // Read-Only-Anzeige im Edit-Modal wenn Standard aktiv ist.
  type DefaultsState = PctMap;
  const DEFAULTS_FALLBACK: DefaultsState = {
    ahv_iv_eo_pct: "5.3", alv_pct: "1.1", nbu_pct: "1.4", bvg_pct: "0", ktg_pct: "0", quellensteuer_pct: "0",
    employer_ahv_pct: "5.3", employer_alv_pct: "1.1", employer_fak_pct: "1.5", employer_bu_pct: "0.5", employer_bvg_pct: "3.0", employer_verwaltung_pct: "0.5",
  };
  const [lohnDefaults, setLohnDefaults] = useState<DefaultsState>(DEFAULTS_FALLBACK);
  const [defaultDrafts, setDefaultDrafts] = useState<DefaultsState>(DEFAULTS_FALLBACK);
  const [savingDefault, setSavingDefault] = useState(false);
  const [editCompOriginal, setEditCompOriginal] = useState<CompOriginal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    // Vollzugriff auf Profile (inkl. email/phone) gibt es nur fuer Admins
    // via SECURITY-DEFINER-Funktion. Direct-Reads via .from("profiles").
    // select("*") liefern jetzt keine email/phone mehr (Column-Grant
    // verweigert den Zugriff fuer normale authenticated User).
    const [profRes, rolesRes] = await Promise.all([
      supabase.rpc("get_all_profiles_admin"),
      fetch("/api/admin/roles").then((r) => r.json()),
    ]);
    // Firmenportal-Team = nur EVENTLINE-interne Profile. Partner-User
    // (role='partner') werden im Partnerportal/Partner-Tab verwaltet,
    // sollen hier NICHT auftauchen.
    const all = (profRes.data as Profile[]) ?? [];
    setProfiles(all.filter((p) => p.role !== "partner"));
    if (rolesRes?.success) {
      // Partner-Rolle aus dem Rollen-Dropdown entfernen — die kann nur
      // ueber den Partner-Tab vergeben werden (braucht zusaetzlich
      // partner_location_id).
      setRoles((rolesRes.roles as RoleOption[]).filter((r) => r.slug !== "partner").map((r) => ({ slug: r.slug, label: r.label })));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Firmen-Lohn-Standards laden. Backend liefert camelCase-LohnPctSet,
  // wir mappen auf die snake_case-DB-Keys damit alles via PCT_KEYS lookup-bar
  // ist. Fail silent wenn das Geraet nicht vertraut ist (trust-gated).
  function applyDefaults(d: Record<string, unknown>) {
    const mapToPctMap = (camelKey: string): number => {
      const v = d[camelKey];
      return v == null ? 0 : Number(v);
    };
    const next: DefaultsState = {
      ahv_iv_eo_pct: String(mapToPctMap("ahvIvEoPct")),
      alv_pct: String(mapToPctMap("alvPct")),
      nbu_pct: String(mapToPctMap("nbuPct")),
      bvg_pct: String(mapToPctMap("bvgPct")),
      ktg_pct: String(mapToPctMap("ktgPct")),
      quellensteuer_pct: String(mapToPctMap("quellensteuerPct")),
      employer_ahv_pct: String(mapToPctMap("employerAhvPct")),
      employer_alv_pct: String(mapToPctMap("employerAlvPct")),
      employer_fak_pct: String(mapToPctMap("employerFakPct")),
      employer_bu_pct: String(mapToPctMap("employerBuPct")),
      employer_bvg_pct: String(mapToPctMap("employerBvgPct")),
      employer_verwaltung_pct: String(mapToPctMap("employerVerwaltungPct")),
    };
    setLohnDefaults(next);
    setDefaultDrafts(next);
  }

  useEffect(() => {
    fetch("/api/hr/lohn-defaults")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.success && json.defaults) applyDefaults(json.defaults);
      })
      .catch(() => { /* untrusted -> Defaults bleiben Fallback */ });
  }, []);

  async function saveLohnDefault(key: string) {
    const k = key as PctKey;
    const draft = defaultDrafts[k];
    const v = parseFloat(draft.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v > 100) { toast.error("Ungueltiger Wert (0-100)"); return; }
    setSavingDefault(true);
    const res = await fetch("/api/hr/lohn-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [`default_${k}`]: v }),
    });
    setSavingDefault(false);
    const json = await res.json();
    if (!res.ok || !json.success) { TOAST.errorOr(json.error); return; }
    setLohnDefaults((prev) => ({ ...prev, [k]: String(v) }));
    toast.success("Standard gespeichert");
  }

  function roleLabel(slug: string): string {
    return roles.find((r) => r.slug === slug)?.label ?? slug;
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    const json = await res.json();
    setCreating(false);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Benutzer angelegt — Einladungs-Mail verschickt");
    setShowCreate(false);
    setCreateForm({ email: "", full_name: "", role: "techniker" });
    load();
  }

  function openEdit(p: Profile) {
    setEdit({ id: p.id, full_name: p.full_name, role: p.role });
    setLohnOpen(false);
    // Reset wage state, lazy-fetch (kann fehlschlagen wenn Geraet nicht
    // vertraut ist — dann bleiben Felder leer und der Trust-Gate im
    // Modal zeigt die Vertrauen-Anfrage).
    setEditWage(""); setEditNotes("");
    setEditUsesStandard(true);
    setEditPcts(PCT_EMPTY);
    setEditFrom(new Date().toISOString().slice(0, 10));
    setEditCompOriginal(null);
    fetch("/api/hr/compensation")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (!json?.success) return;
        if (json.defaults) applyDefaults(json.defaults);
        type Empl = { profile_id: string; compensation: CompOriginal | null };
        const empl = (json.employees as Empl[]).find((e) => e.profile_id === p.id);
        const c = empl?.compensation;
        if (c) {
          setEditWage(String(c.hourly_wage_chf));
          setEditUsesStandard(c.uses_standard_lohn !== false);
          setEditFrom(c.effective_from);
          setEditNotes(c.notes ?? "");
          // Pcts in editPcts laden. Falls Override-Modus aber NULL gespeichert
          // war (sollte nicht passieren), zeigen wir den aktuellen Standard
          // als sinnvollen Pre-Fill an.
          const fill = (v: number | null, fallback: string) => v == null ? fallback : String(v);
          setEditPcts({
            ahv_iv_eo_pct: fill(c.ahv_iv_eo_pct, ""),
            alv_pct: fill(c.alv_pct, ""),
            nbu_pct: fill(c.nbu_pct, ""),
            bvg_pct: fill(c.bvg_pct, ""),
            ktg_pct: fill(c.ktg_pct, ""),
            quellensteuer_pct: fill(c.quellensteuer_pct, ""),
            employer_ahv_pct: fill(c.employer_ahv_pct, ""),
            employer_alv_pct: fill(c.employer_alv_pct, ""),
            employer_fak_pct: fill(c.employer_fak_pct, ""),
            employer_bu_pct: fill(c.employer_bu_pct, ""),
            employer_bvg_pct: fill(c.employer_bvg_pct, ""),
            employer_verwaltung_pct: fill(c.employer_verwaltung_pct, ""),
          });
          setEditCompOriginal(c);
        }
      })
      .catch(() => { /* untrusted → leer lassen, Gate uebernimmt */ });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setSavingEdit(true);

    // 1) Profile patchen (Name/Rolle)
    const profileRes = await fetch(`/api/admin/users/${edit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: edit.full_name, role: edit.role }),
    });
    const profileJson = await profileRes.json();
    if (!profileJson.success) {
      setSavingEdit(false);
      TOAST.errorOr(profileJson.error);
      return;
    }

    // 2) Lohn-Zeile patchen wenn Werte gesetzt UND geaendert
    const wage = parseFloat(editWage.replace(",", "."));
    // Pcts pro Spalte: bei uses_standard wird das Feld eh als null
    // gesendet (vom Backend), aber wir senden's hier schon zur Eindeutigkeit.
    const pctOrNull = (s: string): number | null => {
      const n = parseFloat(s.replace(",", "."));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    };
    const pctPayload: Record<string, number | null> = {};
    for (const k of PCT_KEYS) {
      pctPayload[k] = editUsesStandard ? null : pctOrNull(editPcts[k]);
    }
    if (Number.isFinite(wage) && wage >= 0 && editFrom) {
      // Change-Detection: wage/notes/from + uses_standard_lohn-Flag.
      // Bei Override-Modus zusaetzlich: jeden einzelnen Pct vergleichen.
      const eq = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);
      const pctsChanged = !editUsesStandard && editCompOriginal && PCT_KEYS.some((k) => !eq(editCompOriginal[k as keyof CompOriginal] as number | null, pctPayload[k]));
      const changed = !editCompOriginal
        || editCompOriginal.hourly_wage_chf !== wage
        || editCompOriginal.uses_standard_lohn !== editUsesStandard
        || editCompOriginal.effective_from !== editFrom
        || (editCompOriginal.notes ?? "") !== editNotes.trim()
        || pctsChanged;
      if (changed) {
        const wageRes = await fetch("/api/hr/compensation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_id: edit.id,
            hourly_wage_chf: wage,
            uses_standard_lohn: editUsesStandard,
            effective_from: editFrom,
            notes: editNotes.trim() || null,
            ...pctPayload,
          }),
        });
        const wageJson = await wageRes.json();
        if (!wageRes.ok || !wageJson.success) {
          setSavingEdit(false);
          toast.warning(`Profil gespeichert, Lohn nicht: ${wageJson.error ?? "Fehler"}`);
          load();
          setEdit(null);
          return;
        }
      }
    }

    setSavingEdit(false);
    toast.success("Gespeichert");
    setEdit(null);
    load();
  }

  async function resetPassword(p: Profile) {
    const ok = await confirm({
      title: "Passwort zurücksetzen?",
      message: `${p.full_name} bekommt einen Link an ${p.email} um sich selbst ein neues Passwort zu setzen.`,
      confirmLabel: "Mail senden",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(p.id);
    const res = await fetch(`/api/admin/users/${p.id}/reset-password`, { method: "POST" });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success(`Reset-Mail an ${p.email} verschickt`);
  }

  async function hardDelete(p: Profile) {
    const ok = await confirm({
      title: "Dossier erstellen + endgültig löschen?",
      message: `Bevor ${p.full_name} gelöscht wird, packen wir alle Daten (Stempel, Rapporte, Lohndokumente, Notifications, hochgeladene Dateien) in ein ZIP-Dossier zum Download. Dann wird der Benutzer aus dem System entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`,
      confirmLabel: "Dossier + löschen",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(p.id);

    // 1) Dossier generieren (= ZIP-Backup aller Daten + PDFs)
    let dossierUrl: string | null = null;
    try {
      const dossierRes = await fetch(`/api/admin/users/${p.id}/dossier`, { method: "POST" });
      const dossierJson = await dossierRes.json();
      if (!dossierJson.success) {
        setBusyId(null);
        TOAST.errorOr(dossierJson.error || "Dossier konnte nicht erstellt werden — Benutzer NICHT gelöscht");
        return;
      }
      dossierUrl = dossierJson.download_url ?? null;
    } catch (err) {
      setBusyId(null);
      toast.error("Dossier-Fehler: " + (err instanceof Error ? err.message : "Netzwerk") + " — Benutzer NICHT gelöscht");
      return;
    }

    // 2) User löschen
    const res = await fetch(`/api/admin/users/${p.id}`, { method: "DELETE" });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }

    // 3) Toast mit Download-Link (1h gültig)
    if (dossierUrl) {
      toast.success(`${p.full_name} gelöscht — Dossier verfügbar`, {
        action: {
          label: "Download",
          onClick: () => {
            const a = document.createElement("a");
            a.href = dossierUrl!;
            a.download = `dossier_${p.full_name}.zip`;
            a.target = "_blank";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          },
        },
        duration: 60000, // 60s sichtbar
      });
    } else {
      toast.success(`${p.full_name} endgültig gelöscht`);
    }
    load();
  }

  async function toggleActive(p: Profile) {
    const ok = await confirm({
      title: p.is_active ? "Benutzer deaktivieren?" : "Benutzer reaktivieren?",
      message: p.is_active
        ? `${p.full_name} kann sich nicht mehr einloggen. Bestehende Aufträge bleiben unverändert.`
        : `${p.full_name} kann sich wieder einloggen.`,
      confirmLabel: p.is_active ? "Deaktivieren" : "Reaktivieren",
      variant: p.is_active ? "red" : "blue",
    });
    if (!ok) return;
    setBusyId(p.id);
    const res = await fetch(`/api/admin/users/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !p.is_active }),
    });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success(p.is_active ? "Deaktiviert" : "Reaktiviert");
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          EVENTLINE-interne Mitarbeiter. Neue User bekommen eine Einladungs-Mail und setzen sich selbst ein Passwort.
        </p>
        <button type="button" onClick={() => setShowCreate(true)} className="kasten kasten-red">
          <Plus className="h-3.5 w-3.5" />Neuer Benutzer
        </button>
      </div>

      {/* Lohn-Standardwerte — firmenweit. Zwei Gruppen: Mitarbeiter-Abzuege
          (vom Brutto abgezogen -> Netto) und Arbeitgeber-Anteil (zusaetzlich
          zur Firma -> Vollkosten). Summe wird automatisch berechnet. */}
      <Card className="bg-card">
        <CardContent className="p-3 space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Lohn-Standardwerte</p>
              <p className="text-[11px] text-muted-foreground">
                Greifen bei jedem Mitarbeiter mit Standard-Lohn. Pro Mitarbeiter via Edit-Modal komplett uebersteuerbar.
              </p>
            </div>
          </div>

          {/* Mitarbeiter-Abzuege (AN) */}
          <DefaultsGroup
            title="Mitarbeiter-Abzüge (% vom Brutto)"
            subtitle="werden vom Brutto abgezogen → Netto-Auszahlung"
            fields={[
              { key: "ahv_iv_eo_pct", label: "AHV/IV/EO" },
              { key: "alv_pct", label: "ALV" },
              { key: "nbu_pct", label: "NBU" },
              { key: "bvg_pct", label: "BVG" },
              { key: "ktg_pct", label: "KTG" },
              { key: "quellensteuer_pct", label: "Quellensteuer" },
            ]}
            drafts={defaultDrafts}
            setDrafts={setDefaultDrafts}
            current={lohnDefaults}
            onSave={saveLohnDefault}
            saving={savingDefault}
          />

          {/* Arbeitgeber-Anteil (AG) */}
          <DefaultsGroup
            title="Arbeitgeber-Anteil (% vom Brutto)"
            subtitle="zusätzliche Firmenkosten → Vollkosten"
            fields={[
              { key: "employer_ahv_pct", label: "AHV/IV/EO" },
              { key: "employer_alv_pct", label: "ALV" },
              { key: "employer_fak_pct", label: "FAK" },
              { key: "employer_bu_pct", label: "BU" },
              { key: "employer_bvg_pct", label: "BVG" },
              { key: "employer_verwaltung_pct", label: "Verwaltung" },
            ]}
            drafts={defaultDrafts}
            setDrafts={setDefaultDrafts}
            current={lohnDefaults}
            onSave={saveLohnDefault}
            saving={savingDefault}
          />
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-2">{[1,2,3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4"><div className="h-5 bg-muted rounded w-1/2" /></CardContent></Card>)}</div>
      ) : profiles.length === 0 ? (
        <Card className="bg-card border-dashed"><CardContent className="py-12 text-center text-sm text-muted-foreground">Noch keine Benutzer.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <Card key={p.id} className={`card-hover bg-card ${!p.is_active ? "opacity-60" : ""}`}>
              <CardContent className="px-4 py-1.5 flex items-center gap-3">
                <div className="h-7 w-7 rounded-md bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {p.full_name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm truncate">{p.full_name}</span>
                    <span className={`inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full shrink-0 ${p.role === "admin" ? "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300" : "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300"}`}>
                      {roleLabel(p.role)}
                    </span>
                    {!p.is_active && (
                      <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0">
                        Deaktiviert
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
                    <Mail className="h-2.5 w-2.5 shrink-0" />{p.email}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => resetPassword(p)}
                    disabled={busyId === p.id || !p.is_active}
                    className="kasten kasten-muted"
                    data-tooltip="Passwort zurücksetzen"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(p)}
                    className="kasten kasten-purple"
                    data-tooltip="Bearbeiten"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(p)}
                    disabled={busyId === p.id}
                    className={p.is_active ? "kasten kasten-muted" : "kasten kasten-green"}
                    data-tooltip={p.is_active ? "Deaktivieren" : "Reaktivieren"}
                  >
                    {p.is_active ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                  </button>
                  {!p.is_active && (
                    <button
                      type="button"
                      onClick={() => hardDelete(p)}
                      disabled={busyId === p.id}
                      className="kasten kasten-red"
                      data-tooltip="Endgültig löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create-Modal */}
      <Modal open={showCreate} onClose={() => !creating && setShowCreate(false)} title="Neuer Benutzer" size="md">
        <form onSubmit={createUser} className="space-y-4">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Vor- und Nachname *</p>
            <Input
              value={createForm.full_name}
              onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })}
              placeholder="Max Muster"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Email *</p>
            <Input
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              placeholder="max@eventline-basel.com"
              required
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Rolle *</p>
            <select
              value={createForm.role}
              onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              className="w-full h-9 px-3 text-sm rounded-xl border border-border bg-card"
            >
              {roles.map((r) => <option key={r.slug} value={r.slug}>{r.label}</option>)}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            An die angegebene Email-Adresse wird ein Link verschickt, mit dem der Benutzer sich selbst ein Passwort setzt.
          </p>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setShowCreate(false)} disabled={creating} className="kasten kasten-muted flex-1">Abbrechen</button>
            <button type="submit" disabled={creating || !createForm.email || !createForm.full_name} className="kasten kasten-red flex-1">
              {creating ? "Erstellt…" : "Benutzer anlegen"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit-Modal — Name + Rolle + Lohn-Sektion (hinter Trust-Gate). */}
      <Modal open={!!edit} onClose={() => !savingEdit && setEdit(null)} title="Benutzer bearbeiten" size="md">
        {edit && (
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Name</p>
              <Input
                value={edit.full_name}
                onChange={(e) => setEdit({ ...edit, full_name: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Rolle</p>
              <select
                value={edit.role}
                onChange={(e) => setEdit({ ...edit, role: e.target.value })}
                className="w-full h-9 px-3 text-sm rounded-xl border border-border bg-card"
              >
                {roles.map((r) => <option key={r.slug} value={r.slug}>{r.label}</option>)}
              </select>
            </div>

            {/* Lohn-Sektion — klappbarer Header. Nur sichtbar auf vertrautem
                Geraet (sensible Daten). */}
            <div className="pt-3 border-t">
              <button
                type="button"
                onClick={() => setLohnOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 text-xs font-semibold py-1 hover:text-foreground/70 transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Wallet className="h-3.5 w-3.5" /> Lohn &amp; Abzüge
                </span>
                {lohnOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {lohnOpen && (
                <div className="mt-2">
                  <TrustedDeviceGate>
                    <div className="space-y-3">
                      {/* Brutto — wage ist immer pro-Mitarbeiter (kein Standard). */}
                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground/70 ml-1">Brutto / h (CHF)</p>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={editWage}
                          onChange={(e) => setEditWage(e.target.value)}
                          placeholder="z.B. 22.50"
                        />
                      </div>

                      {/* All-or-Nothing-Toggle: Standard verwenden ODER alle
                          12 Pcts selber setzen. Kein per-Feld-Override. */}
                      <div className="flex items-center justify-between pt-2 border-t border-foreground/10">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Lohn-Abzüge &amp; AG-Anteil
                        </p>
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editUsesStandard}
                            onChange={(e) => setEditUsesStandard(e.target.checked)}
                            className="h-3.5 w-3.5"
                          />
                          <span>Firmen-Standard verwenden</span>
                        </label>
                      </div>

                      {editUsesStandard ? (
                        // Read-Only-Ansicht: zeigt die 12 Standard-Werte.
                        <div className="space-y-3">
                          <ReadonlyPctGroup
                            title="Mitarbeiter-Abzüge"
                            fields={[
                              { key: "ahv_iv_eo_pct", label: "AHV/IV/EO" },
                              { key: "alv_pct", label: "ALV" },
                              { key: "nbu_pct", label: "NBU" },
                              { key: "bvg_pct", label: "BVG" },
                              { key: "ktg_pct", label: "KTG" },
                              { key: "quellensteuer_pct", label: "QST" },
                            ]}
                            values={lohnDefaults}
                          />
                          <ReadonlyPctGroup
                            title="Arbeitgeber-Anteil"
                            fields={[
                              { key: "employer_ahv_pct", label: "AHV/IV/EO" },
                              { key: "employer_alv_pct", label: "ALV" },
                              { key: "employer_fak_pct", label: "FAK" },
                              { key: "employer_bu_pct", label: "BU" },
                              { key: "employer_bvg_pct", label: "BVG" },
                              { key: "employer_verwaltung_pct", label: "Verwaltung" },
                            ]}
                            values={lohnDefaults}
                          />
                          <p className="text-[10px] text-muted-foreground/70 italic">
                            Die 12 Werte werden im Block oben (Lohn-Standardwerte) firmenweit gesetzt.
                          </p>
                        </div>
                      ) : (
                        // Override-Modus: 12 editierbare Inputs.
                        <div className="space-y-3">
                          <EditablePctGroup
                            title="Mitarbeiter-Abzüge"
                            fields={[
                              { key: "ahv_iv_eo_pct", label: "AHV/IV/EO" },
                              { key: "alv_pct", label: "ALV" },
                              { key: "nbu_pct", label: "NBU" },
                              { key: "bvg_pct", label: "BVG" },
                              { key: "ktg_pct", label: "KTG" },
                              { key: "quellensteuer_pct", label: "QST" },
                            ]}
                            values={editPcts}
                            setValues={setEditPcts}
                            defaults={lohnDefaults}
                          />
                          <EditablePctGroup
                            title="Arbeitgeber-Anteil"
                            fields={[
                              { key: "employer_ahv_pct", label: "AHV/IV/EO" },
                              { key: "employer_alv_pct", label: "ALV" },
                              { key: "employer_fak_pct", label: "FAK" },
                              { key: "employer_bu_pct", label: "BU" },
                              { key: "employer_bvg_pct", label: "BVG" },
                              { key: "employer_verwaltung_pct", label: "Verwaltung" },
                            ]}
                            values={editPcts}
                            setValues={setEditPcts}
                            defaults={lohnDefaults}
                          />
                        </div>
                      )}

                      {/* Netto / Vollkosten Preview. */}
                      <LohnPreview
                        wage={editWage}
                        values={editUsesStandard ? lohnDefaults : editPcts}
                      />

                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground/70 ml-1">Gültig ab</p>
                        <Input type="date" value={editFrom} onChange={(e) => setEditFrom(e.target.value)} />
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional)</p>
                        <Input
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="z.B. 'Anpassung BVG ab 2026'"
                          maxLength={200}
                        />
                      </div>
                    </div>
                  </TrustedDeviceGate>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setEdit(null)} disabled={savingEdit} className="kasten kasten-muted flex-1">Abbrechen</button>
              <button type="submit" disabled={savingEdit || !edit.full_name} className="kasten kasten-red flex-1">
                {savingEdit ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {ConfirmModalElement}
    </div>
  );
}

/** Lohn-Standardwerte-Block, gruppiert nach AN/AG. Jedes Feld speichert
 *  einzeln (kleiner OK-Button erscheint wenn Wert vom gespeicherten
 *  abweicht). Summe der Gruppe wird am Ende angezeigt. */
function DefaultsGroup({ title, subtitle, fields, drafts, setDrafts, current, onSave, saving }: {
  title: string;
  subtitle: string;
  fields: Array<{ key: string; label: string }>;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  current: Record<string, string>;
  onSave: (k: string) => Promise<void>;
  saving: boolean;
}) {
  const sum = fields.reduce((s, f) => s + (parseFloat((drafts[f.key] ?? "0").replace(",", ".")) || 0), 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70">{subtitle} · <span className="font-semibold text-foreground/80 tabular-nums">Σ {fmtPct(sum)}%</span></p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {fields.map((f) => {
          const draft = drafts[f.key] ?? "";
          const dirty = draft !== current[f.key];
          return (
            <div key={f.key} className="space-y-0.5">
              <label className="text-[10px] text-muted-foreground/70 truncate block">{f.label}</label>
              <div className="flex gap-1">
                <div className="relative flex-1 min-w-0">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDrafts((p) => ({ ...p, [f.key]: e.target.value }))}
                    className="h-8 text-xs pr-7"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">%</span>
                </div>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => onSave(f.key)}
                    disabled={saving}
                    className="px-2 h-8 text-[10px] font-semibold rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25 transition-colors shrink-0"
                  >
                    OK
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Read-only Anzeige einer Pct-Gruppe (im Modal wenn Standard aktiv ist). */
function ReadonlyPctGroup({ title, fields, values }: {
  title: string;
  fields: Array<{ key: string; label: string }>;
  values: Record<string, string>;
}) {
  const sum = fields.reduce((s, f) => s + (parseFloat((values[f.key] ?? "0").replace(",", ".")) || 0), 0);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">Σ {fmtPct(sum)}%</p>
      </div>
      <div className="grid grid-cols-3 gap-1 text-xs">
        {fields.map((f) => (
          <div key={f.key} className="flex items-center justify-between px-2 py-1 rounded border border-dashed border-border bg-muted/30 text-muted-foreground">
            <span className="truncate text-[10px]">{f.label}</span>
            <span className="tabular-nums">{fmtPct(parseFloat((values[f.key] ?? "0").replace(",", ".")) || 0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Editierbare Pct-Gruppe (im Modal wenn Override aktiv ist).
 *  Default-Wert wird als Placeholder angezeigt. */
function EditablePctGroup({ title, fields, values, setValues, defaults }: {
  title: string;
  fields: Array<{ key: string; label: string }>;
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  defaults: Record<string, string>;
}) {
  const sum = fields.reduce((s, f) => {
    const v = parseFloat((values[f.key] || defaults[f.key] || "0").replace(",", ".")) || 0;
    return s + v;
  }, 0);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">Σ {fmtPct(sum)}%</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {fields.map((f) => (
          <div key={f.key} className="space-y-0.5">
            <label className="text-[10px] text-muted-foreground/70 truncate block">{f.label}</label>
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                className="h-9 text-xs pr-7"
                placeholder={defaults[f.key] ?? "0"}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Netto/Vollkosten-Preview. Liest direkt aus dem effektiven Pct-Set
 *  (entweder editPcts wenn Override aktiv, sonst lohnDefaults). */
function LohnPreview({ wage, values }: {
  wage: string;
  values: Record<string, string>;
}) {
  const w = parseFloat(wage.replace(",", "."));
  if (!Number.isFinite(w) || w < 0) return null;
  const num = (k: string) => parseFloat((values[k] ?? "0").replace(",", ".")) || 0;
  const totalAnPct = num("ahv_iv_eo_pct") + num("alv_pct") + num("nbu_pct") + num("bvg_pct") + num("ktg_pct") + num("quellensteuer_pct");
  const totalAgPct = num("employer_ahv_pct") + num("employer_alv_pct") + num("employer_fak_pct") + num("employer_bu_pct") + num("employer_bvg_pct") + num("employer_verwaltung_pct");
  const deductionAmount = w * (totalAnPct / 100);
  const netto = w - deductionAmount;
  const agAmount = w * (totalAgPct / 100);
  const vollkosten = w + agAmount;
  return (
    <div className="space-y-1 px-3 py-2 rounded-lg bg-foreground/[0.04] dark:bg-foreground/[0.06] text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground">Brutto / h</span>
        <span className="tabular-nums">CHF {CHF.format(w)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground">
        <span>− Abzüge ({fmtPct(totalAnPct)}%)</span>
        <span className="tabular-nums">CHF {CHF.format(deductionAmount)}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1 border-t border-foreground/10">
        <span className="font-semibold">Netto / h</span>
        <span className="font-semibold tabular-nums">CHF {CHF.format(netto)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground pt-1">
        <span>+ AG-Anteil ({fmtPct(totalAgPct)}%)</span>
        <span className="tabular-nums">CHF {CHF.format(agAmount)}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1 border-t border-foreground/10 text-muted-foreground">
        <span>Vollkosten / h</span>
        <span className="tabular-nums">CHF {CHF.format(vollkosten)}</span>
      </div>
    </div>
  );
}
