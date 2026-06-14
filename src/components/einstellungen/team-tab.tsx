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
  employer_costs_chf_per_hour: number | null;
  effective_from: string;
  notes: string | null;
  ahv_iv_eo_pct: number;
  alv_pct: number;
  nbu_pct: number;
  bvg_pct: number;
  ktg_pct: number;
  quellensteuer_pct: number;
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
  // Firmen-Standard fuer Arbeitgeber-Kosten — geladen via /api/hr/lohn-defaults.
  // editierbar im oben gerenderten Lohn-Standardwerte-Block.
  const [defaultEmployerCosts, setDefaultEmployerCosts] = useState<number>(0);
  const [defaultEmployerDraft, setDefaultEmployerDraft] = useState<string>("");
  const [savingDefault, setSavingDefault] = useState(false);
  const [editFrom, setEditFrom] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editAhv, setEditAhv] = useState("5.3");
  const [editAlv, setEditAlv] = useState("1.1");
  const [editNbu, setEditNbu] = useState("1.4");
  const [editBvg, setEditBvg] = useState("0");
  const [editKtg, setEditKtg] = useState("0");
  const [editQst, setEditQst] = useState("0");
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

  // Standard-Arbeitgeber-Kosten laden — fuer Anzeige in Standardwerte-
  // Block + als Placeholder/Default im Edit-Modal. Fail silent wenn das
  // Geraet nicht vertraut ist (Endpoint ist trust-gated).
  useEffect(() => {
    fetch("/api/hr/lohn-defaults")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.success) {
          setDefaultEmployerCosts(Number(json.defaultEmployerCostsChfPerHour ?? 0));
          setDefaultEmployerDraft(String(json.defaultEmployerCostsChfPerHour ?? 0));
        }
      })
      .catch(() => { /* untrusted -> Default bleibt 0 */ });
  }, []);

  async function saveDefaultEmployerCosts() {
    const v = parseFloat(defaultEmployerDraft.replace(",", "."));
    if (!Number.isFinite(v) || v < 0) { toast.error("Ungueltiger Wert"); return; }
    setSavingDefault(true);
    const res = await fetch("/api/hr/lohn-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_employer_costs_chf_per_hour: v }),
    });
    setSavingDefault(false);
    const json = await res.json();
    if (!res.ok || !json.success) { TOAST.errorOr(json.error); return; }
    setDefaultEmployerCosts(v);
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
    setEditCompOriginal(null);
    fetch("/api/hr/compensation")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (!json?.success) return;
        if (json.defaults?.employer_costs_chf_per_hour != null) {
          setDefaultEmployerCosts(Number(json.defaults.employer_costs_chf_per_hour));
        }
        type Empl = { profile_id: string; compensation: CompOriginal | null };
        const empl = (json.employees as Empl[]).find((e) => e.profile_id === p.id);
        const c = empl?.compensation;
        if (c) {
          setEditWage(String(c.hourly_wage_chf));
          // null = Standard verwenden, sonst Override
          if (c.employer_costs_chf_per_hour == null) {
            setEditEmployerUseDefault(true);
            setEditEmployer("");
          } else {
            setEditEmployerUseDefault(false);
            setEditEmployer(String(c.employer_costs_chf_per_hour));
          }
          setEditFrom(c.effective_from);
          setEditNotes(c.notes ?? "");
          setEditAhv(String(c.ahv_iv_eo_pct));
          setEditAlv(String(c.alv_pct));
          setEditNbu(String(c.nbu_pct));
          setEditBvg(String(c.bvg_pct));
          setEditKtg(String(c.ktg_pct));
          setEditQst(String(c.quellensteuer_pct));
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
    const employer: number | null = editEmployerUseDefault
      ? null
      : (parseFloat(editEmployer.replace(",", ".")) || 0);
    const parsePct = (s: string, fallback: number) => {
      const n = parseFloat(s.replace(",", "."));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
    };
    const ahv = parsePct(editAhv, 5.3);
    const alv = parsePct(editAlv, 1.1);
    const nbu = parsePct(editNbu, 1.4);
    const bvg = parsePct(editBvg, 0);
    const ktg = parsePct(editKtg, 0);
    const qst = parsePct(editQst, 0);
    if (Number.isFinite(wage) && wage >= 0 && editFrom) {
      const changed = !editCompOriginal
        || editCompOriginal.hourly_wage_chf !== wage
        || (editCompOriginal.employer_costs_chf_per_hour ?? null) !== employer
        || editCompOriginal.effective_from !== editFrom
        || (editCompOriginal.notes ?? "") !== editNotes.trim()
        || editCompOriginal.ahv_iv_eo_pct !== ahv
        || editCompOriginal.alv_pct !== alv
        || editCompOriginal.nbu_pct !== nbu
        || editCompOriginal.bvg_pct !== bvg
        || editCompOriginal.ktg_pct !== ktg
        || editCompOriginal.quellensteuer_pct !== qst;
      if (changed) {
        const wageRes = await fetch("/api/hr/compensation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_id: edit.id,
            hourly_wage_chf: wage,
            employer_costs_chf_per_hour: employer,
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
        <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Lohn-Standardwerte</p>
              <p className="text-[11px] text-muted-foreground">
                Arbeitgeber-Kosten pro Stunde (AHV/BVG/UVG/FAK). Greift bei jedem Mitarbeiter ohne expliziten Override.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                inputMode="decimal"
                value={defaultEmployerDraft}
                onChange={(e) => setDefaultEmployerDraft(e.target.value)}
                className="w-24 h-8 text-sm"
                placeholder="0.00"
              />
              <span className="text-xs text-muted-foreground">CHF / h</span>
            </div>
            <button
              type="button"
              onClick={saveDefaultEmployerCosts}
              disabled={savingDefault || defaultEmployerDraft === String(defaultEmployerCosts)}
              className="kasten kasten-blue"
            >
              {savingDefault ? "Speichert…" : "Speichern"}
            </button>
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
                            <p className="text-[10px] text-muted-foreground/70">Arbeitgeber / h (CHF)</p>
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
                              CHF {CHF.format(defaultEmployerCosts)} <span className="ml-1 text-[10px] opacity-70">(Firmen-Standard)</span>
                            </div>
                          ) : (
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={editEmployer}
                              onChange={(e) => setEditEmployer(e.target.value)}
                              placeholder="z.B. 5.54"
                            />
                          )}
                        </div>
                      </div>

                      {/* Abzüge */}
                      <div className="pt-2 border-t border-foreground/10">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Abzüge Mitarbeiter (% vom Brutto)</p>
                        <div className="grid grid-cols-3 gap-2">
                          <PctField label="AHV/IV/EO" value={editAhv} onChange={setEditAhv} hint="Standard 5.3%" />
                          <PctField label="ALV" value={editAlv} onChange={setEditAlv} hint="Standard 1.1%" />
                          <PctField label="NBU" value={editNbu} onChange={setEditNbu} hint="~1.4%" />
                          <PctField label="BVG" value={editBvg} onChange={setEditBvg} hint="altersabhängig" />
                          <PctField label="KTG" value={editKtg} onChange={setEditKtg} hint="optional" />
                          <PctField label="Quellensteuer" value={editQst} onChange={setEditQst} hint="meist 0%" />
                        </div>
                      </div>

                      {/* Netto / Vollkosten Preview */}
                      <LohnPreview
                        wage={editWage}
                        employer={editEmployerUseDefault ? String(defaultEmployerCosts) : editEmployer}
                        ahv={editAhv}
                        alv={editAlv}
                        nbu={editNbu}
                        bvg={editBvg}
                        ktg={editKtg}
                        qst={editQst}
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

function PctField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] text-muted-foreground/70">{label}</label>
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
      {hint && <p className="text-[9px] text-muted-foreground/50">{hint}</p>}
    </div>
  );
}

function LohnPreview({ wage, employer, ahv, alv, nbu, bvg, ktg, qst }: {
  wage: string; employer: string;
  ahv: string; alv: string; nbu: string; bvg: string; ktg: string; qst: string;
}) {
  const w = parseFloat(wage.replace(",", "."));
  const e = parseFloat(employer.replace(",", ".")) || 0;
  if (!Number.isFinite(w) || w < 0) return null;
  const num = (s: string) => {
    const n = parseFloat(s.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const totalDeductionPct = num(ahv) + num(alv) + num(nbu) + num(bvg) + num(ktg) + num(qst);
  const deductionAmount = w * (totalDeductionPct / 100);
  const netto = w - deductionAmount;
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
