import { beforeAll, describe, expect, it } from "vitest";
import { erstelleVisualisierungLink, pruefeVisualisierungLink, LINK_GUELTIG_TAGE } from "./visualisierung-link";

const DOC = "3f2b6a1e-9c4d-4e8a-b1f0-1234567890ab";
const token = (url: string) => url.split("/ansicht/")[1];

beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-pepper-mindestens-32-zeichen-lang";
});

describe("visualisierung-link", () => {
  it("gueltiger Link liefert die Dokument-id", () => {
    const { url } = erstelleVisualisierungLink(DOC);
    expect(pruefeVisualisierungLink(token(url))).toBe(DOC);
  });

  it("abgelaufener Link wird abgelehnt", () => {
    const jetzt = Date.now();
    const { url } = erstelleVisualisierungLink(DOC, jetzt);
    const spaeter = jetzt + (LINK_GUELTIG_TAGE + 1) * 24 * 3600 * 1000;
    expect(pruefeVisualisierungLink(token(url), spaeter)).toBeNull();
  });

  it("veraenderte id, Ablaufzeit oder Signatur wird abgelehnt", () => {
    const [id, exp, sig] = token(erstelleVisualisierungLink(DOC).url).split(".");
    const fremd = "00000000-0000-4000-8000-000000000000";
    expect(pruefeVisualisierungLink(`${fremd}.${exp}.${sig}`)).toBeNull();
    expect(pruefeVisualisierungLink(`${id}.${Number(exp) + 1}.${sig}`)).toBeNull();
    expect(pruefeVisualisierungLink(`${id}.${exp}.${sig.slice(0, -1)}A`)).toBeNull();
    expect(pruefeVisualisierungLink("kaputt")).toBeNull();
  });
});
