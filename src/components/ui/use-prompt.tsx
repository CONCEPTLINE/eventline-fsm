"use client";

// Hook fuer "Bitte gebe einen Grund / Wert ein"-Dialoge — Ersatz fuer
// browser-natives prompt(). Nutzt die zentrale Modal-Komponente, sieht
// ueberall gleich aus.
//
// Verwendung:
//   const { prompt, PromptModalElement } = usePrompt();
//
//   async function markNotBillable() {
//     const reason = await prompt({
//       title: "Grund fuer 'nicht verrechnen'",
//       label: "Warum werden diese Stunden NICHT verrechnet?",
//       placeholder: "z.B. Kulanz, Eigenleistung, Fehler-Korrektur",
//       confirmLabel: "Markieren",
//       variant: "red",
//     });
//     if (reason === null) return; // Cancel
//     // ... reason ist getrimmt + non-empty
//   }
//
//   return <>{...}{PromptModalElement}</>;

import { useCallback, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";

export interface PromptOptions {
  title: string;
  /** Label oberhalb der Textarea (optional). */
  label?: string;
  /** Hilfstext unter dem Label (optional). */
  hint?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'red' (default) fuer destruktive Aktionen, 'blue' fuer Bestaetigungen. */
  variant?: "red" | "blue";
  /** Initialer Textwert (z.B. wenn man einen bestehenden Grund editieren laesst). */
  defaultValue?: string;
  /** Max-Laenge fuer Validierung + Zaehler. Default 500. */
  maxLength?: number;
}

interface State {
  open: boolean;
  options: PromptOptions;
}

export function usePrompt() {
  const [state, setState] = useState<State>({
    open: false,
    options: { title: "" },
  });
  const [value, setValue] = useState("");
  // Resolver wird gerufen sobald User bestaetigt (string) oder abbricht (null).
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const prompt = useCallback((options: PromptOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setValue(options.defaultValue ?? "");
      setState({ open: true, options });
    });
  }, []);

  const handleClose = useCallback(() => {
    setState((s) => ({ ...s, open: false }));
    resolverRef.current?.(null);
    resolverRef.current = null;
  }, []);

  const handleConfirm = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return; // Pflichtfeld
    setState((s) => ({ ...s, open: false }));
    resolverRef.current?.(trimmed);
    resolverRef.current = null;
  }, [value]);

  const variant = state.options.variant ?? "red";
  const confirmClass = variant === "red" ? "kasten kasten-red" : "kasten kasten-blue";
  const maxLength = state.options.maxLength ?? 500;
  const confirmDisabled = !value.trim() || value.length > maxLength;

  const PromptModalElement = (
    <Modal
      open={state.open}
      onClose={handleClose}
      title={state.options.title}
      size="sm"
    >
      <div className="space-y-3">
        {state.options.label && (
          <label className="text-sm font-medium">{state.options.label}</label>
        )}
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={state.options.placeholder ?? ""}
          rows={4}
          maxLength={maxLength + 50}
          autoFocus
          onKeyDown={(e) => {
            // Enter = bestaetigen (Outlook/Chat-Pattern). Shift+Enter
            // erzeugt einen Zeilenumbruch fuer mehrzeilige Eingaben.
            // (Vorher: Cmd+Enter — war fuer User nicht entdeckbar, hat
            // dazu gefuehrt dass Leute den OK-Button suchten und teils
            // einfach aufgaben.)
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleConfirm();
            }
          }}
          className="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring resize-none"
        />
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{state.options.hint ?? "Enter = bestätigen · Shift+Enter = neue Zeile"}</span>
          <span className={value.length > maxLength ? "text-red-500 font-semibold" : ""}>
            {value.length}/{maxLength}
          </span>
        </div>
      </div>
      <div className="flex gap-2 pt-3">
        <button type="button" onClick={handleClose} className="kasten kasten-muted flex-1">
          {state.options.cancelLabel ?? "Abbrechen"}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={confirmDisabled}
          className={`${confirmClass} flex-1 disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {state.options.confirmLabel ?? "Bestätigen"}
        </button>
      </div>
    </Modal>
  );

  return { prompt, PromptModalElement };
}
