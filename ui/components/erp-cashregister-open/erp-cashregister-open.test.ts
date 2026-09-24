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
    expect(el.shadowRoot.querySelector('ion-input[type="number"]'), 'falta el fondo de apertura').toBeTruthy();
    expect(el.shadowRoot.querySelector('ion-button.open-session')).toBeTruthy();
  });

  it('con UN solo cajón no pregunta cuál: lo asume', async () => {
    registros = [CAJONES[0]];
    const el = await montar();
    // Un salón o un bar pequeño tienen un cajón. Preguntar cuál es fricción diaria inútil.
    expect(el.shadowRoot.querySelector('ion-select')).toBeFalsy();

    teclear(el, 'ion-input[type="number"]', '150');
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
    teclear(el, 'ion-input[type="number"]', '150.50');
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
    teclear(el, 'ion-input[type="number"]', '150.50');
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
