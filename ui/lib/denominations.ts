// The notes and coins of the till count, per currency (cash_register#111).
//
// Each key is the FACE VALUE in major units («1000», «0.50», «0.005»). It is also the contract with
// the WASM handler, which multiplies it by the count and scales it with the hub currency's decimals
// on the server — so the key is the same string on both sides, whatever the currency.
//
// A local, minimal table on purpose: the currencies of the markets ERPlora sells in plus the two
// scales that are not 2 (JPY 0, KWD 3). A currency that is not here has NO breakdown — the count
// screen asks for the total instead — because showing the euro's notes in another currency is how
// the count added up wrong in the first place.
//
// Largest first (the order a drawer is counted in). A note and a coin never share a face value:
// the screen keeps one count per key, so the $1 coin and the MX$20 coin are left out next to their
// notes of the same value.

export interface DenominationTable {
  bills: string[];
  coins: string[];
}

const TABLES: Record<string, DenominationTable> = {
  EUR: {
    bills: ['500', '200', '100', '50', '20', '10', '5'],
    coins: ['2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01'],
  },
  USD: {
    bills: ['100', '50', '20', '10', '5', '2', '1'],
    coins: ['0.50', '0.25', '0.10', '0.05', '0.01'],
  },
  GBP: {
    bills: ['50', '20', '10', '5'],
    coins: ['2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01'],
  },
  CHF: {
    bills: ['1000', '200', '100', '50', '20', '10'],
    coins: ['5', '2', '1', '0.50', '0.20', '0.10', '0.05'],
  },
  PLN: {
    bills: ['500', '200', '100', '50', '20', '10'],
    coins: ['5', '2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01'],
  },
  RON: {
    bills: ['500', '200', '100', '50', '20', '10', '5', '1'],
    coins: ['0.50', '0.10', '0.05', '0.01'],
  },
  MXN: {
    bills: ['1000', '500', '200', '100', '50', '20'],
    coins: ['10', '5', '2', '1', '0.50'],
  },
  JPY: {
    bills: ['10000', '5000', '2000', '1000'],
    coins: ['500', '100', '50', '10', '5', '1'],
  },
  KWD: {
    bills: ['20', '10', '5', '1', '0.5', '0.25'],
    coins: ['0.1', '0.05', '0.02', '0.01', '0.005'],
  },
};

/** The notes and coins of `currency` (ISO-4217), or `null` when the module has no table for it. */
export function denominationsFor(currency: string | undefined | null): DenominationTable | null {
  return TABLES[String(currency ?? '').trim().toUpperCase()] ?? null;
}

/** How many of a note/coin the person typed, as the server reads it: a whole, non-negative count.
 *  Blank, «abc» or «-2» count as none (the handler never receives them). */
export function pieceCount(raw: string | number | undefined): number {
  const n = Math.trunc(Number(raw ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Total of the count in INTEGER minor units: each face value is scaled ONCE with the currency's
 *  `decimals` (0,05 € = 5, ¥1 = 1, 0.005 KWD = 5) and then everything adds up as integers — nothing
 *  accumulates in floating major units (0,05 × 3 = 0.15000000000000002). */
export function countTotalMinor(counts: Record<string, string | number>, decimals: number): number {
  let total = 0;
  for (const [face, raw] of Object.entries(counts)) {
    total += Math.round(Number(face) * 10 ** decimals) * pieceCount(raw);
  }
  return total;
}
