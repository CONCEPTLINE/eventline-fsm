"use client";

/**
 * Rollen-Tab in /einstellungen — admin-only.
 *
 * Liste aller Rollen, jede Karte einklappbar (Default kollabiert) damit
 * sich nicht alle Matrizen gleichzeitig auftuermen.
 *
 * Pro Rolle:
 *   - Modul-Matrix (Sehen/Anlegen/Bearbeiten/Loeschen …) als Tabelle.
 *     Kaestchen-Matrix mit rotem X pro erlaubter Zelle — Klick toggelt.
 *   - Feature-Section (z.B. Bexio-Zugriff) — cross-cutting Permissions
 *     die nicht an einen Modul-Pfad gebunden sind.
 *
 * Aktive Permission = rotes X-Icon im Cell. Anklickbares Cell, Toggle
 * fuegt die Permission der Liste zu / entfernt sie.
 *
 * Modal-Breite: `4xl` (896px) damit die volle Aktions-Matrix ohne
 * horizontales Scrollen passt. `overflow-x-auto` bleibt als Safety
 * fuer sehr schmale Viewports.
 *
 * Schutzregeln:
 *   - Admin-Rolle ist gesperrt (sonst Lockout-Risiko).
 *   - System-Rollen (admin, techniker) sind nicht loeschbar; techniker-
 *     Permissions koennen aber editiert werden.
 *   - Custom-Rollen sind voll editier- und loeschbar (nur wenn keine User
 *     mehr drauf haengen).
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { PERMISSION_MODULES, PORTAL_PERMISSION_MODULES, PERMISSION_FEATURES, type PermissionAction, type PermissionModule, type RollenScope } from "@/lib/permissions";
import { istPortalRolle } from "@/lib/portals";
import { DASHBOARD_WIDGETS } from "@/lib/dashboard-widgets";
import { Plus, Trash2, Lock, Save, X, ChevronDown, ChevronRight, GripVertical, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

/** Rollen-Override fuer das Dashboard-Set. NULL = Registry-Default. */
type WidgetConfig = { order: string[]; hidden: string[] };

/** Sichtbarkeits-Reichweite einer Rolle (Migration 208).
 *   self = nur eigene Datensaetze (Default)
 *   team = zusaetzlich Datensaetze der Mitarbeiter mit team_lead_id = ich
 *   all  = alle Datensaetze */
type RoleScope = "self" | "team" | "all";

const SCOPE_OPTIONS: Array<{ id: RoleScope; label: string; sub: string }> = [
  { id: "self", label: "Nur eigene", sub: "Sieht ausschliesslich die eigenen Datensätze — Default." },
  { id: "team", label: "Nur Team",   sub: "Sieht zusätzlich Datensätze der Mitarbeiter, die auf sie als Teamleiter zeigen." },
  { id: "all",  label: "Alle",       sub: "Sieht alle Datensätze der Firma. Wie *:see-all für jedes Modul." },
];

function scopeLabel(scope: RoleScope): string {
  return SCOPE_OPTIONS.find((o) => o.id === scope)?.label ?? scope;
}

interface Role {
  slug: string;
  label: string;
  permissions: string[];
  is_system: boolean;
  /** NULL = Registry-Default; sonst explizites Override. */
  dashboard_widgets: WidgetConfig | null;
  /** Zugriffs-Reichweite (Migration 208). Default 'self' fuer alte API-
   *  Antworten die das Feld nicht liefern. */
  scope: RoleScope;
}

const ACTION_LABELS: Record<PermissionAction, string> = {
  view: "Sehen",
  create: "Anlegen",
  edit: "Bearbeiten",
  archive: "Archivieren",
  delete: "Löschen",
  manage: "Verwalten",
  approve: "Genehmigen",
  "see-all": "Alle sehen",
  "edit-all": "Alle bearbeiten",
};

// Spalten gruppiert: Standard-CRUD vs. erweiterte/Spezial-Permissions.
// Visuell durch einen Trennstrich in der Matrix unterschieden, damit
// klar ist dass z.B. 'Alle sehen' oder 'Genehmigen' nicht in jedem
// Bereich existieren — sondern bewusst nur dort wo angeboten.
const STANDARD_ACTIONS: PermissionAction[] = ["view", "create", "edit", "archive", "delete"];
const ADVANCED_ACTIONS: PermissionAction[] = ["approve", "manage", "see-all", "edit-all"];
const ACTION_COLUMNS: PermissionAction[] = [...STANDARD_ACTIONS, ...ADVANCED_ACTIONS];

