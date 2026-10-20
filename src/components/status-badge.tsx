"use client";

import type { ReactNode } from "react";
import {
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  ClockIcon,
  InfoIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

const tones: Record<StatusTone, { classes: string; Icon: typeof InfoIcon }> = {
  success: {
    classes: "border-success/30 bg-success-subtle text-success-subtle-foreground",
    Icon: CircleCheckIcon,
  },
  warning: {
    classes: "border-warning/30 bg-warning-subtle text-warning-subtle-foreground",
    Icon: ClockIcon,
  },
  destructive: {
    classes: "border-destructive/30 bg-destructive-subtle text-destructive-subtle-foreground",
    Icon: CircleXIcon,
  },
  info: {
    classes: "border-primary/30 bg-info-subtle text-info-subtle-foreground",
    Icon: InfoIcon,
  },
  neutral: {
    classes: "border-border bg-muted text-foreground",
    Icon: CircleIcon,
  },
};

type StatusBadgeProps = {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
};

/** Tone + icon + text. Colour is never the only signal. Not interactive. */
export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  const { classes, Icon } = tones[tone];
  return (
    <Badge variant="outline" className={cn("h-6 gap-1.5 px-2.5", classes, className)}>
      <Icon aria-hidden="true" data-icon="inline-start" />
      {children}
    </Badge>
  );
}
