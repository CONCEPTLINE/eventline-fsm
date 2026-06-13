"use client";

/**
 * Admin-Space — geteilter Notiz-Block fuer Admins.
 *
 * Jeder Admin hat seine eigene Zeile mit Zielen + Notizen. Alle anderen
 * Admins sehen alle Eintraege live (Realtime via admin_personal_space-
 * Subscription), koennen aber nur den eigenen bearbeiten.
 *
 * Auto-Save: debounced 800ms nach letztem Tastendruck. Kein 'Speichern'-
 * Button. Subtle 'gespeichert vor X'-Indikator.
 *
 * RLS sorgt fuer Sicherheit: Non-Admins kriegen sowieso einen leeren
 * Result und der Component rendert sich gar nicht erst.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Target, StickyNote, Users } from "lucide-react";

interface AdminSpaceRow {
  user_id: string;
  goals: string;
  notes: string;
  updated_at: string;
  // Joined via separate profile fetch
  full_name?: string;
}

const DEBOUNCE_MS = 800;

export function AdminSpace() {
  const supabase = createClient();
  const [rows, setRows] = useState<AdminSpaceRow[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [admins, setAdmins] = useState<{ id: string; full_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  // Lokale Edit-State pro user_id damit das Tippen nicht beim Realtime-
  // Update ueberschrieben wird waehrend man noch schreibt.
  const [localEdits, setLocalEdits] = useState<Record<string, { goals: string; notes: string }>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function load() {
    const [{ data: spaceData }, { data: adminData }, { data: { user } }] = await Promise.all([
      supabase
        .from("admin_personal_space")
        .select("user_id, goals, notes, updated_at")
        .order("updated_at", { ascending: false }),
      // Liste aller Admins damit auch User OHNE existing Space-Row gerendert
      // werden (Empty-State mit ihrem Namen).
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("role", "admin")
        .eq("is_active", true)
        .order("full_name"),
      supabase.auth.getUser(),
    ]);
    if (user) setCurrentUserId(user.id);
    if (adminData) setAdmins(adminData as { id: string; full_name: string }[]);
    if (spaceData) setRows(spaceData as AdminSpaceRow[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("realtime:admin_personal_space", handler);
    return () => window.removeEventListener("realtime:admin_personal_space", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bei Tippen: lokale State setzen + nach DEBOUNCE upserten.
  function schedule(userId: string, patch: Partial<{ goals: string; notes: string }>) {
    setLocalEdits((prev) => {
      const existing = prev[userId] ?? getCurrentValues(userId);
      return { ...prev, [userId]: { ...existing, ...patch } };
    });
    if (saveTimers.current[userId]) clearTimeout(saveTimers.current[userId]);
    saveTimers.current[userId] = setTimeout(async () => {
      const current = { ...getCurrentValues(userId), ...patch };
      await supabase
        .from("admin_personal_space")
        .upsert({ user_id: userId, ...current }, { onConflict: "user_id" });
      delete saveTimers.current[userId];
    }, DEBOUNCE_MS);
  }

  function getCurrentValues(userId: string): { goals: string; notes: string } {
    const local = localEdits[userId];
    if (local) return local;
    const row = rows.find((r) => r.user_id === userId);
    return { goals: row?.goals ?? "", notes: row?.notes ?? "" };
  }

  // Reihenfolge: ich selbst zuerst, dann andere alphabetisch.
  const ordered = useMemo(() => {
    return [...admins].sort((a, b) => {
      if (a.id === currentUserId) return -1;
      if (b.id === currentUserId) return 1;
      return a.full_name.localeCompare(b.full_name, "de");
    });
  }, [admins, currentUserId]);

  if (loading) {
    return (
      <Card className="bg-card">
        <CardContent className="p-4">
          <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />
        </CardContent>
      </Card>
    );
  }
  if (admins.length === 0) return null;

  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Admin-Space
          </h2>
          <p className="text-[10px] text-muted-foreground">
            Sichtbar fuer alle Admins · Auto-Save
          </p>
        </div>
        <div className="space-y-3">
          {ordered.map((a) => {
            const row = rows.find((r) => r.user_id === a.id);
            const values = getCurrentValues(a.id);
            const isOwn = a.id === currentUserId;
            const updatedAgo = row?.updated_at ? formatAgo(row.updated_at) : null;
            return (
              <div
                key={a.id}
                className={`rounded-lg border p-3 ${
                  isOwn
                    ? "border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/[0.04]"
                    : "border-border bg-muted/20"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold">
                    {a.full_name}
                    {isOwn && (
                      <span className="ml-1.5 text-[9px] font-normal text-red-600 dark:text-red-400 uppercase tracking-wider">
                        Du
                      </span>
                    )}
                  </p>
                  {updatedAgo && (
                    <span className="text-[10px] text-muted-foreground/70">{updatedAgo}</span>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                      <Target className="h-3 w-3" />
                      Ziele
                    </label>
                    <textarea
                      value={values.goals}
                      readOnly={!isOwn}
                      onChange={(e) => schedule(a.id, { goals: e.target.value })}
                      placeholder={isOwn ? "Was willst du erreichen?" : "—"}
                      rows={8}
                      className={`w-full px-3 py-2 text-sm rounded-md border resize-y transition-colors ${
                        isOwn
                          ? "border-border bg-card focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-400"
                          : "border-transparent bg-transparent cursor-default text-muted-foreground"
                      }`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                      <StickyNote className="h-3 w-3" />
                      Notizen
                    </label>
                    <textarea
                      value={values.notes}
                      readOnly={!isOwn}
                      onChange={(e) => schedule(a.id, { notes: e.target.value })}
                      placeholder={isOwn ? "Was beschaeftigt dich gerade?" : "—"}
                      rows={8}
                      className={`w-full px-3 py-2 text-sm rounded-md border resize-y transition-colors ${
                        isOwn
                          ? "border-border bg-card focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-400"
                          : "border-transparent bg-transparent cursor-default text-muted-foreground"
                      }`}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function formatAgo(iso: string): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return "gerade eben";
  if (diffSec < 3600) return `vor ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `vor ${Math.floor(diffSec / 3600)} h`;
  return new Date(iso).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" });
}
