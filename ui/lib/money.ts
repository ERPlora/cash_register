// The money-input border of the till: what the person types (MAJOR units) ↔ what the database keeps
// (INTEGER MINOR units, ADR-0007/0123). Shared by every money field of the module — the dashboard
// (open, close, movement, a count typed as a total) and the opening screen the shell interposes on
// the POS — so no two fields can read the same text differently (cash_register#106, pm#521).
//
// The reading itself is the toolkit's `money-input`, the one every module uses (pm#521): it
// accepts «1.250,50» — verbatim how the screen prints money —, «1250,5», «1,250.50» or «12 €»,
// leaves empty as empty and answers garbage or an ambiguous «1.250» with a code, never a 0. Extra
// decimals round HALF_UP («12,5555» € → 12,56 €). This file adds the till's own rule on top: no
// amount typed here is negative.
import { formatMoneyInput, normaliseMoneyInput, parseMoneyInput } from '@erplora/module-toolkit/money-input';
import esLocale from '../../locales/es.json';
import enLocale from '../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface HubClient {
  currency?: unknown;
  currencyDecimals?: unknown;
  locale?: unknown;
  t?: (catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>) => string;
}

function client(): HubClient {
  return (globalThis as { erplora?: HubClient }).erplora ?? {};
}

/** Decimals of the hub currency (`erplora.currencyDecimals`: 0 in JPY, 2 in EUR, 3 in KWD).
 *  A shell too old to inject the scale would give `undefined`, and `10 ** undefined` is NaN —
 *  silent corruption in an INTEGER column. Same fallback the SDK client uses: 2. */
export function currencyDecimals(): number {
  const decimals = client().currencyDecimals;
  return typeof decimals === 'number' ? decimals : 2;
}

/** The hub's ISO currency: the only one that may sit next to the digits («12 €», «EUR 12»). */
function hubCurrency(): string | undefined {
  const currency = client().currency;
  return typeof currency === 'string' && currency ? currency : undefined;
}

function hubLocale(): string | undefined {
  const locale = client().locale;
  return typeof locale === 'string' && locale ? locale : undefined;
}

function t(key: string, params?: Record<string, unknown>): string {
  // Called ON the client: the SDK's `t` is a method that reads `this.locale` (detached it throws).
  const c = client();
  return c.t ? c.t(CATALOG, key, params) : key;
}

export type MoneyFieldRead =
  /** `minor: null` — nothing was typed; each field decides what empty means. */
  | { ok: true; minor: number | null }
  | { ok: false; code: 'not_an_amount' | 'ambiguous_amount' | 'negative_amount'; message: string };

/** What the person typed or pasted → MINOR units of the hub currency, or the sentence that says
 *  why it cannot be taken. «1.250,50» → 125050 in EUR; «1.250» → both readings, so the person
 *  picks one; «-5» → refused: an opening float, a count or a movement amount is a magnitude (the
 *  movement's direction is its type), and turning it positive would be guessing the sign. */
export function readMoneyField(typed: string): MoneyFieldRead {
  const decimals = currencyDecimals();
  const locale = hubLocale();
  const read = parseMoneyInput(typed, decimals, { currency: hubCurrency(), locale });
  if (read.ok) {
    if (read.minor !== null && read.minor < 0) {
      return { ok: false, code: 'negative_amount', message: t('ui.errNegativeAmount') };
    }
    return read;
  }
  if (read.code === 'ambiguous_amount') {
    // Both readings, in the hub's format, so the person can copy back the one they meant.
    return {
      ok: false,
      code: 'ambiguous_amount',
      message: t('ui.errAmbiguousAmount', {
        typed: String(typed ?? '').trim(),
        grouped: formatMoneyInput(read.readings.grouped, decimals, locale),
        decimal: formatMoneyInput(read.readings.decimal, decimals, locale),
      }),
    };
  }
  return { ok: false, code: 'not_an_amount', message: t('ui.errNotAnAmount') };
}

/** The field once the person leaves it: the hub format when readable, exactly as typed when not. */
export function normaliseMoneyField(typed: string): string {
  return normaliseMoneyInput(String(typed ?? ''), currencyDecimals(), hubLocale(), hubCurrency());
}

/** MINOR units → the text a money field is filled with (the close prefilled from the last count,
 *  cash_register#65): hub locale, currency decimals, NO grouping — so `readMoneyField` reads it
 *  back to exactly the same minor units. */
export function moneyFieldText(minor: number): string {
  return formatMoneyInput(minor, currencyDecimals(), hubLocale());
}
