// The module's closed domains and its dates, as the USER reads them (cash_register#50).
//
// The Cash screens printed the raw database enum — `open`/`closed` in the STATUS column,
// `in`/`out`/`sale`/`refund` in the movement TYPE column — while the `<ion-select>` two hundred
// pixels away, for the very same field, already said «Entrada»/«Salida». Two sources for one enum,
// and the tables had the untranslated one. So the catalogue of every closed domain of this module
// lives HERE, and both the cell and the picker read from it: there is nowhere else to drift to.
//
// Same shape `staff` landed on (staff#37, `staff/ui/lib/enums.ts`) and the same i18n plumbing
// `customers` uses (`locales/*.json`) — deliberately NOT a third way.
//
// The keys are the module's public values (its schemas and its SQL); the labels are i18n keys
// resolved at RENDER time through `erplora.t()` (ADR-0055), never at module load: when this file is
// imported the shell has not published the client yet, and the user can change language later.
import esLocale from '../../locales/es.json';
import enLocale from '../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface Translator {
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  formatMoney(minor: number, opts?: { currency?: string; locale?: string }): string;
  currencyDecimals: number;
}

function erplora(): Translator {
  const c = (globalThis as { erplora?: Translator }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** `cash_register_session.status` — the three values migration 001 allows. */
export const SESSION_STATUS_KEY: Record<string, string> = {
  open: 'ui.statusOpen',
  closed: 'ui.statusClosed',
  suspended: 'ui.statusSuspended',
};

/** `cash_register_movement.movement_type` — the enum of `schemas/add_movement.json`. `in`/`out`
 *  reuse the labels the movement form's «Tipo» select was already painting. */
export const MOVEMENT_TYPE_KEY: Record<string, string> = {
  in: 'ui.movementIn',
  out: 'ui.movementOut',
  sale: 'ui.movementSale',
  refund: 'ui.movementRefund',
};

/** `cash_register_count.count_type` — the enum of `schemas/add_count.json`. */
export const COUNT_TYPE_KEY: Record<string, string> = {
  opening: 'ui.countOpening',
  closing: 'ui.countClosing',
};

/**
 * The FACTORY vocabulary of `cash_register_movement.payment_method`, keyed in lower case.
 *
 * Unlike the three maps above this column is NOT a closed domain: it carries two different things
 * on purpose, and both reach the movements table.
 *  - A manual movement stores the canonical keyword the `movement.add` handler normalises to
 *    (`cash`|`card`|`transfer`|`other`, hub#778 — the enum of `schemas/add_movement.json`).
 *  - A sale stores the payment method NAME the event came with (`_movement_for_open_session.sql`),
 *    which the `sales` factory seed sows in canonical English — `Cash`/`Card`, ADR-0055 — and which
 *    the owner is free to rename to «BBVA TPV».
 *
 * Both factory forms differ only in case, so one lower-cased map covers the pair.
 */
const PAYMENT_METHOD_KEY: Record<string, string> = {
  cash: 'ui.methodCash',
  card: 'ui.methodCard',
  transfer: 'ui.methodTransfer',
  other: 'ui.methodOther',
};

/**
 * The payment method of a movement as the PERSON reads it (cash_register#66).
 *
 * A factory value is translated; anything else is printed verbatim, because it is the text the
 * owner typed and no catalogue outranks it. Deliberately NOT resolved through the sibling column
 * `payment_method_type`: a method renamed «BBVA TPV» carries `type = 'card'` and would be painted
 * «Tarjeta», losing the very name that tells the manager which terminal took the money. The TYPE
 * decides money — it is what the five reconciliation reads sum by — and the NAME decides text.
 */
export function paymentMethodLabel(value: unknown): string {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return '';
  const key = PAYMENT_METHOD_KEY[raw.toLowerCase()];
  return key ? erplora().t(CATALOG, key) : raw;
}

/**
 * The label of `value` in the active language.
 *
 * A value the catalogue does not know is printed AS IS: a hub running a module version newer than
 * its catalogue must still show the row, not a blank cell — a till screen that hides a movement is
 * worse than one that shows an untranslated word.
 */
export function enumLabel(keys: Record<string, string>, value: unknown): string {
  const raw = value == null ? '' : String(value);
  const key = keys[raw];
  return key ? erplora().t(CATALOG, key) : raw;
}

/** The options of a closed domain, for an `<ion-select>` or a column filter — the same labels the
 *  cell prints, by construction. */
export function enumOptions(keys: Record<string, string>): { value: string; label: string }[] {
  return Object.keys(keys).map((value) => ({ value, label: enumLabel(keys, value) }));
}

/**
 * An instant in the hub's locale: `21/08/2026, 19:52`, the same shape `sales` already prints in its
 * own list. The engine hands over `2026-08-21T17:52:13.198500671+00:00` — nine decimals of a second
 * and a UTC offset — which is a value, not a piece of information.
 *
 * Formatted in the BROWSER's zone on purpose (unlike `staff.formatDate`, which handles calendar
 * days): a cash movement is an instant, and the person reading it wants the time on the clock
 * behind the counter. An unparseable value comes back untouched — never `Invalid Date`.
 */
export function formatDateTime(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(erplora().locale || 'es', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(d);
  } catch {
    return raw; // an unknown locale is not a reason to lose the date
  }
}

/**
 * An instant for a LIST column, short enough for a tablet: `30/9, 23:45` for this year, `31/12/2025`
 * for an older one (cash_register#127). Lists drop the year of the current one and the time of older
 * ones — Shopify prints «Sep 30 at 11:45 pm» and «Sep 12, 2024», Gmail the same. The full
 * `formatDateTime` (123 px) did not fit the width a tablet can give the column.
 */
export function formatListDateTime(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const thisYear = d.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(
      erplora().locale || 'es',
      thisYear
        ? { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' },
    ).format(d);
  } catch {
    return raw; // an unknown locale is not a reason to lose the date
  }
}

/**
 * The label of a denomination of the drawer (`'0.50'`, `'500'`) as MONEY: `0,50 €`, not `0.50 €`.
 *
 * The arqueo card printed the key verbatim, so a Spanish hub showed a dot in the sixteen
 * denomination labels and a comma in the «Total contado» right under them — two decimal separators
 * in the same card. The KEY does not change (it is the contract with the WASM handler, which reads
 * it as euros with `Decimal::from_str`); only what the person reads.
 *
 * The scale is the hub currency's, via `currencyDecimals` — in JPY the minor unit IS the yen.
 */
export function denominationLabel(denomination: string): string {
  const client = erplora();
  const decimals = typeof client.currencyDecimals === 'number' ? client.currencyDecimals : 2;
  const major = Number(denomination);
  if (!Number.isFinite(major)) return denomination;
  // A whole face value reads like the note: «500 €», «1.000 SEK», «20 KWD» — its zero decimals made
  // the label too long for its box (cash_register#114). A fractional one keeps the currency scale.
  const whole = Number.isInteger(major);
  return client.formatMoney(Math.round(major * 10 ** decimals), whole ? { maximumFractionDigits: 0 } : undefined);
}
