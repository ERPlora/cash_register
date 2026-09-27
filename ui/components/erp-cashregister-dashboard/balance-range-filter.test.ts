// The «Opening / Expected / Counted / Difference» range filters of the sessions list filter in the
// unit the column shows (cash_register#103, sibling of pm#498; «Difference» since cash_register#107,
// where it was an exact-match text box over cents and «5» looked for 0,05 €).
//
// `cash_register_session.opening_balance`, `expected_balance` and `closing_balance` are INTEGER in
// the minor unit (cents in EUR, ADR-0007/0123) and the dispatcher compares the `range` filter
// against that integer. The columns paint them as money of the hub («100,00 €»), so the person
// types «100» meaning one hundred euros — and the screen sent `100` as is: «Opening from 100» let a
// 1,50 € float through and hid a 50 € one.
//
// What the table types (major unit) is scaled to the minor unit with the hub's currency decimals
// before the list is asked for; the edges of every other column travel untouched.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildListParams } from '@erplora/module-sdk';
import './erp-cashregister-dashboard';

/** The `filters` of every page the screen asked the hub for, in call order. */
const asked: Array<Record<string, unknown>> = [];
let decimals = 2;

beforeEach(() => {
  document.body.replaceChildren();
  asked.length = 0;
  decimals = 2;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryOptional: async () => undefined,
    queryPage: async (name: string, params: { filters?: Record<string, unknown> }) => {
      if (name === 'cash_register.sessions.list') asked.push(structuredClone(params.filters ?? {}));
      return { rows: [], total: 0, limit: 50, offset: 0 };
    },
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    currency: 'EUR',
    t: (_catalog: unknown, key: string) => key,
    formatAmount: (units: number) => `AMOUNT(${units})`,
    formatMoney: (minor: number) => `MONEY(${minor})`,
    get currencyDecimals() {
      return decimals;
    },
  };
});

