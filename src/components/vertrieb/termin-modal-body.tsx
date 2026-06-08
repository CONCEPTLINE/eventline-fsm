"use client";

import { Input } from "@/components/ui/input";

interface Props {
  terminType: "kunde" | "telefon";
  terminForm: { date: string; time: string; end_time: string; note: string };
  setTerminForm: (f: Props["terminForm"]) => void;
  onSave: () => void | Promise<void>;
  onClose: () => void;
  saving: boolean;
}

export function TerminModalBody({ terminForm, setTerminForm, onSave, onClose, saving }: Props) {
  return (
    <>
      <div>
        <label className="text-sm font-medium">Datum *</label>
        <Input type="date" value={terminForm.date} onChange={(e) => setTerminForm({ ...terminForm, date: e.target.value })} className="mt-1.5 bg-gray-50" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium">Von *</label>
          <Input type="time" value={terminForm.time} onChange={(e) => setTerminForm({ ...terminForm, time: e.target.value })} className="mt-1.5 bg-gray-50" />
        </div>
        <div>
          <label className="text-sm font-medium">Bis *</label>
          <Input type="time" value={terminForm.end_time} onChange={(e) => setTerminForm({ ...terminForm, end_time: e.target.value })} className="mt-1.5 bg-gray-50" />
        </div>
      </div>
      <div>
        <label className="text-sm font-medium">Notiz (optional)</label>
        <textarea value={terminForm.note} onChange={(e) => setTerminForm({ ...terminForm, note: e.target.value })} placeholder="Worum geht es?" className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 resize-none" rows={2} />
      </div>
      <div className="flex gap-3">
        <button onClick={onClose} className="kasten kasten-muted flex-1">Abbrechen</button>
        <button onClick={onSave} disabled={saving} className="kasten kasten-red flex-1">
          {saving ? "Speichern…" : "Termin erstellen"}
        </button>
      </div>
    </>
  );
}
