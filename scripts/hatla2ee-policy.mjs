function normalizePriceAmount(value) {
  const latin = String(value ?? '').replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const digits = latin.replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

export function hasRequiredHatla2eeCardData({ price, city, mileage } = {}) {
  return Boolean(price && city && mileage);
}

export function hasConflictingPrice(displayPrice, detailText = '') {
  const displayedAmount = normalizePriceAmount(displayPrice);
  if (displayedAmount === null) return false;
  const labelPattern = /(?:\bprice\b|السعر(?:\s+المطلوب)?|المطلوب)\s*(?:(?:is|asked|asking|requested)\s+|[:：-]\s*)?([0-9٠-٩][0-9٠-٩,٬.]*)/giu;
  for (const match of detailText.matchAll(labelPattern)) {
    const claimedAmount = normalizePriceAmount(match[1]);
    if (claimedAmount !== null && claimedAmount !== displayedAmount) return true;
  }
  return false;
}
