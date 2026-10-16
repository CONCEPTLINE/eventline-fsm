import { describe, it, expect, vi, beforeEach } from "vitest";

// Sicherheits-Grenzen Bucket «documents» (Migration 308, 2026-10-12) und
// Partnerportal nur ueber Server-Routen (Migration 345/346, 2026-10-16):
//   - POST /api/upload: nur interne Konten; Portal-Konten (auch Partner) 403 —
//     Partner-Anhaenge laufen ueber /api/partner/anfragen/[id]/dokumente.
//   - POST /api/partner/anfragen/[id]/zurueckziehen: Gate requirePartnerPortal
//     + eigene Anfrage + Recht, RPC partnerportal_zurueckziehen mit dem Admin-
//     Client (im Namen des Partners), danach entfernt der Admin-Client NUR
//     partner-anfragen/<jobId>/… (plus verwaiste Uploads im Ordner)
//   - GET /api/lieferant/anfragen/[jobId]/angebot: signiert nur den eigenen
//     Lieferanten-Ordner jobs/<jobId>/lieferant-<id>/… (erst nach der Anfrage)
//
// Attrappen statt Netz: Supabase-Admin-Client (Tabellen ohne RLS, plus RPC),
// Nutzer-Client (Tabellen = was die RLS dem Konto zeigt) und requireUser.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

const STANDORT = "99999999-9999-4999-8999-999999999999";

const state = {
  userId: null as string | null,
  /** Admin-Client: sieht alles. */
  admin: {} as Record<string, Row[]>,
  /** Nutzer-Client: nur, was die RLS dem Konto zeigt. */
  nutzer: {} as Record<string, Row[]>,
  rpc: { data: null as unknown, error: null as unknown },
  /** Admin-Client: Abfrage-Fehler je Tabelle (DB-Haenger simulieren). */
  adminFehler: {} as Record<string, unknown>,
  /** Storage-Ordnerinhalt fuer list(). */
  ordner: [] as { id: string | null; name: string; created_at: string | null }[],
  calls: {
    upload: [] as string[],
    remove: [] as string[][],
    signed: [] as string[],
    list: [] as string[],
    rpc: [] as { fn: string; args: unknown }[],
    nutzerRpc: [] as { fn: string; args: unknown }[],
    nutzerTabellen: [] as string[],
  },
  removeError: null as unknown,
};

function likeZuRegex(muster: string): RegExp {
  const esc = muster.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, "s");
}

function abfrage(rows: Row[], fehler: unknown = null) {
  const filter: Filter[] = [];
  const ergebnis = () => rows.filter((r) => filter.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    eq: (k: string, v: unknown) => (filter.push((r) => r[k] === v), b),
    in: (k: string, vs: unknown[]) => (filter.push((r) => vs.includes(r[k])), b),
    like: (k: string, m: string) => (filter.push((r) => typeof r[k] === "string" && likeZuRegex(m).test(r[k] as string)), b),
    maybeSingle: () =>
      Promise.resolve(fehler ? { data: null, error: fehler } : { data: ergebnis()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: ergebnis()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: ergebnis(), error: null }).then(res, rej),
  };
  return b;
}

const storage = {
  from: () => ({
    upload: (path: string) => {
      state.calls.upload.push(path);
      return Promise.resolve({ data: { path }, error: null });
    },
    remove: (paths: string[]) => {
      state.calls.remove.push(paths);
      return Promise.resolve({ data: [], error: state.removeError });
    },
    createSignedUrl: (path: string) => {
      state.calls.signed.push(path);
      return Promise.resolve({ data: { signedUrl: `signed:${path}` }, error: null });
    },
    list: (ordner: string) => {
      state.calls.list.push(ordner);
      return Promise.resolve({ data: state.ordner, error: null });
    },
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => abfrage(state.admin[t] ?? [], state.adminFehler[t] ?? null),
    storage,
    rpc: (fn: string, args: unknown) => {
      state.calls.rpc.push({ fn, args });
      return Promise.resolve(state.rpc);
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (t: string) => {
      state.calls.nutzerTabellen.push(t);
      return abfrage(state.nutzer[t] ?? []);
    },
    rpc: (fn: string, args: unknown) => {
      state.calls.nutzerRpc.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    // Portal-Konten duerfen im Bucket nichts mehr loeschen — der Nutzer-
    // Client hat hier bewusst KEIN storage: ein Aufruf wuerde den Test sprengen.
  }),
}));

