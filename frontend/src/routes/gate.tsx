import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { requireStaffGuard } from "@/lib/auth-guard";

export const Route = createFileRoute("/gate")({
  beforeLoad: async ({ location }) => {
    await requireStaffGuard(location);
  },
  head: () => ({
    meta: [
      { title: "Gate Scanner — ParkGrid One" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: lazyRouteComponent(() => import("@/components/gate/gate-page"), "GatePage"),
});
