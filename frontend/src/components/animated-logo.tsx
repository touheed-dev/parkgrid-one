import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type AnimatedLogoPreset = "small" | "large" | "static";

export interface AnimatedLogoProps {
  src: string;
  alt?: string;
  size?: number | string;
  /** Accepted for backwards compatibility; the logo is no longer animated. */
  preset?: AnimatedLogoPreset;
  variant?: AnimatedLogoPreset;
  animated?: boolean;
  colorOverrides?: { outline?: string; halo?: string; strand?: string };
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
}

/** The brand mark: a plain flat image. (It used to fade/scale in with a cyan glow.) */
export function AnimatedLogo({
  src,
  alt = "ParkGrid One",
  size,
  className = "",
  imgClassName = "object-contain",
  style,
}: AnimatedLogoProps) {
  return (
    <div
      className={cn("inline-grid place-items-center", className)}
      style={{ ...style, ...(size ? { width: size, height: size } : {}) }}
    >
      <img
        src={src}
        alt={alt}
        className={cn("size-full", imgClassName)}
        loading="eager"
        decoding="async"
      />
    </div>
  );
}

export default AnimatedLogo;
