// The money-input border of the till, shared by every field where a person types an amount — the
// opening float (dashboard and the screen the shell interposes on the POS), the counted cash of the
// close, a cash movement and the typed total of a count — and turns it into the INTEGER minor units
// the database keeps (ADR-0007/0123). One gate, so no field can read «1.250,50» differently again.
//
// pm#521: the till read with `replace(',', '.')` + `majorToMinor`: «1.250,50» — verbatim how the
// screen prints money — opened the till with 0, and «1.250» in the counted cash closed the shift
// declaring 1,25 € instead of 1.250 €. Now it is the toolkit's `money-input`, the same reading
// every module uses, plus the one rule of the till: no amount here is negative.
import { afterEach, describe, expect, it } from 'vitest';
import { currencyDecimals, moneyFieldText, normaliseMoneyField, readMoneyField } from './money';
import esLocale from '../../locales/es.json';

function hub(currency: string | undefined, decimals: number | undefined, locale = 'es') {
  (globalThis as Record<string, unknown>).erplora = {
    ...(currency === undefined ? {} : { currency }),
    ...(decimals === undefined ? {} : { currencyDecimals: decimals }),
    locale,
    t: (_catalog: unknown, key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).erplora;
});

const minor = (typed: string) => {
  const r = readMoneyField(typed);
  return r.ok ? r.minor : r.code;
};

describe('readMoneyField — what is typed or pasted → minor units of the hub currency', () => {
  it('reads «1.250,50» exactly as the screen prints it, and every other honest spelling', () => {
    hub('EUR', 2);
    expect(minor('1.250,50')).toBe(125050);
    expect(minor('1250,5')).toBe(125050);
    expect(minor('1,250.50')).toBe(125050);
    expect(minor('12')).toBe(1200);
    expect(minor(' 150,50 ')).toBe(15050);
  });

  it('reads the thousands separators a copy from a formatted amount brings (NBSP, NNBSP)', () => {
    hub('EUR', 2);
    expect(minor('1\u00a0250,50')).toBe(125050);
    expect(minor('1\u202f250,50')).toBe(125050);
  });

  it('accepts the hub currency next to the digits — and only the hub currency', () => {
    hub('EUR', 2);
    expect(minor('1.250,50\u00a0€')).toBe(125050);
    expect(minor('EUR 12')).toBe(1200);
    expect(minor('$12')).toBe('not_an_amount');
  });

  it('accepts the currency as the screen prints it in the hub locale («US$» in a Spanish hub)', () => {
    // es prints dollars as «1.250,50 US$»; English only knows «$» — a copy from this very screen
    // must read back.
    hub('USD', 2, 'es');
    expect(minor('1.250,50 US$')).toBe(125050);
  });

  it('uses the scale of the hub currency, not a fixed ×100', () => {
    hub('JPY', 0);
    // No decimals in yen: «1.000» can only be a thousand, and a ×100 would book 100 000.
    expect(minor('1.000')).toBe(1000);
    expect(minor('1000')).toBe(1000);
    hub('KWD', 3);
    expect(minor('10,5')).toBe(10500);
  });

  it('rounds extra decimals HALF_UP instead of refusing them (the kit rule, now the till rule)', () => {
    hub('EUR', 2);
    expect(minor('12,555')).toBe('ambiguous_amount'); // three decimals after one separator: two readings
    expect(minor('1.250,505')).toBe(125051);
    expect(minor('12,5555')).toBe(1256);
    hub('JPY', 0);
    expect(minor('12,5')).toBe(13);
  });

  it('empty is empty (null), never a silent 0', () => {
    hub('EUR', 2);
    expect(minor('')).toBeNull();
    expect(minor('   ')).toBeNull();
  });

  it('garbage is not_an_amount, with the message in the till catalogue', () => {
    hub('EUR', 2);
    for (const typed of ['abc', '12\u2212', '(12)', '1.5k', '5½', '12%', '+-12']) {
      const r = readMoneyField(typed);
      expect(r.ok, `«${typed}» was read as an amount`).toBe(false);
      if (!r.ok) {
        expect(r.code, `«${typed}»`).toBe('not_an_amount');
        expect(r.message).toBe('ui.errNotAnAmount');
      }
    }
  });

  it('«1.250» is ambiguous: both readings, in the hub format, and what was typed trimmed', () => {
    hub('EUR', 2);
    const r = readMoneyField(' 1.250 ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ambiguous_amount');
      expect(r.message).toBe(
        `ui.errAmbiguousAmount ${JSON.stringify({ typed: '1.250', grouped: '1250,00', decimal: '1,25' })}`,
      );
    }
  });

  it('a negative amount is refused, never turned positive: nobody counts minus cash in a drawer', () => {
    hub('EUR', 2);
    for (const typed of ['-1.250,50', '\u22121.250,50', '-0,01']) {
      const r = readMoneyField(typed);
      expect(r.ok, `«${typed}» was accepted`).toBe(false);
      if (!r.ok) {
        expect(r.code, `«${typed}»`).toBe('negative_amount');
        expect(r.message).toBe('ui.errNegativeAmount');
      }
    }
    expect(minor('0')).toBe(0);
  });

  it('speaks through the real client, whose t() is a METHOD that reads this.locale', () => {
    // The SDK client's `t` is `catalog[this.locale]`: called detached it threw «reading 'locale'»
    // on every refusal and the screen said nothing (seen on the hub:stable bench, pm#521).
    class Client {
      currency = 'EUR';
      currencyDecimals = 2;
      locale = 'es';
      t(catalog: Record<string, unknown>, key: string): string {
        const dict = catalog[this.locale] as { ui: Record<string, string> };
        return dict.ui[key.slice('ui.'.length)];
      }
    }
    (globalThis as Record<string, unknown>).erplora = new Client();
    for (const [typed, key] of [['abc', 'errNotAnAmount'], ['-5', 'errNegativeAmount']] as const) {
      const r = readMoneyField(typed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toBe((esLocale as { ui: Record<string, string> }).ui[key]);
    }
    const ambiguous = readMoneyField('1.250');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.code).toBe('ambiguous_amount');
  });

  it('a shell that does not inject the scale falls back to 2 decimals, never NaN', () => {
    hub(undefined, undefined);
    expect(currencyDecimals()).toBe(2);
    expect(minor('0,29')).toBe(29);
  });
});

