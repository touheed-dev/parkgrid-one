/**
 * Static facility facts that do NOT live in the database. Kept in config (not in a prompt string),
 * so changing a phone number never means editing AI instructions.
 * Anything that changes during the day (availability, prices, GST) is read live from the DB.
 */
export const FACILITY = {
  name: "ParkGrid One",
  address: "Bandra Kurla Complex (BKC), Mumbai - entrance from the main BKC access road (G-Block)",
  hours: "Open 24/7",
  supportPhone: "+91 20 4827 2400",
  supportEmail: "help@parkgrid.one",
  levels: { B2: "Basement 2", B1: "Basement 1", G1: "Ground", L1: "Upper deck 1", L2: "Upper deck 2" },
} as const;
