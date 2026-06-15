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
  /** null = nutzt Firmen-Standard, number = expliziter Override. */
  /** Arbeitgeber-Anteil als % vom Brutto (Migration 154). */
  employer_pct: number | null;
  effective_from: string;
  notes: string | null;
  // null = nutzt Firmen-Standard, number = expliziter Override.
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
}
const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const [editEmployer, setEditEmployer] = useState("");
  // Checkbox 'Standard verwenden' im Edit-Modal. Wenn true wird der Override
  // im POST als null gesendet -> Backend nutzt app_settings.default_*.
  const [editEmployerUseDefault, setEditEmployerUseDefault] = useState(true);
  // Firmen-Standards — geladen via /api/hr/lohn-defaults. Werden im
  // oben gerenderten Standardwerte-Block editiert + im Edit-Modal als
  // Placeholder/Default-Anzeige verwendet wenn 'Standard' aktiv ist.
  interface DefaultsState {
    employer: number;
    ahv: number;
    alv: number;
    nbu: number;
    bvg: number;
    ktg: number;
    qst: number;
  }
  const [lohnDefaults, setLohnDefaults] = useState<DefaultsState>({
    employer: 0, ahv: 5.3, alv: 1.1, nbu: 1.4, bvg: 0, ktg: 0, qst: 0,
  });
  // Drafts — eines pro Feld damit man unabhaengig speichern kann.
  const [defaultDrafts, setDefaultDrafts] = useState<Record<keyof DefaultsState, string>>({
    employer: "0", ahv: "5.3", alv: "1.1", nbu: "1.4", bvg: "0", ktg: "0", qst: "0",
  });
  const [savingDefault, setSavingDefault] = useState(false);
  const [editFrom, setEditFrom] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editAhv, setEditAhv] = useState("5.3");
  const [editAlv, setEditAlv] = useState("1.1");
  const [editNbu, setEditNbu] = useState("1.4");
  const [editBvg, setEditBvg] = useState("0");
  const [editKtg, setEditKtg] = useState("0");
  const [editQst, setEditQst] = useState("0");
  // 'Standard verwenden' Toggles pro Abzug. Wenn true wird im POST null
  // gesendet -> Backend nimmt den Firmen-Standard.
  const [editUseDefAhv, setEditUseDefAhv] = useState(true);
  const [editUseDefAlv, setEditUseDefAlv] = useState(true);
  const [editUseDefNbu, setEditUseDefNbu] = useState(true);
  const [editUseDefBvg, setEditUseDefBvg] = useState(true);
  const [editUseDefKtg, setEditUseDefKtg] = useState(true);
  const [editUseDefQst, setEditUseDefQst] = useState(true);
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

  // Firmen-Lohn-Standards laden — fuer Anzeige in Standardwerte-Block
  // + als Placeholder/Default im Edit-Modal. Fail silent wenn das Geraet
  // nicht vertraut ist (Endpoint ist trust-gated).
  function applyDefaults(d: { employerPct: number; ahvIvEoPct: number; alvPct: number; nbuPct: number; bvgPct: number; ktgPct: number; quellensteuerPct: number }) {
    const next: DefaultsState = {
      employer: Number(d.employerPct ?? 12),
      ahv: Number(d.ahvIvEoPct ?? 5.3),
      alv: Number(d.alvPct ?? 1.1),
      nbu: Number(d.nbuPct ?? 1.4),
      bvg: Number(d.bvgPct ?? 0),
      ktg: Number(d.ktgPct ?? 0),
      qst: Number(d.quellensteuerPct ?? 0),
    };
    setLohnDefaults(next);
    setDefaultDrafts({
      employer: String(next.employer),
      ahv: String(next.ahv),
      alv: String(next.alv),
      nbu: String(next.nbu),
      bvg: String(next.bvg),
      ktg: String(next.ktg),
      qst: String(next.qst),
    });
  }

  useEffect(() => {
    fetch("/api/hr/lohn-defaults")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.success && json.defaults) applyDefaults(json.defaults);
      })
      .catch(() => { /* untrusted -> Defaults bleiben Fallback */ });
  }, []);

  // Mappt UI-Keys auf die Backend-Spaltennamen.
  const DEFAULT_COLUMN: Record<keyof DefaultsState, string> = {
    employer: "default_employer_pct",
    ahv: "default_ahv_iv_eo_pct",
    alv: "default_alv_pct",
    nbu: "default_nbu_pct",
    bvg: "default_bvg_pct",
    ktg: "default_ktg_pct",
    qst: "default_quellensteuer_pct",
  };

  async function saveLohnDefault(key: keyof DefaultsState) {
    const draft = defaultDrafts[key];
    const v = parseFloat(draft.replace(",", "."));
    if (!Number.isFinite(v) || v < 0) { toast.error("Ungueltiger Wert"); return; }
    setSavingDefault(true);
    const res = await fetch("/api/hr/lohn-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [DEFAULT_COLUMN[key]]: v }),
    });
    setSavingDefault(false);
    const json = await res.json();
    if (!res.ok || !json.success) { TOAST.errorOr(json.error); return; }
    setLohnDefaults((prev) => ({ ...prev, [key]: v }));
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
    // Modal zeigt die Vertrauen-Anfrage). Wenn schon Daten existieren,
    // werden sie vorgefuellt.
    setEditWage(""); setEditEmployer(""); setEditNotes("");
    setEditEmployerUseDefault(true);
    setEditFrom(new Date().toISOString().slice(0, 10));
    setEditAhv("5.3"); setEditAlv("1.1"); setEditNbu("1.4");
    setEditBvg("0"); setEditKtg("0"); setEditQst("0");
    setEditUseDefAhv(true); setEditUseDefAlv(true); setEditUseDefNbu(true);
    setEditUseDefBvg(true); setEditUseDefKtg(true); setEditUseDefQst(true);
    setEditCompOriginal(null);
    fetch("/api/hr/compensation")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (!json?.success) return;
        if (json.defaults) {
          // Defaults sind auch im /api/hr/compensation-Payload — wir
          // syncen damit's stimmt selbst wenn das separate /lohn-defaults
          // noch nicht durch ist.
          applyDefaults({
            employerPct: Number(json.defaults.employer_pct ?? 12),
            ahvIvEoPct: Number(json.defaults.ahv_iv_eo_pct ?? 5.3),
            alvPct: Number(json.defaults.alv_pct ?? 1.1),
            nbuPct: Number(json.defaults.nbu_pct ?? 1.4),
            bvgPct: Number(json.defaults.bvg_pct ?? 0),
            ktgPct: Number(json.defaults.ktg_pct ?? 0),
            quellensteuerPct: Number(json.defaults.quellensteuer_pct ?? 0),
          });
        }
        type Empl = { profile_id: string; compensation: CompOriginal | null };
        const empl = (json.employees as Empl[]).find((e) => e.profile_id === p.id);
        const c = empl?.compensation;
        if (c) {
          setEditWage(String(c.hourly_wage_chf));
          // null = Standard verwenden, sonst Override
          if (c.employer_pct == null) {
            setEditEmployerUseDefault(true);
            setEditEmployer("");
          } else {
            setEditEmployerUseDefault(false);
            setEditEmployer(String(c.employer_pct));
          }
          setEditFrom(c.effective_from);
          setEditNotes(c.notes ?? "");
          // Pro Abzug: null = Standard, sonst Override
          const applyPct = (v: number | null, setU: (b: boolean) => void, setV: (s: string) => void) => {
            if (v == null) { setU(true); setV(""); }
            else { setU(false); setV(String(v)); }
          };
          applyPct(c.ahv_iv_eo_pct, setEditUseDefAhv, setEditAhv);
          applyPct(c.alv_pct, setEditUseDefAlv, setEditAlv);
          applyPct(c.nbu_pct, setEditUseDefNbu, setEditNbu);
          applyPct(c.bvg_pct, setEditUseDefBvg, setEditBvg);
          applyPct(c.ktg_pct, setEditUseDefKtg, setEditKtg);
          applyPct(c.quellensteuer_pct, setEditUseDefQst, setEditQst);
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
    // null = Standard verwenden, sonst der explizite Override (auch 0 erlaubt
    // wenn 'Standard verwenden' aus ist und das Feld leer war -> 0).
    // AG-Anteil: NULL = Standard, sonst der explizite Pct-Wert vom Brutto.
    const employerPct: number | null = editEmployerUseDefault
      ? null
      : (parseFloat(editEmployer.replace(",", ".")) || 0);
    // Pro Abzug: useDefault -> null, sonst parsed Wert (Fallback 0
     // wenn das Feld leer/ungueltig).
    const pctOrNull = (useDef: boolean, s: string): number | null => {
      if (useDef) return null;
      const n = parseFloat(s.replace(",", "."));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
    };
    const ahv = pctOrNull(editUseDefAhv, editAhv);
    const alv = pctOrNull(editUseDefAlv, editAlv);
    const nbu = pctOrNull(editUseDefNbu, editNbu);
    const bvg = pctOrNull(editUseDefBvg, editBvg);
    const ktg = pctOrNull(editUseDefKtg, editKtg);
    const qst = pctOrNull(editUseDefQst, editQst);
    if (Number.isFinite(wage) && wage >= 0 && editFrom) {
      const eq = (a: number | null, b: number | null) => (a ?? null) === (b ?? null);
      const changed = !editCompOriginal
        || editCompOriginal.hourly_wage_chf !== wage
        || (editCompOriginal.employer_pct ?? null) !== employerPct
        || editCompOriginal.effective_from !== editFrom
        || (editCompOriginal.notes ?? "") !== editNotes.trim()
        || !eq(editCompOriginal.ahv_iv_eo_pct, ahv)
        || !eq(editCompOriginal.alv_pct, alv)
        || !eq(editCompOriginal.nbu_pct, nbu)
        || !eq(editCompOriginal.bvg_pct, bvg)
        || !eq(editCompOriginal.ktg_pct, ktg)
        || !eq(editCompOriginal.quellensteuer_pct, qst);
      if (changed) {
        const wageRes = await fetch("/api/hr/compensation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_id: edit.id,
            hourly_wage_chf: wage,
            employer_pct: employerPct,
            effective_from: editFrom,
            notes: editNotes.trim() || null,
            ahv_iv_eo_pct: ahv, alv_pct: alv, nbu_pct: nbu,
            bvg_pct: bvg, ktg_pct: ktg, quellensteuer_pct: qst,
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

      {/* Lohn-Standardwerte — firmenweit. Pro Mitarbeiter kann via Edit-
          Modal ein eigener Override gesetzt werden, sonst greift dieser
          Wert automatisch. */}
      <Card className="bg-card">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Lohn-Standardwerte</p>
              <p className="text-[11px] text-muted-foreground">
                Greifen bei jedem Mitarbeiter ohne expliziten Override. Pro Mitarbeiter via Edit-Modal anpassbar.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            <DefaultField label="Arbeitgeber-Anteil" suffix="%" draftKey="employer" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.employer} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="AHV/IV/EO" suffix="%" draftKey="ahv" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.ahv} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="ALV" suffix="%" draftKey="alv" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.alv} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="NBU" suffix="%" draftKey="nbu" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.nbu} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="BVG" suffix="%" draftKey="bvg" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.bvg} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="KTG" suffix="%" draftKey="ktg" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.ktg} onSave={saveLohnDefault} saving={savingDefault} />
            <DefaultField label="Quellensteuer" suffix="%" draftKey="qst" drafts={defaultDrafts} setDrafts={setDefaultDrafts} current={lohnDefaults.qst} onSave={saveLohnDefault} saving={savingDefault} />
          </div>
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
                      {/* Brutto + AG */}
                      <div className="grid grid-cols-2 gap-2">
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
                        <div className="space-y-1">
                          <div className="flex items-center justify-between ml-1">
                            <p className="text-[10px] text-muted-foreground/70">AG-Anteil (% Brutto)</p>
                            <label className="flex items-center gap-1 text-[10px] text-muted-foreground/70 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editEmployerUseDefault}
                                onChange={(e) => setEditEmployerUseDefault(e.target.checked)}
                                className="h-3 w-3"
                              />
                              Standard
                            </label>
                          </div>
                          {editEmployerUseDefault ? (
                            <div className="h-9 px-3 flex items-center text-sm rounded-xl border border-dashed border-border bg-muted/30 text-muted-foreground">
                              {lohnDefaults.employer.toFixed(2)}% <span className="ml-1 text-[10px] opacity-70">(Firmen-Standard)</span>
                            </div>
                          ) : (
                            <div className="relative">
                              <Input
                                type="text"
                                inputMode="decimal"
                                value={editEmployer}
                                onChange={(e) => setEditEmployer(e.target.value)}
                                placeholder="z.B. 12"
                                className="pr-7"
                              />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/60 pointer-events-none">%</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Abzüge — pro Feld Override oder Firmen-Standard. */}
                      <div className="pt-2 border-t border-foreground/10">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Abzüge Mitarbeiter (% vom Brutto)</p>
                        <div className="grid grid-cols-3 gap-2">
                          <PctField label="AHV/IV/EO" value={editAhv} onChange={setEditAhv} useDefault={editUseDefAhv} setUseDefault={setEditUseDefAhv} defaultValue={lohnDefaults.ahv} />
                          <PctField label="ALV" value={editAlv} onChange={setEditAlv} useDefault={editUseDefAlv} setUseDefault={setEditUseDefAlv} defaultValue={lohnDefaults.alv} />
                          <PctField label="NBU" value={editNbu} onChange={setEditNbu} useDefault={editUseDefNbu} setUseDefault={setEditUseDefNbu} defaultValue={lohnDefaults.nbu} />
                          <PctField label="BVG" value={editBvg} onChange={setEditBvg} useDefault={editUseDefBvg} setUseDefault={setEditUseDefBvg} defaultValue={lohnDefaults.bvg} />
                          <PctField label="KTG" value={editKtg} onChange={setEditKtg} useDefault={editUseDefKtg} setUseDefault={setEditUseDefKtg} defaultValue={lohnDefaults.ktg} />
                          <PctField label="Quellensteuer" value={editQst} onChange={setEditQst} useDefault={editUseDefQst} setUseDefault={setEditUseDefQst} defaultValue={lohnDefaults.qst} />
                        </div>
                      </div>

                      {/* Netto / Vollkosten Preview — rechnet immer mit den
                          effektiven Werten (Override oder Firmen-Standard). */}
                      <LohnPreview
                        wage={editWage}
                        employerPct={editEmployerUseDefault ? String(lohnDefaults.employer) : editEmployer}
                        ahv={editUseDefAhv ? String(lohnDefaults.ahv) : editAhv}
                        alv={editUseDefAlv ? String(lohnDefaults.alv) : editAlv}
                        nbu={editUseDefNbu ? String(lohnDefaults.nbu) : editNbu}
                        bvg={editUseDefBvg ? String(lohnDefaults.bvg) : editBvg}
                        ktg={editUseDefKtg ? String(lohnDefaults.ktg) : editKtg}
                        qst={editUseDefQst ? String(lohnDefaults.qst) : editQst}
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

function PctField({ label, value, onChange, useDefault, setUseDefault, defaultValue }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  useDefault: boolean;
  setUseDefault: (b: boolean) => void;
  defaultValue: number;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-1">
        <label className="text-[10px] text-muted-foreground/70 truncate">{label}</label>
        <label className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={useDefault}
            onChange={(e) => setUseDefault(e.target.checked)}
            className="h-3 w-3"
          />
          Std
        </label>
      </div>
      {useDefault ? (
        <div className="h-9 px-3 flex items-center text-xs rounded-xl border border-dashed border-border bg-muted/30 text-muted-foreground tabular-nums">
          {defaultValue.toFixed(2)}<span className="ml-0.5">%</span>
        </div>
      ) : (
        <div className="relative">
          <Input
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="pr-7"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/60 pointer-events-none">%</span>
        </div>
      )}
    </div>
  );
}

/** Inline-Editor fuer einen Firmen-Standardwert. Speichert das jeweilige
 *  Feld einzeln (POST mit nur diesem Key) sobald 'Speichern' geklickt
 *  wird oder das Feld den 'current'-Wert verlassen hat. */
function DefaultField<K extends string>({ label, suffix, draftKey, drafts, setDrafts, current, onSave, saving }: {
  label: string;
  suffix: string;
  draftKey: K;
  drafts: Record<K, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<K, string>>>;
  current: number;
  onSave: (k: K) => Promise<void>;
  saving: boolean;
}) {
  const draft = drafts[draftKey];
  const dirty = draft !== String(current);
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] text-muted-foreground/70 truncate block">{label}</label>
      <div className="flex gap-1">
        <div className="relative flex-1 min-w-0">
          <Input
            type="text"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDrafts((p) => ({ ...p, [draftKey]: e.target.value }))}
            className="h-8 text-xs pr-8"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">{suffix}</span>
        </div>
        {dirty && (
          <button
            type="button"
            onClick={() => onSave(draftKey)}
            disabled={saving}
            className="px-2 h-8 text-[10px] font-semibold rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25 transition-colors shrink-0"
          >
            OK
          </button>
        )}
      </div>
    </div>
  );
}

