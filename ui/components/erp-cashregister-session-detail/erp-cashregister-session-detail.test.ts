// cash_register#2 — the session detail (Square "drawer report" / Toast "cash drawer details"): the
// summary of ONE session (`cash_register.session.summary`) plus its movements and counts
// (`cash_register.movements.list` / `cash_register.counts.list`, both scoped by `session_id`).
// Until this file the three queries existed and nobody consumed them: the data was unreachable.
import { beforeEach, describe, expect, it } from 'vitest';

const SESSION = { id: 's1', session_number: 'S-260818-1', status: 'closed', opening_balance: 10000, expected_balance: 12500, closing_balance: 12000, difference: -500 };
const SUMMARY = { id: 's1', session_number: 'S-260818-1', status: 'closed', opening_balance: 10000, total_sales: 2500, total_refunds: 0, total_cash_in: 500, total_cash_out: 500, total_gifts: 0, expected_cash: 12500, movement_count: 3 };
// The two writers of `cash_register_movement.payment_method` do NOT store the same thing, and the
// fixture carries one of each (cash_register#66): a SALE keeps the method NAME the event came with
// (`_movement_for_open_session.sql`), which the `sales` factory seed sows in canonical English
// (`Cash`/`Card`, ADR-0055); a MANUAL movement keeps the canonical keyword the handler normalises
// to (`cash`|`card`|`transfer`|`other`, hub#778). The fixture used to hold `'cash'` in both rows,
// so nothing here ever saw the seed name that the manager actually reads on screen.
const MOVEMENTS = [
  { id: 'm1', movement_type: 'sale', amount: 2500, payment_method: 'Cash', sale_reference: 'T-1', description: 'Sale T-1', employee_id: 'u1', created_at: '2026-08-18T10:00:00Z' },
  { id: 'm2', movement_type: 'out', amount: -500, payment_method: 'cash', sale_reference: '', description: 'supplier bread', employee_id: 'u1', created_at: '2026-08-18T11:00:00Z' },
];
const COUNTS = [{ id: 'c1', count_type: 'closing', total: 12000, denominations: '{}', notes: '', counted_at: '2026-08-18T20:00:00Z' }];

let calls: { name: string; params: unknown }[];

beforeEach(() => {
  calls = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string, params: unknown) => {
      calls.push({ name, params });
      return name === 'cash_register.session.summary' ? [SUMMARY] : [];
    },
    queryAll: async () => [],
    queryPage: async (name: string, params: { params?: Record<string, unknown> }) => {
      calls.push({ name, params });
      if (name === 'cash_register.movements.list') return { rows: MOVEMENTS, total: 2, limit: 50, offset: 0 };
      if (name === 'cash_register.counts.list') return { rows: COUNTS, total: 1, limit: 50, offset: 0 };
      return { rows: [], total: 0, limit: 50, offset: 0 };
    },
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (_c: unknown, key: string) => key,
    currency: 'EUR',
    formatAmount: (u: number) => `${(u || 0).toFixed(2)} €`,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
  };
});

async function montar() {
  await import('./erp-cashregister-session-detail');
  const el = document.createElement('erp-cashregister-session-detail') as HTMLElement & { session: unknown; updateComplete: Promise<unknown> };
  el.session = SESSION;
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
  return el;
}

