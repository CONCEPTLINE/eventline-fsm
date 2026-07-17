"use client";

/**
 * Team-Tab in /einstellungen — admin-only User-Verwaltung.
 *
 * Listet alle User mit Name, Email, Rolle, Status. Pro Zeile drei Aktionen:
 *   - Passwort zuruecksetzen (Mail-Link an die User-Mail)
 *   - Bearbeiten (Name, Rolle, Geburtsdatum)
 *   - Deaktivieren / Aktivieren (Soft-Delete via is_active + auth-ban)
 *   - Hard-Delete (mit Dossier-Backup)
 *
 * "Neuer Benutzer"-Button: Email + Name + Rolle + Geburtsdatum + (optional)
 * Brutto-Stundenlohn. Wenn Wage gesetzt, wird beim Anlegen automatisch eine
 * employee_compensation-Zeile mit uses_standard_lohn=true erstellt -- so
 * dass der Mitarbeiter sofort vollstaendig konfiguriert ist ohne 2. Klick.
 *
 * Lohn-Pflege (Brutto, Override, Standardwerte) lebt jetzt unter
 * HR -> Loehne -> Mitarbeiter-Lohn / Standardwerte. Dieses Tab ist
 * reine Stammdaten-Verwaltung.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/swiss-time";
import type { Profile } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { Plus, KeyRound, Pencil, UserX, UserCheck, Trash2, Mail } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

type EditState = { id: string; full_name: string; role: string; birthdate: string } | null;
interface RoleOption { slug: string; label: string }

function calcAge(birthdate: string | null | undefined): number | null {
  if (!birthdate) return null;
  const today = todayLocalIso();
  const [by, bm, bd] = birthdate.split("-").map(Number);
  const [ay, am, ad] = today.split("-").map(Number);
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age--;
  return age;
}

export function TeamTab() {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    email: "", full_name: "", role: "techniker", birthdate: "", hourly_wage_chf: "",
  });
  const [edit, setEdit] = useState<EditState>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    const [profRes, rolesRes] = await Promise.all([
      supabase.rpc("get_all_profiles_admin"),
      fetch("/api/admin/roles").then((r) => r.json()),
    ]);
    const all = (profRes.data as Profile[]) ?? [];
    setProfiles(all.filter((p) => p.role !== "partner"));
    if (rolesRes?.success) {
      setRoles((rolesRes.roles as RoleOption[]).filter((r) => r.slug !== "partner").map((r) => ({ slug: r.slug, label: r.label })));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function roleLabel(slug: string): string {
    return roles.find((r) => r.slug === slug)?.label ?? slug;
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const payload: Record<string, unknown> = {
      email: createForm.email,
      full_name: createForm.full_name,
      role: createForm.role,
    };
    if (createForm.birthdate) payload.birthdate = createForm.birthdate;
    // Wenn Brutto angegeben, wird beim User-Create eine Comp-Row mit
    // uses_standard_lohn=true angelegt -> kein 2. Klick noetig.
    if (createForm.hourly_wage_chf) {
      const wage = parseFloat(createForm.hourly_wage_chf.replace(",", "."));
      if (Number.isFinite(wage) && wage >= 0) payload.hourly_wage_chf = wage;
    }
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setCreating(false);
    if (!json.success) { TOAST.errorOr(json.error); return; }
    toast.success("Benutzer angelegt — Einladungs-Mail verschickt");
    setShowCreate(false);
    setCreateForm({ email: "", full_name: "", role: "techniker", birthdate: "", hourly_wage_chf: "" });
    load();
  }

  function openEdit(p: Profile) {
    setEdit({ id: p.id, full_name: p.full_name, role: p.role, birthdate: p.birthdate ?? "" });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setSavingEdit(true);
    const res = await fetch(`/api/admin/users/${edit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: edit.full_name,
        role: edit.role,
        birthdate: edit.birthdate ? edit.birthdate : null,
      }),
    });
    const json = await res.json();
    setSavingEdit(false);
    if (!json.success) { TOAST.errorOr(json.error); return; }
    toast.success("Gespeichert");
    setEdit(null);
    load();
  }

  async function resetPassword(p: Profile) {
    const ok = await confirm({
      title: "Passwort zurücksetzen?",
      message: `${p.full_name} bekommt einen Reset-Link per Mail an ${p.email}.`,
      confirmLabel: "Zurücksetzen",
      variant: "blue",
    });
    if (!ok) return;
    setBusyId(p.id);
    const res = await fetch(`/api/admin/users/${p.id}/reset-password`, { method: "POST" });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) { TOAST.errorOr(json.error); return; }
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
    const res = await fetch(`/api/admin/users/${p.id}`, { method: "DELETE" });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) { TOAST.errorOr(json.error); return; }
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
        duration: 60000,
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
    if (!json.success) { TOAST.errorOr(json.error); return; }
    toast.success(p.is_active ? "Deaktiviert" : "Reaktiviert");
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          EVENTLINE-interne Mitarbeiter — Stammdaten. Lohn-Pflege unter <span className="font-medium">HR → Löhne</span>.
        </p>
        <button type="button" onClick={() => setShowCreate(true)} className="kasten kasten-red">
          <Plus className="h-3.5 w-3.5" />Neuer Benutzer
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">{[1,2,3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4"><div className="h-5 bg-muted rounded w-1/2" /></CardContent></Card>)}</div>
      ) : profiles.length === 0 ? (
        <Card className="bg-card border-dashed"><CardContent className="py-12 text-center text-sm text-muted-foreground">Noch keine Benutzer.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <div key={p.id} className={`rounded-xl border bg-card px-4 py-2.5 flex items-center gap-3 card-hover ${!p.is_active ? "opacity-60" : ""}`}>
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-sm font-bold shrink-0">
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
                    disabled={busyId === p.id}
                    className="kasten kasten-muted"
                    data-tooltip="Bearbeiten"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(p)}
                    disabled={busyId === p.id}
                    className={p.is_active ? "kasten kasten-red" : "kasten kasten-blue"}
                    data-tooltip={p.is_active ? "Deaktivieren" : "Reaktivieren"}
                  >
                    {p.is_active ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                    {p.is_active ? "Deaktivieren" : "Aktivieren"}
                  </button>
                  {!p.is_active && (
                    <button
                      type="button"
                      onClick={() => hardDelete(p)}
                      disabled={busyId === p.id}
                      className="kasten kasten-muted"
                      data-tooltip="Endgültig löschen (mit Dossier-Backup)"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
            </div>
          ))}
        </div>
      )}

      {/* Create-Modal — Email, Name, Rolle, optional Geburtsdatum + Brutto */}
      <Modal open={showCreate} onClose={() => !creating && setShowCreate(false)} title="Neuer Benutzer" size="md">
        <form onSubmit={createUser} className="space-y-4">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Name *</p>
            <Input
              value={createForm.full_name}
              onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })}
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
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Geburtsdatum (optional)</p>
              <Input
                type="date"
                value={createForm.birthdate}
                onChange={(e) => setCreateForm({ ...createForm, birthdate: e.target.value })}
              />
              {createForm.birthdate && (() => {
                const age = calcAge(createForm.birthdate);
                if (age == null) return null;
                return (
                  <p className="text-[10px] text-muted-foreground/70 ml-1">
                    {age} Jahre · Ferienanteil <strong>{age <= 20 ? "10.64%" : "8.33%"}</strong>
                  </p>
                );
              })()}
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Brutto / h (CHF, optional)</p>
              <Input
                type="text"
                inputMode="decimal"
                value={createForm.hourly_wage_chf}
                onChange={(e) => setCreateForm({ ...createForm, hourly_wage_chf: e.target.value })}
                placeholder="z.B. 22.50"
              />
              <p className="text-[10px] text-muted-foreground/70 ml-1">
                Wenn gesetzt, greifen die Firmen-Standardwerte automatisch.
              </p>
            </div>
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

      {/* Edit-Modal — Stammdaten only (Name, Rolle, Geburtsdatum). */}
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
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Geburtsdatum (für Ferienanteil-Auto-Erkennung)</p>
              <Input
                type="date"
                value={edit.birthdate}
                onChange={(e) => setEdit({ ...edit, birthdate: e.target.value })}
              />
              {edit.birthdate && (() => {
                const age = calcAge(edit.birthdate);
                if (age == null) return null;
                return (
                  <p className="text-[10px] text-muted-foreground/70 ml-1">
                    Aktuell {age} Jahre · Ferienanteil <strong>{age <= 20 ? "10.64%" : "8.33%"}</strong>
                  </p>
                );
              })()}
            </div>

            <p className="text-[11px] text-muted-foreground italic pt-2 border-t border-foreground/10">
              Brutto-Stundenlohn + Abzüge werden unter <strong>HR → Löhne → Mitarbeiter-Lohn</strong> verwaltet.
            </p>

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
