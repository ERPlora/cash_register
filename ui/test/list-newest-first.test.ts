// cash_register#127 — the Cash grid and the counts of a session list the NEWEST first.
//
// Both screens built their list controller with `sort: 'id', dir: 'asc'`. The `id` is a UUID, so
// the order had nothing to do with time: with three shifts of the same day, today's open one could
// come back last, between two closed ones, and the person had to hunt for it. The SDK controller
// always sends its `sort`/`dir`, so the manifest's `default_sort` never applied to these screens —
// the screen itself has to ask for `opened_at` / `counted_at` DESC (Square, Toast, Lightspeed and
// Odoo all list sessions most-recent first). The table must also show that order in its header, or
// the first click on «Opened» would flip to ascending while the arrow claimed otherwise.
import { beforeEach, describe, expect, it } from 'vitest';

type Call = { name: string; params: Record<string, unknown> };
let calls: Call[];

const SESSION = { id: 's1', session_number: 'S-260930-0003', status: 'open', opening_balance: 10000 };

beforeEach(() => {
  calls = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
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

async function settle(el: HTMLElement & { updateComplete: Promise<unknown> }) {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Table = HTMLElement & { sort?: string; sortDir?: string; testid?: string };

describe('the Cash grid lists the newest session first (cash_register#127)', () => {
  it('asks sessions.list for opened_at DESC and the table header shows that order', async () => {
    await import('../components/erp-cashregister-dashboard/erp-cashregister-dashboard');
    const el = document.createElement('erp-cashregister-dashboard') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.appendChild(el);
    await settle(el);

    const sessions = calls.filter((c) => c.name === 'cash_register.sessions.list');
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].params.sort).toBe('opened_at');
    expect(sessions[0].params.dir).toBe('desc');

    const table = el.shadowRoot?.querySelector('ok-data-table[testid="cash-register-table"]') as Table | null;
    expect(table?.sort).toBe('opened_at');
    expect(table?.sortDir).toBe('desc');
    el.remove();
  });

  it('shows WHEN each session opened in a sortable column, so the order is visible and can be restored', async () => {
    // Without the column the default order points at a header that does not exist: no arrow tells
    // the person how the list is sorted, and after sorting by another column there is no way back to
    // «newest first» short of reloading. Odoo (Opening Date) and Square (start time) show it.
    await import('../components/erp-cashregister-dashboard/erp-cashregister-dashboard');
    const el = document.createElement('erp-cashregister-dashboard') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.appendChild(el);
    await settle(el);
    type Col = { key: string; header: string; sortable?: boolean; format?: (r: Record<string, unknown>) => string };
    const table = el.shadowRoot?.querySelector('ok-data-table[testid="cash-register-table"]') as (Table & { columns: Col[] }) | null;
    const keys = (table?.columns ?? []).map((c) => c.key);
    expect(keys.slice(0, 2)).toEqual(['session_number', 'opened_at']);
    const opened = table!.columns[1];
    expect(opened.header).toBe('ui.colOpenedAt');
    expect(opened.sortable).toBe(true);
    // An instant in the hub's locale, never the engine's nine-decimal RFC 3339 string.
    const shown = opened.format?.({ opened_at: '2026-09-30T08:05:13.093240004+00:00' }) ?? '';
    expect(shown).toMatch(/30\/09\/2026/);
    expect(shown).not.toContain('T08');
    el.remove();
  });
});

describe('the counts of a session list the newest first (cash_register#127)', () => {
  it('asks counts.list for counted_at DESC and the counts table shows that order', async () => {
    await import('../components/erp-cashregister-session-detail/erp-cashregister-session-detail');
    const el = document.createElement('erp-cashregister-session-detail') as HTMLElement & { session: unknown; updateComplete: Promise<unknown> };
    el.session = SESSION;
    document.body.appendChild(el);
    await settle(el);

    const counts = calls.filter((c) => c.name === 'cash_register.counts.list');
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0].params.sort).toBe('counted_at');
    expect(counts[0].params.dir).toBe('desc');

    // Movements already came newest first; the counts table must match it, not the other way round.
    const tables = Array.from(el.shadowRoot?.querySelectorAll('ok-data-table') ?? []) as Table[];
    expect(tables.map((t) => [t.sort, t.sortDir])).toEqual([
      ['created_at', 'desc'],
      ['counted_at', 'desc'],
    ]);
    el.remove();
  });
});
