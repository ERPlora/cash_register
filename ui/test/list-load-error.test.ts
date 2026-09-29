// A list that could not load must not read «No sessions» / «No movements» + «0 records» (pm#533, hub#2328).
//
// The shell's `<ok-data-table>` (OutfitKit ≥ 0.1.113) paints a failed load itself: «could not
// load», the reason and a Retry button. Every list hands it its controller's `error` and reloads on
// its `retry` event — and drops its own red banner, which would say the same thing twice. But a
// module paints with the SHELL's OutfitKit (ADR-0451): on a hub whose table has no `error` property
// the banner is the only place the reason is shown, so it stays.
//
// The shell's table is stood in for by a bare element registered BEFORE the screens load (as the
// shell does at boot; the screen's own `define()` then loses, like in the hub). Its `error`
// property is added or removed per test, which is exactly what `dataTableShowsLoadError()` reads.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class ShellTable extends HTMLElement {}
const errors = new WeakMap<HTMLElement, unknown>();

function shellTableKnowsErrors(yes: boolean) {
  if (yes) {
    Object.defineProperty(ShellTable.prototype, 'error', {
      configurable: true,
      get(this: HTMLElement) { return errors.get(this) ?? ''; },
      set(this: HTMLElement, v: unknown) { errors.set(this, v); },
    });
  } else {
    delete (ShellTable.prototype as { error?: unknown }).error;
  }
}

const REASON = 'The hub is not responding.';
const ROW = { id: 'r1', session_number: 'S-1', status: 'open', movement_type: 'cash_in', amount: 500, count_type: 'closing', total: 500 };
const SESSION = { id: 's1', session_number: 'S-1', status: 'open', opening_balance: 10000 };

let hubAnswers = false;
let pageCalls: string[] = [];
let queryCalls: string[] = [];

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-cashregister-dashboard/erp-cashregister-dashboard');
  await import('../components/erp-cashregister-session-detail/erp-cashregister-session-detail');
});