vi.mock("@/lib/api-auth", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireUser: async () =>
      state.userId
        ? { user: { id: state.userId }, effectiveUserId: state.userId, isImpersonating: false, error: null }
        : {
            user: null,
            effectiveUserId: null,
            isImpersonating: false,
            error: NextResponse.json({ success: false, error: "Nicht authentifiziert" }, { status: 401 }),
          },
  };
});

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/notification-service", () => ({ notifyTechnikAntwort: vi.fn() }));
vi.mock("@/lib/notification-recipients", () => ({ recipientsWithPermission: vi.fn(async () => []) }));

import { POST as upload } from "@/app/api/upload/route";
import { POST as zurueckziehen } from "@/app/api/partner/anfragen/[id]/zurueckziehen/route";
import { GET as angebote } from "@/app/api/lieferant/anfragen/[jobId]/angebot/route";
import type { NextRequest } from "next/server";

const JOB_EIGEN = "11111111-1111-4111-8111-111111111111";
const JOB_FREMD = "22222222-2222-4222-8222-222222222222";
/** Mit Buchstaben — fuer die Gross-/Kleinschreibungs-Faelle. */
const JOB_HEX = "abcdef12-3456-4789-8abc-def123456789";

const PARTNER_RECHTE = ["partner:anfragen:view", "partner:anfragen:edit", "partner:anfragen:delete"];

function rollen(partnerRechte: string[] = PARTNER_RECHTE): Row[] {
  return [
    { slug: "admin", is_portal: false, permissions: [] },
    { slug: "projekt-leiter", is_portal: false, permissions: [] },
    { slug: "team-leiter", is_portal: false, permissions: [] },
    { slug: "techniker", is_portal: false, permissions: [] },
    { slug: "vertrieb", is_portal: false, permissions: [] },
    { slug: "temporar", is_portal: false, permissions: [] },
    { slug: "partner", is_portal: true, permissions: partnerRechte },
    { slug: "lieferant", is_portal: true, permissions: [] },
  ];
}

function konto(id: string, role: string | null, extra: Row = {}) {
  state.userId = id;
  state.admin.profiles = role === null ? [] : [{ id, role, is_active: true, ...extra }];
}

/** Partner-Konto am STANDORT (mit Standort, wie im Portal Pflicht). */
function partnerKonto(extra: Row = {}) {
  konto("u-partner", "partner", { partner_location_id: STANDORT, full_name: "Partner Test", ...extra });
}

beforeEach(() => {
  state.userId = null;
  state.admin = {
    roles: rollen(),
    profiles: [],
    // Auftraege am Partner-Standort: eigene Anfragen (Entwurf/Anfrage) und
    // ein EVENTLINE-eigener Auftrag am selben Standort (fremd).
    jobs: [
      { id: JOB_EIGEN, location_id: STANDORT, is_deleted: false, status: "partner_anfrage", accepted_at: null, rejected_at: null, created_by: "u-partner" },
      { id: JOB_HEX, location_id: STANDORT, is_deleted: false, status: "partner_entwurf", accepted_at: null, rejected_at: null, created_by: "u-partner" },
      { id: JOB_FREMD, location_id: STANDORT, is_deleted: false, status: "offen", accepted_at: null, rejected_at: null, created_by: "u-admin" },
    ],
  };
  // RLS-Sicht eines Partners: seit Migration 346 nichts mehr direkt.
  state.nutzer = {};
  state.rpc = { data: null, error: null };
  state.adminFehler = {};
  state.removeError = null;
  state.ordner = [];
  state.calls = { upload: [], remove: [], signed: [], list: [], rpc: [], nutzerRpc: [], nutzerTabellen: [] };
});

async function hochladen(path: string, mime = "application/pdf") {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: mime }));
  fd.append("path", path);
  const req = new Request("http://localhost/api/upload", { method: "POST", body: fd });
  const res = await upload(req as unknown as NextRequest);
  return { status: res.status, json: (await res.json()) as { success: boolean; error?: string } };
}

