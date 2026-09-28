// The notes and coins the till count offers, per currency (cash_register#111). The count used to show
// the euro's 500…0,01 in every hub and add them up ×100: in yen there was no ¥1000 note to count and
// every ¥1 coin booked ¥100. The table is keyed by the hub currency; a currency without a table has
// no breakdown at all (the screen falls back to typing the total), never the euro's.
import { describe, expect, it } from 'vitest';
import { countTotalMinor, denominationsFor } from './denominations';

// ISO-4217 decimals of the currencies the table carries — what each face value must fit in.
const ISO_DECIMALS: Record<string, number> = {
  EUR: 2, USD: 2, GBP: 2, CHF: 2, PLN: 2, RON: 2, MXN: 2, JPY: 0, KWD: 3,
  SEK: 2, NOK: 2, DKK: 2, BRL: 2, CZK: 2, HUF: 2, COP: 2, CLP: 0, PEN: 2,
};

// The currencies a business can pick in the hub's own settings (hub apps/web SettingsPage.vue,
// `CURRENCIES`). Every one of them must be countable note by note (cash_register#113): a hub in
// Swedish kronor or Brazilian reais used to get «type the total» and add up the drawer by hand.
const HUB_SETTINGS_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL'];

describe('the denomination table follows the hub currency', () => {
  it('EUR keeps the euro drawer: 7 notes (500…5) and 8 coins (2…0,01)', () => {
    expect(denominationsFor('EUR')).toEqual({
      bills: ['500', '200', '100', '50', '20', '10', '5'],
      coins: ['2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01'],
    });
  });

  it('JPY counts yen notes and coins, with no euro cents anywhere', () => {
    const jpy = denominationsFor('JPY')!;
    expect(jpy.bills).toEqual(['10000', '5000', '2000', '1000']);
    expect(jpy.coins).toEqual(['500', '100', '50', '10', '5', '1']);
  });

  it('KWD reaches the fils: its smallest coin is 0.005', () => {
    const kwd = denominationsFor('KWD')!;
    expect(kwd.bills).toEqual(['20', '10', '5', '1', '0.5', '0.25']);
    expect(kwd.coins).toEqual(['0.1', '0.05', '0.02', '0.01', '0.005']);
  });

  it('every currency the hub settings offer has a breakdown (cash_register#113)', () => {
    for (const code of HUB_SETTINGS_CURRENCIES) {
      expect(denominationsFor(code), `${code} has no breakdown`).not.toBeNull();
    }
  });

  it('SEK counts krona notes and coins only: öre coins are gone since 2010', () => {
    expect(denominationsFor('SEK')).toEqual({
      bills: ['1000', '500', '200', '100', '50', '20'],
      coins: ['10', '5', '2', '1'],
    });
  });

  it('NOK has the 20-krone coin and no note below 50', () => {
    expect(denominationsFor('NOK')).toEqual({
      bills: ['1000', '500', '200', '100', '50'],
      coins: ['20', '10', '5', '1'],
    });
  });

  it('DKK keeps the 50-øre coin', () => {
    expect(denominationsFor('DKK')).toEqual({
      bills: ['1000', '500', '200', '100', '50'],
      coins: ['20', '10', '5', '2', '1', '0.50'],
    });
  });

  it('BRL has the R$2 note and the R$1 coin', () => {
    expect(denominationsFor('BRL')).toEqual({
      bills: ['200', '100', '50', '20', '10', '5', '2'],
      coins: ['1', '0.50', '0.25', '0.10', '0.05'],
    });
  });

  it('CZK and HUF count whole korunas and forints', () => {
    expect(denominationsFor('CZK')).toEqual({
      bills: ['5000', '2000', '1000', '500', '200', '100'],
      coins: ['50', '20', '10', '5', '2', '1'],
    });
    expect(denominationsFor('HUF')).toEqual({
      bills: ['20000', '10000', '5000', '2000', '1000', '500'],
      coins: ['200', '100', '50', '20', '10', '5'],
    });
  });

  it('COP, CLP and PEN count the pesos and soles that circulate today', () => {
    expect(denominationsFor('COP')).toEqual({
      bills: ['100000', '50000', '20000', '10000', '5000', '2000'],
      coins: ['1000', '500', '200', '100', '50'],
    });
    expect(denominationsFor('CLP')).toEqual({
      bills: ['20000', '10000', '5000', '2000', '1000'],
      coins: ['500', '100', '50', '10'],
    });
    expect(denominationsFor('PEN')).toEqual({
      bills: ['200', '100', '50', '20', '10'],
      coins: ['5', '2', '1', '0.50', '0.20', '0.10'],
    });
  });

  it('the code is matched as ISO-4217, whatever the case or spacing', () => {
    expect(denominationsFor(' jpy ')).toEqual(denominationsFor('JPY'));
  });

  it('a currency without a table has NO breakdown — never the euro one', () => {
    expect(denominationsFor('XAF')).toBeNull();
    expect(denominationsFor('')).toBeNull();
    expect(denominationsFor(undefined)).toBeNull();
  });

  it('every face value is a whole number of the currency minor unit, and no key repeats', () => {
    for (const [code, decimals] of Object.entries(ISO_DECIMALS)) {
      const table = denominationsFor(code);
      expect(table, `${code} has no table`).not.toBeNull();
      const keys = [...table!.bills, ...table!.coins];
      // One count per face value: a note and a coin of the same value would share one field.
      expect(new Set(keys).size, `${code} repeats a face value`).toBe(keys.length);
      for (const k of keys) {
        const minor = Number(k) * 10 ** decimals;
        expect(Math.abs(minor - Math.round(minor)) < 1e-9, `${code} ${k} is not whole minor units`).toBe(true);
        expect(Number(k) > 0, `${code} ${k}`).toBe(true);
      }
      // Largest first, as a drawer is counted and as every till in the market lists them.
      const values = keys.map(Number);
      expect([...table!.bills.map(Number)]).toEqual([...table!.bills.map(Number)].sort((a, b) => b - a));
      expect([...table!.coins.map(Number)]).toEqual([...table!.coins.map(Number)].sort((a, b) => b - a));
      expect(values.length).toBeGreaterThan(0);
    }
  });
});

describe('the count adds up in integer minor units with the hub scale', () => {
  it('EUR: 3 × 0,05 € is 15 cents exactly', () => {
    expect(countTotalMinor({ '0.05': '3' }, 2)).toBe(15);
  });

  it('JPY: 5 × ¥1000 + 3 × ¥1 is 5003 yen, not 500300', () => {
    expect(countTotalMinor({ '1000': '5', '1': '3' }, 0)).toBe(5003);
  });

  it('CLP has no decimals: 2 × $20.000 + 3 × $10 is 40030 pesos', () => {
    expect(countTotalMinor({ '20000': '2', '10': '3' }, 0)).toBe(40030);
  });

  it('KWD: 2 × 0.25 + 3 × 0.005 is 515 fils', () => {
    expect(countTotalMinor({ '0.25': '2', '0.005': '3' }, 3)).toBe(515);
  });

  it('blank, negative or non-numeric counts add nothing', () => {
    expect(countTotalMinor({ '10': '', '5': 'abc', '1': '-2', '2': '1' }, 2)).toBe(200);
  });

  it('a fractional count is whole pieces, as the server truncates it', () => {
    expect(countTotalMinor({ '1': '2.5' }, 2)).toBe(200);
    expect(countTotalMinor({ '1000': '1.9' }, 0)).toBe(1000);
  });
});
