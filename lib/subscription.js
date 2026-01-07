const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function computeIsSubscribed(businessRow) {
  if (!businessRow) return false;

  if (businessRow.is_subscribed === true) {
    return true;
  }

  const status =
    (businessRow.stripe_status || businessRow.stripe_subscription_status || '')
      .toString()
      .toLowerCase();

  if (status && ACTIVE_STATUSES.has(status)) {
    return true;
  }

  const periodEnd = parseDate(businessRow.stripe_current_period_end);
  if (periodEnd && periodEnd.getTime() > Date.now()) {
    return true;
  }

  return false;
}