// Visuelles Toggle-Cell: aktive Permission = rotes X im Cell, sonst leer.
// `onToggle` fehlt bei locked-Rollen (Admin) damit die Cells nicht klickbar sind.
function PermCell({ active, locked, onToggle, label }: {
  active: boolean;
  locked: boolean;
  onToggle?: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={locked}
      onClick={onToggle}
      aria-label={label}
      aria-pressed={active}
      className={`
        inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors
        ${active
          ? "border-red-300 bg-red-50 dark:bg-red-500/15 dark:border-red-500/40"
          : "border-border hover:bg-foreground/[0.04]"}
        ${locked ? "cursor-not-allowed opacity-70" : "cursor-pointer"}
      `}
    >
      {active && <X className="h-4 w-4 text-red-600 dark:text-red-400" strokeWidth={3} />}
    </button>
  );
}

interface RollenTabProps {
  /** "firma" = alle internen Rollen (keine Portal-Rollen); ein Portal-Slug
      (partner/lieferant/…) = nur genau diese Portal-Rolle.
      Default "firma". Steuert Filter + UI-Texte. */
  scope?: RollenScope;
}

/** Intro-Text pro Portal-Scope — Firmenportal-Text ist der Fallback. */
const PORTAL_INTRO: Partial<Record<RollenScope, string>> = {
  partner: "Berechtigungen der Partner-Rolle. Steuert was Locationspartner im Partner-Portal sehen und tun dürfen.",
  lieferant: "Berechtigungen der Lieferanten-Rolle. Steuert was Lieferanten im Lieferantenportal sehen und tun dürfen.",
};

