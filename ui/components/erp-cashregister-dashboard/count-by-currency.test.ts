// The till count («Registrar arqueo», and the closing count that leads to the close) in the HUB
// currency (cash_register#111). The card used to show the euro's notes and coins in every hub and
// add them up ×100: in yen there was no ¥1000 note to count and each ¥1 coin booked ¥100; in Kuwaiti
// dinars the total came out ten times short. Now the card shows the notes and coins of the hub
// currency and adds them up with its scale; a currency the module has no table for gets no
// breakdown at all — the person types the total — never the euro one.
import { beforeEach, describe, expect, it } from 'vitest';
import enLocale from '../../../locales/en.json';
import esLocale from '../../../locales/es.json';

type Cmd = { name: string; payload: Record<string, unknown> };
let comandos: Cmd[] = [];

function hub(currency: string, currencyDecimals: number) {
  comandos = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
    queryOptional: async () => undefined,
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
    currency,
    formatAmount: (units: number) => `${units} ${currency}`,
    // Minor units in, the hub currency out — the shell divides by the currency's own scale.
    formatMoney: (minor: number) => `${((minor || 0) / 10 ** currencyDecimals).toFixed(currencyDecimals)} ${currency}`,
    currencyDecimals,
  };
}

beforeEach(() => hub('EUR', 2));

type Wc = HTMLElement & {
  updateComplete: Promise<unknown>;
  panel: string | null;
  target: unknown;
  countType: string;
  denomCounts: Record<string, string>;
  countTotalInput: string;
  countTotalMinor(): number;
  addCount(e: Event): Promise<void>;
  openPanel(panel: string, session: unknown): void;
  formMsg: string;
};

const S1 = { id: 's1', session_number: 'S-1', status: 'open' };
const S2 = { id: 's2', session_number: 'S-2', status: 'open' };

async function countCard(): Promise<Wc> {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  el.openPanel('count', S1);
  await el.updateComplete;
  return el;
}

const denomIds = (el: Wc) =>
  [...el.shadowRoot!.querySelectorAll('[data-testid^="cash-register-count-denom-"]')].map((n) =>
    n.getAttribute('data-testid')!.replace('cash-register-count-denom-', ''),
  );
const byId = (el: Wc, id: string) => el.shadowRoot!.querySelector(`[data-testid="${id}"]`);
const countCmd = () => comandos.find((c) => c.name === 'cash_register.count.add')?.payload;

describe('the count card shows the notes and coins of the hub currency', () => {
  it('EUR: the euro drawer, as before (500 € … 0,01 €)', async () => {
    const el = await countCard();
    expect(denomIds(el)).toEqual(['500', '200', '100', '50', '20', '10', '5', '2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01']);
  });

  it('JPY: yen notes and coins — the ¥1000 note is there, no euro cents', async () => {
    hub('JPY', 0);
    const el = await countCard();
    expect(denomIds(el)).toEqual(['10000', '5000', '2000', '1000', '500', '100', '50', '10', '5', '1']);
  });

  it('KWD: down to the 5-fils coin', async () => {
    hub('KWD', 3);
    const el = await countCard();
    expect(denomIds(el)).toContain('0.005');
    expect(denomIds(el)).not.toContain('0.50');
  });
});

describe('the count adds up with the hub currency scale, on screen and in what is sent', () => {
  const run = async (currency: string, decimals: number, counts: Record<string, string>) => {
    hub(currency, decimals);
    const el = await countCard();
    el.denomCounts = counts;
    await el.updateComplete;
    const shown = byId(el, 'cash-register-count-total')!.textContent;
    await el.addCount(new Event('submit'));
    return { el, shown, sent: countCmd() };
  };

  it('EUR (2 decimals): 2 × 50 € + 3 × 0,05 € is 100,15 €', async () => {
    const { shown, sent } = await run('EUR', 2, { '50': '2', '0.05': '3' });
    expect(shown?.trim()).toBe('ui.totalCounted: 100.15 EUR');
    expect(sent?.denominations).toEqual({ bills: { '50': 2 }, coins: { '0.05': 3 } });
  });

  it('JPY (0 decimals): 5 × ¥1000 + 3 × ¥1 is ¥5003, not ¥500300', async () => {
    const { el, shown, sent } = await run('JPY', 0, { '1000': '5', '1': '3' });
    expect(shown?.trim()).toBe('ui.totalCounted: 5003 JPY');
    expect(sent?.denominations).toEqual({ bills: { '1000': 5 }, coins: { '1': 3 } });
    expect(sent).not.toHaveProperty('total');
    // The confirmation quotes the same total the server will store.
    expect(el.formMsg).toContain('5003 JPY');
  });

  it('KWD (3 decimals): 2 × 0.25 + 3 × 0.005 is 0.515 KWD, not 0.053', async () => {
    const { shown, sent } = await run('KWD', 3, { '0.25': '2', '0.005': '3' });
    expect(shown?.trim()).toBe('ui.totalCounted: 0.515 KWD');
    expect(sent?.denominations).toEqual({ bills: { '0.25': 2 }, coins: { '0.005': 3 } });
  });

  it('a count the server would ignore (blank, negative) adds nothing on screen either', async () => {
    const { shown, sent } = await run('EUR', 2, { '50': '-2', '10': '', '5': '1' });
    expect(shown?.trim()).toBe('ui.totalCounted: 5.00 EUR');
    expect(sent?.denominations).toEqual({ bills: { '5': 1 }, coins: {} });
  });

  it('a fractional count («2.5» notes) is the whole pieces the server stores, on screen too', async () => {
    // The handler truncates each count to whole pieces; the screen and the confirmation must quote
    // that same total, not 2.5 × 10 € = 25 € for a count stored as 20 €.
    const { el, shown, sent } = await run('EUR', 2, { '10': '2.5' });
    expect(shown?.trim()).toBe('ui.totalCounted: 20.00 EUR');
    expect(sent?.denominations).toEqual({ bills: { '10': 2 }, coins: {} });
    expect(el.formMsg).toContain('20.00 EUR');
  });
});

