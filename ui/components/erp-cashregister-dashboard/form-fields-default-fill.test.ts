// Monorepo rule: `fill="outline"` is a no-op on ion-input/ion-select/ion-textarea in `ios` mode (the
// shell pins it), so the attribute only made the dashboard forms render differently per platform.
// Every panel of the dashboard (open, close, movement, count) uses the default fill; the buttons
// keep `fill="outline"` because on ion-button it does paint (cash_register#98, sibling of #97).
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

describe('dashboard form fields use the default fill (cash_register#98)', () => {
  it('open panel', async () => {
    const el = await mount();
    el.panel = 'open';
    await settle(el);
    const fields = fieldsOf(el);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.getAttribute('fill'), f.getAttribute('data-testid') ?? f.tagName).toBeNull();
  });

  for (const panel of ['close', 'movement', 'count'] as const) {
    it(`${panel} panel`, async () => {
      const el = await mount();
      el.openPanel(panel, SESSION);
      await settle(el);
      const fields = fieldsOf(el);
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) expect(f.getAttribute('fill'), f.getAttribute('data-testid') ?? f.tagName).toBeNull();
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
