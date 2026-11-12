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
  const includesAny = (...terms) => terms.some(term => text.includes(term));
  if (/\b(cairo|new cairo|heliopolis|nasr city|maadi|helwan)\b/i.test(text) ||
      includesAny('القاهره', 'القاهرة', 'التجمع', 'المعادي', 'حلوان', 'مدينة نصر', 'مصر الجديدة', 'الشروق')) return 'cairo';
  if (/\b(giza|6th of october|6 october|sheikh zayed|zayed|haram|faisal|dokki)\b/i.test(text) ||
      includesAny('الجيزه', 'الجيزة', 'اكتوبر', 'الشيخ زايد', 'زايد', 'الهرم', 'فيصل', 'الدقي')) return 'giza';
  if (/\balexandria\b/i.test(text) || includesAny('اسكندريه', 'اسكندرية', 'الإسكندرية', 'الاسكندرية')) return 'alexandria';
  if (/\b(qalyubia|banha)\b/i.test(text) || includesAny('القليوبيه', 'القليوبية', 'بنها')) return 'qalyubia';
  if (/\b(gharbia|tanta)\b/i.test(text) || includesAny('طنطا', 'الغربيه', 'الغربية')) return 'gharbia';
  if (/\b(monufia|menoufia|shebin el kom)\b/i.test(text) || includesAny('شبين الكوم', 'المنوفيه', 'المنوفية')) return 'monufia';
  if (/\b(dakahlia|mansoura)\b/i.test(text) || includesAny('المنصوره', 'المنصورة', 'الدقهليه', 'الدقهلية')) return 'dakahlia';
  if (/\b(sharqia|zagazig)\b/i.test(text) || includesAny('الشرقيه', 'الشرقية', 'الزقازيق')) return 'sharqia';
  if (/\b(ismailia)\b/i.test(text) || includesAny('الاسماعيليه', 'الإسماعيلية')) return 'ismailia';
  if (/\b(beheira|damanhur)\b/i.test(text) || includesAny('دمنهور', 'البحيره', 'البحيرة')) return 'beheira';
  if (/\bdamietta\b/i.test(text) || includesAny('دمياط')) return 'damietta';
  if (/\bsuez\b/i.test(text) || includesAny('السويس')) return 'suez';
  if (/\bport said\b/i.test(text) || includesAny('بورسعيد')) return 'port-said';
  if (/\b(faiyum|fayoum)\b/i.test(text) || includesAny('الفيوم')) return 'faiyum';
  if (/\basyut\b/i.test(text) || includesAny('اسيوط', 'أسيوط')) return 'asyut';
  if (/\bminya\b/i.test(text) || includesAny('المنيا')) return 'minya';
  if (/\bsohag\b/i.test(text) || includesAny('سوهاج')) return 'sohag';
  if (/\bqena\b/i.test(text) || includesAny('قنا')) return 'qena';
  if (/\baswan\b/i.test(text) || includesAny('اسوان', 'أسوان')) return 'aswan';
  if (/\bmatrouh\b/i.test(text) || includesAny('مرسى مطروح', 'مطروح')) return 'matrouh';
  if (/\b(red sea|hurghada)\b/i.test(text) || includesAny('البحر الاحمر', 'البحر الأحمر', 'الغردقه', 'الغردقة')) return 'red-sea';
  if (/\bnorth sinai\b/i.test(text) || includesAny('شمال سيناء')) return 'north-sinai';
  if (/\b(south sinai|sharm el sheikh)\b/i.test(text) || includesAny('جنوب سيناء', 'شرم الشيخ')) return 'south-sinai';
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