describe("POST /api/upload — Rollen-Matrix", () => {
  const interneWege = [
    `jobs/${JOB_FREMD}/1_Offerte.pdf`,
    `projekte/${JOB_FREMD}/1_plan.pdf`,
    `raeume/${JOB_FREMD}/1_plan.pdf`,
    `standorte/${JOB_FREMD}/1_plan.pdf`,
    `rapport-photos/${JOB_FREMD}/1_0.jpg`,
    "signatures/client/1.png",
    `partner-anfragen/${JOB_FREMD}/1_anhang.pdf`,
  ];

  for (const rolle of ["admin", "techniker", "projekt-leiter"]) {
    it(`${rolle}: alle internen Ordner wie bisher`, async () => {
      for (const p of interneWege) {
        konto(`u-${rolle}`, rolle);
        const { status, json } = await hochladen(p);
        expect({ p, status, ok: json.success }).toEqual({ p, status: 200, ok: true });
      }
      expect(state.calls.upload).toEqual(interneWege);
      // Interne Konten brauchen keine Sichtbarkeits-Pruefung ueber den Nutzer-Client
      expect(state.calls.nutzerTabellen).toEqual([]);
    });
  }

  it("inaktives internes Konto bleibt intern (wie is_internal_user, offener Entscheid)", async () => {
    konto("u-tl", "team-leiter", { is_active: false });
    expect((await hochladen(`jobs/${JOB_FREMD}/1_a.pdf`)).status).toBe(200);
  });

  // Archiv = nur lesen (src/lib/archiv.ts, Migration 342): keine neuen
  // Dateien an archivierten Auftraegen/Projekten/Locations — 409 vor dem
  // Hochladen, damit keine verwaiste Datei im Storage liegen bleibt.
  it("archivierter Auftrag/Projekt/Location: 409, nichts hochgeladen", async () => {
    konto("u-admin", "admin");
    state.admin.jobs = [{ id: JOB_FREMD, status: "storniert" }];
    state.admin.projects = [{ id: JOB_FREMD, status: "abgeschlossen" }];
    state.admin.locations = [{ id: JOB_FREMD, archived_at: "2026-10-01T10:00:00Z" }];
    for (const p of [`jobs/${JOB_FREMD}/1_a.pdf`, `projekte/${JOB_FREMD}/1_a.pdf`, `standorte/${JOB_FREMD}/1_a.pdf`]) {
      const { status, json } = await hochladen(p);
      expect({ p, status, ok: json.success }).toEqual({ p, status: 409, ok: false });
    }
    expect(state.calls.upload).toEqual([]);
    // offener Auftrag am selben Pfad-Muster laeuft weiter
    state.admin.jobs = [{ id: JOB_FREMD, status: "offen" }];
    expect((await hochladen(`jobs/${JOB_FREMD}/1_b.pdf`)).status).toBe(200);
  });

  it("Partner: /api/upload ist gesperrt — auch der eigene Anfrage-Ordner (Anhaenge laufen ueber /api/partner/…/dokumente)", async () => {
    partnerKonto();
    const pfade = [
      `partner-anfragen/${JOB_EIGEN}/1_anhang.pdf`,
      `partner-anfragen/${JOB_HEX}/1_a.pdf`,
      `jobs/${JOB_EIGEN}/1_a.pdf`,
      `projekte/${JOB_EIGEN}/1_a.pdf`,
      "signatures/client/1.png",
      `partner-anfragen/${JOB_EIGEN}/sub/1_a.pdf`,
      "partner-anfragen/keine-uuid/1_a.pdf",
      `partner-anfragen/${JOB_EIGEN}/`,
    ];
    for (const p of pfade) {
      const { status } = await hochladen(p);
      expect({ p, status }).toEqual({ p, status: 403 });
    }
    expect(state.calls.upload).toEqual([]);
    // Keine Sichtbarkeits-Pruefung mehr ueber den Nutzer-Client
    expect(state.calls.nutzerTabellen).toEqual([]);
    expect(state.calls.nutzerRpc).toEqual([]);
  });

  it("Partner: Pfad mit '..' -> abgewiesen (400 schon vor der Rollen-Pruefung)", async () => {
    partnerKonto();
    const r1 = await hochladen(`partner-anfragen/${JOB_EIGEN}/../${JOB_FREMD}/x.pdf`);
    const r2 = await hochladen(`partner-anfragen/../jobs/${JOB_FREMD}/x.pdf`);
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(state.calls.upload).toEqual([]);
  });

  it("Partner inaktiv -> 403", async () => {
    partnerKonto({ is_active: false });
    expect((await hochladen(`partner-anfragen/${JOB_EIGEN}/1_a.pdf`)).status).toBe(403);
    expect(state.calls.upload).toEqual([]);
  });

  it("Lieferant: nirgends, auch nicht partner-anfragen/ -> 403", async () => {
    konto("u-lief", "lieferant", { lieferant_id: "l1" });
    for (const p of [`jobs/${JOB_EIGEN}/1_a.pdf`, `partner-anfragen/${JOB_EIGEN}/1_a.pdf`]) {
      expect((await hochladen(p)).status).toBe(403);
    }
    expect(state.calls.upload).toEqual([]);
  });

  it("Konto ohne Profil -> 403", async () => {
    konto("u-ohne", null);
    for (const p of [`jobs/${JOB_EIGEN}/1_a.pdf`, `partner-anfragen/${JOB_EIGEN}/1_a.pdf`]) {
      expect((await hochladen(p)).status).toBe(403);
    }
    expect(state.calls.upload).toEqual([]);
  });

  it("Profil-Abfrage schlaegt fehl -> 500 statt falschem Rechte-Fehler", async () => {
    konto("u-tech", "techniker");
    state.adminFehler.profiles = { message: "canceling statement due to statement timeout" };
    const { status, json } = await hochladen(`jobs/${JOB_EIGEN}/1_a.pdf`);
    expect(status).toBe(500);
    expect(json.error).toBe("Upload fehlgeschlagen — Server-Fehler");
    expect(state.calls.upload).toEqual([]);
  });

  it("Rollen-Abfrage schlaegt fehl -> 500", async () => {
    konto("u-tech", "techniker");
    state.adminFehler.roles = { message: "connection reset" };
    const { status } = await hochladen(`jobs/${JOB_EIGEN}/1_a.pdf`);
    expect(status).toBe(500);
    expect(state.calls.upload).toEqual([]);
  });

  it("Profil mit unbekannter Rolle -> 403", async () => {
    konto("u-x", "kunde");
    expect((await hochladen(`jobs/${JOB_EIGEN}/1_a.pdf`)).status).toBe(403);
  });

  it("nicht angemeldet -> 401", async () => {
    state.userId = null;
    expect((await hochladen(`jobs/${JOB_EIGEN}/1_a.pdf`)).status).toBe(401);
    expect(state.calls.upload).toEqual([]);
  });
});

