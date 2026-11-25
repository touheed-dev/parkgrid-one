import React from "react";
import { cn } from "@/lib/utils";

export interface SpotlightCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  /** Accepted for backwards compatibility; the cursor-following spotlight was removed. */
  spotlightColor?: string;
  spotlightSize?: number;
  borderColor?: string;
}

/** A plain, flat card. (It used to draw a cursor-following gradient spotlight.) */
export function SpotlightCard({
  children,
  className = "",
  spotlightColor: _spotlightColor,
  spotlightSize: _spotlightSize,
  borderColor: _borderColor,
  ...props
}: SpotlightCardProps) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card p-6 shadow-sm transition-colors duration-200 hover:border-primary/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export default SpotlightCard;
