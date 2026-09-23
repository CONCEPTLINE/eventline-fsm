import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Leitplanke (Skalierbarkeits-Audit 2026-09): destructive Client-Deletes
  // in Components gehen ueber die Server-Boundary (deleteRow → /api/db/delete),
  // nicht direkt via supabase.from(...).delete(). "warn" statt "error", weil
  // Bestand existiert — Neubauten sollen aber den gewollten Pfad nehmen.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            'CallExpression[callee.property.name="delete"][callee.object.callee.property.name="from"]',
          message:
            "Client-Deletes über deleteRow() aus @/lib/db-mutations führen (Audit-Log/Storage-Cleanup)",
        },
      ],
    },
  },
  // Leitplanke Datums-Disziplin (CLAUDE.md §4 / timezone-guard.test.ts):
  // toLocale* nur mit timeZone Europe/Zurich — am besten gar nicht direkt,
  // sondern ueber die format-Helper. Die Regel kann Argumente nicht pruefen,
  // deshalb "warn" auf jede Verwendung; die kanonischen Helper-Dateien sind
  // ausgenommen (dort ist die direkte Verwendung die Implementierung).
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/format.ts", "src/lib/swiss-time.ts"],
    rules: {
      "no-restricted-properties": [
        "warn",
        {
          property: "toLocaleDateString",
          message: "formatDate*-Helper aus @/lib/format nutzen (timeZone Europe/Zurich Pflicht)",
        },
        {
          property: "toLocaleTimeString",
          message: "formatDate*-Helper aus @/lib/format nutzen (timeZone Europe/Zurich Pflicht)",
        },
        {
          property: "toLocaleString",
          message: "formatDate*-Helper aus @/lib/format nutzen (timeZone Europe/Zurich Pflicht)",
        },
      ],
    },
  },
]);

export default eslintConfig;
