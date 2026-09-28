// Contrato de la PANTALLA DE APERTURA de caja (ADR-0130).
//
// Es la pantalla que el shell INTERPONE en la ruta del TPV cuando la caja está activada y no hay
// sesión abierta (patrón «Opening Control» de Odoo / Lightspeed / Loyverse / SumUp: no se vende sin
// abrir caja). El cajero mete el fondo inicial, abre, y el shell remonta el TPV en la MISMA ruta —
// sin baile de navegación.
//
// No es un panel del dashboard de caja: es un componente propio precisamente porque lo monta OTRO
// módulo (la ruta protegida es de `sales`). Por eso el contrato importa:
//   • pide el fondo de apertura,
//   • si hay más de un cajón, obliga a elegir cuál (la sesión es del TERMINAL, no del cajero),
//   • al abrir emite `cash_register.session_opened` → el shell lo escucha (`resume_on`) y remonta.
import { beforeEach, describe, expect, it } from 'vitest';

const CAJONES = [
  { id: 'reg-1', name: 'Barra' },
  { id: 'reg-2', name: 'Sala' },
];

let comandos: { name: string; payload: Record<string, unknown> }[] = [];
let registros: { id: string; name: string }[] = [];

beforeEach(() => {
  comandos = [];
  registros = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'cash_register.registers.list' ? registros : []),
    queryAll: async (name: string) => (name === 'cash_register.registers.list' ? registros : []),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

async function montar() {
  await import('./erp-cashregister-open');
  const el = document.createElement('erp-cashregister-open');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { shadowRoot: ShadowRoot };
}

/** Teclear en un ion-input: asignar `.value` NO dispara nada — el WC escucha `ionInput`. */
function teclear(el: HTMLElement & { shadowRoot: ShadowRoot }, selector: string, valor: string) {
  const input = el.shadowRoot.querySelector(selector) as HTMLElement & { value: string };
  input.value = valor;
  input.dispatchEvent(new CustomEvent('ionInput', { bubbles: true, composed: true }));
}

describe('erp-cashregister-open', () => {
  it('pide el fondo de apertura y ofrece abrir la caja', async () => {
    const el = await montar();
    expect(el.shadowRoot.querySelector('ion-input[data-testid="cash-register-opening-balance"]'), 'falta el fondo de apertura').toBeTruthy();
    expect(el.shadowRoot.querySelector('ion-button.open-session')).toBeTruthy();
  });

  it('con UN solo cajón no pregunta cuál: lo asume', async () => {
    registros = [CAJONES[0]];
    const el = await montar();
    // Un salón o un bar pequeño tienen un cajón. Preguntar cuál es fricción diaria inútil.
    expect(el.shadowRoot.querySelector('ion-select')).toBeFalsy();

    teclear(el, 'ion-input[data-testid="cash-register-opening-balance"]', '150');
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const abrir = comandos.find((c) => c.name === 'cash_register.session.open');
    expect(abrir!.payload.register_id).toBe('reg-1');
  });

  it('con VARIOS cajones obliga a elegir uno antes de abrir', async () => {
    registros = CAJONES;
    const el = await montar();
    const select = el.shadowRoot.querySelector('ion-select');
    expect(select, 'con varios cajones hay que elegir terminal').toBeTruthy();

    // Sin elegir cajón NO se abre: la sesión es del TERMINAL, y una sesión sin terminal no cuadra
    // con ningún arqueo físico.
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(comandos.find((c) => c.name === 'cash_register.session.open')).toBeFalsy();
    expect(el.shadowRoot.querySelector('.error')?.textContent?.trim()).toBeTruthy();
  });

  it('el fondo de apertura viaja en CÉNTIMOS, no en euros', async () => {
    registros = [CAJONES[0]];
    const el = await montar();
    teclear(el, 'ion-input[data-testid="cash-register-opening-balance"]', '150.50');
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));

    // El dinero es INTEGER en céntimos (ADR-0007/0123). 150,50 € = 15050, no 150.5.
    const abrir = comandos.find((c) => c.name === 'cash_register.session.open')!;
    expect(abrir.payload.opening_balance).toBe(15050);
  });

  // cash_register#49 — el NÚMERO DE TURNO lo acuña el servidor con un contador atómico por (hub,
  // día). Esta pantalla componía `S-YYMMDD-HHMMSS`, que además podía COLISIONAR entre dos
  // terminales que abrieran caja el mismo segundo. Si sigue mandándolo, hay dos formatos vivos
  // según por dónde se abra la caja — que es justo el fallo.
  it('no compone el número de turno: eso es del servidor', async () => {
    registros = [CAJONES[0]];
    const el = await montar();
    teclear(el, 'ion-input[data-testid="cash-register-opening-balance"]', '150.50');
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const abrir = comandos.find((c) => c.name === 'cash_register.session.open')!;
    expect(abrir.payload).not.toHaveProperty('session_number');
  });

  // cash_register#11: two devices on the guard screen press "Open" at once → the database keeps ONE
  // and refuses the other with `cash_register.session_already_open`. The loser reads it in their
  // language, not the raw English fallback of the server.
  it('si el servidor rechaza con `cash_register.session_already_open`, muestra el texto traducido', async () => {
    registros = [CAJONES[0]];
    const el = await montar();
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = async () => {
      const e = new Error('A cash session is already open for this business.') as Error & { code: string };
      e.code = 'cash_register.session_already_open';
      throw e;
    };
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(el.shadowRoot.querySelector('.error')?.textContent?.trim()).toBe('ui.errSessionAlreadyOpen');
  });
});