function LohnPreview({ wage, employerPct, ahv, alv, nbu, bvg, ktg, qst }: {
  wage: string;
  /** Arbeitgeber-Anteil als % vom Brutto (z.B. "12"). */
  employerPct: string;
  ahv: string; alv: string; nbu: string; bvg: string; ktg: string; qst: string;
}) {
  const w = parseFloat(wage.replace(",", "."));
  const eP = parseFloat(employerPct.replace(",", ".")) || 0;
  if (!Number.isFinite(w) || w < 0) return null;
  const num = (s: string) => {
    const n = parseFloat(s.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const totalDeductionPct = num(ahv) + num(alv) + num(nbu) + num(bvg) + num(ktg) + num(qst);
  const deductionAmount = w * (totalDeductionPct / 100);
  const netto = w - deductionAmount;
  // AG-Anteil in CHF/h aus % vom Brutto.
  const e = w * eP / 100;
  const vollkosten = w + e;
  return (
    <div className="space-y-1 px-3 py-2 rounded-lg bg-foreground/[0.04] dark:bg-foreground/[0.06] text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground">Brutto / h</span>
        <span className="tabular-nums">CHF {CHF.format(w)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground">
        <span>− Abzüge ({totalDeductionPct.toFixed(2)}%)</span>
        <span className="tabular-nums">CHF {CHF.format(deductionAmount)}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1 border-t border-foreground/10">
        <span className="font-semibold">Netto / h</span>
        <span className="font-semibold tabular-nums">CHF {CHF.format(netto)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground pt-1">
        <span>Vollkosten / h (inkl. AG)</span>
        <span className="tabular-nums">CHF {CHF.format(vollkosten)}</span>
      </div>
    </div>
  );
}
