"use client";

/**
 * Standort-Detail: Tab "Übersicht".
 *
 * Fokus: was das Team beim Öffnen des Standorts sofort sehen soll.
 *   1) Gepinnte Notizen (Tuerschluessel-Code, WLAN, Besonderheiten) —
 *      prominent oben, gelber Akzent.
 *   2) Kontaktpersonen als kompakte Chips mit tel:/mailto:.
 *
 * Alles andere lebt in den anderen Tabs (Notizen/Dokumente/Einstellungen).
 * Die frueher hier gezeigte Instandhaltungs-Section wurde entfernt —
 * echte Aufgaben laufen ueber Auftraege mit Datum + Verantwortung.
 */

import { useState } from "react";
import Link from "next/link";
import { useConfirm } from "@/components/ui/use-confirm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Users, UserPlus, Phone, Mail, Trash2, Pin, StickyNote, Link as LinkIcon, X,
} from "lucide-react";
import type { LocationContact } from "@/types";
import type { Note } from "./use-standort-data";

type Props = {
  contacts: LocationContact[];
  pinnedNotes: Note[];
  canEdit: boolean;
  onGoToNotesTab: () => void;
  onUnpinNote: (id: string) => Promise<void>;
  onCreateContact: (input: {
    name: string;
    role?: string;
    email?: string;
    phone?: string;
  }) => Promise<boolean>;
  onDeleteContact: (id: string) => Promise<void>;
};

function isUrl(s: string): boolean {
  return /^https?:\/\/\S+/i.test(s.trim());
}

export function OverviewTab({
  contacts,
  pinnedNotes,
  canEdit,
  onGoToNotesTab,
  onUnpinNote,
  onCreateContact,
  onDeleteContact,
}: Props) {
  const { confirm, ConfirmModalElement } = useConfirm();
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", role: "", email: "", phone: "" });

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onCreateContact(contactForm);
    if (!ok) return;
    setContactForm({ name: "", role: "", email: "", phone: "" });
    setShowContactForm(false);
  }

  async function handleDeleteContact(c: LocationContact) {
    const ok = await confirm({
      title: "Kontakt löschen?",
      message: `"${c.name}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    await onDeleteContact(c.id);
  }

  return (
    <div className="space-y-4">
      {/* ─── Gepinnte Notizen ────────────────────────────────────────
          Nur sichtbar wenn welche existieren. Gelber Pin-Akzent damit
          man sie beim Scrollen sofort erkennt. */}
      {pinnedNotes.length > 0 && (
        <Card className="bg-card border-amber-300/40 dark:border-amber-500/30">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Pin className="h-4 w-4 fill-amber-400 text-amber-500" strokeWidth={2.5} />
              Gepinnt
              <span className="text-[10px] font-normal text-muted-foreground">({pinnedNotes.length})</span>
            </CardTitle>
            <button
              type="button"
              onClick={onGoToNotesTab}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Alle Notizen →
            </button>
          </CardHeader>
          <CardContent className="space-y-2">
            {pinnedNotes.map((n) => (
              <div
                key={n.id}
                className="group flex items-start gap-2.5 p-3 rounded-xl border border-amber-200/50 bg-amber-50/50 dark:bg-amber-500/[0.06] dark:border-amber-500/20"
              >
                <div
                  className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: "rgba(245,158,11,0.15)", color: "rgb(154,90,10)" }}
                >
                  {isUrl(n.content) ? <LinkIcon className="h-3.5 w-3.5" /> : <StickyNote className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  {isUrl(n.content) ? (
                    <a
                      href={n.content}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
                    >
                      {n.content}
                    </a>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{n.content}</p>
                  )}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onUnpinNote(n.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
                    data-tooltip="Pin entfernen"
                    aria-label="Pin entfernen"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ─── Kontaktpersonen ─────────────────────────────────────────
          Kompakte Chips mit tel:/mailto:. Jede Karte hat einen kleinen
          Rot-Rand beim Hover für Löschen. */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users className="h-4 w-4" />
            Kontaktpersonen
            <span className="text-[10px] font-normal text-muted-foreground">({contacts.length})</span>
          </CardTitle>
          {canEdit && !showContactForm && (
            <button
              type="button"
              onClick={() => setShowContactForm(true)}
              className="kasten kasten-red"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Neuer Kontakt
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {showContactForm && (
            <form onSubmit={addContact} className="p-3 rounded-xl border border-border bg-muted/30 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Name *"
                  value={contactForm.name}
                  onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                  required
                  autoFocus
                />
                <Input
                  placeholder="Rolle (z.B. Techniker)"
                  value={contactForm.role}
                  onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="email"
                  placeholder="E-Mail"
                  value={contactForm.email}
                  onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                />
                <Input
                  type="tel"
                  placeholder="Telefon"
                  value={contactForm.phone}
                  onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowContactForm(false); setContactForm({ name: "", role: "", email: "", phone: "" }); }}
                  className="kasten kasten-muted"
                >
                  Abbrechen
                </button>
                <button type="submit" className="kasten kasten-red" disabled={!contactForm.name.trim()}>
                  Hinzufügen
                </button>
              </div>
            </form>
          )}

          {contacts.length === 0 && !showContactForm ? (
            <div className="text-center py-8">
              <div className="mx-auto w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-3">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Noch keine Kontakte</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Techniker, Hausmeister, Buchhaltung — alles was du beim Anrufen brauchst.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {contacts.map((c) => (
                <div
                  key={c.id}
                  className="group flex items-center gap-2.5 p-2.5 rounded-xl border border-border bg-muted/20 hover:bg-muted/40 transition-colors"
                >
                  <div className="w-8 h-8 shrink-0 rounded-full bg-foreground/[0.06] flex items-center justify-center text-xs font-semibold text-foreground/70">
                    {c.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    {c.role && <p className="text-[11px] text-muted-foreground truncate">{c.role}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      {c.phone && (
                        <a
                          href={`tel:${c.phone.replace(/\s+/g, "")}`}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                          data-tooltip={c.phone}
                        >
                          <Phone className="h-3 w-3" />
                          Anrufen
                        </a>
                      )}
                      {c.email && (
                        <a
                          href={`mailto:${c.email}`}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                          data-tooltip={c.email}
                        >
                          <Mail className="h-3 w-3" />
                          Mailen
                        </a>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleDeleteContact(c)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                      data-tooltip="Kontakt löschen"
                      aria-label="Kontakt löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Wenn keine Pinned + keine Kontakte: Onboarding-Hinweis ─── */}
      {pinnedNotes.length === 0 && contacts.length === 0 && (
        <Card className="bg-card border-dashed">
          <CardContent className="py-6">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 shrink-0 rounded-lg bg-muted flex items-center justify-center">
                <Pin className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-sm">
                <p className="font-medium">Tipp — mach den Standort schnell nutzbar</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Leg Kontakte an (oben), und im{" "}
                  <button type="button" onClick={onGoToNotesTab} className="text-foreground underline decoration-dotted underline-offset-2">
                    Notizen-Tab
                  </button>{" "}
                  eine kurze Notiz für Türschlüssel-Code, WLAN oder Besonderheiten. Wichtige Notizen kannst du <Pin className="inline h-3 w-3 mb-0.5 fill-amber-400 text-amber-500" strokeWidth={2.5} /> pinnen — dann erscheinen sie hier oben.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {ConfirmModalElement}
    </div>
  );
}