describe('la ficha de una sesión de caja (cash_register#2)', () => {
  it('pide el resumen, los movimientos y los arqueos DE ESA sesión (session_id)', async () => {
    await montar();
    const summary = calls.find((c) => c.name === 'cash_register.session.summary');
    expect(summary?.params).toEqual({ session_id: 's1' });
    const movements = calls.find((c) => c.name === 'cash_register.movements.list');
    expect((movements?.params as { params?: Record<string, unknown> })?.params?.session_id).toBe('s1');
    const counts = calls.find((c) => c.name === 'cash_register.counts.list');
    expect((counts?.params as { params?: Record<string, unknown> })?.params?.session_id).toBe('s1');
  });

  it('muestra los totales del resumen formateados en la moneda del hub y las dos listas', async () => {
    const el = await montar();
    // The summary goes through `ok-detail-list` (its own shadow root): assert what it is handed.
    const items = (el.shadowRoot?.querySelector('ok-detail-list') as unknown as { items: { label: string; value?: string }[] }).items;
    const values = items.map((i) => i.value);
    expect(values).toContain('125.00 €'); // expected cash 12500
    expect(values).toContain('25.00 €'); // cash sales 2500
    expect(values).toContain('-5.00 €'); // difference -500 (revealed: the session is closed)
    expect(values).toContain('120.00 €'); // counted 12000
    const tables = el.shadowRoot?.querySelectorAll('ok-data-table') ?? [];
    expect(tables.length, 'movements + counts').toBe(2);
    const rows = (tables[0] as unknown as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(2);
    expect((tables[1] as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('en una sesión ABIERTA no inventa contado ni diferencia (— hasta declarar)', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.query = async (name: string) => (name === 'cash_register.session.summary' ? [{ ...SUMMARY, status: 'open' }] : []);
    await import('./erp-cashregister-session-detail');
    const el = document.createElement('erp-cashregister-session-detail') as HTMLElement & { session: unknown; updateComplete: Promise<unknown> };
    el.session = { ...SESSION, status: 'open', expected_balance: null, closing_balance: null, difference: null };
    document.body.appendChild(el);
    for (let i = 0; i < 3; i++) { await el.updateComplete; await new Promise((r) => setTimeout(r, 0)); }
    const items = (el.shadowRoot?.querySelector('ok-detail-list') as unknown as { items: { label: string; value?: string }[] }).items;
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
    expect(byLabel['ui.detailCounted']).toBe('—');
    expect(byLabel['ui.colDifference']).toBe('—');
    expect(byLabel['ui.colExpected'], 'live expected cash while open').toBe('125.00 €');
  });
});

// cash_register#50 — the detail printed the database, not the language. `Estado open` sat two
// hundred pixels under a green badge that already said «Sesión abierta»; the movements table
// printed `out` in the TYPE column and `2026-08-21T17:52:13.198500671+00:00` in the WHEN column.
// Everything a person reads goes through i18n (`ui/lib/enums.ts`) and the locale formatter.
describe('la ficha no enseña datos en crudo (cash_register#50)', () => {
  const columnsOf = (el: HTMLElement, getter: 'movementColumns' | 'countColumns') =>
    (el as unknown as Record<string, { key: string; format?: (r: Record<string, unknown>) => unknown }[]>)[getter];

  it('el estado de la sesión va traducido, no `closed`', async () => {
    const el = await montar();
    const items = (el as unknown as { summaryItems: { label: string; value: unknown }[] }).summaryItems;
    const estado = items.find((i) => i.label === 'ui.colStatus');
    expect(estado?.value).toBe('ui.statusClosed');
  });

  it('el TIPO de cada movimiento va traducido, no `out`', async () => {
    const el = await montar();
    const col = columnsOf(el, 'movementColumns').find((c) => c.key === 'movement_type')!;
    expect(col.format, 'la columna TIPO no formatea nada: imprime el enum crudo').toBeTruthy();
    expect(col.format!({ movement_type: 'out' })).toBe('ui.movementOut');
    expect(col.format!({ movement_type: 'refund' })).toBe('ui.movementRefund');
  });

  it('el TIPO de arqueo va traducido, no `closing`', async () => {
    const el = await montar();
    const col = columnsOf(el, 'countColumns').find((c) => c.key === 'count_type')!;
    expect(col.format!({ count_type: 'closing' })).toBe('ui.countClosing');
  });

  it('ninguna fecha visible lleva `T` ni el offset UTC', async () => {
    const el = await montar();
    const when = columnsOf(el, 'movementColumns').find((c) => c.key === 'created_at')!;
    const shown = String(when.format!({ created_at: '2026-08-21T17:52:13.198500671+00:00' }));
    expect(shown).not.toContain('T');
    expect(shown).not.toContain('+00:00');
    expect(shown).toMatch(/^\d{2}\/\d{2}\/\d{4}/);

    const counted = columnsOf(el, 'countColumns').find((c) => c.key === 'counted_at')!;
    expect(String(counted.format!({ counted_at: '2026-08-18T20:00:00Z' }))).not.toContain('T');
  });
});

// cash_register#66 — the one column of the movements table that #50 left without `format`. A
// Spanish hub read «Cash» in the METHOD cell while the cell next to it already said «Venta»: the
// `sales` factory seed sows its methods with the canonical English name (ADR-0055) and a manual
// movement stores the canonical keyword (hub#778), so BOTH factory vocabularies land in this
// column and both have to be read in the hub's language.
//
// The line that decides the fix: the TYPE decides money, the NAME decides text. Resolving the
// label through `payment_method_type` would paint «Tarjeta» over a method the owner renamed to
// «BBVA TPV» — so what the owner typed is printed verbatim, always.
describe('la forma de pago se lee en el idioma del hub (cash_register#66)', () => {
  const methodColumn = (el: HTMLElement) =>
    (el as unknown as Record<string, { key: string; format?: (r: Record<string, unknown>) => unknown }[]>)
      .movementColumns.find((c) => c.key === 'payment_method')!;

  it('traduce el nombre de fábrica que siembra `sales` («Cash» no se lee en un hub español)', async () => {
    const el = await montar();
    const col = methodColumn(el);
    expect(col.format, 'la columna FORMA DE PAGO no formatea nada: imprime la fila en crudo').toBeTruthy();
    expect(col.format!({ payment_method: 'Cash' })).toBe('ui.methodCash');
    expect(col.format!({ payment_method: 'Card' })).toBe('ui.methodCard');
  });

  it('traduce también el vocabulario canónico con el que se guarda un movimiento manual', async () => {
    const col = methodColumn(await montar());
    expect(col.format!({ payment_method: 'cash' })).toBe('ui.methodCash');
    expect(col.format!({ payment_method: 'card' })).toBe('ui.methodCard');
    expect(col.format!({ payment_method: 'transfer' })).toBe('ui.methodTransfer');
    expect(col.format!({ payment_method: 'other' })).toBe('ui.methodOther');
  });

  it('el nombre que teclea el dueño manda: sale TAL CUAL, sin traducir', async () => {
    const col = methodColumn(await montar());
    expect(col.format!({ payment_method: 'BBVA TPV' })).toBe('BBVA TPV');
    expect(col.format!({ payment_method: 'Ticket restaurante' })).toBe('Ticket restaurante');
    // A method the catalogue does not know is a value it must still SHOW: a till screen that
    // blanks the method of a movement is worse than one that shows an untranslated word.
    expect(col.format!({ payment_method: 'Bizum' })).toBe('Bizum');
  });

  it('una fila sin forma de pago deja la celda vacía, nunca `null` ni `undefined`', async () => {
    const col = methodColumn(await montar());
    expect(col.format!({ payment_method: null })).toBe('');
    expect(col.format!({})).toBe('');
  });
});

// cash_register#84 — the detail was the door next to the one #24 closed: `session.summary` streamed
// the live expected of an OPEN session to anyone with `view_session`. The server now gags it in a
// blind hub; the detail asks for the ungagged twin only when the person may see expected totals,
// and never paints a number of its own.
describe('la ficha respeta el arqueo ciego (cash_register#84)', () => {
  async function montarAbierta(canSee: boolean, blindSummary: boolean) {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.hasPermission = (perm: string) => canSee && perm === 'cash_register.view_expected_totals';
    sdk.query = async (name: string, params: unknown) => {
      calls.push({ name, params });
      if (name === 'cash_register.session.summary') return [{ ...SUMMARY, status: 'open', expected_cash: blindSummary ? null : 12500 }];
      if (name === 'cash_register.session.summary.expected') return [{ ...SUMMARY, status: 'open' }];
      return [];
    };
    await import('./erp-cashregister-session-detail');
    const el = document.createElement('erp-cashregister-session-detail') as HTMLElement & { session: unknown; updateComplete: Promise<unknown> };
    el.session = { ...SESSION, status: 'open', expected_balance: null, closing_balance: null, difference: null };
    document.body.appendChild(el);
    for (let i = 0; i < 3; i++) { await el.updateComplete; await new Promise((r) => setTimeout(r, 0)); }
    const items = (el.shadowRoot?.querySelector('ok-detail-list') as unknown as { items: { label: string; value?: string }[] }).items;
    return Object.fromEntries(items.map((i) => [i.label, i.value]));
  }

  it('sin el permiso de ver totales esperados lee la puerta con guarda y no enseña esperado', async () => {
    const byLabel = await montarAbierta(false, true);
    const names = calls.map((c) => c.name);
    expect(names).toContain('cash_register.session.summary');
    expect(names, 'the ungagged twin is a supervisor door').not.toContain('cash_register.session.summary.expected');
    expect(byLabel['ui.colExpected']).toBe('—');
    expect(byLabel['ui.detailCashSales'], 'the rest of the summary stays').toBe('25.00 €');
  });

  it('con el permiso lee la gemela sin guarda y el supervisor ve el esperado', async () => {
    const byLabel = await montarAbierta(true, true);
    const summary = calls.find((c) => c.name === 'cash_register.session.summary.expected');
    expect(summary, 'a supervisor reads the ungagged twin').toBeTruthy();
    expect(summary!.params).toEqual({ session_id: 's1' });
    expect(byLabel['ui.colExpected']).toBe('125.00 €');
  });
});