async function zurueck(id: string) {
  const res = await zurueckziehen(
    new Request(`http://localhost/api/partner/anfragen/${id}/zurueckziehen`, { method: "POST" }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: (await res.json()) as { success: boolean; error?: string; warnung?: string } };
}

describe("POST /api/partner/anfragen/[id]/zurueckziehen", () => {
  const rpcAufruf = (jobId: string) => [{ fn: "partnerportal_zurueckziehen", args: { p_actor: "u-partner", p_job_id: jobId } }];

  it("eigene Anfrage: RPC im Namen des Partners, nur partner-anfragen/<jobId>/ wird entfernt", async () => {
    partnerKonto();
    state.rpc = {
      data: [{
        storage_paths: [
          `partner-anfragen/${JOB_EIGEN}/1_a.pdf`,
          `partner-anfragen/${JOB_EIGEN}/2_b.pdf`,
          `jobs/${JOB_EIGEN}/intern.pdf`,
          `partner-anfragen/${JOB_FREMD}/fremd.pdf`,
          `partner-anfragen/${JOB_EIGEN}/../../jobs/x.pdf`,
        ],
      }],
      error: null,
    };
    const { status, json } = await zurueck(JOB_EIGEN);
    expect(status).toBe(200);
    expect(json).toEqual({ success: true });
    expect(state.calls.rpc).toEqual(rpcAufruf(JOB_EIGEN));
    expect(state.calls.remove).toEqual([[`partner-anfragen/${JOB_EIGEN}/1_a.pdf`, `partner-anfragen/${JOB_EIGEN}/2_b.pdf`]]);
    // Ordner auf verwaiste Uploads geprueft (leer)
    expect(state.calls.list).toEqual([`partner-anfragen/${JOB_EIGEN}`]);
    // Nichts mehr ueber den Nutzer-Client
    expect(state.calls.nutzerRpc).toEqual([]);
  });

  it("verwaiste Uploads im Anfrage-Ordner werden mit entfernt", async () => {
    partnerKonto();
    state.rpc = { data: [{ storage_paths: [] }], error: null };
    state.ordner = [{ id: "o1", name: "9_abgebrochen.pdf", created_at: new Date().toISOString() }];
    expect((await zurueck(JOB_EIGEN)).json).toEqual({ success: true });
    expect(state.calls.remove).toEqual([[`partner-anfragen/${JOB_EIGEN}/9_abgebrochen.pdf`]]);
  });

  it("EVENTLINE-eigener Auftrag am selben Standort -> 404 ohne RPC (keine Existenz-Auskunft)", async () => {
    partnerKonto();
    const { status, json } = await zurueck(JOB_FREMD);
    expect(status).toBe(404);
    expect(json.error).toBe("Anfrage nicht gefunden");
    expect(state.calls.rpc).toEqual([]);
    expect(state.calls.remove).toEqual([]);
  });

  it("Partner ohne Recht partner:anfragen:delete -> 403 ohne RPC", async () => {
    partnerKonto();
    state.admin.roles = rollen(["partner:anfragen:view", "partner:anfragen:edit"]);
    expect((await zurueck(JOB_EIGEN)).status).toBe(403);
    expect(state.calls.rpc).toEqual([]);
  });

  it("Partner ohne Standort oder inaktiv -> 403 ohne RPC", async () => {
    partnerKonto({ partner_location_id: null });
    expect((await zurueck(JOB_EIGEN)).status).toBe(403);
    partnerKonto({ is_active: false });
    expect((await zurueck(JOB_EIGEN)).status).toBe(403);
    expect(state.calls.rpc).toEqual([]);
  });

  const rpcFaelle: [string, number, string][] = [
    ["forbidden: not your job", 403, "Kein Zugriff auf diese Anfrage"],
    ["forbidden: missing permission partner:anfragen:delete", 403, "Kein Zugriff auf diese Anfrage"],
    ["cannot withdraw job in status offen", 409, "Anfrage wurde bereits bearbeitet und kann nicht mehr zurückgezogen werden"],
    ["job not found", 404, "Anfrage nicht gefunden"],
    ["canceling statement due to statement timeout", 500, "Anfrage konnte nicht zurückgezogen werden"],
  ];
  for (const [meldung, code, text] of rpcFaelle) {
    it(`RPC-Fehler «${meldung}» -> ${code} mit Klartext, nichts geloescht`, async () => {
      partnerKonto();
      state.rpc = { data: null, error: { message: meldung } };
      const { status, json } = await zurueck(JOB_EIGEN);
      expect(status).toBe(code);
      expect(json.success).toBe(false);
      expect(json.error).toBe(text);
      expect(state.calls.remove).toEqual([]);
    });
  }

  it("Job-ID in Grossbuchstaben: RPC und Aufraeumen mit kleiner ID", async () => {
    partnerKonto();
    state.rpc = { data: [{ storage_paths: [`partner-anfragen/${JOB_HEX}/1_a.pdf`] }], error: null };
    const { status } = await zurueck(JOB_HEX.toUpperCase());
    expect(status).toBe(200);
    expect(state.calls.rpc).toEqual(rpcAufruf(JOB_HEX));
    expect(state.calls.remove).toEqual([[`partner-anfragen/${JOB_HEX}/1_a.pdf`]]);
  });

  it("ohne Anhaenge: kein Loeschen im Storage", async () => {
    partnerKonto();
    state.rpc = { data: [{ storage_paths: [] }], error: null };
    expect((await zurueck(JOB_EIGEN)).json).toEqual({ success: true });
    expect(state.calls.remove).toEqual([]);
  });

  it("Storage-Fehler beim Entfernen -> Erfolg mit Warnung", async () => {
    partnerKonto();
    state.rpc = { data: [{ storage_paths: [`partner-anfragen/${JOB_EIGEN}/1_a.pdf`] }], error: null };
    state.removeError = { message: "storage down" };
    const { status, json } = await zurueck(JOB_EIGEN);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.warnung).toMatch(/Anhänge konnten aber nicht vollständig entfernt werden/);
  });

  it("ungueltige ID -> 400 ohne RPC", async () => {
    partnerKonto();
    const { status } = await zurueck("keine-uuid");
    expect(status).toBe(400);
    expect(state.calls.rpc).toEqual([]);
  });

  it("nicht angemeldet -> 401 ohne RPC", async () => {
    state.userId = null;
    expect((await zurueck(JOB_EIGEN)).status).toBe(401);
    expect(state.calls.rpc).toEqual([]);
  });
});

