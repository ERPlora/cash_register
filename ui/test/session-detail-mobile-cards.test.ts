// cash_register#129 — on a phone the two lists of the session detail (movements and counts) stayed a
// table with horizontal scroll: the WHEN column was cut to «30/09/2026…», without the time, which is
// exactly what tells one count from another. The sessions list of the same screen already turns into
// cards on a phone (`views`), so a person reads it whole; the two detail lists must do the same.
//
// Mounted with the REAL `<ok-data-table>`: it decides cards vs table from `matchMedia` on connect
// (MOBILE_BREAKPOINT 640 px), so the viewport is what the stub below answers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SESSION = { id: 's1', session_number: 'S-260930-1', status: 'closed', opening_balance: 10000, expected_balance: 12500, closing_balance: 12000, difference: -500 };
const SUMMARY = { id: 's1', status: 'closed', opening_balance: 10000, total_sales: 2500, total_refunds: 0, total_cash_in: 0, total_cash_out: 0, total_gifts: 0, expected_cash: 12500, movement_count: 1 };
const MOVEMENTS = [
  { id: 'm1', movement_type: 'out', amount: -500, payment_method: 'cash', sale_reference: '', description: 'supplier bread', employee_id: 'u1', created_at: '2026-09-30T09:15:00Z' },
];
const COUNTS = [
  { id: 'c1', count_type: 'closing', total: 12000, denominations: '{}', notes: 'shift change', counted_at: '2026-09-30T21:45:00Z' },
  { id: 'c2', count_type: 'opening', total: 8000, denominations: '{}', notes: '', counted_at: '2026-09-30T16:05:00Z' },
];

const realMatchMedia = window.matchMedia;

/** What a viewport of `width` px answers to `(max-width: Npx)` — the only query the table asks. */
function viewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'cash_register.session.summary' ? [SUMMARY] : []),
    queryAll: async () => [],
    queryPage: async (name: string) => {
      if (name === 'cash_register.movements.list') return { rows: MOVEMENTS, total: MOVEMENTS.length, limit: 50, offset: 0 };
      if (name === 'cash_register.counts.list') return { rows: COUNTS, total: COUNTS.length, limit: 50, offset: 0 };
      return { rows: [], total: 0, limit: 50, offset: 0 };
    },
    queryOptional: async () => undefined,
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

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

type Table = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function mount(): Promise<{ movements: Table; counts: Table }> {
  await import('../components/erp-cashregister-session-detail/erp-cashregister-session-detail');
  const el = document.createElement('erp-cashregister-session-detail') as HTMLElement & { session: unknown; updateComplete: Promise<unknown> };
  el.session = SESSION;
  document.body.appendChild(el);
  for (let i = 0; i < 4; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
  const find = (id: string) => el.shadowRoot?.querySelector(`ok-data-table[testid="${id}"]`) as Table | null;
  const movements = find('cash-register-session-movements-table');
  const counts = find('cash-register-session-counts-table');
  expect(movements, 'movements table rendered').toBeTruthy();
  expect(counts, 'counts table rendered').toBeTruthy();
  await movements!.updateComplete;
  await counts!.updateComplete;
  return { movements: movements!, counts: counts! };
}

/** The date AND time the detail paints for a count, in the hub locale (`formatDateTime`). */
const whenEs = (iso: string) => new Intl.DateTimeFormat('es', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

describe('la ficha de sesión se lee entera en el móvil (cash_register#129)', () => {
  it('a 375 px los ARQUEOS salen en tarjetas, cada una con su fecha Y su hora, tipo, total y notas', async () => {
    viewport(375);
    const { counts } = await mount();
    expect(counts.shadowRoot.querySelector('.cards-grid'), 'counts must be cards on a phone, not a sideways-scrolling table').toBeTruthy();
    const card = counts.shadowRoot.querySelector('[data-testid="cash-register-session-counts-table-row-c1"]') as HTMLElement | null;
    expect(card, 'one card per count').toBeTruthy();
    const text = card!.textContent ?? '';
    expect(whenEs(COUNTS[0].counted_at)).toMatch(/\d{2}:\d{2}/); // the control: the expectation carries a time
    expect(text).toContain(whenEs(COUNTS[0].counted_at));
    expect(text).toContain('ui.countClosing');
    expect(text).toContain('120.00 €');
    expect(text).toContain('shift change');
    // The time is the TITLE of the card: it is what tells one count from the other at a glance.
    const title = card!.querySelector('.rc-title')?.textContent?.trim();
    expect(title).toBe(whenEs(COUNTS[0].counted_at));
    expect(counts.shadowRoot.querySelectorAll('.cards-grid > *').length).toBe(COUNTS.length);
  });

  it('a 375 px los MOVIMIENTOS también salen en tarjetas con su fecha y hora como título', async () => {
    viewport(375);
    const { movements } = await mount();
    expect(movements.shadowRoot.querySelector('.cards-grid'), 'movements must be cards on a phone').toBeTruthy();
    const card = movements.shadowRoot.querySelector('[data-testid="cash-register-session-movements-table-row-m1"]') as HTMLElement | null;
    expect(card, 'one card per movement').toBeTruthy();
    expect(card!.querySelector('.rc-title')?.textContent?.trim()).toBe(whenEs(MOVEMENTS[0].created_at));
    const text = card!.textContent ?? '';
    expect(text).toContain('-5.00 €');
    expect(text).toContain('supplier bread');
  });

  it('en escritorio (1440 px) las dos siguen siendo tabla: las tarjetas son del móvil', async () => {
    viewport(1440);
    const { movements, counts } = await mount();
    expect(movements.shadowRoot.querySelector('.cards-grid')).toBeNull();
    expect(counts.shadowRoot.querySelector('.cards-grid')).toBeNull();
  });
});