describe('normaliseMoneyField — the field when the person leaves it', () => {
  it('rewrites a readable amount in the hub format, ungrouped, with the currency decimals', () => {
    hub('EUR', 2);
    expect(normaliseMoneyField('1.250,5')).toBe('1250,50');
    expect(normaliseMoneyField('12 €')).toBe('12,00');
    hub('KWD', 3);
    expect(normaliseMoneyField('10,5')).toBe('10,500');
    hub('EUR', 2, 'en');
    expect(normaliseMoneyField('1,250.5')).toBe('1250.50');
  });

  it('leaves what it cannot read exactly as typed, so the person can fix it', () => {
    hub('EUR', 2);
    expect(normaliseMoneyField('1.250')).toBe('1.250');
    expect(normaliseMoneyField('abc')).toBe('abc');
    // Another currency is not this till's money: left as typed, never quietly relabelled as euros.
    expect(normaliseMoneyField('$12')).toBe('$12');
  });
});

describe('moneyFieldText — minor units back into a field (the close prefilled from the count)', () => {
  it('hub locale, currency decimals, NO grouping — and it reads back to the same minor units', () => {
    hub('EUR', 2);
    expect(moneyFieldText(1234550)).toBe('12345,50');
    expect(minor(moneyFieldText(1234550))).toBe(1234550);
    hub('JPY', 0);
    expect(moneyFieldText(1000)).toBe('1000');
    hub('KWD', 3);
    expect(moneyFieldText(10500)).toBe('10,500');
  });
});