// cash_register#93 — this screen is mounted precisely because NO session is open. Its subtitle used
// the success message `ui.msgSessionOpened` («Sesión abierta»), contradicting the title in the same
// card. It must explain why the till is blocked, in both languages.
describe('erp-cashregister-open · subtitle', () => {
  it('does not claim the session is open while asking to open it', async () => {
    const el = await montar();
    const sub = el.shadowRoot.querySelector('p.sub')?.textContent?.trim();
    expect(sub).not.toBe('ui.msgSessionOpened');
    expect(sub).toBe('ui.subOpenToContinue');
  });

  it('the subtitle key is translated in en and es', async () => {
    const en = (await import('../../../locales/en.json')).default as { ui: Record<string, string> };
    const es = (await import('../../../locales/es.json')).default as { ui: Record<string, string> };
    expect(en.ui.subOpenToContinue).toBeTruthy();
    expect(es.ui.subOpenToContinue).toBeTruthy();
    expect(es.ui.subOpenToContinue).not.toBe(en.ui.subOpenToContinue);
  });
});

// cash_register#100 — the fields of this screen must show a BOX, like the dashboard panels
// (cash_register#98). The Hub shell pins `mode: 'ios'` (ADR-0143) and there Ionic never paints
// `fill` on ion-input/ion-select/ion-textarea: no `fill` renders as loose text and `fill="outline"`
// alone is a silent no-op. The one combination that paints is `fill="outline" mode="md"`, the
// shell's (hub#760). Same assertion as erp-cashregister-dashboard/form-fields-painted-fill.test.ts.
it('form fields paint their box in ios mode (fill="outline" + mode="md")', async () => {
  registros = CAJONES;
  const el = await montar();
  const fields = [...el.shadowRoot.querySelectorAll('ion-input, ion-select, ion-textarea')];
  expect(fields.map((f) => f.getAttribute('data-testid'))).toEqual([
    'cash-register-opening-register',
    'cash-register-opening-balance',
    'cash-register-opening-notes',
  ]);
  for (const f of fields) {
    const id = f.getAttribute('data-testid');
    expect(f.getAttribute('fill'), `${id}: no fill → no box in ios mode`).toBe('outline');
    expect(f.getAttribute('mode'), `${id}: fill without mode="md" never paints in ios mode`).toBe('md');
  }
});

