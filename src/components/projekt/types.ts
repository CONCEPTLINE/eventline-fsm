/**
 * Geteilte Types fuer /projekte/[id] und seine Tab-Sub-Components.
 * Ein einziger Ort fuer die Row-Shapes -- damit page.tsx und die Tab-Files
 * denselben Vertrag teilen.
 */

import type { PROJECT_STATUS_LABEL } from "@/lib/projekte-format";

export interface Project {
  id: string;
  project_number: number | null;
  title: string;
  description: string | null;
  status: keyof typeof PROJECT_STATUS_LABEL;
  proposed_hours: number | null;
  budget_hours: number | null;
  assigned_to: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  /** Namens-Historie (Migration 222), falls das Profil geloescht wurde. */
  approved_by_name?: string | null;
  decision_note: string | null;
  goal_text: string | null;
  goal_date: string | null;
  notes: string | null;
  completion_success: boolean | null;
  completion_note: string | null;
  parent_project_id: string | null;
  created_at: string;
  assignee?: { full_name: string | null } | null;
  approver?: { full_name: string | null } | null;
  parent?: { id: string; project_number: number | null; title: string } | null;
}

/**
 * TimeEntry — nach Migration 212 aus `time_entries WHERE project_id = <id>`.
 *
 * `entry_date` (YYYY-MM-DD, Europe/Zurich) und `minutes` liegen NICHT in der
 * DB; sie werden im Loader (`projekte/[id]/page.tsx`) aus `clock_in`/`clock_out`
 * abgeleitet, damit die Tab-Sub-Components (Overview / Zeit) das gewohnte
 * Row-Shape unveraendert weiterverwenden koennen. Offener Stempel
 * (`clock_out === null`) => `minutes === null`.
 */
export interface TimeEntry {
  id: string;
  entry_date: string;
  minutes: number | null;
  clock_in: string | null;
  clock_out: string | null;
  description: string | null;
  user_id: string;
  created_at: string;
  user?: { full_name: string | null } | null;
}

export interface AppointmentParticipant {
  id: string;
  profile_id: string | null;
  customer_id: string | null;
  name: string;
}

export interface Appointment {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  assigned_to: string | null;
  assignee?: { full_name: string | null } | null;
  participants: AppointmentParticipant[];
  notesCount: number;
}

export interface Child {
  id: string;
  project_number: number | null;
  title: string;
  status: string;
}

export interface Member {
  user_id: string;
  joined_at: string;
  full_name: string | null;
  role: string | null;
  hourly_wage_chf: number | null;
}

export interface AuditEntry {
  id: string;
  kind: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
  changer?: { full_name: string | null } | null;
}
