// Single source of truth for navigation icons.
// New nav items in constants.ts reference an icon by name (string);
// this map resolves that name to the lucide-react component.
//
// To add an icon: import here, add to the map. Don't define another iconMap anywhere.

import {
  AlertTriangle,
  BarChart3,
  Briefcase,
  Calendar,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Clock,
  DoorOpen,
  FileText,
  FolderOpen,
  FolderKanban,
  GraduationCap,
  Handshake,
  Inbox,
  LayoutDashboard,
  MapPin,
  Receipt,
  Send,
  Settings,
  Ticket,
  TrendingUp,
  Users,
} from "lucide-react";

export type IconComponent = React.ComponentType<{ className?: string }>;

export const NAV_ICON_MAP: Record<string, IconComponent> = {
  AlertTriangle,
  BarChart3,
  Briefcase,
  Calendar,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Clock,
  DoorOpen,
  FileText,
  FolderOpen,
  FolderKanban,
  GraduationCap,
  Handshake,
  Inbox,
  LayoutDashboard,
  MapPin,
  Receipt,
  Send,
  Settings,
  Ticket,
  TrendingUp,
  Users,
};

export function getNavIcon(name: string): IconComponent | null {
  return NAV_ICON_MAP[name] ?? null;
}
