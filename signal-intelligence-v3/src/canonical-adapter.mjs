export function adaptCanonicalScannerCard(input) {
  const card = input?.card ?? input;
  if (!card || typeof card !== 'object') return null;
  return { card };
}

export function adaptCanonicalScannerCards(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(adaptCanonicalScannerCard).filter(Boolean);
}
