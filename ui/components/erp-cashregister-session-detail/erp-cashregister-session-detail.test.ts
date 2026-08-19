// cash_register#2 — the session detail (Square "drawer report" / Toast "cash drawer details"): the
// summary of ONE session (`cash_register.session.summary`) plus its movements and counts
// (`cash_register.movements.list` / `cash_register.counts.list`, both scoped by `session_id`).
// Until this file the three queries existed and nobody consumed them: the data was unreachable.
import { beforeEach, describe, expect, it } from 'vitest';

const SESSION = { id: 's1', session_number: 'S-260818-1', status: 'closed', opening_balance: 10000, expected_balance: 12500, closing_balance: 12000, difference: -500 };
const SUMMARY = { id: 's1', session_number: 'S-260818-1', status: 'closed', opening_balance: 10000, total_sales: 2500, total_refunds: 0, total_cash_in: 500, total_cash_out: 500, total_gifts: 0, expected_cash: 12500, movement_count: 3 };
const MOVEMENTS = [
  { id: 'm1', movement_type: 'sale', amount: 2500, payment_method: 'cash', sale_reference: 'T-1', description: 'Sale T-1', employee_id: 'u1', created_at: '2026-08-18T10:00:00Z' },
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