type Mounted = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function settle(el: Mounted): Promise<void> {
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

async function mount(): Promise<Mounted> {
  const el = document.createElement('erp-cashregister-dashboard') as Mounted;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

/** Fires what `ok-data-table` emits when one edge of a filter is typed. */
async function type(el: Mounted, col: string, value: unknown): Promise<Record<string, unknown>> {
  el.shadowRoot
    .querySelector('ok-data-table')!
    .dispatchEvent(new CustomEvent('filterChange', { detail: { col, value } }));
  await settle(el);
  return asked[asked.length - 1];
}

describe('«Opening / Expected / Counted» range filters compare in the unit the column shows (cash_register#103)', () => {
  it('«Opening from 12» asks for 12,00 € (1200 cents), not 12 cents', async () => {
    const el = await mount();
    expect(await type(el, 'opening_balance', { from: 12 })).toEqual({ opening_balance: { from: 1200 } });
  });

  it('«Expected» and «Counted» are money too: each edge is scaled the same way', async () => {
    const el = await mount();
    expect(await type(el, 'expected_balance', { from: 100 })).toEqual({ expected_balance: { from: 10000 } });
    expect(await type(el, 'closing_balance', { to: 250 })).toEqual({
      expected_balance: { from: 10000 },
      closing_balance: { to: 25000 },
    });
  });

  it('«to 50» keeps the other edge and asks for 5000 cents, so a 1 € float is not hidden', async () => {
    const el = await mount();
    await type(el, 'opening_balance', { from: 12 });
    expect(await type(el, 'opening_balance', { to: 50 })).toEqual({ opening_balance: { from: 1200, to: 5000 } });
  });

  it('a decimal amount is rounded to the minor unit (12.10 → 1210, never 1209)', async () => {
    const el = await mount();
    expect(await type(el, 'opening_balance', { from: 12.1 })).toEqual({ opening_balance: { from: 1210 } });
    expect(await type(el, 'opening_balance', { to: 0.29 })).toEqual({ opening_balance: { from: 1210, to: 29 } });
  });

  it('the inline control emits text: «12.5» and «12,5» both mean 12,50 €', async () => {
    const el = await mount();
    expect(await type(el, 'opening_balance', { from: '12.5' })).toEqual({ opening_balance: { from: 1250 } });
    expect(await type(el, 'opening_balance', { from: '12,5' })).toEqual({ opening_balance: { from: 1250 } });
  });

  it('uses the scale of the hub currency: 0 decimals (JPY) sends the amount as is, 3 (KWD) ×1000', async () => {
    decimals = 0;
    const jpy = await mount();
    expect(await type(jpy, 'opening_balance', { from: 1999 })).toEqual({ opening_balance: { from: 1999 } });
    jpy.remove();
    decimals = 3;
    const kwd = await mount();
    expect(await type(kwd, 'opening_balance', { from: 1.5 })).toEqual({ opening_balance: { from: 1500 } });
  });

  it('clearing an edge drops it instead of filtering «from 0»', async () => {
    const el = await mount();
    await type(el, 'opening_balance', { from: 12 });
    await type(el, 'opening_balance', { to: 50 });
    expect(await type(el, 'opening_balance', { from: '' })).toEqual({ opening_balance: { to: 5000 } });
    expect(await type(el, 'opening_balance', { to: '' })).toEqual({});
  });

  it('text that is not a number is not turned into «from 0»', async () => {
    // Judged on what the hub RECEIVES (`buildListParams`, what the real `queryPage` sends): the SDK
    // keeps the empty edge until it flattens, and it travels as nothing, never as 0.
    const el = await mount();
    expect(buildListParams({ filters: await type(el, 'opening_balance', { from: 'abc' }) })).toEqual({});
    expect(buildListParams({ filters: await type(el, 'opening_balance', { to: '   ' }) })).toEqual({});
  });

  it('a cleared filter (null) clears it, never a crash', async () => {
    const el = await mount();
    await type(el, 'opening_balance', { from: 12 });
    expect(await type(el, 'opening_balance', null)).toEqual({});
  });

  it('typed in the real Filters panel: asks for cents and the field still shows what was typed', async () => {
    const el = await mount();
    type Table = HTMLElement & { open(panel: 'filters'): void; shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
    const table = el.shadowRoot.querySelector('ok-data-table') as Table;
    table.open('filters');
    await table.updateComplete;
    const fromOfOpening = (): HTMLInputElement => {
      const label = [...table.shadowRoot.querySelectorAll('.flabel')].find((l) => l.textContent === 'ui.colOpening');
      return label!.parentElement!.querySelector('ion-input') as unknown as HTMLInputElement;
    };
    fromOfOpening().value = '12';
    fromOfOpening().dispatchEvent(new CustomEvent('ionInput', { bubbles: true, composed: true }));
    await settle(el);
    await table.updateComplete;
    expect(asked[asked.length - 1]).toEqual({ opening_balance: { from: 1200 } });
    // The cents only travel to the hub: the field keeps «12», never «1200».
    expect(String(fromOfOpening().value)).toBe('12');
  });

  it('other columns travel untouched: the session number stays the text typed and the status its value', async () => {
    const el = await mount();
    expect(await type(el, 'session_number', '12')).toEqual({ session_number: '12' });
    expect(await type(el, 'status', 'open')).toEqual({ session_number: '12', status: 'open' });
  });

  it('«Difference» is money too (cash_register#107): «from 5» asks for 500 cents, not 5', async () => {
    const el = await mount();
    expect(await type(el, 'difference', { from: 5 })).toEqual({ difference: { from: 500 } });
  });

  it('«Difference» takes a shortage: «from -5 to -0.5» asks for -500…-50 cents', async () => {
    // A short drawer is a NEGATIVE difference: the range has to take the minus sign, typed as a
    // Number by the panel or as text («-0,5») by the inline control.
    const el = await mount();
    await type(el, 'difference', { from: -5 });
    expect(await type(el, 'difference', { to: '-0,5' })).toEqual({ difference: { from: -500, to: -50 } });
  });

  it('«Difference» is offered as a from / to range, like its three neighbours', async () => {
    const el = await mount();
    type Table = HTMLElement & { columns: Array<{ key: string; filterType?: string }> };
    const table = el.shadowRoot.querySelector('ok-data-table') as Table;
    const filterTypes = Object.fromEntries(table.columns.map((c) => [c.key, c.filterType]));
    expect(filterTypes).toMatchObject({
      opening_balance: 'range',
      expected_balance: 'range',
      closing_balance: 'range',
      difference: 'range',
    });
  });

  it('typed in the real Filters panel: «Difference from -5» asks for -500 cents and shows «-5»', async () => {
    const el = await mount();
    type Table = HTMLElement & { open(panel: 'filters'): void; shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
    const table = el.shadowRoot.querySelector('ok-data-table') as Table;
    table.open('filters');
    await table.updateComplete;
    const fromOfDifference = (): HTMLInputElement => {
      const label = [...table.shadowRoot.querySelectorAll('.flabel')].find((l) => l.textContent === 'ui.colDifference');
      return label!.parentElement!.querySelector('ion-input') as unknown as HTMLInputElement;
    };
    fromOfDifference().value = '-5';
    fromOfDifference().dispatchEvent(new CustomEvent('ionInput', { bubbles: true, composed: true }));
    await settle(el);
    await table.updateComplete;
    expect(asked[asked.length - 1]).toEqual({ difference: { from: -500 } });
    expect(String(fromOfDifference().value)).toBe('-5');
  });

  it('a range that is not money (the dates `sessions.list` filters by) is never scaled', async () => {
    // The table paints no date column today, but the list query filters `opened_at`/`closed_at`
    // by range: only the money columns are scaled, so a date range added later travels as typed.
    const el = await mount();
    expect(await type(el, 'opened_at', { from: '2026-09-01', to: 20260930 })).toEqual({
      opened_at: { from: '2026-09-01', to: 20260930 },
    });
  });
});
