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
    // Honours maximumFractionDigits like the SDK does (cash_register#114).
    formatMoney: (cents: number, opts?: { maximumFractionDigits?: number }) =>
      new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: 'EUR',
        ...(opts?.maximumFractionDigits != null ? { maximumFractionDigits: opts.maximumFractionDigits } : {}),
      }).format(cents / 100),
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
  // The instant from the QA capture. 17:52 UTC — which is 19:52 in Madrid in summer, 18:52 in
  // winter, and 13:52 in New York. That is the whole point of what follows.
  const QA_INSTANT = '2026-08-21T17:52:13.198500671+00:00';

  it('a timestamp with nanoseconds and offset becomes a readable local date and time', () => {
    // 🔴 This used to assert the literal `'21/08/2026, 19:52'`, and that is a UTC+2 hardcoded into
    // a test: GREEN only in Madrid, and only in SUMMER. Red under TZ=UTC (what CI runs), red in
    // New York, and red on Ioan's own laptop from the October DST switch onwards.
    //
    // What the function actually promises is «render this instant in the reader's LOCAL time», so
    // that is what gets asserted — and through a DIFFERENT route than the one under test
    // (`Date.getHours()` vs `Intl.DateTimeFormat`), because comparing `Intl` against `Intl` would
    // only prove that the machine agrees with itself.
    const d = new Date(QA_INSTANT);
    const pad = (n: number) => String(n).padStart(2, '0');
    const out = formatDateTime(QA_INSTANT);

    expect(out, 'dd/mm/yyyy, hh:mm').toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    expect(out).toContain(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    expect(out).toContain(`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
  });

  it('renders in LOCAL time, not UTC — the guard against pinning a timeZone', () => {
    // A cashier closing the till at 00:30 has to see today's date, not yesterday's. If someone ever
    // pinned `timeZone: 'UTC'` in `formatDateTime`, the test above would still pass under TZ=UTC —
    // so this one exists to catch it wherever the runtime zone is NOT UTC.
    const d = new Date(QA_INSTANT);
    const utcHour = String(d.getUTCHours()).padStart(2, '0');
    const localHour = String(d.getHours()).padStart(2, '0');
    if (utcHour === localHour) {
      // Explicit, never a silent pass: under TZ=UTC there is nothing to tell apart.
      console.log('SKIPPED: the runtime is on UTC, so local and UTC render identically here');
      return;
    }
    expect(formatDateTime(QA_INSTANT)).toContain(`${localHour}:`);
    expect(formatDateTime(QA_INSTANT)).not.toContain(`${utcHour}:`);
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

  // cash_register#114: «500,00 €» on a note is two characters of nothing, and with thousands and a
  // currency code («1.000,00 SEK», «20,000 KWD») the label no longer fitted its box and was cut —
  // on a 390 px phone and on a 1440 px desktop alike. A drawer count reads like the drawer (Square,
  // Lightspeed: «$100», «20 KWD»): a whole face value prints without decimals.
  it('a whole face value prints without decimals: «500 €», not «500,00 €»', () => {
    expect(denominationLabel('500')).toBe(`500${NBSP}€`);
    expect(denominationLabel('2')).toBe(`2${NBSP}€`);
  });

  it('a fractional face value keeps the currency scale: «0,50 €», not «0,5 €»', () => {
    expect(denominationLabel('0.50')).toBe(`0,50${NBSP}€`);
    expect(denominationLabel('0.5')).toBe(`0,50${NBSP}€`);
  });

  describe('with the SDK formatter itself (a METHOD that reads this, honouring maximumFractionDigits)', () => {
    // The SDK's formatMoney is a class method that reads this.locale/this.currency and passes
    // maximumFractionDigits to Intl. An arrow-function double would hide a lost `this`
    // (area-modulos-sdk, cash_register#116) and a double that ignores the option would hide a
    // label that still prints its zeros.
    function sdkHub(currency: string, currencyDecimals: number) {
      (globalThis as Record<string, unknown>).erplora = {
        locale: 'es-ES',
        currency,
        currencyDecimals,
        formatMoney(this: { locale: string; currency: string; currencyDecimals: number }, minor: number, opts?: { maximumFractionDigits?: number }) {
          return new Intl.NumberFormat(this.locale, {
            style: 'currency',
            currency: this.currency,
            useGrouping: true,
            ...(opts?.maximumFractionDigits != null ? { maximumFractionDigits: opts.maximumFractionDigits } : {}),
          }).format(minor / 10 ** this.currencyDecimals);
        },
      };
    }

    it('SEK: the 1.000 note reads «1.000 SEK», the label the bench saw cut as «1.000,00…»', () => {
      sdkHub('SEK', 2);
      expect(denominationLabel('1000')).toBe(`1.000${NBSP}SEK`);
    });

    it('KWD (3 decimals): «20 KWD» on the note, «0,005 KWD» and «0,250 KWD» keep the fils', () => {
      sdkHub('KWD', 3);
      expect(denominationLabel('20')).toBe(`20${NBSP}KWD`);
      expect(denominationLabel('0.005')).toBe(`0,005${NBSP}KWD`);
      expect(denominationLabel('0.25')).toBe(`0,250${NBSP}KWD`);
    });

    it('JPY and CLP (0 decimals) are unchanged: nothing to drop', () => {
      sdkHub('CLP', 0);
      expect(denominationLabel('20000')).toBe(`20.000${NBSP}CLP`);
    });
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
