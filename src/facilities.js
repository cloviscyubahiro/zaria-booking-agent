// Zaria's facilities on Ticqet, and matching the names people type in the sheet
// ("Pitch A", "5-a-side pitch a") to the facility they mean.

// Every Zaria facility on Ticqet. The Ticqet ID is the code at the end of the
// facility's link, e.g. https://ticqet.rw/#/event/wyUcHcKLSP52EBIr9asf.
export const KNOWN_FACILITIES = [
  { name: 'Multi-Purpose Court', ticqetEventId: 'wyUcHcKLSP52EBIr9asf' },
  { name: '5-a-side Pitch A', ticqetEventId: 'MX9KuPLIoNeBGlskCFba' },
  { name: '5-a-side Pitch B', ticqetEventId: 'lfbaTFIZ2wc1rS5QjbUs' },
];

// Letters and digits only, lower case: "5-A-SIDE PITCH (A)" -> "5asidepitcha".
export const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const sameName = (a, b) => nameKey(a) === nameKey(b);

// The facility a typed name refers to: an exact match (ignoring case, spaces
// and punctuation), else the only facility whose name contains it or is
// contained in it ("Pitch A" -> "5-a-side Pitch A"). null if none or unclear.
export function resolveFacility(name, facilities) {
  const n = nameKey(name);
  if (!n) return null;
  const exact = facilities.find((f) => nameKey(f.name) === n);
  if (exact) return exact;
  const near = facilities.filter((f) => {
    const k = nameKey(f.name);
    return k.includes(n) || n.includes(k);
  });
  return near.length === 1 ? near[0] : null;
}
