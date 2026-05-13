"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Plus, Clock, Check, XCircle, FileText, Search } from "lucide-react";

interface PartnerAnfrage {
  id: string;
  job_number: number | null;
  title: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
  partner_response_message: string | null;
  appointments: { id: string; assigned_to: string | null }[] | null;
}

function statusStyle(status: string) {
  switch (status) {
    case "partner_anfrage":
      return { label: "Anfrage offen", icon: Clock, bg: "bg-amber-50 dark:bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30" };
    case "offen":
    case "abgeschlossen":
      return { label: status === "offen" ? "Bestätigt" : "Abgeschlossen", icon: Check, bg: "bg-green-50 dark:bg-green-500/15", text: "text-green-800 dark:text-green-300", border: "border-green-200 dark:border-green-500/30" };
    case "storniert":
      return { label: "Abgelehnt", icon: XCircle, bg: "bg-red-50 dark:bg-red-500/15", text: "text-red-800 dark:text-red-300", border: "border-red-200 dark:border-red-500/30" };
    default:
      return { label: status, icon: Clock, bg: "bg-muted/30", text: "text-foreground/70", border: "border-border" };
  }
}

type StatusFilter = "all" | "partner_anfrage" | "offen" | "storniert" | "abgeschlossen";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "partner_anfrage", label: "Wartet" },
  { key: "offen", label: "Bestätigt" },
  { key: "abgeschlossen", label: "Abgeschlossen" },
  { key: "storniert", label: "Abgelehnt" },
];

