"use client";

/**
 * Admin-Tool: App-interne Mitteilung an Mitarbeiter senden.
 *
 * Use-Case: 'Neue Features verfuegbar', 'Wartungsfenster heute Abend',
 * 'Bitte Stundenrapport bis Ende Woche einreichen', etc.
 *
 * Empfaenger-Auswahl: 'Alle' (Broadcast) / Rollen / einzelne User.
 * Notification geht durch den zentralen Service (notifySystem) -> die
 * user_notification_settings.channels werden respektiert.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Megaphone, Send, Users } from "lucide-react";

type AudienceMode = "all" | "roles" | "users";

interface RoleRow { slug: string; label: string }
interface UserRow { id: string; full_name: string; role: string }

export function MitteilungTab() {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("all");
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [rolesRes, usersRes] = await Promise.all([
        supabase.from("roles").select("slug, label").neq("slug", "partner").order("label"),
        supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
      ]);
      if (rolesRes.data) setRoles(rolesRes.data as RoleRow[]);
      if (usersRes.data) setUsers(usersRes.data as UserRow[]);
    })();
  }, [supabase]);

  // Recipient-Count fuer Konfirmation
  const recipientCount = useMemo(() => {
    if (audienceMode === "all") return users.length;
    if (audienceMode === "roles") {
      return users.filter((u) => selectedRoles.has(u.role)).length;
    }
    return selectedUsers.size;
  }, [audienceMode, users, selectedRoles, selectedUsers]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase().trim();
    if (!q) return users;
    return users.filter((u) =>
      u.full_name.toLowerCase().includes(q) || u.role.toLowerCase().includes(q),
    );
  }, [users, userSearch]);

  function toggleRole(slug: string) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }
  function toggleUser(id: string) {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function send() {
    if (!title.trim()) {
      toast.error("Titel ist Pflicht");
      return;
    }
    if (audienceMode === "roles" && selectedRoles.size === 0) {
      toast.error("Mindestens eine Rolle waehlen");
      return;
    }
    if (audienceMode === "users" && selectedUsers.size === 0) {
      toast.error("Mindestens einen User waehlen");
      return;
    }
    if (recipientCount === 0) {
      toast.error("Keine Empfaenger");
      return;
    }

    const audienceLabel =
      audienceMode === "all"
        ? `alle ${recipientCount} aktiven Mitarbeiter`
        : audienceMode === "roles"
          ? `${recipientCount} Mitarbeiter aus ${selectedRoles.size} Rollen`
          : `${recipientCount} ausgewaehlte Mitarbeiter`;

    const ok = await confirm({
      title: "Mitteilung senden?",
      message: `'${title.trim()}' geht an ${audienceLabel}. Kann nicht rueckgaengig gemacht werden.`,
      confirmLabel: "Senden",
      variant: "red",
    });
    if (!ok) return;

    setSending(true);
    const body: Record<string, unknown> = {
      title: title.trim(),
      message: message.trim() || null,
      link: link.trim() || null,
    };
    if (audienceMode === "all") body.targetAll = true;
    if (audienceMode === "roles") body.targetRoles = Array.from(selectedRoles);
    if (audienceMode === "users") body.userIds = Array.from(selectedUsers);

    const res = await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSending(false);
    if (!json.success) {
      TOAST.errorOr(json.error, "Senden fehlgeschlagen");
      return;
    }
    toast.success(`An ${json.sent ?? recipientCount} Mitarbeiter gesendet`);
    // Form zuruecksetzen
    setTitle("");
    setMessage("");
    setLink("");
    setSelectedRoles(new Set());
    setSelectedUsers(new Set());
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="text-sm text-muted-foreground">
        Versendet eine In-App-Benachrichtigung an mehrere Mitarbeiter. Empfaenger sehen sie sofort in
        ihrer Glocke + bekommen Push wenn sie es aktiviert haben (siehe Mein-Konto → Benachrichtigungen).
      </div>

      {/* Inhalt */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <Field label="Titel *">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="z.B. Neues Feature: 'Mein Konto' verfuegbar"
              maxLength={200}
            />
          </Field>
          <Field label="Nachricht">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Optionale Erklaerung — was ist neu? Was sollen die Mitarbeiter wissen?"
              rows={4}
              maxLength={1000}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </Field>
          <Field label="Link (optional)" hint="z.B. /mein-konto oder eine externe URL. Klick auf die Notification fuehrt dorthin.">
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="/mein-konto?tab=benachrichtigungen"
            />
          </Field>
        </CardContent>
      </Card>

      {/* Empfaenger */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-semibold">Empfaenger</p>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {recipientCount} {recipientCount === 1 ? "Person" : "Personen"}
            </span>
          </div>

          {/* Mode-Tabs */}
          <div className="flex gap-1 p-0.5 rounded-lg bg-muted">
            {([
              { key: "all", label: "Alle" },
              { key: "roles", label: "Nach Rolle" },
              { key: "users", label: "Einzeln" },
            ] as { key: AudienceMode; label: string }[]).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setAudienceMode(m.key)}
                className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                  audienceMode === m.key ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Roles-Modus */}
          {audienceMode === "roles" && (
            <div className="grid grid-cols-2 gap-2">
              {roles.map((r) => {
                const checked = selectedRoles.has(r.slug);
                const userCountInRole = users.filter((u) => u.role === r.slug).length;
                return (
                  <label
                    key={r.slug}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm transition-colors ${
                      checked ? "border-red-300 bg-red-500/[0.06]" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRole(r.slug)}
                      className="h-4 w-4"
                    />
                    <span className="flex-1">{r.label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{userCountInRole}</span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Users-Modus */}
          {audienceMode === "users" && (
            <div className="space-y-2">
              <Input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Name oder Rolle suchen…"
                className="h-9"
              />
              <div className="border border-border rounded-lg max-h-72 overflow-y-auto divide-y divide-border/40">
                {filteredUsers.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">Keine Treffer.</p>
                ) : filteredUsers.map((u) => {
                  const checked = selectedUsers.has(u.id);
                  return (
                    <label
                      key={u.id}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${
                        checked ? "bg-red-500/[0.06]" : "hover:bg-muted/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleUser(u.id)}
                        className="h-4 w-4"
                      />
                      <span className="flex-1">{u.full_name}</span>
                      <span className="text-[10px] text-muted-foreground capitalize">{u.role}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex gap-2 text-xs">
                <button type="button" onClick={() => setSelectedUsers(new Set(filteredUsers.map((u) => u.id)))} className="text-muted-foreground hover:text-foreground">
                  Alle in Suche
                </button>
                <button type="button" onClick={() => setSelectedUsers(new Set())} className="text-muted-foreground hover:text-foreground">
                  Auswahl leeren
                </button>
              </div>
            </div>
          )}

          {audienceMode === "all" && (
            <p className="text-xs text-muted-foreground italic">
              Geht an alle {users.length} aktiven Mitarbeiter (ohne Partner). User die System-Benachrichtigungen aus haben werden uebersprungen.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Send */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={send}
          disabled={sending || !title.trim() || recipientCount === 0}
          className="kasten kasten-red"
        >
          <Send className="h-3.5 w-3.5" />
          {sending ? "Sendet…" : `An ${recipientCount} senden`}
        </button>
      </div>

      {/* Preview-Info */}
      <Card className="bg-card border-dashed">
        <CardContent className="p-3 flex items-start gap-2 text-xs text-muted-foreground">
          <Megaphone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div>
            Empfaenger sehen die Mitteilung in der Glocken-Sektion <strong>&quot;Updates&quot;</strong> (Typ: system).
            Wenn sie die Push-Benachrichtigung im Browser aktiviert haben, kommt sie auch als
            System-Benachrichtigung auf dem Geraet an.
          </div>
        </CardContent>
      </Card>

      {ConfirmModalElement}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {hint && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
