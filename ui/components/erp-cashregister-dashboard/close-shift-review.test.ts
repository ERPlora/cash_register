// El cierre REVISA el turno antes de cerrarlo (cash_register#68).
//
// El defecto que esto fija: se cierra la caja del día y la sesión se cierra sin una palabra, aunque
// queden comandas sin servir en la pantalla de cocina y trabajos de impresión encolados. Reproducido
// en la pasada de QA de restaurante del 25/08: dos comandas abiertas de la mesa S1 y dos impresiones
// pendientes; `cash_register.session.close` cerró el turno en silencio.
//
// Lo que hace el mercado: el *Shift Review* de Toast, y el informe previo a la Z de Square y
// Lightspeed, LISTAN lo que queda abierto y piden una confirmación explícita — pero **nunca lo
// impiden**. El cierre es el único momento en que alguien mira el día entero; negarse a cerrar solo
// dejaría el cajón a medias.
//
// Modularidad (ADR-0127): `cash_register` NO depende de `kitchen` —una peluquería instala la caja y
// nunca instala cocina—, así que las comandas se leen por la puerta OPCIONAL y la cola de impresión
// por el namespace reservado `hub.` del runtime (ADR-0192/ADR-0196). Un hub SIN cocina cierra
// exactamente como cerraba: ese es el último test de este fichero.
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

const OTHER_SESSION = { ...SESSION, id: 's2', session_number: 'S-260825-0002' };

/** Una línea del feed del KDS (`kitchen.orders.display`): UNA FILA POR LÍNEA de la comanda. */
function linea(orderId: string, label: string | null): Record<string, unknown> {
  return { order_id: orderId, order_number: `K-${orderId}`, label, order_status: 'pending', product_name: 'Tortilla' };
}

let comandos: { name: string; payload: Record<string, unknown> }[] = [];
let preguntadas: string[] = [];
let kitchen: unknown;
let cobertura: unknown;
/** `undefined` = cocina NO instalada (lo que `queryOptional` responde, ADR-0127). */
let cocinaInstalada = true;

beforeEach(() => {
  comandos = [];
  preguntadas = [];
  cocinaInstalada = true;
  kitchen = [];
  cobertura = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => {
      preguntadas.push(name);
      if (name === 'hub.print.coverage') return cobertura;
      return [];
    },
    queryOptional: async (name: string) => {
      preguntadas.push(name);
      if (name === 'kitchen.orders.display') return cocinaInstalada ? kitchen : undefined;
      return undefined;
    },
    queryAll: async () => [],
    queryPage: async () => ({ rows: [SESSION], total: 1, limit: 50, offset: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    // La clave ES el contrato (ADR-0055): los tests afirman sobre ella y sobre los parámetros que
    // recibe, nunca sobre la prosa traducida.
    t: (_catalog: unknown, key: string, params?: Record<string, unknown>) =>
      (params ? `${key}(${JSON.stringify(params)})` : key),
    currency: 'EUR',
    formatAmount: (units: number) => `${(units || 0).toFixed(2)} €`,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
  };
});

interface Wc {
  panel: string | null;
  target: { id: string } | null;
  closeBalance: string;
  openPanel(panel: string, session: unknown): void;
  closeSession(e: Event): Promise<void>;
  resetPanel(): void;
  updateComplete: Promise<unknown>;
  shadowRoot: ShadowRoot | null;
}

async function montar(): Promise<HTMLElement & Wc> {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as unknown as HTMLElement & Wc;
}

async function asentar(el: Wc): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
}

function pintado(el: Wc): string {
  return el.shadowRoot?.textContent ?? '';
}

async function abrirCierre(el: Wc, session: unknown = SESSION): Promise<void> {
  el.openPanel('close', session);
  await asentar(el);
}