export default function PartnerAnfragenPage() {
  const router = useRouter();
  const supabase = createClient();
  const [anfragen, setAnfragen] = useState<PartnerAnfrage[]>([]);
  const [assigneeNameById, setAssigneeNameById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  // Filter-State — Status-Wahl persistent in localStorage, Suche fluechtig.
  const [filterStatus, setFilterStatus] = useState<StatusFilter>(() =>
    typeof window !== "undefined"
      ? ((localStorage.getItem("partner-anfragen-status") as StatusFilter | null) || "all")
      : "all"
  );
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("partner-anfragen-status", filterStatus);
  }, [filterStatus]);

  // DB-Query reagiert auf filterStatus (Suche bleibt client-seitig auf den
  // geladenen Rows — Partner hat eh nur eine ueberschaubare Menge Anfragen).
  useEffect(() => {
    (async () => {
      setLoading(true);
      // RLS laesst den Partner alle Jobs an seiner Location sehen (damit
      // der Belegungsplan funktioniert). Hier filtern wir aber explizit auf
      // EIGENE Anfragen — sonst tauchen Eventline-interne Auftraege/Vermiet-
      // entwuerfe an seinem Standort in "Meine Anfragen" auf.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      let q = supabase
        .from("jobs")
        .select("id, job_number, title, start_date, end_date, status, created_at, partner_response_message, appointments:job_appointments(id, assigned_to)")
        .eq("created_by", user.id);
      if (filterStatus !== "all") {
        q = q.eq("status", filterStatus);
      }
      const [jobsRes, usersRes] = await Promise.all([
        q
          // Naechstes Event zuerst (kein start_date ans Ende — sind in der
          // Praxis Anfragen die noch kein Datum haben).
          .order("start_date", { ascending: true, nullsFirst: false })
          .limit(100),
        // SECURITY DEFINER-Funktion: liefert id/full_name aller aktiven
        // EVENTLINE-Mitarbeiter. Partner braucht das um assigned_to-UUIDs
        // in lesbare Namen aufzuloesen — direkter Profile-Join scheitert an
        // der profiles-RLS (eigenes Profil + Admin only).
        supabase.rpc("get_assignable_users"),
      ]);
      setAnfragen((jobsRes.data ?? []) as PartnerAnfrage[]);
      const map = new Map<string, string>();
      for (const u of (usersRes.data as { id: string; full_name: string }[] | null) ?? []) {
        map.set(u.id, u.full_name);
      }
      setAssigneeNameById(map);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  // Client-Filter ueber die schon geladenen Rows — Titel + INT-Nummer.
  // Bei max 100 Rows ist das instantan, kein Debounce noetig.
  const filteredAnfragen = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return anfragen;
    return anfragen.filter((a) => {
      if (a.title.toLowerCase().includes(q)) return true;
      if (a.job_number !== null && String(a.job_number).includes(q)) return true;
      return false;
    });
  }, [anfragen, searchInput]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meine Anfragen</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Erstelle Anfragen für Veranstaltungen an deinem Standort. EVENTLINE bestätigt oder lehnt ab.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/partner/anfragen/neu")}
          className="kasten kasten-red"
        >
          <Plus className="h-3.5 w-3.5" />
          Neue Anfrage
        </button>
      </div>

      {/* Filter-Bar — Suche (Titel + INT-Nr) links, Status-Buttons rechts.
          Gleiches Pattern wie /auftraege im Firmenportal. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Suchen (Titel oder INT-Nr)…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilterStatus(f.key)}
              className={filterStatus === f.key ? "kasten-active" : "kasten-toggle-off"}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse bg-card">
              <CardContent className="p-4">
                <div className="h-5 bg-foreground/10 dark:bg-foreground/15 rounded w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredAnfragen.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-foreground/10 dark:bg-foreground/15 flex items-center justify-center mb-4">
              <FileText className="h-7 w-7 text-foreground/40" />
            </div>
            <h3 className="font-semibold text-lg">
              {anfragen.length === 0 ? "Noch keine Anfragen" : "Keine Treffer"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {anfragen.length === 0
                ? "Klick auf „Neue Anfrage“ um zu starten."
                : "Versuch einen anderen Filter oder Suchbegriff."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredAnfragen.map((a) => {
            const s = statusStyle(a.status);
            const Icon = s.icon;
            // Termin-Zuweisungs-Anzeige nur fuer angenommene/laufende
            // Anfragen sinnvoll. partner_anfrage = noch nicht angenommen;
            // storniert = abgelehnt. abgeschlossen darf weiter Namen zeigen.
            const showAssignmentInfo = a.status === "offen" || a.status === "abgeschlossen";
            const appts = a.appointments ?? [];
            const hasAppt = appts.length > 0;
            const assignedIds = Array.from(new Set(appts.map((x) => x.assigned_to).filter((x): x is string => !!x)));
            const assigneeNames = assignedIds.map((id) => assigneeNameById.get(id)).filter((n): n is string => !!n);
            const isUnassigned = showAssignmentInfo && hasAppt && assigneeNames.length === 0;
            const isAssigned = showAssignmentInfo && assigneeNames.length > 0;
            const dateText = a.start_date
              ? new Date(a.start_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" })
                + (a.end_date && a.end_date !== a.start_date ? " – " + new Date(a.end_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" }) : "")
              : "";
            // Rechts-Inhalt zentral pro Karte — einmal definiert, in Mobile-
            // und Desktop-Branch identisch wiederverwendet.
            const rightSide = isUnassigned ? (
              <span className="text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">Termin nicht zugewiesen</span>
            ) : isAssigned ? (
              <span className="text-xs font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-300 truncate max-w-[180px]" title={assigneeNames.join(", ")}>
                {assigneeNames.join(", ")}
              </span>
            ) : null;
            return (
              <Link key={a.id} href={`/partner/anfragen/${a.id}`} className="block group">
                <Card className="auftrag-card-hover relative bg-card cursor-pointer">
                  {/* Mobile: 2-Zeilen-Stack analog zum Firmenportal /auftraege.
                      Zeile 1: Status-Pille | Titel.
                      Zeile 2: INT | Datum | Termin-Status. */}
                  <div className="md:hidden px-3 py-2.5 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border shrink-0 ${s.bg} ${s.text} ${s.border}`}>
                        <Icon className="h-3 w-3" />
                        {s.label}
                      </span>
                      <span className="auftrag-card-title font-medium text-sm truncate transition-colors flex-1 min-w-0">{a.title}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {a.job_number && (
                          <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded shrink-0">
                            INT-{String(a.job_number).padStart(4, "0")}
                          </span>
                        )}
                        {dateText && <span className="text-muted-foreground/70 text-[11px] whitespace-nowrap truncate">{dateText}</span>}
                      </div>
                      {rightSide && <div className="shrink-0">{rightSide}</div>}
                    </div>
                  </div>

                  {/* Desktop: Grid-Layout 1:1 analog zum Firmenportal /auftraege.
                      Spalten: Status-Pille | INT | Titel | Spacer | Datum |
                      Spacer | Rechts-Status. */}
                  <div
                    className="hidden md:grid px-4 py-2 items-center gap-x-3"
                    style={{ gridTemplateColumns: "minmax(110px, 130px) minmax(80px, 92px) minmax(140px, 260px) minmax(0, 1fr) minmax(110px, 180px) minmax(0, 1fr) minmax(120px, 200px)" }}
                  >
                    {/* Col 1: Status-Pille */}
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border w-fit ${s.bg} ${s.text} ${s.border}`}>
                      <Icon className="h-3 w-3" />
                      {s.label}
                    </span>

                    {/* Col 2: INT-Nummer (gleicher Look wie JobNumber-Komponente
                        im Firmenportal — Mono-Font, leichter Hintergrund). */}
                    {a.job_number ? (
                      <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded w-fit">
                        INT-{String(a.job_number).padStart(4, "0")}
                      </span>
                    ) : <span />}

                    {/* Col 3: Titel */}
                    <span className="auftrag-card-title font-medium text-sm truncate transition-colors min-w-0">{a.title}</span>

                    {/* Col 4: Spacer */}
                    <div />

                    {/* Col 5: Datum */}
                    <span className="text-xs text-muted-foreground whitespace-nowrap truncate">
                      {dateText || "—"}
                    </span>

                    {/* Col 6: Spacer */}
                    <div />

                    {/* Col 7: Rechts — Termin-Status */}
                    <div className="flex justify-end">
                      {rightSide}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
