// Every money field of the till dashboard reads what is typed or pasted with the toolkit's
// `money-input` (pm#521): the opening float, the counted cash of the close, a cash movement and
// the typed total of a count.
//
// The screen prints money as «1.250,50 €», and that is exactly what a person copies back. The
// till read it with `replace(',', '.')` + `majorToMinor`: the float opened with 0, and «1.250» in
// the counted cash closed the shift declaring 1,25 € — a fabricated shortage of the whole drawer,
// with no error anywhere. And a pasted «-12» movement was silently turned into +12.
import { beforeEach, describe, expect, it } from 'vitest';

type Cmd = { name: string; payload: Record<string, unknown> };
let comandos: Cmd[] = [];

function hub(currency = 'EUR', currencyDecimals = 2) {
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
    formatMoney: (minor: number) => `${((minor || 0) / 10 ** currencyDecimals).toFixed(currencyDecimals)} ${currency}`,
    currencyDecimals,
  };
}

beforeEach(() => hub());

type Wc = HTMLElement & {
  updateComplete: Promise<unknown>;
  panel: string | null;
  formError: string;
  openBalance: string;
  closeBalance: string;
  movAmount: string;
  movType: 'in' | 'out';
  countTotalInput: string;
  expectedForClose: number | null;
  openPanel(panel: string, session: unknown): void;
  openSession(e: Event): Promise<void>;
  closeSession(e: Event): Promise<void>;
  addMovement(e: Event): Promise<void>;
  addCount(e: Event): Promise<void>;
};

const S1 = { id: 's1', session_number: 'S-1', status: 'open' };