describe('el cierre revisa el turno antes de cerrarlo (cash_register#68)', () => {
  it('con comandas sin servir, el panel de cierre AVISA y dice cuántas y cuáles', async () => {
    kitchen = [linea('a', 'S1'), linea('a', 'S1'), linea('b', 'S2')];
    const el = await montar();
    await abrirCierre(el);

    const texto = pintado(el);
    expect(texto, 'el aviso nombra su clave i18n, no una frase suelta').toContain('ui.shiftReviewOrders');
    expect(texto, 'DOS comandas vivas, aunque el feed traiga tres líneas').toContain('"count":2');
    expect(texto, 'sin saber QUÉ mesa, el aviso no sirve para ir a buscarla').toContain('S1');
    expect(texto).toContain('S2');
  });

  it('con impresiones encoladas, el aviso las cuenta y nombra la estación', async () => {
    cobertura = [
      { role: 'kitchen', waiting: 2, liveHosts: 0, waitingSeconds: 900, undrained: true },
      { role: 'receipt', waiting: 0, liveHosts: 1, waitingSeconds: 0, undrained: false },
    ];
    const el = await montar();
    await abrirCierre(el);

    const texto = pintado(el);
    expect(texto).toContain('ui.shiftReviewPrints');
    expect(texto).toContain('"count":2');
    expect(texto).toContain('kitchen');
  });

  it('el primer intento de cerrar con trabajo pendiente NO cierra: pide confirmación explícita', async () => {
    kitchen = [linea('a', 'S1')];
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';

    await el.closeSession(new Event('submit'));
    await asentar(el);

    expect(
      comandos.find((c) => c.name === 'cash_register.session.close'),
      'cerrar el día entero en silencio es justo el defecto: el primer clic pregunta',
    ).toBeUndefined();
    expect(pintado(el), 'y la pantalla dice que el siguiente clic cierra igual').toContain('ui.closeAnyway');
  });

  it('…y el segundo clic SÍ cierra: el aviso informa, nunca impide (Toast/Square)', async () => {
    kitchen = [linea('a', 'S1')];
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';

    await el.closeSession(new Event('submit'));
    await asentar(el);
    await el.closeSession(new Event('submit'));
    await asentar(el);

    const cierre = comandos.find((c) => c.name === 'cash_register.session.close');
    expect(cierre, 'el turno se cierra igual: negarse dejaría el cajón a medias').toBeTruthy();
    expect(cierre!.payload.session_id).toBe('s1');
    expect(cierre!.payload.closing_balance).toBe(25130);
  });

  it('sin nada pendiente el cierre NO añade ni un paso: cierra al primer clic', async () => {
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';

    await el.closeSession(new Event('submit'));
    await asentar(el);

    expect(comandos.find((c) => c.name === 'cash_register.session.close'), 'un turno limpio se cierra de una').toBeTruthy();
    expect(pintado(el)).not.toContain('ui.shiftReviewOrders');
    expect(pintado(el)).not.toContain('ui.shiftReviewPrints');
  });

  it('un hub SIN cocina cierra exactamente como antes (regresión: la caja no depende de cocina)', async () => {
    cocinaInstalada = false;
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';

    expect(pintado(el), 'un módulo ausente no es un aviso').not.toContain('ui.shiftReview');
    await el.closeSession(new Event('submit'));
    await asentar(el);
    expect(comandos.find((c) => c.name === 'cash_register.session.close'), 'de un solo clic').toBeTruthy();
  });

  it('si la revisión no se puede hacer, se DICE — y aun así no se añade un paso', async () => {
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, unknown>).erplora as Record<string, unknown>),
      queryOptional: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission_denied' });
      },
    };
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';

    expect(pintado(el), 'un fallo mudo es como una pantalla deja de ayudar sin que nadie se entere').toContain(
      'ui.shiftReviewUnavailable',
    );
    await el.closeSession(new Event('submit'));
    await asentar(el);
    expect(
      comandos.find((c) => c.name === 'cash_register.session.close'),
      'sin evidencia de trabajo pendiente no se inventa un paso',
    ).toBeTruthy();
  });

  it('la revisión se pide POR SESIÓN y la confirmación no se hereda de la anterior', async () => {
    kitchen = [linea('a', 'S1')];
    const el = await montar();
    await abrirCierre(el);
    el.closeBalance = '251.30';
    await el.closeSession(new Event('submit')); // consume la confirmación de s1
    await asentar(el);

    await abrirCierre(el, OTHER_SESSION);
    el.closeBalance = '100.00';
    await el.closeSession(new Event('submit'));
    await asentar(el);

    expect(
      comandos.find((c) => c.name === 'cash_register.session.close'),
      'la confirmación de OTRA sesión no puede cerrar ésta a la primera',
    ).toBeUndefined();
    expect(preguntadas.filter((n) => n === 'kitchen.orders.display').length).toBe(2);
  });

  it('cancelar el panel borra la revisión: no se queda pintada sobre otra pantalla', async () => {
    kitchen = [linea('a', 'S1')];
    const el = await montar();
    await abrirCierre(el);
    expect(pintado(el)).toContain('ui.shiftReviewOrders');

    el.resetPanel();
    await asentar(el);

    expect(pintado(el)).not.toContain('ui.shiftReviewOrders');
  });

  it('mientras se comprueba, la pantalla lo dice (estado de carga, no un hueco en blanco)', async () => {
    let liberar: (v: unknown) => void = () => {};
    kitchen = [linea('a', 'S1')];
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, unknown>).erplora as Record<string, unknown>),
      queryOptional: async () => new Promise((r) => { liberar = r; }),
    };
    const el = await montar();
    el.openPanel('close', SESSION);
    await el.updateComplete;

    expect(pintado(el)).toContain('ui.shiftReviewChecking');

    liberar([linea('a', 'S1')]);
    await asentar(el);
    expect(pintado(el)).toContain('ui.shiftReviewOrders');
  });
});
