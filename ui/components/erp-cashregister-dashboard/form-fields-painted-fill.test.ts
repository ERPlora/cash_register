// hub#760 / cash_register#98 — the dashboard forms (open, close, movement, count) must show a BOX
// around every field. The Hub shell pins `mode: 'ios'` (ADR-0143) and there Ionic never paints
// `fill` on ion-input/ion-select/ion-textarea: a `fill="outline"` alone is a silent no-op and a
// control with no `fill` at all renders as loose text, with no border and no surface — the cashier
// cannot see where to type. The one combination that paints is `fill="outline" mode="md"`, which is
// what the shell (Employees, Business settings) and the modules already swept by ERPlora/pm#152
// (customers, tickets, kitchen, inventory, staff, tables) use. The buttons keep their own
// `fill="outline"`: on ion-button it paints in both modes.
import { beforeEach, describe, expect, it } from 'vitest';

const SESSION = {
  id: 's1',
  session_number: 'S-260825-0001',
  status: 'open',
  opening_balance: 15000,
  closing_balance: null,
  expected_balance: 25130,
  difference: null,
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'cash_register.registers.list' ? [{ id: 'reg-1', name: 'Barra' }] : []),
    queryAll: async (name: string) => (name === 'cash_register.registers.list' ? [{ id: 'reg-1', name: 'Barra' }] : []),
    queryPage: async () => ({ rows: [SESSION], total: 1, limit: 50, offset: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    formatAmount: (units: number) => `${(units || 0).toFixed(2)} €`,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
  };
});

interface Wc {
  panel: string | null;
  openPanel(panel: string, session: unknown): void;
  updateComplete: Promise<unknown>;
  shadowRoot: ShadowRoot;
}

async function mount(): Promise<HTMLElement & Wc> {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard') as unknown as HTMLElement & Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

function fieldsOf(el: Wc): Element[] {
  return [...el.shadowRoot.querySelectorAll('ion-input, ion-select, ion-textarea')];
}

/** A field is visible only when its `fill` is real: `outline` AND `mode="md"`, together. */
function expectPaintedFill(f: Element): void {
  const id = f.getAttribute('data-testid') ?? f.tagName;
  expect(f.getAttribute('fill'), `${id}: no fill → no box in ios mode`).toBe('outline');
  expect(f.getAttribute('mode'), `${id}: fill without mode="md" never paints in ios mode`).toBe('md');
}

describe('dashboard form fields paint their box in ios mode (cash_register#98)', () => {
  it('open panel', async () => {
    const el = await mount();
    el.panel = 'open';
    await settle(el);
    const fields = fieldsOf(el);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expectPaintedFill(f);
  });

  for (const panel of ['close', 'movement', 'count'] as const) {
    it(`${panel} panel`, async () => {
      const el = await mount();
      el.openPanel(panel, SESSION);
      await settle(el);
      const fields = fieldsOf(el);
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) expectPaintedFill(f);
    });
  }

  it('buttons keep fill="outline" (it paints on ion-button)', async () => {
    const el = await mount();
    el.openPanel('close', SESSION);
    await settle(el);
    const cancel = el.shadowRoot.querySelector('[data-testid="cash-register-close-cancel"]');
    expect(cancel?.getAttribute('fill')).toBe('outline');
  });
});
