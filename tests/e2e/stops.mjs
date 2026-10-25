// The one stop per city the smoke tests use; scripts/record-fixtures.mjs records exactly these.
// 1011 ΠΑΝΕΠΙΣΤΗΜΙΟΥ & ΑΡΕΘΑ (lines 201, 606, 609); 404 ΠΟΛΥΚΛΙΝΙΚΗ, mid-route on Corfu lines 04, 07, 08, 11, 14.
// Not a terminus: a first stop (e.g. 801 Πλ. Σαρόκου) only ever lists scheduled departures, never a LIVE bus.
export const E2E_STOPS = { patra: '1011', corfu: '404' };
