// The module's closed domains and its dates, as the USER reads them (cash_register#50).
//
// The Cash screens printed the raw database enum: `open`/`closed` in the STATUS column,
// `in`/`out`/`sale`/`refund` in the movement TYPE column — while the `<ion-select>` two hundred
// pixels away, for the very same field, already said «Entrada»/«Salida». Two sources for one enum,
// and the tables had the untranslated one. Dates came out worse: the movement list printed
// `2026-08-21T17:52:13.198500671+00:00`, the engine's timestamp with nine decimals of a second.
//
// This is the SAME shape `staff` landed on (staff#37, `staff/ui/lib/enums.ts`) — one catalogue per
// module, resolved through `erplora.t()` at RENDER time — so there is no third way to drift into.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COUNT_TYPE_KEY,
  MOVEMENT_TYPE_KEY,
  SESSION_STATUS_KEY,
  denominationLabel,
  enumLabel,
  enumOptions,
  formatDateTime,
} from './enums';

beforeEach(() => {
  (globalThis as Record<string, unknown>).erplora = {
    locale: 'es',
    // The real client resolves the key against the module catalogue; here the KEY comes back, so a
    // test that passes proves the label is looked up and not hardcoded.
    t: (_catalog: unknown, key: string) => key,
    formatMoney: (cents: number) =>
      new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100),
    currencyDecimals: 2,
  };
});

describe('the closed domains have ONE catalogue (cash_register#50)', () => {
  it('covers every session status the table can receive', () => {
    // The column prints what `cash_register_session.status` holds: the three of migration 001.
    expect(Object.keys(SESSION_STATUS_KEY).sort()).toEqual(['closed', 'open', 'suspended']);
    for (const value of Object.keys(SESSION_STATUS_KEY)) {
      expect(enumLabel(SESSION_STATUS_KEY, value)).toMatch(/^ui\./);
    }
  });

  it('covers the four kinds of movement, and reuses the labels the form already had', () => {
    expect(Object.keys(MOVEMENT_TYPE_KEY).sort()).toEqual(['in', 'out', 'refund', 'sale']);
    // Not a new vocabulary: these two keys are the ones the «Tipo» select was already painting.
    expect(MOVEMENT_TYPE_KEY.in).toBe('ui.movementIn');
    expect(MOVEMENT_TYPE_KEY.out).toBe('ui.movementOut');
  });

  it('covers the two kinds of count', () => {
    expect(Object.keys(COUNT_TYPE_KEY).sort()).toEqual(['closing', 'opening']);
  });

  // A hub can run a module version newer than its catalogue. The row must still be readable: an
  // operative screen that hides a movement is worse than one that shows an untranslated word.
  it('a value the catalogue does not know is printed as is, never blank', () => {
    expect(enumLabel(MOVEMENT_TYPE_KEY, 'teleport')).toBe('teleport');
    expect(enumLabel(SESSION_STATUS_KEY, null)).toBe('');
  });

  it('offers the same labels as options, so cell and picker cannot drift', () => {
    expect(enumOptions(MOVEMENT_TYPE_KEY)).toEqual([
      { value: 'in', label: 'ui.movementIn' },
      { value: 'out', label: 'ui.movementOut' },
      { value: 'sale', label: 'ui.movementSale' },
      { value: 'refund', label: 'ui.movementRefund' },
    ]);
  });
});

describe('dates are read by a person, not by the engine', () => {
  it('a timestamp with nanoseconds and offset becomes a readable local date and time', () => {
    // The exact string from the QA capture.
    expect(formatDateTime('2026-08-21T17:52:13.198500671+00:00')).toBe('21/08/2026, 19:52');
  });

  it('never leaks the ISO markers', () => {
    const out = formatDateTime('2026-08-21T17:52:13.198500671+00:00');
    expect(out).not.toContain('T');
    expect(out).not.toContain('+00:00');
  });

  it('an empty or unparseable value comes back untouched, not as `Invalid Date`', () => {
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

describe('denominations are money, so they are formatted like money', () => {
  // `Intl` separates the amount from the symbol with a NON-BREAKING space (U+00A0) in es-ES —
  // spelled out here because a plain space would make these assertions fail for the wrong reason.
  const NBSP = '\u00a0';

  it('the coin labelled 0.50 reads 0,50 € in a Spanish hub, not «0.50 €»', () => {
    // Two decimal separators in the same card — a dot in the labels, a comma in the total right
    // under them — is what the QA pass caught.
    expect(denominationLabel('0.50')).toBe(`0,50${NBSP}€`);
    expect(denominationLabel('0.05')).toBe(`0,05${NBSP}€`);
  });

  it('a note keeps its whole-euro shape', () => {
    expect(denominationLabel('500')).toBe(`500,00${NBSP}€`);
  });

  it('uses the hub currency scale, not a hardcoded x100', () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.currencyDecimals = 0;
    sdk.formatMoney = (units: number) =>
      new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(units);
    // In JPY the minor unit IS the yen: 500 major units are 500 minor units, not 50000.
    expect(denominationLabel('500')).toBe('￥500');
  });
});
