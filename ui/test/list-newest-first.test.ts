// cash_register#127 — the Cash grid and the counts of a session list the NEWEST first.
//
// Both screens built their list controller with `sort: 'id', dir: 'asc'`. The `id` is a UUID, so
// the order had nothing to do with time: with three shifts of the same day, today's open one could
// come back last, between two closed ones, and the person had to hunt for it. The SDK controller
// always sends its `sort`/`dir`, so the manifest's `default_sort` never applied to these screens —
// the screen itself has to ask for `opened_at` / `counted_at` DESC (Square, Toast, Lightspeed and
// Odoo all list sessions most-recent first). The table must also show that order in its header, or
// the first click on «Opened» would flip to ascending while the arrow claimed otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en.json';
import es from '../../locales/es.json';

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
    const shown = opened.format?.({ opened_at: '2025-09-30T08:05:13.093240004+00:00' }) ?? '';
    expect(shown).toMatch(/30\/0?9\/2025/);
    expect(shown).not.toContain('T08');
    el.remove();
  });

  it('fits its seven columns on a tablet without sliding under the actions', async () => {
    // Measured on the hub:stable bench: at 820 px the table is 788 px wide, the collapsed actions
    // track takes 44 px and the eight tracks add 88 px of gaps and padding, so the data columns
    // have 656 px; at 1024 px (landscape, side menu open) they have 752 - 32 - 88 = 632 px. With the
    // new column at a 10rem floor the row needed 868 px at 820: the grid scrolled and «Diferencia»
    // slid under the pinned actions. The number keeps the 7rem that holds «S-260930-0003» (109 px);
    // the rest must fit what is left.
    await import('../components/erp-cashregister-dashboard/erp-cashregister-dashboard');
    const el = document.createElement('erp-cashregister-dashboard') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.appendChild(el);
    await settle(el);
    type Col = { key: string; width?: string };
    const cols = (el.shadowRoot?.querySelector('ok-data-table[testid="cash-register-table"]') as unknown as { columns: Col[] }).columns;
    // A column without `width` gets ok-data-table's floor, minmax(5.5rem,1fr).
    const floorPx = (c: Col) => {
      const m = /^minmax\((\d+(?:\.\d+)?)rem,\s*1fr\)$/.exec(c.width ?? 'minmax(5.5rem,1fr)');
      expect(m, `${c.key} keeps a rem floor that grows with 1fr`).not.toBeNull();
      return Number(m![1]) * 16;
    };
    expect(cols).toHaveLength(7);
    expect(cols.reduce((sum, c) => sum + floorPx(c), 0)).toBeLessThanOrEqual(632);
    // Each floor still holds the widest thing it paints, measured on the bench: the number (109 px),
    // «9/30, 11:45 PM» (97 px) and the «DIFFERENCE» header with its sort caret (92 px).
    const floor = (key: string) => floorPx(cols.find((c) => c.key === key)!);
    expect(floor('session_number')).toBeGreaterThanOrEqual(112);
    expect(floor('opened_at')).toBeGreaterThanOrEqual(100);
    expect(floor('difference')).toBeGreaterThanOrEqual(92);
    // The status gives back the width «Cerrada» does not use, never what its own words need: the
    // «ESTADO» header with its caret is 53 px and «Cerrada» 52 px (bench, ios and md).
    expect(floor('status')).toBeGreaterThanOrEqual(56);
    el.remove();
  });

  it('the new column header is translated: English source plus its Spanish', () => {
    const header = (l: unknown) => (l as { ui: Record<string, string> }).ui.colOpenedAt;
    // Short on purpose: «Fecha de apertura» was cut to «FECHA DE APERT…» on desktop and tablet.
    expect(header(en)).toBe('Opened');
    // «Apertura» is already the OPENING FLOAT column in Spanish: the date must not read the same.
    expect(header(es)).toBe('Abierta el');
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

describe('the opening date of the Cash grid is short enough for a tablet (cash_register#127)', () => {
  // «30/09/2026, 23:45» is 123 px and did not fit the column a tablet can give it. Lists drop the
  // year of the current one and the time of older ones (Shopify «Sep 30 at 11:45 pm» / «Sep 12,
  // 2024», Gmail): today's shift reads «30/9, 23:45», a shift of another year its date.
  afterEach(() => vi.useRealTimers());

  it('prints day, month and time for a session of the current year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T22:00:00'));
    const { formatListDateTime } = await import('../lib/enums');
    const shown = formatListDateTime('2026-09-30T08:05:13.093240004+00:00');
    expect(shown).toBe(new Intl.DateTimeFormat('es', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date('2026-09-30T08:05:13Z')));
    expect(shown).not.toContain('2026');
    expect(shown).toMatch(/\d{2}:\d{2}/);
  });

  it('prints the full date, without the time, for a session of another year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T22:00:00'));
    const { formatListDateTime } = await import('../lib/enums');
    const shown = formatListDateTime('2025-12-31T12:00:00+00:00');
    expect(shown).toMatch(/31\/12\/2025/);
    expect(shown).not.toMatch(/\d{2}:\d{2}/);
  });

  it('never prints Invalid Date: an empty value stays empty and garbage comes back untouched', async () => {
    const { formatListDateTime } = await import('../lib/enums');
    expect(formatListDateTime(null)).toBe('');
    expect(formatListDateTime('not-a-date')).toBe('not-a-date');
  });

  it('is what the Opened column prints', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T22:00:00'));
    const { formatListDateTime } = await import('../lib/enums');
    await import('../components/erp-cashregister-dashboard/erp-cashregister-dashboard');
    const el = document.createElement('erp-cashregister-dashboard') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.appendChild(el);
    await settle(el);
    type Col = { key: string; format?: (r: Record<string, unknown>) => string };
    const cols = (el.shadowRoot?.querySelector('ok-data-table[testid="cash-register-table"]') as unknown as { columns: Col[] }).columns;
    const value = '2026-09-30T08:05:13.093240004+00:00';
    expect(cols.find((c) => c.key === 'opened_at')?.format?.({ opened_at: value })).toBe(formatListDateTime(value));
    el.remove();
  });
});
