// dataUrlZuBlob ohne fetch (CSP connect-src erlaubt kein data:) — echte PNG-Bytes bleiben unverändert.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { dataUrlZuBlob } from "./rapport-outbox";

describe("dataUrlZuBlob", () => {
  it("base64-PNG → Blob mit denselben Bytes und Typ", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
    const url = "data:image/png;base64," + Buffer.from(bytes).toString("base64");
    const blob = await dataUrlZuBlob(url);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("ruft fetch nicht auf", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await dataUrlZuBlob("data:image/png;base64,iVBORw0KGgo=");
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("wirft bei kaputtem dataURL", async () => {
    await expect(dataUrlZuBlob("kein-data-url")).rejects.toThrow(/ungültiges Bildformat/);
  });
});
