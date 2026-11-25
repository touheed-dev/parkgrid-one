import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 border-reserved/40 bg-reserved/10 text-reserved text-[10px] font-mono px-2 py-0.5 rounded",
        className,
      )}
    >
      <Sparkles className="size-2.5 text-reserved" />
      Demo data
    </Badge>
  );
}