async function mount(): Promise<Wc> {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

async function settle(el: Wc) {
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

const byId = (el: Wc, id: string) => el.shadowRoot!.querySelector(`[data-testid="${id}"]`) as (HTMLElement & { value: string }) | null;
const sent = (name: string) => comandos.find((c) => c.name === name)?.payload;
const AMBIGUOUS = `ui.errAmbiguousAmount ${JSON.stringify({ typed: '1.250', grouped: '1250,00', decimal: '1,25' })}`;

/** Types into a money field and leaves it: `ionInput` then `ionBlur`, as Ionic fires them. */
async function typeAndLeave(el: Wc, id: string, typed: string) {
  const field = byId(el, id)!;
  field.value = typed;
  field.dispatchEvent(new CustomEvent('ionInput', { bubbles: true, composed: true }));
  await el.updateComplete;
  field.dispatchEvent(new CustomEvent('ionBlur', { bubbles: true, composed: true }));
  await el.updateComplete;
}

describe('the money fields are text with a decimal keypad, never type="number"', () => {
  // type="number" DROPS a pasted «1.250,50» in a real browser: the value arrives empty.
  it.each([
    ['open', 'cash-register-open-balance'],
    ['close', 'cash-register-close-counted'],
    ['movement', 'cash-register-movement-amount'],
  ])('%s: %s', async (panel, id) => {
    const el = await mount();
    if (panel === 'open') el.panel = 'open';
    else el.openPanel(panel, S1);
    await settle(el);
    const field = byId(el, id)!;
    expect(field.getAttribute('type')).toBe('text');
    expect(field.getAttribute('inputmode')).toBe('decimal');
  });
});

describe('open the till (dashboard)', () => {
  const open = async (typed: string) => {
    const el = await mount();
    el.panel = 'open';
    await el.updateComplete;
    el.openBalance = typed;
    await el.openSession(new Event('submit'));
    return el;
  };

  it('«1.250,50» opens with 1.250,50 €, not 0', async () => {
    await open('1.250,50');
    expect(sent('cash_register.session.open')?.opening_balance).toBe(125050);
  });

  it('«1.250» is ambiguous: nothing is opened and both readings are shown', async () => {
    const el = await open(' 1.250 ');
    expect(sent('cash_register.session.open')).toBeUndefined();
    expect(el.formError).toBe(AMBIGUOUS);
  });

  it('garbage is not an amount: nothing is opened', async () => {
    const el = await open('abc');
    expect(sent('cash_register.session.open')).toBeUndefined();
    expect(el.formError).toBe('ui.errNotAnAmount');
  });

  it('a negative float is refused, not opened negative nor turned positive', async () => {
    for (const typed of ['-1.250,50', '\u22121.250,50']) {
      const el = await open(typed);
      expect(sent('cash_register.session.open'), typed).toBeUndefined();
      expect(el.formError).toBe('ui.errNegativeAmount');
      el.remove();
    }
  });

  it('an empty float opens with 0 (the column is NOT NULL and 0 is a legitimate float)', async () => {
    await open('');
    expect(sent('cash_register.session.open')?.opening_balance).toBe(0);
  });

  it('leaving the field rewrites it in the hub format', async () => {
    const el = await mount();
    el.panel = 'open';
    await el.updateComplete;
    await typeAndLeave(el, 'cash-register-open-balance', '1.250,5');
    expect(el.openBalance).toBe('1250,50');
  });
});

describe('close the till: the counted cash', () => {
  const close = async (typed: string) => {
    const el = await mount();
    el.openPanel('close', S1);
    await settle(el);
    el.closeBalance = typed;
    await el.closeSession(new Event('submit'));
    return el;
  };

  it('«1.250,50» closes with 1.250,50 € counted', async () => {
    await close('1.250,50');
    expect(sent('cash_register.session.close')?.closing_balance).toBe(125050);
  });

  it('«1.250» does NOT close declaring 1,25 €: it asks which one was meant', async () => {
    const el = await close('1.250');
    expect(sent('cash_register.session.close')).toBeUndefined();
    expect(el.formError).toBe(AMBIGUOUS);
  });

  it('garbage and negatives say why; empty still asks for the count', async () => {
    for (const [typed, key] of [['abc', 'ui.errNotAnAmount'], ['-5', 'ui.errNegativeAmount'], ['', 'ui.errCountedCashRequired']]) {
      const el = await close(typed);
      expect(sent('cash_register.session.close'), `«${typed}» closed the till`).toBeUndefined();
      expect(el.formError, typed).toBe(key);
      el.remove();
    }
  });

  it('the live difference reads the same gate: a dash while the amount is ambiguous', async () => {
    const el = await mount();
    el.openPanel('close', S1);
    await settle(el);
    el.expectedForClose = 100000;
    el.closeBalance = '1.250,50';
    await el.updateComplete;
    const diff = () => (el as unknown as { closeReconcileItems: { value: string }[] }).closeReconcileItems[1].value;
    expect(diff()).toBe('+250.50 EUR');
    el.closeBalance = '1.250';
    expect(diff()).toBe('—');
  });

  it('leaving the field rewrites it in the hub format', async () => {
    const el = await mount();
    el.openPanel('close', S1);
    await settle(el);
    await typeAndLeave(el, 'cash-register-close-counted', '1.250,5');
    expect(el.closeBalance).toBe('1250,50');
  });
});

describe('a cash movement', () => {
  const move = async (typed: string, type: 'in' | 'out' = 'in') => {
    const el = await mount();
    el.openPanel('movement', S1);
    await settle(el);
    el.movType = type;
    el.movAmount = typed;
    await el.addMovement(new Event('submit'));
    return el;
  };

  it('«1.250,50» moves 1.250,50 €, not 0', async () => {
    await move('1.250,50', 'out');
    expect(sent('cash_register.movement.add')).toMatchObject({ movement_type: 'out', amount: 125050 });
  });

  it('a pasted negative is refused, never silently turned into a cash-in', async () => {
    const el = await move('-12', 'in');
    expect(sent('cash_register.movement.add')).toBeUndefined();
    expect(el.formError).toBe('ui.errNegativeAmount');
  });

  it('«1.250» is ambiguous and 0 is no movement', async () => {
    let el = await move('1.250');
    expect(sent('cash_register.movement.add')).toBeUndefined();
    expect(el.formError).toBe(AMBIGUOUS);
    el.remove();
    el = await move('0');
    expect(sent('cash_register.movement.add')).toBeUndefined();
    expect(el.formError).toBe('ui.errInvalidAmount');
  });

  it('leaving the field rewrites it in the hub format', async () => {
    const el = await mount();
    el.openPanel('movement', S1);
    await settle(el);
    await typeAndLeave(el, 'cash-register-movement-amount', '12');
    expect(el.movAmount).toBe('12,00');
  });
});

describe('a count typed as a total (a currency without a notes-and-coins table)', () => {
  const count = async (typed: string) => {
    hub('XTS', 2);
    const el = await mount();
    el.openPanel('count', S1);
    await settle(el);
    el.countTotalInput = typed;
    await el.updateComplete;
    return el;
  };

  it('«1.250,50» is recorded as 125050 minor units', async () => {
    const el = await count('1.250,50');
    await el.addCount(new Event('submit'));
    expect(sent('cash_register.count.add')?.total).toBe(125050);
  });

  it('what cannot be read says why under the field, and is not recorded', async () => {
    for (const [typed, key] of [['1.250', AMBIGUOUS],['abc', 'ui.errNotAnAmount'], ['-5', 'ui.errNegativeAmount']]) {
      const el = await count(typed);
      expect(byId(el, 'cash-register-count-total-error')?.textContent?.trim(), typed).toBe(key);
      expect(byId(el, 'cash-register-count-submit')!.hasAttribute('disabled'), typed).toBe(true);
      await el.addCount(new Event('submit'));
      expect(sent('cash_register.count.add'), typed).toBeUndefined();
      el.remove();
    }
  });

  it('an empty field disables the submit without scolding the person', async () => {
    const el = await count('');
    expect(byId(el, 'cash-register-count-total-error')).toBeNull();
    expect(byId(el, 'cash-register-count-submit')!.hasAttribute('disabled')).toBe(true);
  });

  it('leaving the field rewrites it in the hub format', async () => {
    const el = await count('');
    await typeAndLeave(el, 'cash-register-count-total-input', '1250,5');
    expect(el.countTotalInput).toBe('1250,50');
  });
});
