"use client";

/**
 * /anleitung — die feste Adresse fuer App-Neuerungen + Anleitungen.
 *
 * Datenquelle: src/lib/app-updates.ts (statischer Katalog, wird bei jedem
 * Feature-Push mitgepflegt — siehe Pflege-Regel dort).
 *
 * Aufbau:
 *   - Suchfeld oben (filtert Titel + Text + Keywords, umlaut-normalisiert)
 *   - Tab "Neu":       Eintraege der letzten 7 Tage
 *   - Tab "Anleitung": ALLE Eintraege, gruppiert nach Zielgruppe
 *     (Alle / Teamleiter / Projektleiter)
 *
 * Tab-State in der URL (?tab=neu|anleitung, §10) — Reload behaelt den Tab.
 * Seite ist fuer alle eingeloggten User sichtbar (kein Permission-Gate,
 * analog /ferien) — der Katalog enthaelt bewusst keine Admin-Interna.
 */

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, BookOpen, Search, Calendar } from "lucide-react";
import { TabsNav } from "@/components/ui/tabs-nav";
import {
  APP_UPDATES,
  recentUpdates,
  audienceLabel,
  type AppUpdate,
  type UpdateAudience,
} from "@/lib/app-updates";
import { todayLocalIso } from "@/lib/swiss-time";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u")
    .replace(/ß/g, "ss");
}

function matchesQuery(u: AppUpdate, q: string): boolean {
  const tokens = normalize(q).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = normalize(
    [u.title, u.summary, ...u.anleitung, ...u.keywords, audienceLabel(u.audience)].join(" "),
  );
  return tokens.every((t) => hay.includes(t));
}

function fmtDate(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

const AUDIENCE_ORDER: UpdateAudience[] = ["alle", "teamleiter", "projektleiter"];

const AUDIENCE_BADGE: Record<UpdateAudience, string> = {
  alle: "bg-foreground/[0.07] text-muted-foreground",
  teamleiter: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  projektleiter: "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300",
};

export default function WasIstNeuPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const activeTab = urlTab === "anleitung" ? "anleitung" : "neu";
  const [q, setQ] = useState("");

  const today = todayLocalIso();
  const recent = useMemo(() => recentUpdates(today), [today]);

  const filteredRecent = useMemo(
    () => recent.filter((u) => matchesQuery(u, q)),
    [recent, q],
  );
  const filteredAll = useMemo(
    () => APP_UPDATES.filter((u) => matchesQuery(u, q)),
    [q],
  );
  // Anleitung: nach Zielgruppe gruppiert, innerhalb nach Datum desc.
  const grouped = useMemo(() => {
    return AUDIENCE_ORDER.map((aud) => ({
      audience: aud,
      items: filteredAll
        .filter((u) => u.audience === aud)
        .sort((a, b) => b.date.localeCompare(a.date)),
    })).filter((g) => g.items.length > 0);
  }, [filteredAll]);

  function selectTab(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/anleitung?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="max-w-3xl mx-auto page-enter space-y-4">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-red-500" />
          Was ist neu
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Neuerungen und Anleitungen zur EVENTLINE-App — immer aktuell.
        </p>
      </div>

      {/* Suchfeld */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card focus-within:border-foreground/40 transition-colors">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Suchen — z.B. «stempeln», «passkey», «projekt»…"
          className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60"
          aria-label="Neuerungen durchsuchen"
        />
      </div>

      <TabsNav
        tabs={[
          { key: "neu", label: "Neu", icon: <Sparkles className="h-4 w-4" />, badge: recent.length || undefined },
          { key: "anleitung", label: "Anleitung", icon: <BookOpen className="h-4 w-4" /> },
        ]}
        active={activeTab}
        onChange={selectTab}
      />

      {activeTab === "neu" ? (
        filteredRecent.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {q.trim()
              ? `Keine Treffer für «${q}» in den Neuerungen der letzten 7 Tage — probier den Anleitung-Tab.`
              : "Keine Neuerungen in den letzten 7 Tagen."}
          </p>
        ) : (
          <div className="space-y-3">
            {filteredRecent.map((u) => (
              <UpdateCard key={u.id} update={u} showAnleitung />
            ))}
          </div>
        )
      ) : grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Keine Treffer für «{q}».
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <section key={g.audience}>
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                {g.audience === "alle" ? "Für alle" : `Für ${audienceLabel(g.audience)}`}
              </h2>
              <div className="space-y-3">
                {g.items.map((u) => (
                  <UpdateCard key={u.id} update={u} showAnleitung />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function UpdateCard({ update, showAnleitung }: { update: AppUpdate; showAnleitung?: boolean }) {
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="font-semibold text-sm leading-snug">{update.title}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {update.audience !== "alle" && (
            <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded-full ${AUDIENCE_BADGE[update.audience]}`}>
              {audienceLabel(update.audience)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
            <Calendar className="h-2.5 w-2.5" />
            {fmtDate(update.date)}
          </span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{update.summary}</p>
      {showAnleitung && update.anleitung.length > 0 && (
        <ul className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2.5">
          {update.anleitung.map((step, i) => (
            <li key={i} className="text-sm leading-relaxed flex gap-2">
              <span className="text-red-500 font-bold shrink-0 select-none">·</span>
              <span>{step}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
