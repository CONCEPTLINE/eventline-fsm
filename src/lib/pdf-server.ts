// Serverseitiges pdfjs (Node-Runtime in Next-Routen): der legacy-Build
// versucht einen "fake worker" per Modul-Import zu laden, den Turbopack
// verschiebt — workerSrc muss deshalb explizit auf die echte Datei in
// node_modules zeigen (als file://-URL).

import { createRequire } from "module";
import { pathToFileURL } from "url";

export async function ladePdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const req = createRequire(process.cwd() + "/package.json");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  return pdfjs;
}
