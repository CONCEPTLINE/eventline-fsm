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
  Database,
  DoorOpen,
  FileEdit,
  FileText,
  FolderOpen,
  FolderKanban,
  GraduationCap,
  Handshake,
  HardDriveUpload,
  HeartHandshake,
  Inbox,
  LayoutDashboard,
  MapPin,
  Palmtree,
  Receipt,
  Send,
  Settings,
  Ticket,
  TicketCheck,
  TrendingUp,
  Users,
  Wallet,
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
  Database,
  DoorOpen,
  FileEdit,
  FileText,
  FolderOpen,
  FolderKanban,
  GraduationCap,
  Handshake,
  HardDriveUpload,
  HeartHandshake,
  Inbox,
  LayoutDashboard,
  MapPin,
  Palmtree,
  Receipt,
  Send,
  Settings,
  Ticket,
  TicketCheck,
  TrendingUp,
  Users,
  Wallet,
};

export function getNavIcon(name: string): IconComponent | null {
  return NAV_ICON_MAP[name] ?? null;
}
