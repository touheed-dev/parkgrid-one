/**
 * Money is ALWAYS integer paise. These helpers reproduce the rounding of the original SQL:
 *   gst = round(base * gst_bps / 10000)   (Postgres numeric round = half away from zero)
 * For non-negative integers that equals floor((x * bps + 5000) / 10000).
 */
export function percentOfBps(amountPaise: number, bps: number): number {
  if (!Number.isInteger(amountPaise) || !Number.isInteger(bps)) {
    throw new TypeError("amount and bps must be integers");
  }
  return Math.floor((amountPaise * bps + 5000) / 10000);
}

export interface Quote {
  hours: number;
  hourly_rate_paise: number;
  base_paise: number;
  gst_paise: number;
  total_paise: number;
}

export function quoteFor(hours: number, hourlyRatePaise: number, gstBps: number): Quote {
  const base = hours * hourlyRatePaise;
  const gst = percentOfBps(base, gstBps);
  return { hours, hourly_rate_paise: hourlyRatePaise, base_paise: base, gst_paise: gst, total_paise: base + gst };
}

/** Overstay base = ceil(minutes * hourly_rate / 60) (same as end_session SQL). */
export function overstayBase(overstayMinutes: number, hourlyRatePaise: number): number {
  return Math.ceil((overstayMinutes * hourlyRatePaise) / 60);
}

export interface RefundTier {
  refund_paise: number;
  refund_percentage: number;
}

export interface RefundPolicy {
  refund_full_hours: number;
  refund_partial_minutes: number;
  partial_refund_bps: number;
}

/**
 * Cancellation refund tiers (cancellation_preview / cancel_booking SQL):
 *   >= refund_full_hours before start      -> 100 %
 *   >= refund_partial_minutes before start -> partial_refund_bps
 *   otherwise                              -> 0
 * Only PAID bookings are refunded.
 */
export function refundFor(
  totalPaise: number,
  isPaid: boolean,
  msUntilStart: number,
  policy: RefundPolicy,
): RefundTier {
  if (!isPaid) return { refund_paise: 0, refund_percentage: 0 };
  const hours = msUntilStart / 3_600_000;
  const minutes = msUntilStart / 60_000;
  if (hours >= policy.refund_full_hours) return { refund_paise: totalPaise, refund_percentage: 100 };
  if (minutes >= policy.refund_partial_minutes) {
    return {
      refund_paise: percentOfBps(totalPaise, policy.partial_refund_bps),
      refund_percentage: Math.trunc(policy.partial_refund_bps / 100),
    };
  }
  return { refund_paise: 0, refund_percentage: 0 };
}
