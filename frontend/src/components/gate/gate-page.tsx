import { useCallback, useEffect, useRef, useState } from "react";
import { Scanner, type IDetectedBarcode } from "@yudiel/react-qr-scanner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CameraOff,
  CheckCircle2,
  LogIn,
  LogOut,
  ScanLine,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listRecentScans, scanPass, type RecentScan, type ScanOutcome } from "@/lib/api/gate";
import { formatIstTime, formatPaise } from "@/lib/date-utils";
import { cn } from "@/lib/utils";

type Direction = "entry" | "exit";

const RECENT_KEY = ["gate", "recent"] as const;
/** Ignore the same QR for this long: a camera sees the same code many times per second. */
const DUPLICATE_WINDOW_MS = 3500;

const REASON_LABEL: Record<string, string> = {
  ok: "Access granted",
  already_entered: "Already inside",
  already_exited: "Already exited",
  invalid_token: "Invalid QR code",
  cancelled: "Booking cancelled",
  expired: "Pass expired",
  too_early: "Too early",
  already_used: "Pass already used",
  not_entered: "No entry recorded",
  no_session: "No parking session",
};

function ResultCard({ outcome }: { outcome: ScanOutcome | null }) {
  if (!outcome) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 border border-dashed border-border bg-surface p-6 text-center text-muted-foreground">
        <ScanLine className="size-8" aria-hidden="true" />
        <p className="text-sm">
          Point the camera at a ParkGrid pass QR code, or type the code below.
        </p>
      </div>
    );
  }
  const good = outcome.ok;
  const Icon = good ? CheckCircle2 : outcome.result === "too_early" ? AlertTriangle : XCircle;
  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-2 border-2 p-6 text-center",
        good
          ? "border-available bg-available/15 text-available"
          : "border-destructive bg-destructive/15 text-destructive",
      )}
    >
      <Icon className="size-12" aria-hidden="true" />
      <p className="font-display text-2xl font-bold uppercase tracking-wide">
        {outcome.direction === "entry" ? "Entry" : "Exit"} · {good ? "OK" : "DENIED"}
      </p>
      <p className="text-base font-semibold">{REASON_LABEL[outcome.result] ?? outcome.result}</p>
      <p className="max-w-sm text-sm opacity-90">{outcome.message}</p>
      {outcome.booking && (
        <dl className="mt-2 grid grid-cols-3 gap-x-6 gap-y-1 font-mono text-xs text-foreground/90">
          <div>
            <dt className="opacity-60">Plate</dt>
            <dd className="text-sm font-semibold">{outcome.booking.plate}</dd>
          </div>
          <div>
            <dt className="opacity-60">Bay</dt>
            <dd className="text-sm font-semibold">{outcome.booking.slot}</dd>
          </div>
          <div>
            <dt className="opacity-60">Ref</dt>
            <dd className="text-sm font-semibold">{outcome.booking.reference}</dd>
          </div>
        </dl>
      )}
      {outcome.overstay && outcome.overstay.minutes > 0 && (
        <p className="mt-1 rounded border border-reserved/50 bg-reserved/10 px-3 py-1 text-sm text-reserved">
          Overstay {outcome.overstay.minutes} min · {formatPaise(outcome.overstay.total_paise)} (
          {outcome.overstay.status === "due" ? "collect at gate" : "settled"})
        </p>
      )}
    </div>
  );
}

function RecentList({ scans }: { scans: RecentScan[] }) {
  if (scans.length === 0) return <p className="text-xs text-muted-foreground">No scans yet.</p>;
  return (
    <ul className="divide-y divide-border border border-border bg-surface">
      {scans.slice(0, 10).map((s) => {
        const ok =
          s.result === "ok" || s.result === "already_entered" || s.result === "already_exited";
        return (
          <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <span className="flex items-center gap-2">
              {s.direction === "entry" ? (
                <LogIn className="size-3.5" aria-hidden="true" />
              ) : (
                <LogOut className="size-3.5" aria-hidden="true" />
              )}
              <span className="font-mono">{s.plate ?? s.reference ?? "—"}</span>
            </span>
            <span className={cn("font-medium", ok ? "text-available" : "text-destructive")}>
              {REASON_LABEL[s.result] ?? s.result}
            </span>
            <span className="font-mono text-muted-foreground">{formatIstTime(s.created_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function GatePage() {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>("entry");
  const [manual, setManual] = useState("");
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastScan = useRef<{ code: string; at: number } | null>(null);

  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => listRecentScans(),
    refetchInterval: 15_000,
  });

  const scan = useMutation({
    mutationFn: (token: string) => scanPass({ data: { token, direction } }),
    onSuccess: (res) => {
      setOutcome(res);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
    },
    onError: (err: unknown) => {
      setOutcome(null);
      setError(err instanceof Error ? err.message : "Scan failed. Please try again.");
    },
  });

  const submit = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const now = Date.now();
      if (
        lastScan.current &&
        lastScan.current.code === code &&
        now - lastScan.current.at < DUPLICATE_WINDOW_MS
      )
        return;
      lastScan.current = { code, at: now };
      scan.mutate(code);
    },
    [scan],
  );

  // Clear the old result when switching direction so staff never act on a stale card.
  useEffect(() => {
    setOutcome(null);
    setError(null);
  }, [direction]);

  const onScan = (codes: IDetectedBarcode[]) => {
    const value = codes[0]?.rawValue;
    if (value) submit(value);
  };

  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-4 py-6 sm:py-10">
      <header className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-primary">
          Staff · Gate control
        </p>
        <h1 className="font-display text-3xl font-bold">Gate scanner</h1>
      </header>

      <div role="group" aria-label="Scan direction" className="grid grid-cols-2 gap-2">
        {(["entry", "exit"] as const).map((d) => (
          <Button
            key={d}
            type="button"
            size="lg"
            variant={direction === d ? "default" : "outline"}
            aria-pressed={direction === d}
            onClick={() => setDirection(d)}
            className="h-14 text-base uppercase tracking-wide"
          >
            {d === "entry" ? (
              <LogIn className="mr-2 size-5" aria-hidden="true" />
            ) : (
              <LogOut className="mr-2 size-5" aria-hidden="true" />
            )}
            {d}
          </Button>
        ))}
      </div>

      <div className="overflow-hidden border border-border bg-black">
        {cameraError ? (
          <div className="flex aspect-square flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <CameraOff className="size-8" aria-hidden="true" />
            <p>{cameraError}</p>
            <p className="text-xs">Use the manual entry field below instead.</p>
          </div>
        ) : (
          <Scanner
            onScan={onScan}
            onError={(e) =>
              setCameraError(
                /permission|denied|notallowed/i.test(String(e?.message ?? e))
                  ? "Camera access was denied. Allow camera permission in your browser settings."
                  : "The camera could not be started on this device.",
              )
            }
            constraints={{ facingMode: "environment" }}
            formats={["qr_code"]}
            paused={scan.isPending}
            scanDelay={600}
            sound={false}
          />
        )}
      </div>

      <ResultCard outcome={outcome} />
      {error && (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(manual);
          setManual("");
        }}
      >
        <label htmlFor="manual-code" className="sr-only">
          Pass code
        </label>
        <Input
          id="manual-code"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="PG1:… (manual entry)"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="font-mono"
        />
        <Button type="submit" disabled={!manual.trim() || scan.isPending}>
          Check
        </Button>
      </form>

      <section aria-labelledby="recent-scans" className="space-y-2">
        <h2
          id="recent-scans"
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
        >
          Last 10 scans
        </h2>
        <RecentList scans={recent.data?.scans ?? []} />
      </section>
    </main>
  );
}
