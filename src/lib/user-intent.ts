/**
 * Lightweight intent detection from free-text instructions (Writer / QA).
 */

export function wantsCustomerFacingNotes(userAsk: string): boolean {
  const s = userAsk.toLowerCase();
  if (/\b(list|show|include)\s+(every\s+)?ticket\s*(#|number|id)?s?\b/.test(s)) {
    return false;
  }
  return (
    /\b(no|don't|dont|do not|never)\s+.{0,48}\b(ticket|issue)\s*(#|number|id|key)s?\b/.test(
      s,
    ) ||
    /\bwithout\s+(ticket|issue)\s*(number|id|key)s?\b/.test(s) ||
    /\bomit\s+(ticket|issue)\s*(number|id|key)s?\b/.test(s) ||
    /\b(customer|end[- ]users?|non[- ]technical|plain\s+english)\b/.test(s) ||
    (/\b(understandable|layman|business)\b/.test(s) &&
      /\b(way|language|summary|audience)\b/.test(s))
  );
}

export function wantsNoTicketIdsInOutput(userAsk: string): boolean {
  const s = userAsk.toLowerCase();
  return (
    /\b(no|don't|dont|do not|never)\s+.{0,48}\b(ticket|issue)\s*(#|number|id|key)s?\b/.test(
      s,
    ) ||
    /\bwithout\s+(ticket|issue)\s*(number|id|key)s?\b/.test(s) ||
    /\bdon'?t\s+include\s+ticket/.test(s) ||
    /\bdont\s+include\s+ticket/.test(s) ||
    /\bnot\s+include\s+ticket/.test(s) ||
    /\b(dont|don't|do not|no|never)\s+.{0,60}\bticket\s+numbers?\b/.test(s)
  );
}