describe('a currency without a denomination table: no breakdown, the total is typed', () => {
  const manual = async (currency: string, decimals: number, typed: string) => {
    hub(currency, decimals);
    const el = await countCard();
    el.countTotalInput = typed;
    await el.updateComplete;
    return el;
  };

  it('shows NO notes or coins — least of all the euro ones — and a total field instead', async () => {
    const el = await manual('XAF', 0, '');
    expect(denomIds(el)).toEqual([]);
    expect(el.shadowRoot!.querySelector('.denoms')).toBeNull();
    const field = byId(el, 'cash-register-count-total-input');
    expect(field, 'the typed-total field is missing').not.toBeNull();
    // Same money field as opening/closing: text + decimal keypad (a comma must be typeable).
    expect(field!.getAttribute('type')).toBe('text');
    expect(field!.getAttribute('inputmode')).toBe('decimal');
    // It says why there is no breakdown (and does not pretend there is one).
    expect(byId(el, 'cash-register-count-no-breakdown')?.textContent).toContain('ui.countNoBreakdown');
  });

  it('0 decimals: «1500» is recorded as a total of 1500, with no denominations', async () => {
    const el = await manual('XAF', 0, '1500');
    await el.addCount(new Event('submit'));
    expect(countCmd()?.total).toBe(1500);
    expect(countCmd()).not.toHaveProperty('denominations');
    expect(el.formMsg).toContain('1500 XAF');
  });

  it('3 decimals: «10,5» is recorded as 10500 minor units', async () => {
    const el = await manual('XTS', 3, '10,5');
    await el.addCount(new Event('submit'));
    expect(countCmd()?.total).toBe(10500);
  });

  it('nothing typed, or not an amount: the count cannot be recorded', async () => {
    for (const typed of ['', 'abc', '-5']) {
      const el = await manual('XAF', 0, typed);
      const submit = byId(el, 'cash-register-count-submit') as HTMLElement & { disabled: boolean };
      expect(submit.hasAttribute('disabled'), `«${typed}» enabled the submit`).toBe(true);
      await el.addCount(new Event('submit'));
      expect(countCmd(), `«${typed}» reached the server`).toBeUndefined();
      el.remove();
    }
  });
});

describe('the count starts clean for every session', () => {
  it('after recording, and when the card is opened for another session, nothing carries over', async () => {
    hub('XAF', 0);
    const el = await countCard();
    el.countTotalInput = '1500';
    await el.addCount(new Event('submit'));
    el.openPanel('count', S2);
    expect(el.countTotalInput).toBe('');

    el.countTotalInput = '700';
    el.denomCounts = { '50': '1' };
    el.openPanel('count', S1); // abandoned for S2, now counting S1
    expect(el.countTotalInput).toBe('');
    expect(el.denomCounts).toEqual({});
  });
});

describe('the no-breakdown notice is written in both languages', () => {
  const read = (lang: string) => ((lang === 'en' ? enLocale : esLocale) as { ui: Record<string, string> }).ui;

  it('en and es say there is no breakdown for the currency and ask for the total', () => {
    const en = read('en').countNoBreakdown as string;
    const es = read('es').countNoBreakdown as string;
    expect(en).toMatch(/notes and coins/i);
    expect(en).toContain('{currency}');
    expect(es).toMatch(/billetes y monedas/i);
    expect(es).toContain('{currency}');
    expect(read('en').countTotalInput).toBeTruthy();
    expect(read('es').countTotalInput).toBeTruthy();
  });
});