// cash_register#106 — the opening float is typed in MAJOR units of the HUB's currency and stored in
// its MINOR units (ADR-0123). The screen used a fixed ×100: in a yen hub «1000» was stored as
// 100 000 yen, and in a Kuwaiti-dinar hub «10,5» as 1,050 fils instead of 10,500. The scale is
// `erplora.currencyDecimals`, the same one the close and the dashboard already use. Since pm#521
// the field is text (no `step`): leaving it rewrites the amount with the scale of the currency.
describe('erp-cashregister-open · opening float in the hub currency scale (cash_register#106)', () => {
  async function openWith(decimals: number | undefined, typed: string, currency?: string) {
    registros = [CAJONES[0]];
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    if (decimals !== undefined) sdk.currencyDecimals = decimals;
    if (currency !== undefined) sdk.currency = currency;
    const el = await montar();
    teclear(el, 'ion-input[data-testid="cash-register-opening-balance"]', typed);
    const input = el.shadowRoot.querySelector('ion-input[data-testid="cash-register-opening-balance"]')!;
    input.dispatchEvent(new CustomEvent('ionBlur', { bubbles: true, composed: true }));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const shown = (input as HTMLElement & { value: string }).value;
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const open = comandos.find((c) => c.name === 'cash_register.session.open')!;
    return { balance: open.payload.opening_balance, shown };
  }

  it('JPY (0 decimals): 1000 yen is stored as 1000, and the field keeps whole yen', async () => {
    expect(await openWith(0, '1000', 'JPY')).toEqual({ balance: 1000, shown: '1000' });
  });

  it('EUR (2 decimals): «150,50» is stored as 15050 cents', async () => {
    expect(await openWith(2, '150,5', 'EUR')).toEqual({ balance: 15050, shown: '150,50' });
  });

  it('KWD (3 decimals): «10,5» is stored as 10500 fils, and the field shows fils', async () => {
    expect(await openWith(3, '10,5', 'KWD')).toEqual({ balance: 10500, shown: '10,500' });
  });

  it('a shell that does not inject the scale falls back to 2 decimals, never NaN', async () => {
    expect(await openWith(undefined, '0,29')).toEqual({ balance: 29, shown: '0,29' });
  });
});

// pm#521 — the float is read with the toolkit's `money-input`, like every other money field of
// the hub. This screen was `type="number"`: a real browser DROPS a pasted «1.250,50» (the value
// arrives empty) and the till opened with 0; and what did arrive went through
// `replace(',', '.')`, so «1.250» opened with 1,25 €.
describe('erp-cashregister-open · what is typed or pasted in the float (pm#521)', () => {
  async function typeAndOpen(typed: string) {
    comandos = [];
    registros = [CAJONES[0]];
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.currency = 'EUR';
    sdk.currencyDecimals = 2;
    sdk.t = (_catalog: unknown, key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key;
    const el = await montar();
    teclear(el, 'ion-input[data-testid="cash-register-opening-balance"]', typed);
    el.shadowRoot.querySelector<HTMLElement>('ion-button.open-session')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    return {
      sent: comandos.find((c) => c.name === 'cash_register.session.open')?.payload.opening_balance,
      error: el.shadowRoot.querySelector('[data-testid="cash-register-opening-error"]')?.textContent?.trim(),
    };
  }

  it('the field is text with a decimal keypad, never type="number"', async () => {
    const el = await montar();
    const input = el.shadowRoot.querySelector('ion-input[data-testid="cash-register-opening-balance"]')!;
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });

  it('«1.250,50» opens with 125050, and so does a copy with a narrow no-break space', async () => {
    expect(await typeAndOpen('1.250,50')).toEqual({ sent: 125050, error: undefined });
    expect((await typeAndOpen('1\u202f250,50')).sent).toBe(125050);
  });

  it('«1.250» is ambiguous: nothing is opened and both readings are shown', async () => {
    expect(await typeAndOpen(' 1.250 ')).toEqual({
      sent: undefined,
      error: `ui.errAmbiguousAmount ${JSON.stringify({ typed: '1.250', grouped: '1250,00', decimal: '1,25' })}`,
    });
  });

  it('garbage and a negative float say why and open nothing', async () => {
    expect(await typeAndOpen('abc')).toEqual({ sent: undefined, error: 'ui.errNotAnAmount' });
    expect(await typeAndOpen('-1.250,50')).toEqual({ sent: undefined, error: 'ui.errNegativeAmount' });
  });

  it('an empty float opens with 0', async () => {
    expect(await typeAndOpen('')).toEqual({ sent: 0, error: undefined });
  });
});
