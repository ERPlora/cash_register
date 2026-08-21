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
  return client.formatMoney(Math.round(major * 10 ** decimals));
}
