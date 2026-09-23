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

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/swiss-time";
import type { Profile } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { Plus, KeyRound, Pencil, UserX, UserCheck, Trash2, Mail, Users, Search } from "lucide-react";
import { DeveloperModeCard } from "@/components/einstellungen/developer-mode-card";
import { DeleteUserConfirmModal } from "@/components/einstellungen/delete-user-confirm-modal";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { istIntern } from "@/lib/roles";

type EditState = {
  id: string;
  full_name: string;
  role: string;
  birthdate: string;
  team_lead_id: string;
  /** Nur relevant wenn der bearbeitete User selbst Teamleiter ist
   *  (Rolle scope='team'|'all'). Umkehrung des klassischen Flows:
   *  statt bei 10 MA einzeln den TL zu setzen, waehlt der Admin
   *  hier alle Team-Mitglieder auf einmal aus. Beim Save berechnet
   *  die API den Diff und setzt team_lead_id entsprechend. */
  team_member_ids: string[];
} | null;
/** Rolle inkl. scope (Migration 208) — brauchen wir um in der MA-Liste
 *  die Teamleiter-Kandidaten zu filtern (nur Rollen mit scope='team'). */
interface RoleOption { slug: string; label: string; scope: "self" | "team" | "all" }

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
    email: "", full_name: "", role: "techniker", birthdate: "", hourly_wage_chf: "", team_lead_id: "",
  });
  const [edit, setEdit] = useState<EditState>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  /** Suchfeld ueber der Team-Mitglieder-Checkbox-Liste im Edit-Modal. */
  const [memberSearch, setMemberSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Aktiv im Delete-Modal — steuert Impact-basierte Delete-Bestaetigung.
   *  null = Modal zu. */
  const [deletingUser, setDeletingUser] = useState<Profile | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    try {
      const [profRes, rolesRes] = await Promise.all([
        supabase.rpc("get_all_profiles_admin"),
        fetch("/api/admin/roles").then((r) => r.json()),
      ]);
      const all = (profRes.data as Profile[]) ?? [];
      setProfiles(all.filter((p) => istIntern(p.role)));
      if (rolesRes?.success) {
        // scope wird nur zur Filterung der Teamleiter-Kandidaten gebraucht —
        // falls die API-Antwort scope (noch) nicht liefert (aeltere Route),
        // faellt der Fallback auf 'self' zurueck, dann werden schlicht keine
        // Kandidaten angezeigt statt zu crashen.
        const rawRoles = rolesRes.roles as Array<{ slug: string; label: string; scope?: string }>;
        setRoles(
          rawRoles
            .filter((r) => istIntern(r.slug))
            .map((r) => ({
              slug: r.slug,
              label: r.label,
              scope: (r.scope === "team" || r.scope === "all" ? r.scope : "self") as RoleOption["scope"],
            })),
        );
      }
    } catch (err) {
      // Ohne try/catch blieb loading=true haengen wenn fetch/RPC failt —
      // Team-Tab zeigte dann dauerhaft Spinner statt Fehlermeldung.
      console.error("team-tab.load", err);
      toast.error("Team konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function roleLabel(slug: string): string {
    return roles.find((r) => r.slug === slug)?.label ?? slug;
  }

  // Teamleiter-Kandidaten: alle aktiven Mitarbeiter deren Rolle scope='team'
  // ODER scope='all' hat (Migration 208). Admin ist implizit scope='all'
  // (siehe get_my_scope()), taucht daher ebenfalls auf. Wird als items an
  // die SearchableSelect gegeben und pro Ort noch um den bearbeiteten User
  // selbst gefiltert (Self-Ausschluss).
  const teamLeadRoleSlugs = useMemo(
    () => new Set(roles.filter((r) => r.scope === "team" || r.scope === "all").map((r) => r.slug)),
    [roles],
  );
  const teamLeadCandidates = useMemo(() => {
    return profiles.filter(
      (p) => p.is_active && (p.role === "admin" || teamLeadRoleSlugs.has(p.role)),
    );
  }, [profiles, teamLeadRoleSlugs]);

  /** Ist die uebergebene Rolle eine „Teamleiter-Rolle" (scope='team'|'all')
   *  im Sinne der Team-Mitglieder-Zuweisung? Admin wird bewusst NICHT als
   *  Teamleiter gewertet — Admin sieht ohnehin alles und braucht keine
   *  explizite Team-Zuordnung. */
  function isTeamLeaderRole(slug: string): boolean {
    return teamLeadRoleSlugs.has(slug);
  }

  /** Kandidaten fuer die Team-Mitglieder-Liste eines Teamleiters:
   *  aktive Nicht-Admins, keine anderen Teamleiter (transitive Hierarchie
   *  bewusst nicht gewuenscht), und der Teamleiter selbst wird
   *  ausgeschlossen (Self-Exclude). */
  function memberCandidatesFor(leaderId: string) {
    return profiles.filter(
      (p) =>
        p.is_active &&
        p.id !== leaderId &&
        p.role !== "admin" &&
        !teamLeadRoleSlugs.has(p.role),
    );
  }

  /** Aktuell zugewiesene MA eines Teamleiters — abgeleitet aus profiles. */
  function currentMembersOf(leaderId: string): string[] {
    return profiles.filter((p) => p.team_lead_id === leaderId).map((p) => p.id);
  }

  function profileName(id: string | null | undefined): string | null {
    if (!id) return null;
    return profiles.find((p) => p.id === id)?.full_name ?? null;
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
    // Optional: Teamleiter beim Anlegen gleich mitgeben — API setzt
    // profiles.team_lead_id nach dem Auth-Create.
    if (createForm.team_lead_id) payload.team_lead_id = createForm.team_lead_id;
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
    setCreateForm({ email: "", full_name: "", role: "techniker", birthdate: "", hourly_wage_chf: "", team_lead_id: "" });
    load();
  }

  function openEdit(p: Profile) {
    setEdit({
      id: p.id,
      full_name: p.full_name,
      role: p.role,
      birthdate: p.birthdate ?? "",
      team_lead_id: p.team_lead_id ?? "",
      team_member_ids: currentMembersOf(p.id),
    });
    setMemberSearch("");
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setSavingEdit(true);
    // Ist die (evtl. gerade geaenderte) Rolle eine Teamleiter-Rolle?
    // -> team_members-Multi-Select zaehlt, team_lead_id (der Dropdown)
    //    entfaellt visuell und wird bewusst nicht ueberschrieben.
    // Sonst -> klassisches team_lead_id-Feld ueberschreibt wie bisher.
    const asLeader = isTeamLeaderRole(edit.role);
    const payload: Record<string, unknown> = {
      full_name: edit.full_name,
      role: edit.role,
      birthdate: edit.birthdate ? edit.birthdate : null,
    };
    if (asLeader) {
      // Nur den Diff-Trigger senden. Server berechnet was gesetzt/genullt
      // werden muss. Dedup + Self-Ausschluss macht der Server ebenfalls.
      payload.team_members = edit.team_member_ids;
    } else {
      // Leer-String = "kein Teamleiter" -> NULL in DB.
      payload.team_lead_id = edit.team_lead_id ? edit.team_lead_id : null;
    }
    const res = await fetch(`/api/admin/users/${edit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

  // Delete-Flow lebt jetzt in <DeleteUserConfirmModal /> — dieser Button
  // oeffnet nur noch das Modal via setDeletingUser(p). Das Modal zeigt die
  // Impact-Analyse (unwiderrufliche Cascades + SET-NULL-Preserves), bietet
  // ggf. Owner-Transfer und macht dann selbst Dossier + DELETE.

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
                    {/* Teamleiter-Badge: nur wenn team_lead_id gesetzt UND
                        wir den Namen aufloesen koennen (sonst zeigt der Badge
                        eine verwaiste UUID, was verwirrender waere als nichts). */}
                    {p.team_lead_id && profileName(p.team_lead_id) && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300 shrink-0"
                        data-tooltip="Teamleiter dieses Mitarbeiters"
                      >
                        <Users className="h-2.5 w-2.5" />
                        TL: {profileName(p.team_lead_id)}
                      </span>
                    )}
                    {/* „Team: N MA"-Badge beim Teamleiter selbst — zeigt auf
                        einen Blick wie viele Mitarbeiter diesem TL zugeordnet
                        sind. Nur wenn Rolle scope='team'|'all' (isTeamLeaderRole). */}
                    {isTeamLeaderRole(p.role) && (() => {
                      const n = profiles.filter((x) => x.team_lead_id === p.id).length;
                      if (n === 0) return null;
                      return (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 shrink-0"
                          data-tooltip="Anzahl direkt zugewiesener Team-Mitglieder"
                        >
                          <Users className="h-2.5 w-2.5" />
                          Team: {n} MA
                        </span>
                      );
                    })()}
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
                      onClick={() => setDeletingUser(p)}
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

      {/* Developer Mode / View-As — dezent am Ende der Team-Liste. Passt
          semantisch hier weil das Feature genau darum geht, die Perspektive
          eines Team-Mitglieds zu simulieren. Self-renders null wenn nicht Admin. */}
      <DeveloperModeCard />

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
            <SearchableSelect
              value={createForm.role}
              onChange={(v) => setCreateForm({ ...createForm, role: v })}
              items={roles.map((r) => ({ id: r.slug, label: r.label }))}
              clearable={false}
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Teamleiter (optional)</p>
            <SearchableSelect
              value={createForm.team_lead_id}
              onChange={(id) => setCreateForm({ ...createForm, team_lead_id: id })}
              items={teamLeadCandidates.map((c) => ({
                id: c.id,
                label: c.full_name,
                sub: roleLabel(c.role),
              }))}
              placeholder={teamLeadCandidates.length === 0
                ? "Noch keine Teamleiter (Rolle braucht Sichtbarkeit „Nur Team\")"
                : "— kein Teamleiter —"}
              clearable
            />
            <p className="text-[10px] text-muted-foreground/70 ml-1">
              Nur Rollen mit Sichtbarkeit „Nur Team" oder „Alle" tauchen hier auf.
            </p>
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
              <SearchableSelect
                value={edit.role}
                onChange={(v) => setEdit({ ...edit, role: v })}
                items={roles.map((r) => ({ id: r.slug, label: r.label }))}
                clearable={false}
              />
            </div>
            {/* Team-Zuweisung — zwei Modi je nach Rolle:
                a) Bearbeiteter User IST Teamleiter (Rolle scope='team'|'all'):
                   Multi-Select-Checkbox-Liste "Team-Mitglieder" (Umkehrung
                   des klassischen Flows — spart 10 Modal-Oeffnungen).
                b) Bearbeiteter User ist REGULAERER MA (scope='self'):
                   klassischer Teamleiter-Dropdown wie bisher.
                Admin ist scope='all', wird aber NICHT als Teamleiter im
                Sinne dieser Zuweisung behandelt — er sieht ohnehin alles.
                Beim Rollen-Wechsel schaltet die UI live um. */}
            {isTeamLeaderRole(edit.role) ? (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">
                  Team-Mitglieder ({edit.team_member_ids.length})
                </p>
                {(() => {
                  const candidates = memberCandidatesFor(edit.id);
                  if (candidates.length === 0) {
                    return (
                      <div className="rounded-xl border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground text-center">
                        Keine zuweisbaren Mitarbeiter vorhanden.
                      </div>
                    );
                  }
                  const q = memberSearch.trim().toLowerCase();
                  const filtered = q
                    ? candidates.filter((c) => c.full_name.toLowerCase().includes(q))
                    : candidates;
                  const selected = new Set(edit.team_member_ids);
                  /** Team-Exklusivitaet: MA die bereits einem ANDEREN Teamleiter
                   *  angehoeren (team_lead_id gesetzt und != aktuell edierter TL)
                   *  sind gesperrt — nicht auswaehlbar, sichtbar mit Hinweis
                   *  "Bereits im Team von X". Verhindert Team-Diebstahl durch
                   *  parallele Save-Races (Server erzwingt es zusaetzlich 409).
                   *  Ausnahme: eigenes Team (team_lead_id === edit.id) bleibt
                   *  frei ab-/waehlbar — sonst waere ein Transfer (Team A -> B)
                   *  unmoeglich (in A abwaehlen ist explizit erlaubt). */
                  function isLockedByOther(c: Profile): boolean {
                    return !!c.team_lead_id && c.team_lead_id !== edit!.id;
                  }
                  const selectable = filtered.filter((c) => !isLockedByOther(c));
                  const allSelectableSelected =
                    selectable.length > 0 && selectable.every((c) => selected.has(c.id));
                  function toggle(id: string) {
                    if (!edit) return;
                    const next = new Set(edit.team_member_ids);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    setEdit({ ...edit, team_member_ids: Array.from(next) });
                  }
                  function toggleAllVisible() {
                    if (!edit) return;
                    const next = new Set(edit.team_member_ids);
                    // Bulk-Toggle nur ueber die freien Kandidaten — gesperrte
                    // MA werden uebersprungen (Server wuerde sonst 409 werfen).
                    if (allSelectableSelected) {
                      for (const c of selectable) next.delete(c.id);
                    } else {
                      for (const c of selectable) next.add(c.id);
                    }
                    setEdit({ ...edit, team_member_ids: Array.from(next) });
                  }
                  return (
                    <div className="rounded-xl border border-border bg-card overflow-hidden">
                      <div className="relative border-b border-border">
                        <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <input
                          type="text"
                          value={memberSearch}
                          onChange={(ev) => setMemberSearch(ev.target.value)}
                          placeholder="Mitarbeiter suchen…"
                          className="w-full h-9 pl-8 pr-3 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-foreground/[0.02] dark:bg-foreground/[0.05] text-[11px] text-muted-foreground">
                        <span>
                          {filtered.length} von {candidates.length} sichtbar
                          {selectable.length !== filtered.length && (
                            <span className="ml-1 text-amber-700 dark:text-amber-400">
                              · {filtered.length - selectable.length} bereits in anderem Team
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={toggleAllVisible}
                          disabled={selectable.length === 0}
                          className="font-medium text-foreground/80 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {allSelectableSelected ? "Sichtbare abwählen" : "Sichtbare auswählen"}
                        </button>
                      </div>
                      <ul className="max-h-64 overflow-y-auto divide-y divide-border/60">
                        {filtered.length === 0 ? (
                          <li className="px-3 py-4 text-xs text-muted-foreground text-center">
                            Keine Treffer.
                          </li>
                        ) : (
                          filtered.map((c) => {
                            const checked = selected.has(c.id);
                            const locked = isLockedByOther(c);
                            const lockLeaderName = locked ? profileName(c.team_lead_id) : null;
                            return (
                              <li key={c.id}>
                                <label
                                  className={
                                    locked
                                      ? "flex items-center gap-2.5 px-3 py-2 cursor-not-allowed bg-foreground/[0.02] dark:bg-foreground/[0.04]"
                                      : "flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.08]"
                                  }
                                  data-tooltip={locked ? "Zuerst im anderen Team abwählen, dann hier hinzufügen" : undefined}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={locked}
                                    onChange={() => { if (!locked) toggle(c.id); }}
                                    className="h-3.5 w-3.5 rounded border-border text-red-600 focus:ring-red-500/30 disabled:cursor-not-allowed"
                                  />
                                  <div className={`min-w-0 flex-1 ${locked ? "opacity-60" : ""}`}>
                                    <div className="text-sm truncate">{c.full_name}</div>
                                    <div className="text-[10px] text-muted-foreground truncate">
                                      {roleLabel(c.role)}
                                    </div>
                                  </div>
                                  {locked && (
                                    <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400 shrink-0 whitespace-nowrap ml-2 inline-flex items-center gap-1">
                                      <Users className="h-2.5 w-2.5" />
                                      Bereits im Team von {lockLeaderName ?? "anderem TL"}
                                    </span>
                                  )}
                                </label>
                              </li>
                            );
                          })
                        )}
                      </ul>
                    </div>
                  );
                })()}
                <p className="text-[10px] text-muted-foreground/70 ml-1">
                  Alle direkt diesem Teamleiter zugeordneten Mitarbeiter. Admins
                  und andere Teamleiter erscheinen bewusst nicht.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Teamleiter (optional)</p>
                <SearchableSelect
                  value={edit.team_lead_id}
                  onChange={(id) => setEdit({ ...edit, team_lead_id: id })}
                  items={teamLeadCandidates
                    .filter((c) => c.id !== edit.id)
                    .map((c) => ({
                      id: c.id,
                      label: c.full_name,
                      sub: roleLabel(c.role),
                    }))}
                  placeholder={teamLeadCandidates.filter((c) => c.id !== edit.id).length === 0
                    ? "Noch keine Teamleiter (Rolle braucht Sichtbarkeit „Nur Team\")"
                    : "— kein Teamleiter —"}
                  clearable
                />
                <p className="text-[10px] text-muted-foreground/70 ml-1">
                  Nur Rollen mit Sichtbarkeit „Nur Team" oder „Alle" tauchen hier auf.
                </p>
              </div>
            )}
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

      {/* Delete-Flow — Impact-basierte Bestaetigung + Dossier-Backup + Delete. */}
      <DeleteUserConfirmModal
        open={!!deletingUser}
        onClose={() => setDeletingUser(null)}
        user={deletingUser ? { id: deletingUser.id, full_name: deletingUser.full_name, role: roleLabel(deletingUser.role) } : null}
        onDeleted={() => { setDeletingUser(null); load(); }}
        withDossier
      />

      {ConfirmModalElement}
    </div>
  );
}
