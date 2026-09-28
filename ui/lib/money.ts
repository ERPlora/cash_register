// The money-input border of the till: what the person types (MAJOR units) ↔ what the database keeps
// (INTEGER MINOR units, ADR-0007/0123). Shared by the dashboard and by the opening screen the shell
// interposes on the POS, so both ways of opening a till use the same scale (cash_register#106).
//
// The conversion itself is the module-sdk's `majorToMinor`/`minorToMajor`; this file only adds what
// the till's inputs need on top: the hub currency's scale and the es-ES decimal comma.
import { majorToMinor, minorToMajor } from '@erplora/module-sdk';

/** Decimals of the hub currency (`erplora.currencyDecimals`: 0 in JPY, 2 in EUR, 3 in KWD).
 *  A shell too old to inject the scale would give `undefined`, and `10 ** undefined` is NaN —
 *  silent corruption in an INTEGER column. Same fallback the SDK client uses: 2. */
function currencyDecimals(): number {
  const decimals = (globalThis as { erplora?: { currencyDecimals?: unknown } }).erplora?.currencyDecimals;
  return typeof decimals === 'number' ? decimals : 2;
}

/** Typed major units → MINOR units. «150,50» → 15050 in EUR, «1000» → 1000 in JPY.
 *
 *  Two things this border has to get right, and both were bugs here:
 *  - the **decimal comma** (es-ES types «150,50»): without normalising it, `Number` gives `NaN`;
 *  - the **scale**, which belongs to the hub's currency, not a fixed ×100. In JPY the minor unit IS
 *    the yen, and a ×100 here books 100 times too much. */
export function toMinorUnits(v: string | number): number {
  return majorToMinor(String(v ?? '').replace(',', '.'), currencyDecimals());
}

/** MINOR units → the string the money `ion-input` takes back (cash_register#65). The inverse of
 *  `toMinorUnits`, and it has to round-trip through it exactly: 25130 → «251.30» → 25130. A plain
 *  dot on purpose — `toMinorUnits` accepts both separators, and building a locale-formatted string
 *  here (thousands separator, currency symbol) would come back as `NaN` and close the till on 0. */
export function fromMinorUnits(minor: number): string {
  const scale = currencyDecimals();
  return minorToMajor(minor, scale).toFixed(scale);
}

/** The `step` of a money `ion-input`: one minor unit of the hub currency — «1» in JPY, «0.01» in
 *  EUR, «0.001» in KWD. A fixed «0.01» makes the browser flag a valid dinar amount as invalid. */
export function amountStep(): string {
  const scale = currencyDecimals();
  return (10 ** -scale).toFixed(scale);
}