export function RollenTab({ scope = "firma" }: RollenTabProps = {}) {
  // Welche Module in der Matrix erscheinen — Firmenportal hat seinen
  // eigenen Modul-Katalog, jedes Portal (partner/lieferant/…) seinen
  // eigenen (Registry PORTAL_PERMISSION_MODULES). Die Welten teilen das
  // Permission-Format (slug:action), aber nicht den Inhalt.
  const modules: readonly PermissionModule[] = scope === "firma" ? PERMISSION_MODULES : PORTAL_PERMISSION_MODULES[scope];
  // Zusatz-Features (z.B. Bexio) sind nur im Firmenportal relevant.
  const features = scope === "firma" ? PERMISSION_FEATURES : [];
  // Action-Spalten dynamisch: nur Aktionen anzeigen die mind. ein Modul
  // unterstuetzt — sonst hat Partnerportal leere "Archivieren"/"Genehmigen"-
  // Spalten weil dort niemand diese Aktionen kennt.
  const actionCols = ACTION_COLUMNS.filter((a) => modules.some((m) => m.actions.includes(a)));
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<{ label: string; permissions: string[]; scope: RoleScope }>({ label: "", permissions: [], scope: "self" });
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  // Scope-Overrides pro Rolle. 'self'/'team'/'all' — Default 'self'.
  const [scopeEdits, setScopeEdits] = useState<Record<string, RoleScope>>({});
  // Widget-Overrides pro Rolle. NULL = Registry-Default (kein Override in DB).
  // Sonst {order, hidden}: siehe migration 207. Wird beim ersten Toggle/Reorder
  // aus dem Registry-Default materialisiert und weiter gepflegt.
  const [widgetEdits, setWidgetEdits] = useState<Record<string, WidgetConfig | null>>({});
  // Aktuell gezogenes Widget (roleSlug + Index) — nur ein Drag gleichzeitig.
  const [dragging, setDragging] = useState<{ roleSlug: string; idx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ roleSlug: string; idx: number } | null>(null);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  // Welche Rollen-Karten sind aufgeklappt? Default: alles zugeklappt damit
  // die Liste kompakt bleibt.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    const res = await fetch("/api/admin/roles");
    const json = await res.json();
    if (json.success) {
      // Scope-Filter: firma = alle internen Rollen (keine Portal-Rollen),
      // Portal-Scope (partner/lieferant/…) = nur genau diese Rolle.
      // Trennung der Rollen-Welten in /einstellungen (Portal-Haupt-Tabs).
      // Zusaetzlich: scope kann bei aelterer API-Antwort fehlen -> auf 'self'
      // defaulten, damit spaetere Vergleiche nicht undefined lesen.
      const filtered: Role[] = (json.roles as Array<Role & { scope?: string }>).filter((r) =>
        scope === "firma" ? !istPortalRolle(r.slug) : r.slug === scope
      ).map((r) => ({
        ...r,
        scope: (r.scope === "team" || r.scope === "all" ? r.scope : "self") as RoleScope,
      }));
      setRoles(filtered);
      const initial: Record<string, string[]> = {};
      const initialWidgets: Record<string, WidgetConfig | null> = {};
      const initialScopes: Record<string, RoleScope> = {};
      for (const r of filtered) {
        initial[r.slug] = [...r.permissions];
        // dashboard_widgets kann fehlen (aeltere API-Antwort) → als NULL
        // interpretieren = Registry-Default.
        initialWidgets[r.slug] = r.dashboard_widgets
          ? { order: [...r.dashboard_widgets.order], hidden: [...r.dashboard_widgets.hidden] }
          : null;
        initialScopes[r.slug] = r.scope;
      }
      setEdits(initial);
      setWidgetEdits(initialWidgets);
      setScopeEdits(initialScopes);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function toggleExpanded(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  function togglePermission(slug: string, perm: string) {
    setEdits((prev) => {
      const current = prev[slug] ?? [];
      const adding = !current.includes(perm);
      let next = adding ? [...current, perm] : current.filter((s) => s !== perm);

      // Auto-Aktivierung der module:view-Permission wenn create/edit/delete/
      // archive aktiviert wird. Ein User kann z.B. kunden:edit nicht
      // sinnvoll nutzen wenn er die Kunden-Liste gar nicht sehen darf —
      // ohne diesen Auto-Toggle muesste der Admin daran denken view extra
      // anzuhaken.
      if (adding && perm.includes(":")) {
        const [mod, action] = perm.split(":");
        if (action !== "view" && !next.includes(`${mod}:view`)) {
          next = [...next, `${mod}:view`];
        }
      }

      return { ...prev, [slug]: next };
    });
  }

  // "Alle ankreuzen" pro Modul-Zeile — schnellerer Custom-Rollen-Build.
  function setAllForModule(roleSlug: string, modSlug: string, actions: readonly PermissionAction[]) {
    setEdits((prev) => {
      const current = prev[roleSlug] ?? [];
      const modPerms = actions.map((a) => `${modSlug}:${a}`);
      const allSet = modPerms.every((p) => current.includes(p));
      // Wenn alle schon da: alle entfernen. Sonst alle hinzufuegen.
      const next = allSet
        ? current.filter((p) => !modPerms.includes(p))
        : [...new Set([...current, ...modPerms])];
      return { ...prev, [roleSlug]: next };
    });
  }

  // ============================================================
  // Dashboard-Widget-Overrides
  // ============================================================

  /**
   * Widget-Konfig einer Rolle wenn KEIN Override gesetzt ist: alle Registry-
   * Widgets in Registry-Reihenfolge; hidden = alle Widgets deren
   * `defaultRoles` diese Rolle NICHT enthalten.
   *
   * Genutzt fuer die visuelle Darstellung wenn `widgetEdits[slug] === null`
   * (frisch aus DB, kein Override) und als "Reset"-Basis.
   */
  function defaultWidgetConfig(roleSlug: string): WidgetConfig {
    return {
      order: DASHBOARD_WIDGETS.map((w) => w.id),
      hidden: DASHBOARD_WIDGETS.filter((w) => !w.defaultRoles.includes(roleSlug)).map((w) => w.id),
    };
  }

  /** Aktuell wirksame Widget-Konfig einer Rolle (Override oder Default). */
  function currentWidgetConfig(roleSlug: string): WidgetConfig {
    const stored = widgetEdits[roleSlug];
    return stored ?? defaultWidgetConfig(roleSlug);
  }

  /**
   * Registry-Widgets in Anzeige-Reihenfolge. Order-Array kann veraltete IDs
   * enthalten (=> ignorieren) und neue IDs verpassen (=> in Registry-
   * Reihenfolge hintendran). Beides passiert nach Registry-Umbauten.
   */
  function orderedWidgets(config: WidgetConfig) {
    const known = new Set<string>(DASHBOARD_WIDGETS.map((w) => w.id));
    const listed = config.order.filter((id) => known.has(id));
    const listedSet = new Set<string>(listed);
    const rest = DASHBOARD_WIDGETS.filter((w) => !listedSet.has(w.id)).map((w) => w.id as string);
    return [...listed, ...rest].map((id) => DASHBOARD_WIDGETS.find((w) => w.id === id)!);
  }

  function setWidgetsFor(roleSlug: string, next: WidgetConfig) {
    setWidgetEdits((prev) => ({ ...prev, [roleSlug]: next }));
  }

  function toggleWidgetHidden(roleSlug: string, widgetId: string) {
    const cur = currentWidgetConfig(roleSlug);
    const nextHidden = cur.hidden.includes(widgetId)
      ? cur.hidden.filter((w) => w !== widgetId)
      : [...cur.hidden, widgetId];
    // Order dabei auf ALLE bekannten IDs auffuellen, damit ein spaeteres
    // Reorder eine vollstaendige Liste hat.
    const orderedIds = orderedWidgets(cur).map((w) => w.id);
    setWidgetsFor(roleSlug, { order: orderedIds, hidden: nextHidden });
  }

  function moveWidget(roleSlug: string, fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    const cur = currentWidgetConfig(roleSlug);
    const orderedIds = orderedWidgets(cur).map((w) => w.id);
    const [moved] = orderedIds.splice(fromIdx, 1);
    orderedIds.splice(toIdx, 0, moved);
    setWidgetsFor(roleSlug, { order: orderedIds, hidden: cur.hidden });
  }

  function resetWidgetsToDefault(roleSlug: string) {
    // NULL zurueck-schreiben → beim Save landet dashboard_widgets = null in DB
    // und die Rolle nutzt wieder das Registry-Default.
    setWidgetEdits((prev) => ({ ...prev, [roleSlug]: null }));
  }

  // Vergleicht zwei Widget-Konfigs strikt (order-Reihenfolge zaehlt,
  // hidden-Menge ist Set-vergleich). NULL === NULL.
  function widgetsEqual(a: WidgetConfig | null, b: WidgetConfig | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.order.length !== b.order.length) return false;
    for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return false;
    if (a.hidden.length !== b.hidden.length) return false;
    const bh = new Set(b.hidden);
    return a.hidden.every((h) => bh.has(h));
  }

  function isDirty(role: Role): boolean {
    const edited = edits[role.slug] ?? [];
    if (edited.length !== role.permissions.length) return true;
    if (edited.some((s) => !role.permissions.includes(s))) return true;
    // Widget-Overrides diffen
    const nowW = widgetEdits[role.slug] ?? null;
    const origW = role.dashboard_widgets ?? null;
    if (!widgetsEqual(nowW, origW)) return true;
    // Scope-Aenderungen
    const nowScope = scopeEdits[role.slug] ?? role.scope;
    if (nowScope !== role.scope) return true;
    return false;
  }

  async function saveRole(role: Role) {
    setSavingSlug(role.slug);
    const res = await fetch(`/api/admin/roles/${role.slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: edits[role.slug] ?? [],
        // NULL = Registry-Default (Reset); Objekt = expliziter Override.
        dashboard_widgets: widgetEdits[role.slug] ?? null,
        // Sichtbarkeits-Scope der Rolle (self/team/all, Migration 208).
        scope: scopeEdits[role.slug] ?? role.scope,
      }),
    });
    const json = await res.json();
    setSavingSlug(null);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Rolle gespeichert");
    load();
  }

  async function deleteRole(role: Role) {
    const ok = await confirm({
      title: "Rolle löschen?",
      message: `Die Rolle "${role.label}" wird endgültig entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/roles/${role.slug}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Rolle gelöscht");
    load();
  }

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // scope wird bei neuen Rollen mitgeschickt; API validiert self/team/all,
      // DB-Default bleibt 'self' falls das Feld fehlt.
      body: JSON.stringify(createForm),
    });
    const json = await res.json();
    setCreating(false);
    if (!json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Rolle angelegt");
    setShowCreate(false);
    setCreateForm({ label: "", permissions: [], scope: "self" });
    load();
  }

  // Modul-Matrix als Tabelle: Zeilen = Bereiche, Spalten = Aktionen, pro
  // erlaubter Zelle ein `PermCell` (Klick toggelt). `overflow-x-auto` als
  // Safety fuer schmale Viewports — bei Modal-Breite `4xl` (896px) passt
  // die volle Matrix normal ohne x-Scroll.
  //
  // `onSetAll` erlaubt es dem Create-Modal, den "Alle"-Preset-Klick in
  // seinen eigenen `createForm.permissions`-State zu schreiben statt in
  // die Inline-`edits`-Map (Bug-Fix: ohne diesen Callback wuerde der
  // Preset stillschweigend in `edits["create"]` landen).
  function renderModuleMatrix(
    roleSlug: string,
    currentPerms: string[],
    locked: boolean,
    onToggle: (perm: string) => void,
    onSetAll?: (modSlug: string, actions: readonly PermissionAction[]) => void,
  ) {
    const setAll = onSetAll ?? ((mSlug: string, acts: readonly PermissionAction[]) => setAllForModule(roleSlug, mSlug, acts));
    return (
      <div className="overflow-x-auto -mx-2 sm:mx-0">
        <table className="w-full text-sm border-separate border-spacing-y-1 px-2 sm:px-0">
          <thead>
            <tr className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              <th className="text-left pb-1 pr-3">Bereich</th>
              {actionCols.map((a, i) => {
                const isFirstAdvanced = ADVANCED_ACTIONS.includes(a) && (i === 0 || STANDARD_ACTIONS.includes(actionCols[i - 1]));
                return (
                  <th
                    key={a}
                    className={`text-center pb-1 px-1 w-16 ${isFirstAdvanced ? "border-l border-border" : ""}`}
                    data-tooltip={ADVANCED_ACTIONS.includes(a) ? "Erweiterte Permission — nur in einzelnen Bereichen verfügbar." : undefined}
                  >
                    {ACTION_LABELS[a]}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {modules.map((mod) => {
              // Tooltip-Hinweise pro Modul wo es Sub-Pfade gibt die nicht
              // offensichtlich sind. Wird auf den Bereich-Namen gelegt.
              const moduleTooltip = mod.slug === "kalender"
                ? "Steuert auch Termine auf Auftrag-Detail-Seiten."
                : mod.slug === "stempelzeiten"
                ? "Eigene Stempelzeiten bleiben sichtbar; diese Permission steuert die /stempelzeiten-Seite."
                : undefined;
              return (
              <tr key={`${roleSlug}-${mod.slug}`} className="bg-foreground/[0.02] dark:bg-foreground/[0.04]">
                <td className="py-1 px-3 rounded-l-lg text-xs font-medium">
                  <div className="flex items-center gap-1.5">
                    <span data-tooltip={moduleTooltip}>{mod.label}</span>
                    {!locked && mod.actions.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setAll(mod.slug, mod.actions)}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
                        data-tooltip={`Alle ${actionCols.filter(a => mod.actions.includes(a)).length} Aktionen toggeln`}
                      >
                        Alle
                      </button>
                    )}
                  </div>
                </td>
                {actionCols.map((a, i) => {
                  const supported = mod.actions.includes(a);
                  const perm = `${mod.slug}:${a}`;
                  const active = locked ? supported : currentPerms.includes(perm);
                  const isLast = a === actionCols[actionCols.length - 1];
                  const isFirstAdvanced = ADVANCED_ACTIONS.includes(a) && (i === 0 || STANDARD_ACTIONS.includes(actionCols[i - 1]));
                  return (
                    <td key={a} className={`text-center py-1 px-1 ${isLast ? "rounded-r-lg" : ""} ${isFirstAdvanced ? "border-l border-border" : ""}`}>
                      {supported ? (
                        <PermCell
                          active={active}
                          locked={locked}
                          onToggle={() => onToggle(perm)}
                          label={`${mod.label} ${ACTION_LABELS[a]}`}
                        />
                      ) : (
                        <span
                          className="text-muted-foreground/40"
                          data-tooltip={`'${ACTION_LABELS[a]}' gibt es im Bereich '${mod.label}' nicht.`}
                        >—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // ============================================================
  // Dashboard-Widget-Editor pro Rolle
  //
  // Liste aller Registry-Widgets in aktueller Anzeige-Reihenfolge. Pro Zeile:
  //   - Drag-Handle (GripVertical) — HTML5 DnD zum Reihenfolge-Aendern
  //   - PermCell-Toggle (rotes X = sichtbar) — visuell konsistent mit der
  //     Modul-Matrix darueber
  //   - Titel + Muted-Zeile mit `requires`-Slugs als Chips
  //   - Amber-Warnchip wenn die Rolle die fuer das Widget noetigen
  //     Permissions aktuell NICHT hat (Toggle bleibt trotzdem klickbar —
  //     wird effektiv, sobald die Permission spaeter dazukommt)
  // Ganz unten: "Auf Registry-Default zuruecksetzen"-Link — schreibt
  // dashboard_widgets = NULL und hebt damit den Rollen-Override auf.
  // ============================================================
  function renderDashboardWidgets(roleSlug: string, rolePerms: string[]) {
    const config = currentWidgetConfig(roleSlug);
    const widgets = orderedWidgets(config);
    const hiddenSet = new Set(config.hidden);
    const hasOverride = widgetEdits[roleSlug] !== null && widgetEdits[roleSlug] !== undefined;

    return (
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Dashboard-Widgets
          </p>
          {hasOverride && (
            <button
              type="button"
              onClick={() => resetWidgetsToDefault(roleSlug)}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              data-tooltip="Rollen-Override löschen — die Rolle zeigt wieder das Default-Set aus der Registry."
            >
              <RotateCcw className="h-3 w-3" />
              Auf Registry-Default zurücksetzen
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Welche Kacheln User dieser Rolle standardmässig auf dem Dashboard sehen.
          Jeder User kann für sich selbst zusätzlich Widgets ausblenden oder umsortieren.
        </p>
        <div className="space-y-1">
          {widgets.map((w, idx) => {
            const isVisible = !hiddenSet.has(w.id);
            const missing = w.requires.filter((req) => !rolePerms.includes(req));
            const hasAllReqs = missing.length === 0;
            const isDropTarget = dropTarget?.roleSlug === roleSlug && dropTarget.idx === idx;
            const isDragged = dragging?.roleSlug === roleSlug && dragging.idx === idx;
            return (
              <div
                key={w.id}
                onDragOver={(e) => {
                  if (dragging?.roleSlug !== roleSlug) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropTarget({ roleSlug, idx });
                }}
                onDragLeave={() => {
                  if (dropTarget?.roleSlug === roleSlug && dropTarget.idx === idx) setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging?.roleSlug === roleSlug) {
                    moveWidget(roleSlug, dragging.idx, idx);
                  }
                  setDragging(null);
                  setDropTarget(null);
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] transition-colors"
                style={{
                  opacity: isDragged ? 0.4 : hasAllReqs ? 1 : 0.6,
                  boxShadow: isDropTarget && !isDragged ? "inset 0 2px 0 0 rgb(239,68,68)" : undefined,
                }}
              >
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragging({ roleSlug, idx });
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox verlangt setData() sonst startet kein Drag.
                    e.dataTransfer.setData("text/plain", w.id);
                  }}
                  onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                  className="shrink-0 text-muted-foreground/60 hover:text-foreground transition-colors"
                  style={{ cursor: "grab" }}
                  data-tooltip="Ziehen um die Reihenfolge zu ändern"
                  aria-label="Reihenfolge ändern"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <PermCell
                  active={isVisible}
                  locked={false}
                  onToggle={() => toggleWidgetHidden(roleSlug, w.id)}
                  label={`${w.title} ${isVisible ? "ausblenden" : "einblenden"}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{w.title}</p>
                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                    {w.requires.length === 0 ? (
                      <span className="text-[10px] text-muted-foreground/60">Keine Berechtigung noetig</span>
                    ) : (
                      w.requires.map((req) => {
                        const present = rolePerms.includes(req);
                        return (
                          <span
                            key={req}
                            className={`inline-flex items-center px-1.5 py-0 text-[10px] font-mono rounded ${
                              present
                                ? "bg-foreground/[0.06] text-muted-foreground"
                                : "bg-foreground/[0.06] text-muted-foreground/60 line-through"
                            }`}
                            data-tooltip="Wer diese Berechtigung nicht hat, sieht das Widget trotz Aktivierung nicht."
                          >
                            {req}
                          </span>
                        );
                      })
                    )}
                    {!hasAllReqs && (
                      <span
                        className="inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                        data-tooltip={`Diese Rolle hat ${missing.join(", ")} nicht — Widget bleibt trotz Aktivierung leer bis die Permission gesetzt ist.`}
                      >
                        Berechtigung fehlt
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderFeatureGrid(currentPerms: string[], locked: boolean, onToggle: (perm: string) => void) {
    if (features.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Zusatz-Funktionen
        </p>
        <div className="space-y-1">
          {features.map((f) => {
            const active = locked ? true : currentPerms.includes(f.key);
            return (
              <div key={f.key} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04]">
                <PermCell
                  active={active}
                  locked={locked}
                  onToggle={() => onToggle(f.key)}
                  label={f.label}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{f.label}</p>
                  <p className="text-[11px] text-muted-foreground">{f.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          {PORTAL_INTRO[scope]
            ?? "Pro Rolle steuerst du, welche Bereiche sichtbar sind und welche Aktionen erlaubt. Admin sieht und darf immer alles."}
        </p>
        {scope === "firma" && (
          <button type="button" onClick={() => setShowCreate(true)} className="kasten kasten-red">
            <Plus className="h-3.5 w-3.5" />Neue Rolle
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">{[1,2].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4 h-12" /></Card>)}</div>
      ) : (
        <div className="space-y-2">
          {roles.map((role) => {
            const locked = role.slug === "admin";
            const dirty = !locked && isDirty(role);
            const currentPerms = edits[role.slug] ?? [];
            const isOpen = expanded.has(role.slug);
            return (
              <Card key={role.slug} className="bg-card overflow-hidden">
                {/* Header — komplett klickbar fuer Aufklappen. */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(role.slug)}
                  className="w-full flex items-center justify-between gap-2 px-4 py-2 hover:bg-foreground/[0.02] transition-colors text-left"
                >
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <h3 className="font-semibold text-sm">{role.label}</h3>
                    {role.is_system && (
                      <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                        System
                      </span>
                    )}
                    {/* Scope-Chip auch im geschlossenen Header — auf einen
                        Blick sichtbar wer Team-/All-Sicht hat, ohne dass man
                        jede Rolle einzeln aufklappen muss. Admin bleibt implizit
                        scope='all' und braucht keinen Chip (immer-alles-Regel). */}
                    {scope === "firma" && !locked && (
                      <span
                        className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300"
                        data-tooltip="Sichtbarkeits-Reichweite dieser Rolle"
                      >
                        {scopeLabel(scopeEdits[role.slug] ?? role.scope)}
                      </span>
                    )}
                    {locked && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-medium rounded-full bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300">
                        <Lock className="h-2.5 w-2.5" />Geschützt
                      </span>
                    )}
                    {dirty && (
                      <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                        Ungespeichert
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {dirty && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); saveRole(role); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); saveRole(role); } }}
                        aria-disabled={savingSlug === role.slug}
                        className="kasten kasten-red"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {savingSlug === role.slug ? "Speichert…" : "Speichern"}
                      </span>
                    )}
                    {!role.is_system && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); deleteRole(role); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); deleteRole(role); } }}
                        aria-label="Rolle löschen"
                        className="kasten kasten-muted"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <CardContent className="px-4 pt-0 pb-4 space-y-4 border-t border-border">
                    {locked ? (
                      // Admin-Rolle: Matrix zeigen ist sinnlos (kann nicht geaendert
                      // werden). Stattdessen eine kurze Erklaerung — inklusive Hinweis
                      // dass der Widget-Editor fuer Admin gesperrt ist.
                      <div className="pt-3">
                        <div className="flex items-start gap-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
                          <Lock className="h-4 w-4 text-blue-600 dark:text-blue-300 mt-0.5 shrink-0" />
                          <div className="text-xs space-y-1">
                            <p className="font-medium">Admin hat per Definition alle Rechte.</p>
                            <p className="text-muted-foreground">
                              Diese Rolle ist System-geschützt und kann nicht editiert oder
                              gelöscht werden — sonst könntest du dich selbst aussperren.
                              Wenn du jemandem nur einen Teil der Admin-Funktionen geben
                              willst, lege eine neue Rolle an.
                            </p>
                            <p className="text-muted-foreground">
                              Admin sieht per Definition alle verfuegbaren Dashboard-Widgets.
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Sichtbarkeits-Scope — steuert ob User dieser Rolle
                            zusaetzlich Datensaetze ihres Teams oder aller MA
                            sehen (Migration 208). Nur im Firmenportal-Scope;
                            im Partner-Editor irrelevant. */}
                        {scope === "firma" && (
                          <div className="pt-3 space-y-1">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                              Sichtbarkeit
                            </p>
                            <div className="max-w-sm">
                              <SearchableSelect
                                value={scopeEdits[role.slug] ?? role.scope}
                                onChange={(id) => {
                                  if (id === "self" || id === "team" || id === "all") {
                                    setScopeEdits((prev) => ({ ...prev, [role.slug]: id }));
                                  }
                                }}
                                items={SCOPE_OPTIONS}
                                searchable={false}
                                clearable={false}
                              />
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              „Nur Team" macht diese Rolle zum Teamleiter-Kandidaten — MA koennen ihr im Team-Tab zugeordnet werden.
                            </p>
                          </div>
                        )}
                        <div className="pt-3 text-[11px] text-muted-foreground italic">
                          Rotes X = erlaubt. Klick auf eine Zelle setzt oder entfernt die Berechtigung.
                          „—" = Aktion ist im jeweiligen Bereich nicht möglich.
                        </div>
                        {renderModuleMatrix(role.slug, currentPerms, locked, (perm) => togglePermission(role.slug, perm))}
                        {renderFeatureGrid(currentPerms, locked, (perm) => togglePermission(role.slug, perm))}
                        {renderDashboardWidgets(role.slug, currentPerms)}
                      </>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={showCreate} onClose={() => !creating && setShowCreate(false)} title="Neue Rolle" size="4xl">
        <form onSubmit={createRole} className="space-y-4">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Name *</p>
            <Input
              value={createForm.label}
              onChange={(e) => setCreateForm({ ...createForm, label: e.target.value })}
              placeholder="z.B. Vertrieb, Buchhaltung"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Sichtbarkeit</p>
            <div className="max-w-sm">
              <SearchableSelect
                value={createForm.scope}
                onChange={(id) => {
                  if (id === "self" || id === "team" || id === "all") {
                    setCreateForm({ ...createForm, scope: id });
                  }
                }}
                items={SCOPE_OPTIONS}
                searchable={false}
                clearable={false}
              />
            </div>
            <p className="text-[10px] text-muted-foreground/70 ml-1">
              Default „Nur eigene". „Nur Team" macht die Rolle zum Teamleiter-Kandidaten.
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Berechtigungen</p>
            <p className="text-[11px] text-muted-foreground italic mb-2">
              Rotes X = erlaubt. Klick auf eine Zelle setzt oder entfernt die Berechtigung.
              „Alle" schaltet alle Aktionen eines Bereichs auf einmal.
            </p>
            {renderModuleMatrix(
              "create",
              createForm.permissions,
              false,
              (perm) => {
                const next = createForm.permissions.includes(perm)
                  ? createForm.permissions.filter((s) => s !== perm)
                  : [...createForm.permissions, perm];
                setCreateForm({ ...createForm, permissions: next });
              },
              // „Alle"-Preset innerhalb des Create-Modals updated createForm
              // statt der Inline-`edits`-State-Map — sonst wird der Klick
              // stillschweigend in den falschen Zustands-Slot geschrieben.
              (modSlug, actions) => {
                const modPerms = actions.map((a) => `${modSlug}:${a}`);
                const allSet = modPerms.every((p) => createForm.permissions.includes(p));
                const next = allSet
                  ? createForm.permissions.filter((p) => !modPerms.includes(p))
                  : Array.from(new Set([...createForm.permissions, ...modPerms]));
                setCreateForm({ ...createForm, permissions: next });
              },
            )}
            <div className="pt-3">
              {renderFeatureGrid(createForm.permissions, false, (perm) => {
                const next = createForm.permissions.includes(perm)
                  ? createForm.permissions.filter((s) => s !== perm)
                  : [...createForm.permissions, perm];
                setCreateForm({ ...createForm, permissions: next });
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setShowCreate(false)} disabled={creating} className="kasten kasten-muted flex-1">Abbrechen</button>
            <button type="submit" disabled={creating || !createForm.label} className="kasten kasten-red flex-1">
              {creating ? "Erstellt…" : "Rolle anlegen"}
            </button>
          </div>
        </form>
      </Modal>

      {ConfirmModalElement}
    </div>
  );
}
