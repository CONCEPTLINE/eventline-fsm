"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Check, ArrowRight, AlertTriangle, Mail, Phone, Calendar, Filter, Plus, Trash2, PartyPopper, Building2, Users } from "lucide-react";
import type { VertriebContact, VertriebStatus, VertriebPriority } from "@/types";
import { STATUS_OPTIONS, PRIORITY_OPTIONS, KATEGORIE_OPTIONS, STEPS, BEDARF_BEREICHE, type VertriebFormState } from "@/app/(app)/vertrieb/constants";

interface Props {
  // State
  editingId: string | null;
  editingStep: number;
  form: VertriebFormState;
  setForm: React.Dispatch<React.SetStateAction<VertriebFormState>>;
  saving: boolean;
  offertePdf: { name: string; path: string } | null;
  uploadingOfferte: boolean;
  sendingBestaetigung: boolean;
  visibleBedarf: Set<string>;
  setVisibleBedarf: React.Dispatch<React.SetStateAction<Set<string>>>;
  kundenMode: "neu" | "bestehend";
  setKundenMode: React.Dispatch<React.SetStateAction<"neu" | "bestehend">>;
  selectedCustomerId: string;
  setSelectedCustomerId: React.Dispatch<React.SetStateAction<string>>;
  customers: { id: string; name: string; email: string | null; phone: string | null }[];
  contacts: VertriebContact[];
  // Handlers
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
  onClose: () => void;
  onAdvanceStep: () => void | Promise<void>;
  onOpenLost: (id: string) => void;
  onOpenBuchhaltung: () => void;
  onOpenVerbesserung: () => void;
  onOpenTermin: (type: "kunde" | "telefon") => void;
  onDeleteTermin: (terminId: string) => void | Promise<void>;
  onUploadOfferte: (e: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  onRemoveOfferte: () => void | Promise<void>;
  onSendBestaetigung: () => void | Promise<void>;
  onOpenAuftrag: () => void;
  onSelectExistingCustomer: (customerId: string) => void;
  currentContactWithDetails: () => (VertriebContact & { details: any }) | null;
}

export function LeadForm({
  editingId,
  editingStep,
  form,
  setForm,
  saving,
  offertePdf,
  uploadingOfferte,
  sendingBestaetigung,
  visibleBedarf,
  setVisibleBedarf,
  kundenMode,
  setKundenMode,
  selectedCustomerId,
  setSelectedCustomerId,
  customers,
  contacts,
  onSubmit,
  onClose,
  onAdvanceStep,
  onOpenLost,
  onOpenBuchhaltung,
  onOpenVerbesserung,
  onOpenTermin,
  onDeleteTermin,
  onUploadOfferte,
  onRemoveOfferte,
  onSendBestaetigung,
  onOpenAuftrag,
  onSelectExistingCustomer,
  currentContactWithDetails,
}: Props) {
  return (
    <Card className="bg-card border-red-100">
      <CardContent className="p-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold">{editingId ? "Kontakt bearbeiten" : "Neuer Kontakt"}</h3>
              {(() => {
                const k = KATEGORIE_OPTIONS.find((o) => o.value === form.kategorie);
                if (!k) return null;
                const Icon = k.icon;
                return <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium rounded-full border ${k.color}`}><Icon className="h-3 w-3" />{k.label}</span>;
              })()}
            </div>
            <button type="button" onClick={onClose} className="icon-btn icon-btn-muted"><X className="h-4 w-4" /></button>
          </div>

          {/* Step-Progress nur beim Bearbeiten */}
          {editingId && form.status !== "abgesagt" && (
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
              <div className="flex items-center gap-0">
                {STEPS.map((s, i) => {
                  const done = editingStep > s.nr;
                  const active = editingStep === s.nr;
                  return (
                    <div key={s.nr} className="flex items-center flex-1">
                      <div className="flex flex-col items-center w-full relative">
                        {i > 0 && <div className={`absolute top-3 right-1/2 w-full h-0.5 -z-10 ${done ? "bg-green-400" : "bg-gray-300"}`} />}
                        <div className={`flex items-center justify-center w-7 h-7 rounded-full shrink-0 z-10 ${done ? "bg-green-500 text-white" : active ? "bg-blue-500 text-white ring-4 ring-blue-100" : "bg-gray-200 text-gray-400"}`}>
                          {done ? <Check className="h-4 w-4" /> : <span className="text-xs font-bold">{s.nr}</span>}
                        </div>
                        <p className={`text-[10px] font-semibold mt-1.5 text-center ${done ? "text-green-700" : active ? "text-blue-700" : "text-gray-400"}`}>{s.label}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2 flex-wrap pt-2 border-t border-gray-200">
                {/* Schritt 1: Kontakt aufnehmen */}
                {editingStep === 1 && (
                  <button type="button" onClick={onAdvanceStep} className="kasten kasten-blue">
                    <ArrowRight className="h-3.5 w-3.5" />Kontakt aufnehmen
                  </button>
                )}
                {/* Schritt 2-3-4 haben eigene Action-Bars im spezifischen Block */}
                {form.status !== "gewonnen" && (
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenLost(editingId)} className="text-red-600 border-red-200 hover:bg-red-50">
                    <AlertTriangle className="h-4 w-4 mr-1" />Auftrag verloren
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Gewonnen-Banner */}
          {editingId && form.status === "gewonnen" && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-green-50 border-2 border-green-200">
              <Check className="h-6 w-6 text-green-600 shrink-0" />
              <div>
                <p className="font-bold text-green-800">Gewonnen · Auftrag erstellt</p>
                {(() => {
                  const c = contacts.find((c) => c.id === editingId);
                  const jobNum = (() => { try { return JSON.parse(c?.notizen || "{}")._details?.job_number; } catch { return null; } })();
                  return jobNum && <p className="text-sm text-green-700 mt-0.5">INT-{jobNum}</p>;
                })()}
              </div>
            </div>
          )}

          {/* SCHRITT 2: Benachrichtigung Buchhaltung + Termine */}
          {editingId && editingStep === 2 && form.status !== "abgesagt" && (
            <div className="p-4 rounded-xl bg-blue-50 border-2 border-blue-200 space-y-3">
              <p className="text-sm font-semibold text-blue-800 flex items-center gap-1.5"><Mail className="h-4 w-4" />Schritt 2: Kontaktiert</p>

              <div className="flex gap-2 flex-wrap">
                <Button type="button" size="sm" onClick={() => onOpenTermin("telefon")} variant="outline" className="bg-card">
                  <Phone className="h-4 w-4 mr-1" />Telefon-Termin
                </Button>
                <Button type="button" size="sm" onClick={() => onOpenTermin("kunde")} variant="outline" className="bg-card">
                  <Calendar className="h-4 w-4 mr-1" />Kunden-Termin
                </Button>
              </div>

              {/* Erstellte Termine anzeigen */}
              {(() => {
                const c = currentContactWithDetails();
                const termine: any[] = c?.details?.termine || [];
                if (termine.length === 0) return null;
                return (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold text-blue-700 uppercase tracking-wider">Geplante Termine ({termine.length})</p>
                    {termine.map((t) => (
                      <div key={t.id} className="flex items-center gap-2 p-2 rounded-lg bg-card border border-blue-200 text-xs">
                        {t.type === "telefon" ? (
                          <Phone className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                        ) : (
                          <Users className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{t.type === "telefon" ? "Telefon-Termin" : "Kunden-Termin"}</p>
                          <p className="text-muted-foreground text-[11px]">
                            {(() => { const [y,m,d] = t.date.split("-").map(Number); return new Date(y, m-1, d, 12).toLocaleDateString("de-CH", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }); })()} · {t.time}{t.end_time ? ` – ${t.end_time}` : ""}
                          </p>
                          {t.note && <p className="text-muted-foreground text-[11px] italic mt-0.5">{t.note}</p>}
                        </div>
                        <button type="button" onClick={() => onDeleteTermin(t.id)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <div className="pt-2 border-t border-blue-200">
                <p className="text-xs text-blue-700 mb-2">Buchhaltung mit allen Verrechnungs-Infos benachrichtigen:</p>
                <div className="flex gap-2 flex-wrap">
                  <button type="button" onClick={onOpenBuchhaltung} className="kasten kasten-blue">
                    <Mail className="h-3.5 w-3.5" />Benachrichtigung senden
                  </button>
                  <Button type="button" size="sm" onClick={onAdvanceStep} variant="outline" className="text-blue-700 border-blue-300">
                    <ArrowRight className="h-4 w-4 mr-1" />Weiter zu Finalisierung
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* SCHRITT 3: Finalisierung */}
          {editingId && editingStep === 3 && form.status !== "abgesagt" && (
            <div className="p-4 rounded-xl bg-green-50 border-2 border-green-200 space-y-3">
              <p className="text-sm font-semibold text-green-800 flex items-center gap-1.5"><Filter className="h-4 w-4" />Schritt 3: Finalisierung</p>
              <div>
                <label className="text-xs font-medium">Offerte als PDF</label>
                {offertePdf ? (
                  <div className="mt-1.5 flex items-center justify-between p-2 rounded-lg bg-card border border-green-200">
                    <span className="text-sm truncate">{offertePdf.name}</span>
                    <button type="button" onClick={onRemoveOfferte} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <label className="mt-1.5 flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed border-green-300 bg-card text-sm text-green-700 cursor-pointer hover:border-green-500 transition-colors">
                    <Plus className="h-4 w-4" />{uploadingOfferte ? "Hochladen..." : "Offerte PDF hochladen"}
                    <input type="file" accept=".pdf" onChange={onUploadOfferte} className="hidden" disabled={uploadingOfferte} />
                  </label>
                )}
              </div>
              <div className="flex gap-2 flex-wrap pt-2 border-t border-green-200">
                <Button type="button" size="sm" onClick={onOpenVerbesserung} variant="outline" className="text-green-700 border-green-300 hover:bg-green-100">
                  <Mail className="h-4 w-4 mr-1" />Verbesserungs-Nachricht
                </Button>
                <button type="button" onClick={onSendBestaetigung} disabled={sendingBestaetigung} className="kasten kasten-green">
                  <Check className="h-3.5 w-3.5" />{sendingBestaetigung ? "Senden..." : "Offerte bestätigt"}
                </button>
                <button type="button" onClick={onAdvanceStep} className="kasten kasten-blue">
                  <ArrowRight className="h-3.5 w-3.5" />Weiter zu Operations
                </button>
              </div>
            </div>
          )}

          {/* SCHRITT 4: Operations — Auftrag erstellen */}
          {editingId && editingStep === 4 && form.status !== "abgesagt" && (
            <div className="p-4 rounded-xl bg-green-50 border-2 border-green-200 space-y-3">
              <p className="text-sm font-semibold text-green-800 flex items-center gap-1.5"><Check className="h-4 w-4" />Schritt 4: Operations</p>
              {(() => {
                const c = currentContactWithDetails();
                const jobNum = c?.details?.job_number;
                const jobId = c?.details?.job_id;
                if (jobNum && jobId) {
                  return (
                    <div className="p-3 rounded-lg bg-card border border-green-200 flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Auftrag erstellt</p>
                        <p className="font-semibold text-sm"><span className="font-mono text-green-700">INT-{jobNum}</span></p>
                      </div>
                      <a href={`/auftraege/${jobId}`} className="text-sm text-blue-600 hover:underline font-medium">Auftrag öffnen → Schichtplan</a>
                    </div>
                  );
                }
                return (
                  <>
                    <p className="text-xs text-green-700">Erstelle aus diesem Lead einen Auftrag. Leo wird automatisch benachrichtigt. Danach kannst du den Schichtplan machen.</p>
                    <div className="flex gap-2 flex-wrap">
                      <button type="button" onClick={onOpenAuftrag} className="kasten kasten-green">
                        <Plus className="h-3.5 w-3.5" />Auftrag erstellen
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* Verloren-Banner */}
          {editingId && form.status === "abgesagt" && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 border-2 border-red-200">
              <AlertTriangle className="h-6 w-6 text-red-600 shrink-0" />
              <div>
                <p className="font-bold text-red-800">Auftrag verloren</p>
                {(() => {
                  const c = contacts.find((c) => c.id === editingId);
                  return c?.verloren_grund && <p className="text-sm text-red-700 mt-0.5">Grund: {c.verloren_grund}</p>;
                })()}
              </div>
            </div>
          )}

          {/* Kunden-Auswahl: Neu oder Bestehend */}
          {!editingId && (
            <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setKundenMode("neu"); setSelectedCustomerId(""); setForm((f) => ({ ...f, firma: "", email: "", telefon: "", create_customer: true })); }}
                  className={kundenMode === "neu" ? "kasten kasten-red flex-1" : "kasten-toggle-off flex-1"}
                >
                  + Neuer Kunde
                </button>
                <button
                  type="button"
                  onClick={() => { setKundenMode("bestehend"); setForm((f) => ({ ...f, create_customer: false })); }}
                  className={kundenMode === "bestehend" ? "kasten kasten-red flex-1" : "kasten-toggle-off flex-1"}
                >
                  Bestandskunde auswählen
                </button>
              </div>
              {kundenMode === "bestehend" && (
                <div>
                  <label className="text-xs font-medium">Kunde auswählen *</label>
                  <select value={selectedCustomerId} onChange={(e) => onSelectExistingCustomer(e.target.value)} className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-gray-200 bg-card" required>
                    <option value="">— Kunde wählen —</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {selectedCustomerId && (() => {
                    const c = customers.find((x) => x.id === selectedCustomerId);
                    if (!c) return null;
                    return (
                      <div className="mt-2 p-2 rounded-lg bg-card border border-gray-100 text-xs space-y-0.5">
                        <p className="font-semibold">{c.name}</p>
                        {c.email && <p className="text-muted-foreground">{c.email}</p>}
                        {c.phone && <p className="text-muted-foreground">{c.phone}</p>}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs font-medium">Firma *</label>
              <Input value={form.firma} onChange={(e) => setForm({ ...form, firma: e.target.value })} required className="mt-1 bg-gray-50" disabled={kundenMode === "bestehend" && !!selectedCustomerId} />
            </div>
            <div>
              <label className="text-xs font-medium">Branche</label>
              <Input value={form.branche} onChange={(e) => setForm({ ...form, branche: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">Ansprechperson</label>
              <Input value={form.ansprechperson} onChange={(e) => setForm({ ...form, ansprechperson: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">Position</label>
              <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">E-Mail</label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">Telefon</label>
              <Input value={form.telefon} onChange={(e) => setForm({ ...form, telefon: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-medium">Event-Typ</label>
              <Input value={form.event_typ} onChange={(e) => setForm({ ...form, event_typ: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">Datum Kontakt</label>
              <Input type="date" value={form.datum_kontakt} onChange={(e) => setForm({ ...form, datum_kontakt: e.target.value })} className="mt-1 bg-gray-50" />
            </div>
            <div>
              <label className="text-xs font-medium">Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as VertriebStatus })} className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-gray-200 bg-gray-50">
                {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium">Priorität</label>
              <select value={form.prioritaet} onChange={(e) => setForm({ ...form, prioritaet: e.target.value as VertriebPriority })} className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-gray-200 bg-gray-50">
                {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>

          {/* Veranstaltungs-Datum (nur bei Veranstaltungen, nicht bei Verwaltung) */}
          {form.kategorie === "veranstaltung" && (
          <div className="p-4 rounded-xl bg-purple-50/50 border border-purple-200 dark:bg-purple-950/30 space-y-3">
            <p className="text-xs font-semibold text-purple-700 uppercase tracking-wider flex items-center gap-1.5"><PartyPopper className="h-3.5 w-3.5" />Veranstaltungs-Datum</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">Anfang</label>
                <Input type="date" value={form.event_start} onChange={(e) => setForm({ ...form, event_start: e.target.value })} className="mt-1 bg-card" />
              </div>
              <div>
                <label className="text-xs font-medium">Ende</label>
                <Input type="date" value={form.event_end} onChange={(e) => setForm({ ...form, event_end: e.target.value })} className="mt-1 bg-card" />
              </div>
            </div>
          </div>
          )}

          {/* Kategorienspezifische Felder */}
          {form.kategorie === "verwaltung" ? (
            <div className="space-y-3 p-4 rounded-xl bg-blue-50/50 border border-blue-200 dark:bg-blue-950/30">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />Verwaltungs-Details</p>
              <div>
                <label className="text-xs font-medium">Gegebene Infrastruktur</label>
                <textarea value={form.infrastruktur} onChange={(e) => setForm({ ...form, infrastruktur: e.target.value })} placeholder="Was ist vor Ort vorhanden? Saal, Technik, Parkplätze..." className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-card resize-none focus:outline-none focus:ring-2 focus:ring-red-500/20" rows={2} style={{ fieldSizing: "content" } as React.CSSProperties} />
              </div>
              <div>
                <label className="text-xs font-medium">Ort</label>
                <Input value={form.ort} onChange={(e) => setForm({ ...form, ort: e.target.value })} placeholder="Adresse oder Bezeichnung" className="mt-1 bg-card" />
              </div>
              <div>
                <label className="text-xs font-medium">Zielgruppe</label>
                <Input value={form.zielgruppe} onChange={(e) => setForm({ ...form, zielgruppe: e.target.value })} placeholder="Wer wird erreicht?" className="mt-1 bg-card" />
              </div>
              <div>
                <label className="text-xs font-medium">Programm</label>
                <textarea value={form.programm} onChange={(e) => setForm({ ...form, programm: e.target.value })} placeholder="Geplantes Programm / Ablauf..." className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-card resize-none focus:outline-none focus:ring-2 focus:ring-red-500/20" rows={2} style={{ fieldSizing: "content" } as React.CSSProperties} />
              </div>
              <div>
                <label className="text-xs font-medium">Bedarf vor Ort</label>
                <textarea value={form.bedarf_vor_ort} onChange={(e) => setForm({ ...form, bedarf_vor_ort: e.target.value })} placeholder="Was muss zusätzlich beschafft/organisiert werden?" className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-card resize-none focus:outline-none focus:ring-2 focus:ring-red-500/20" rows={2} style={{ fieldSizing: "content" } as React.CSSProperties} />
              </div>
            </div>
          ) : (
            <div className="space-y-3 p-4 rounded-xl bg-purple-50/50 border border-purple-200 dark:bg-purple-950/30">
              <p className="text-xs font-semibold text-purple-700 uppercase tracking-wider flex items-center gap-1.5"><PartyPopper className="h-3.5 w-3.5" />Bedarf (Bereiche auswählen)</p>
              {BEDARF_BEREICHE.map((b) => {
                const hasText = !!form.bedarf[b.key]?.trim();
                const isOpen = visibleBedarf.has(b.key) || hasText;
                return (
                  <div key={b.key}>
                    <button
                      type="button"
                      onClick={() => {
                        const next = new Set(visibleBedarf);
                        if (isOpen) next.delete(b.key); else next.add(b.key);
                        setVisibleBedarf(next);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isOpen ? "bg-purple-600 text-white" : hasText ? "bg-purple-100 text-purple-800 border border-purple-300" : "bg-card text-gray-700 border border-gray-200 hover:border-purple-300"}`}
                    >
                      <span className="flex items-center gap-2">
                        {b.label}
                        {hasText && !isOpen && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-200 text-purple-800">gespeichert</span>}
                      </span>
                      <span className="text-xs">{isOpen ? "−" : "+"}</span>
                    </button>
                    {isOpen && (
                      <textarea
                        value={form.bedarf[b.key] || ""}
                        onChange={(e) => setForm({ ...form, bedarf: { ...form.bedarf, [b.key]: e.target.value } })}
                        placeholder={`Details zu ${b.label}...`}
                        className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-card resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                        rows={2}
                        style={{ fieldSizing: "content" } as React.CSSProperties}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Kontakt als Kunde speichern */}
          {!editingId && form.firma && kundenMode === "neu" && (
            <label className="flex items-center gap-2 p-3 rounded-lg border border-gray-200 bg-gray-50 cursor-pointer hover:border-red-300">
              <input type="checkbox" checked={form.create_customer} onChange={(e) => setForm({ ...form, create_customer: e.target.checked })} className="h-4 w-4" />
              <span className="text-sm">Kontakt zusätzlich als Kunden anlegen ({form.firma})</span>
            </label>
          )}

          <div>
            <label className="text-xs font-medium">Notizen {form.kategorie === "verwaltung" && <span className="text-muted-foreground font-normal">— Beschreibe die Situation detailliert</span>}</label>
            <textarea
              value={form.notizen}
              onChange={(e) => setForm({ ...form, notizen: e.target.value })}
              placeholder={form.kategorie === "verwaltung" ? "Wie ist die aktuelle Situation? Was sind die Herausforderungen, Hintergründe, wichtige Infos..." : "Notizen..."}
              className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 resize-y focus:outline-none focus:ring-2 focus:ring-red-500/20"
              rows={form.kategorie === "verwaltung" ? 8 : 3}
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="kasten kasten-muted">Abbrechen</button>
            <button type="submit" disabled={!form.firma || saving} className="kasten kasten-red">{saving ? "Speichern..." : editingId ? "Änderungen speichern" : "Kontakt hinzufügen"}</button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
