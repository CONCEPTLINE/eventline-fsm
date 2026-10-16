import { describe, it, expect } from "vitest";
import { ladeAblageKontext, ladeIndexZeilenNfc } from "./kontext";

// Unicode (MASTERPLAN §3.0): der Datei-Index speichert die Bytes der Platte,
// das Rig meldet NFC. ladeIndexZeilenNfc muss beide Richtungen finden und die
// gespeicherte Schreibweise zurueckgeben.

type Admin = Parameters<typeof ladeIndexZeilenNfc>[0];

/** Minimaler Admin-Client: nur from(...).select(...).in("pfad", liste) auf
 *  ablage_datei_index, exakter Vergleich wie Postgres. */
function fakeAdmin(gespeichert: string[]): { admin: Admin } {
  const admin = {
    from(tabelle: string) {
      expect(tabelle).toBe("ablage_datei_index");
      return {
        select() {
          return {
            in(spalte: string, werte: string[]) {
              expect(spalte).toBe("pfad");
              const data = gespeichert
                .filter((p) => werte.includes(p))
                .map((p) => ({ pfad: p, name: p.slice(p.lastIndexOf("/") + 1), ordner_pfad: p.slice(0, p.lastIndexOf("/")), geaendert: null }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  };
  return { admin: admin as unknown as Admin };
}

const NFC = "00_ADMIN_RECHT/03_Dauerverträge/Mietvertrag Büro.pdf".normalize("NFC");
const NFD = NFC.normalize("NFD");

describe("ladeIndexZeilenNfc", () => {
  it("NFD im Index, NFC gesucht -> Treffer unter dem NFC-Schluessel, Pfad gespeichert (NFD)", async () => {
    const { admin } = fakeAdmin([NFD, "a/b.pdf"]);
    const index = await ladeIndexZeilenNfc(admin, [NFC, "a/b.pdf"]);
    expect(index.size).toBe(2);
    expect(index.get(NFC)?.pfad).toBe(NFD);
    expect(index.get("a/b.pdf")?.pfad).toBe("a/b.pdf");
  });

  it("NFC im Index, NFD gesucht -> Treffer unter dem NFC-Schluessel, Pfad gespeichert (NFC)", async () => {
    const { admin } = fakeAdmin([NFC]);
    const index = await ladeIndexZeilenNfc(admin, [NFD]);
    expect(index.get(NFC)?.pfad).toBe(NFC);
  });

  it("gemischt (Mac-Ordner NFD, Datei NFC) wird gefunden", async () => {
    const i = NFC.lastIndexOf("/");
    const gemischt = `${NFC.slice(0, i).normalize("NFD")}${NFC.slice(i)}`;
    const { admin } = fakeAdmin([gemischt]);
    expect((await ladeIndexZeilenNfc(admin, [NFC])).get(NFC)?.pfad).toBe(gemischt);
  });

  it("Zwillinge (NFC und NFD gespeichert): die NFC-Form gewinnt", async () => {
    const { admin } = fakeAdmin([NFD, NFC]);
    expect((await ladeIndexZeilenNfc(admin, [NFC])).get(NFC)?.pfad).toBe(NFC);
  });

  it("nicht im Index -> fehlt", async () => {
    const { admin } = fakeAdmin([]);
    expect((await ladeIndexZeilenNfc(admin, [NFC])).size).toBe(0);
  });
});

// Firmenwissen im Kontext eines ablage_analyse-Auftrags (Upload und Mail-Eingang, 16.10.2026).
describe("ladeAblageKontext mitWissen", () => {
  /** Chainable Abfrage: jede Methode gibt sich selbst zurueck, await liefert { data, error }. */
  function abfrage(ergebnis: { data: unknown; error: { message: string } | null }) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq", "in", "range"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown, nein?: (e: unknown) => unknown) => Promise.resolve(ergebnis).then(ok, nein);
    return q;
  }
  function admin(wissenFehler: boolean) {
    const tabellen: Record<string, { data: unknown; error: { message: string } | null }> = {
      ablage_ordner: { data: [{ pfad: "01_A", aktiv: true }], error: null },
      profiles: { data: [], error: null },
      ki_wissen: wissenFehler
        ? { data: null, error: { message: "relation does not exist" } }
        : { data: [{ id: "1", kategorie: "abkuerzung", begriff: "HN", erklaerung: "Halle  Nord", bezug_art: null, bezug_id: null, bezug_name: null, aktiv: true }], error: null },
    };
    return { from: (t: string) => abfrage(tabellen[t] ?? { data: [], error: null }) } as unknown as Parameters<typeof ladeAblageKontext>[0];
  }

  it("nur mit mitWissen, im Format fuers Rig; ein Lesefehler laesst es weg (kein Abbruch)", async () => {
    expect("wissen" in (await ladeAblageKontext(admin(false)))).toBe(false);
    const mit = await ladeAblageKontext(admin(false), { mitWissen: true });
    expect(mit.wissen).toEqual([{ kategorie: "abkuerzung", begriff: "HN", erklaerung: "Halle Nord", bezug: null }]);
    const fehler = await ladeAblageKontext(admin(true), { mitWissen: true });
    expect(fehler.ordner).toEqual(["01_A"]);
    expect("wissen" in fehler).toBe(false);
  });
});
