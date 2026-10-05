export class DubizzleUnavailableError extends Error {
  constructor(reason, url, status = null) {
    const statusText = Number.isFinite(status) ? ` (HTTP ${status})` : '';
    const urlText = url ? ` at ${url}` : '';
    super(`Dubizzle ${reason}${statusText}${urlText}`);
    this.name = 'DubizzleUnavailableError';
    this.status = status;
    this.url = url;
  }
}

export function isDefinitiveDubizzleFailure(status) {
  return status === 403 || status === 429 || status >= 500;
}

export function isUsedListingConditionAllowed(condition, usedRoute) {
  const value = String(condition ?? '').trim();
  if (!value) return Boolean(usedRoute);
  if (/\bnew\b|جديد/i.test(value) || /\bnot\s+used\b|غير\s+مستعمل/i.test(value)) return false;
  return /\bused\b|مستعمل/i.test(value);
}
