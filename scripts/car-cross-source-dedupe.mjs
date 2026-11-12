const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function latinDigits(value = '') {
  return String(value)
    .replace(/[٠-٩]/g, digit => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String(PERSIAN_DIGITS.indexOf(digit)));
}

export function parsePriceAmount(value = '') {
  const text = latinDigits(value);
  const match = text.match(/[0-9][0-9,٬.]*/);
  if (!match) return null;
  const amount = Number(match[0].replace(/[^0-9]/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

export function parseMileageKm(value = '', { assumeThousands = false } = {}) {
  const text = latinDigits(value).toLowerCase().replace(/٬/g, ',');
  const match = text.match(/(\d[\d,.\s]*)(?:\s*(k|thousand|ألف))?\s*(?:km|kms|كم|كيلومتر|كيلو)?/i);
  if (!match) return null;
  const numeric = Number(match[1].replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const hasThousandUnit = Boolean(match[2]) || /ألف/.test(text);
  const kilometers = (hasThousandUnit || (assumeThousands && numeric > 0 && numeric < 1000))
    ? numeric * 1000
    : numeric;
  return Math.round(kilometers);
}

export function normalizeLocation(value = '') {
  const text = latinDigits(value).toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const regions = [
    ['cairo', /\b(cairo|new cairo|heliopolis|nasr city|maadi|helwan|شروق|شروق|الشروق|القاهره|القاهرة|التجمع|المعادي|حلوان|مدينة نصر|مصر الجديده|مصر الجديدة)\b/i],
    ['giza', /\b(giza|6th of october|6 october|sheikh zayed|zayed|haram|faisal|dokki|الجيزه|الجيزة|اكتوبر|أكتوبر|الشيخ زايد|زايد|الهرم|فيصل|الدقي)\b/i],
    ['alexandria', /\b(alexandria|اسكندريه|اسكندرية|الإسكندرية|الاسكندرية)\b/i],
    ['qalyubia', /\b(qalyubia|banha|beni suef? el? qalyub|القليوبيه|القليوبية|بنها)\b/i],
    ['gharbia', /\b(gharbia|tanta|طنطا|الغربيه|الغربية)\b/i],
    ['monufia', /\b(monufia|menoufia|shebin el kom|شبين الكوم|المنوفيه|المنوفية)\b/i],
    ['dakahlia', /\b(dakahlia|mansoura|المنصوره|المنصورة|الدقهليه|الدقهلية)\b/i],
    ['sharqia', /\b(sharqia|zagazig|الشرقيه|الشرقية|الزقازيق)\b/i],
    ['ismailia', /\b(ismailia|الاسماعيليه|الإسماعيلية)\b/i],
    ['beheira', /\b(beheira|damanhur|دمنهور|البحيره|البحيرة)\b/i],
    ['damietta', /\b(damietta|دمياط)\b/i],
    ['suez', /\b(suez|السويس)\b/i],
    ['port-said', /\b(port said|بورسعيد)\b/i],
    ['faiyum', /\b(faiyum|fayoum|الفيوم)\b/i],
    ['asyut', /\b(asyut|اسيوط|أسيوط)\b/i],
    ['minya', /\b(minya|المنيا)\b/i],
    ['sohag', /\b(sohag|سوهاج)\b/i],
    ['qena', /\b(qena|قنا)\b/i],
    ['aswan', /\b(aswan|اسوان|أسوان)\b/i],
    ['matrouh', /\b(matrouh|مرسى مطروح|مطروح)\b/i],
    ['red-sea', /\b(red sea|hurghada|البحر الاحمر|البحر الأحمر|الغردقه|الغردقة)\b/i],
    ['north-sinai', /\b(north sinai|شمال سيناء)\b/i],
    ['south-sinai', /\b(south sinai|جنوب سيناء|شرم الشيخ)\b/i],
  ];
  for (const [region, pattern] of regions) if (pattern.test(text)) return region;
  return text.replace(/\s+/g, '-');
}

export function crossSourceFingerprint({ price, year, mileage, city }) {
  const amount = parsePriceAmount(price);
  const kilometers = typeof mileage === 'number' ? mileage : parseMileageKm(mileage);
  const modelYear = Number(latinDigits(year));
  const location = normalizeLocation(city);
  if (!amount || !Number.isInteger(modelYear) || modelYear < 1950 || modelYear > new Date().getFullYear() + 1) return '';
  if (!kilometers || !location || location === 'egypt') return '';
  return ['car-v1', modelYear, amount, kilometers, location].join('|');
}