async function angeboteLaden(jobId: string) {
  const res = await angebote(
    new Request(`http://localhost/api/lieferant/anfragen/${jobId}/angebot`) as unknown as NextRequest,
    { params: Promise.resolve({ jobId }) },
  );
  return { status: res.status, json: (await res.json()) as { success: boolean; angebote?: { id: string; url: string | null }[] } };
}

describe("GET /api/lieferant/anfragen/[jobId]/angebot", () => {
  // Angebote liegen im eigenen Ordner des Lieferanten (den Pfad vergibt nur
  // die Upload-Route) — Firmen-Uploads im Ordner «Angebote» bleiben intern.
  const EIGEN = `jobs/${JOB_EIGEN}/lieferant-l1/`;
  beforeEach(() => {
    konto("u-lief", "lieferant", { lieferant_id: "l1", full_name: "Herzog" });
    state.admin.lieferanten = [{ id: "l1", name: "Herzog Tech", is_active: true }];
    state.admin.jobs = [{ id: JOB_EIGEN, title: "Gala", status: "offen", job_number: 1, is_deleted: false }];
    state.admin.job_lieferanten = [{ id: "jl1", job_id: JOB_EIGEN, lieferant_id: "l1", angefragt_at: "2026-10-01T08:00:00Z", anfrage_runden: 1 }];
    state.admin.documents = [
      { id: "d1", job_id: JOB_EIGEN, folder: "Angebote", name: "A", storage_path: `${EIGEN}1_Angebot.pdf`, created_at: "2026-10-01" },
      { id: "d2", job_id: JOB_EIGEN, folder: "Angebote", name: "Rechnung", storage_path: `jobs/${JOB_FREMD}/Rechnung.pdf`, created_at: "2026-10-02" },
      { id: "d3", job_id: JOB_EIGEN, folder: "Angebote", name: "Lohn", storage_path: "lohn/x/2026/lohn.pdf", created_at: "2026-10-03" },
      { id: "d4", job_id: JOB_EIGEN, folder: "Angebote", name: "Trick", storage_path: `${EIGEN}../../${JOB_FREMD}/x.pdf`, created_at: "2026-10-04" },
      { id: "d5", job_id: JOB_EIGEN, folder: "Dokumente", name: "Intern", storage_path: `${EIGEN}intern.pdf`, created_at: "2026-10-05" },
      { id: "d6", job_id: JOB_EIGEN, folder: "Angebote", name: "Firmen-Offerte", storage_path: `jobs/${JOB_EIGEN}/1_Offerte.pdf`, created_at: "2026-10-06" },
      { id: "d7", job_id: JOB_EIGEN, folder: "Angebote", name: "Andere Firma", storage_path: `jobs/${JOB_EIGEN}/lieferant-l2/1_Angebot.pdf`, created_at: "2026-10-07" },
    ];
  });

  it("signiert nur Angebote aus dem eigenen Lieferanten-Ordner, Firmen-Uploads und fremde Pfade nie", async () => {
    const { status, json } = await angeboteLaden(JOB_EIGEN);
    expect(status).toBe(200);
    expect(json.angebote?.map((a) => a.id)).toEqual(["d1"]);
    expect(state.calls.signed).toEqual([`${EIGEN}1_Angebot.pdf`]);
  });

  it("Auftrag ohne Zuordnung zum Lieferanten -> 403, nichts signiert", async () => {
    const { status } = await angeboteLaden(JOB_FREMD);
    expect(status).toBe(403);
    expect(state.calls.signed).toEqual([]);
  });

  it("zugewiesen, aber noch nicht angefragt -> 403, nichts signiert", async () => {
    state.admin.job_lieferanten = [{ id: "jl1", job_id: JOB_EIGEN, lieferant_id: "l1", angefragt_at: null, anfrage_runden: 0 }];
    expect((await angeboteLaden(JOB_EIGEN)).status).toBe(403);
    expect(state.calls.signed).toEqual([]);
  });

  it("deaktivierte Lieferanten-Firma -> 403, nichts signiert", async () => {
    state.admin.lieferanten = [{ id: "l1", name: "Herzog Tech", is_active: false }];
    expect((await angeboteLaden(JOB_EIGEN)).status).toBe(403);
    expect(state.calls.signed).toEqual([]);
  });

  it("Partner-Konto -> 403", async () => {
    konto("u-partner", "partner");
    expect((await angeboteLaden(JOB_EIGEN)).status).toBe(403);
    expect(state.calls.signed).toEqual([]);
  });
});
