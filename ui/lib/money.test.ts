// The money-input border of the till, shared by every screen that turns what the person types into
// the INTEGER minor units the database keeps (ADR-0007/0123): the dashboard (open, count, close,
// movements) and the opening screen the shell interposes on the POS (cash_register#106). One
// function, so the two ways of opening a till can never disagree on the scale again.
import { afterEach, describe, expect, it } from 'vitest';
import { amountStep, fromMinorUnits, toMinorUnits } from './money';

function hubCurrency(decimals: number | undefined) {
  (globalThis as Record<string, unknown>).erplora = decimals === undefined ? {} : { currencyDecimals: decimals };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).erplora;
});

describe('toMinorUnits — typed major units → minor units of the hub currency', () => {
  it('JPY (0 decimals): the minor unit IS the yen', () => {
    hubCurrency(0);
    expect(toMinorUnits('1000')).toBe(1000);
  });

  it('EUR (2 decimals): accepts the es-ES decimal comma and rounds IEEE noise', () => {
    hubCurrency(2);
    expect(toMinorUnits('150,50')).toBe(15050);
    expect(toMinorUnits('0.29')).toBe(29);
  });

  it('KWD (3 decimals): «10,5» dinars are 10500 fils', () => {
    hubCurrency(3);
    expect(toMinorUnits('10,5')).toBe(10500);
  });

  it('without an injected scale falls back to 2, and garbage is 0, never NaN', () => {
    hubCurrency(undefined);
    expect(toMinorUnits('1')).toBe(100);
    expect(toMinorUnits('abc')).toBe(0);
  });
});

describe('fromMinorUnits — the exact inverse, as the plain-dot string an ion-input takes', () => {
  it('round-trips in 0, 2 and 3 decimals', () => {
    hubCurrency(0);
    expect(fromMinorUnits(1000)).toBe('1000');
    hubCurrency(2);
    expect(fromMinorUnits(25130)).toBe('251.30');
    expect(toMinorUnits(fromMinorUnits(25130))).toBe(25130);
    hubCurrency(3);
    expect(fromMinorUnits(10500)).toBe('10.500');
  });
});

describe('amountStep — the step of a money ion-input is one minor unit', () => {
  it('1 in JPY, 0.01 in EUR, 0.001 in KWD, 0.01 without a scale', () => {
    hubCurrency(0);
    expect(amountStep()).toBe('1');
    hubCurrency(2);
    expect(amountStep()).toBe('0.01');
    hubCurrency(3);
    expect(amountStep()).toBe('0.001');
    hubCurrency(undefined);
    expect(amountStep()).toBe('0.01');
  });
});