beforeEach(() => {
  document.body.innerHTML = '';
  hubAnswers = false;
  pageCalls = [];
  queryCalls = [];
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (!hubAnswers) throw new Error(REASON);
    if (name === 'cash_register.current_session') return [SESSION];
    if (name === 'cash_register.registers.list') return [{ id: 'reg1', name: 'Caja 1' }];
    if (name.startsWith('cash_register.session.summary')) return [{ status: 'open', movement_count: 1, opening_balance: 10000 }];
    return [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryAll: answer,
    queryPage: async (name: string) => {
      pageCalls.push(name);
      if (!hubAnswers) throw new Error(REASON);
      return { rows: [ROW], total: 1 };
    },
    command: async () => ({}),
    hasPermission: () => true,
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
type Table = HTMLElement & { error: string; rows: unknown[] };

async function settle(el: Screen) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

function tableOf(el: Screen, testid: string): Table {
  const table = el.shadowRoot.querySelector<Table>(`ok-data-table[testid="${testid}"]`);
  expect(table, `the screen paints ${testid}`).toBeTruthy();
  return table!;
}

async function retry(el: Screen, table: Table, query: string) {
  const before = pageCalls.filter((n) => n === query).length;
  hubAnswers = true;
  table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
  await vi.waitFor(() => {
    if (pageCalls.filter((n) => n === query).length === before) throw new Error('Retry did not ask the hub again');
  });
  await vi.waitFor(async () => {
    await el.updateComplete;
    if (table.error !== '') throw new Error('the error is still on the table');
  });
}

describe('erp-cashregister-dashboard — the sessions list could not load (pm#533)', () => {
  const TABLE = 'cash-register-table';
  const BANNER = 'cash-register-load-error';
  const LIST = 'cash_register.sessions.list';

  async function mountFailed(): Promise<Screen> {
    const el = document.createElement('erp-cashregister-dashboard') as Screen;
    document.body.appendChild(el);
    await vi.waitFor(() => {
      if (!pageCalls.includes(LIST)) throw new Error('the list has not asked for its page yet');
    });
    await settle(el);
    return el;
  }

  it('hands the reason to the shell table and paints no second banner', async () => {
    shellTableKnowsErrors(true);
    const el = await mountFailed();
    expect(tableOf(el, TABLE).error).toBe(REASON);
    expect(el.shadowRoot.querySelector(`[data-testid="${BANNER}"]`), 'the reason would be said twice').toBeNull();
  });

  it('Retry on the table asks the hub again and paints the rows that now arrive', async () => {
    shellTableKnowsErrors(true);
    const el = await mountFailed();
    const table = tableOf(el, TABLE);
    await retry(el, table, LIST);
    expect(table.rows).toEqual([ROW]);
  });

  it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
    shellTableKnowsErrors(false);
    const el = await mountFailed();
    const banner = el.shadowRoot.querySelector(`[data-testid="${BANNER}"]`);
    expect(banner, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(banner!.textContent).toContain(REASON);
  });

  it('Retry also asks again for the registers and the open session the failure left out', async () => {
    // Both load with the list when the screen opens and swallow their failure: after a failed start
    // «Open session» would stay enabled with an open session and the register picker empty.
    shellTableKnowsErrors(true);
    const el = await mountFailed();
    const state = el as unknown as { hasOpenSession: boolean; registers: unknown[] };
    expect(state.hasOpenSession).toBe(false);
    await retry(el, tableOf(el, TABLE), LIST);
    await vi.waitFor(() => {
      if (!state.hasOpenSession) throw new Error('the open session was not asked again');
      if (state.registers.length !== 1) throw new Error('the registers were not asked again');
    });
  });
});

describe('erp-cashregister-session-detail — a list of the session could not load (pm#533)', () => {
  async function mountFailed(): Promise<Screen> {
    const el = document.createElement('erp-cashregister-session-detail') as Screen & { session: unknown };
    el.session = SESSION;
    document.body.appendChild(el);
    await vi.waitFor(() => {
      if (!pageCalls.includes('cash_register.movements.list') || !pageCalls.includes('cash_register.counts.list')) {
        throw new Error('the lists have not asked for their pages yet');
      }
    });
    await settle(el);
    return el;
  }

  describe.each([
    { list: 'movements', table: 'cash-register-session-movements-table', banner: 'cash-register-session-movements-load-error', query: 'cash_register.movements.list' },
    { list: 'counts', table: 'cash-register-session-counts-table', banner: 'cash-register-session-counts-load-error', query: 'cash_register.counts.list' },
  ])('$list', ({ table, banner, query }) => {
    it('hands the reason to the shell table and paints no second banner', async () => {
      shellTableKnowsErrors(true);
      const el = await mountFailed();
      expect(tableOf(el, table).error).toBe(REASON);
      expect(el.shadowRoot.querySelector(`[data-testid="${banner}"]`), 'the reason would be said twice').toBeNull();
    });

    it('Retry on the table asks the hub again and paints the rows that now arrive', async () => {
      shellTableKnowsErrors(true);
      const el = await mountFailed();
      const t = tableOf(el, table);
      await retry(el, t, query);
      expect(t.rows).toEqual([ROW]);
    });

    it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
      shellTableKnowsErrors(false);
      const el = await mountFailed();
      const shown = el.shadowRoot.querySelector(`[data-testid="${banner}"]`);
      expect(shown, 'an older hub would show the failure nowhere').toBeTruthy();
      expect(shown!.textContent).toContain(REASON);
    });

    it('Retry also asks again for the session summary that failed with it', async () => {
      // The summary loads with the lists: without asking again, the red «could not load» of the
      // summary would stay on screen above the rows that came back.
      shellTableKnowsErrors(true);
      const el = await mountFailed();
      const state = el as unknown as { error: string };
      expect(state.error, 'the summary failed with the lists').toBe(REASON);
      await retry(el, tableOf(el, table), query);
      await vi.waitFor(() => {
        if (state.error !== '') throw new Error('the summary was not asked again');
      });
      expect(queryCalls.filter((n) => n.startsWith('cash_register.session.summary')).length).toBeGreaterThanOrEqual(2);
    });
  });
});
