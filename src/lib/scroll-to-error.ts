// Scroll-to-error + Highlight nach failed-Submit.
//
// Pattern in langen Formularen: User klickt 'Speichern', Validation
// schlaegt fehl. Toast flasht nur kurz; das fehlerhafte Feld ist evtl.
// gar nicht im Viewport. Daher:
//   - scrollToError(fieldId)      : zum ersten Fehler scrollen + Fokus
//   - highlightFields([ids], ms)  : alle fehlenden Felder rot pulsieren
//                                   (CSS-Klasse 'field-error-pulse' in globals.css)
//   - reportFormErrors({ missing, scrollTo }) : Kombination — Toast,
//                                   Scroll, Highlight in einem Aufruf
//
// Usage in der Validierung:
//   const errors: FormError[] = [];
//   if (!form.title.trim()) errors.push({ id: "title", label: "Titel" });
//   if (errors.length) { reportFormErrors({ missing: errors }); return; }

import { toast } from "sonner";

export interface FormError {
  /** DOM-id des Feldes (oder Wrapper-Elements mit dieser id). */
  id: string;
  /** Lesbarer Name fuer die Fehler-Toast-Liste. */
  label: string;
}

export function scrollToError(fieldId?: string) {
  if (typeof window === "undefined") return;
  if (fieldId) {
    const el = document.getElementById(fieldId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        setTimeout(() => el.focus(), 300);
      }
      return;
    }
  }
  const invalid = document.querySelector('[aria-invalid="true"]');
  if (invalid) {
    invalid.scrollIntoView({ behavior: "smooth", block: "center" });
    if (invalid instanceof HTMLElement) setTimeout(() => invalid.focus?.(), 300);
  }
}

/** Markiert die uebergebenen Felder visuell als Fehler — pulsierende
 *  rote Outline via CSS-Klasse. Bleibt aktiv bis der User mit dem Feld
 *  interagiert (Klick/Focus/Eingabe) — pro Feld einzeln. */
export function highlightFields(fieldIds: string[]): void {
  if (typeof window === "undefined") return;
  for (const id of fieldIds) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLElement)) continue;
    el.classList.add("field-error-pulse");
    const cleanup = () => {
      el.classList.remove("field-error-pulse");
      el.removeEventListener("click", cleanup);
      el.removeEventListener("focusin", cleanup);
      el.removeEventListener("input", cleanup);
      el.removeEventListener("change", cleanup);
    };
    // focusin (statt focus) bubbelt — fuer Wrapper-divs mit verschachtelten
    // inputs (z.B. SearchableSelect-Container).
    el.addEventListener("click", cleanup);
    el.addEventListener("focusin", cleanup);
    el.addEventListener("input", cleanup);
    el.addEventListener("change", cleanup);
  }
}

/** All-in-one: Toast mit Liste der fehlenden Felder, Scroll zum ersten,
 *  Highlight aller fehlerhaften Felder (bis User darauf reagiert). */
export function reportFormErrors(opts: { missing: FormError[]; toastTitle?: string }) {
  const { missing, toastTitle = "Bitte ergaenze" } = opts;
  if (missing.length === 0) return;
  const labels = missing.map((m) => m.label);
  const message = labels.length === 1
    ? labels[0]
    : labels.length <= 3
      ? labels.join(", ")
      : `${labels.slice(0, 3).join(", ")} … (+${labels.length - 3} weitere)`;
  toast.error(`${toastTitle}: ${message}`, { duration: 6000 });
  scrollToError(missing[0].id);
  highlightFields(missing.map((m) => m.id));
}

