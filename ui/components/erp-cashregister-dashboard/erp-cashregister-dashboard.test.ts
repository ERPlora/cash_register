// La lista de CAJAS del dashboard de caja.
//
// Regresión de la migración `page_size` → `queryAll` (ADR-0124): `queryAll()` devuelve **el array**
// de filas, no el sobre `{rows,total}` — pero el código siguió leyendo `page?.rows`, que sobre un
// array es `undefined`. Resultado: `this.registers` quedaba SIEMPRE vacío, el desplegable de cajas
// salía sin opciones y **no se podía abrir sesión de caja**. O sea: no se podía cobrar.
//
// Y no se veía venir, porque la carga está envuelta en un `catch` mudo.
import { beforeEach, describe, expect, it } from 'vitest';

const CAJAS = [
  { id: 'r1', name: 'Caja mostrador', is_active: 1 },
  { id: 'r2', name: 'Caja terraza', is_active: 1 },
];

beforeEach(() => {
  // El doble imita el contrato del CLIENTE (`ErploraClient`): `queryAll()` entrega el ARRAY ya
  // desenvuelto. Mockear aquí el sobre `{rows}` sería un doble infiel — y es justo lo que tapaba
  // este bug.
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async (name: string) => (name === 'cash_register.registers.list' ? CAJAS : []),
    queryPage: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    formatAmount: (units: number) => `${(units || 0).toFixed(2)} €`,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    // Scale of the hub's currency, injected by the shell: 2 in EUR, 0 in JPY, 3 in KWD.
    currencyDecimals: 2,
  };
});

async function montar() {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { updateComplete: Promise<unknown> };
}

describe('las cajas del dashboard (regresión queryAll, ADR-0124)', () => {
  it('las cajas que devuelve el servidor LLEGAN al componente (sin ellas no se puede abrir sesión)', async () => {
    const el = await montar();
    const registers = (el as unknown as { registers: unknown[] }).registers;
    expect(registers, 'queryAll devuelve el ARRAY: leer `.rows` sobre él da undefined').toHaveLength(2);
    expect((registers[0] as { name: string }).name).toBe('Caja mostrador');
  });

  it('si el servidor contesta algo que no es una lista, la vista aguanta (no revienta)', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.queryAll = async () => ({ error: 'boom' } as unknown); // respuesta rara, no un array
    const el = await montar();
    expect((el as unknown as { registers: unknown[] }).registers).toEqual([]);
  });
});

// El dinero es INTEGER en CÉNTIMOS (ADR-0007/0123). El panel de apertura mandaba
// `Number(this.openBalance)` —los EUROS crudos del ion-input— a una columna INTEGER: abrir la caja
// con 150,50 € guardaba 150 céntimos = 1,50 €. El arqueo del día arrancaba con el fondo equivocado
// (y el `erplora validate` lo cantaba: `opening_balance` declaraba `number` en vez de `integer`).
describe('el fondo de apertura va en céntimos (ADR-0007/0123)', () => {
  it('teclear 150,50 € abre la sesión con 15050, no con 150', async () => {
    const comandos: { name: string; payload: Record<string, unknown> }[] = [];
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    };

    const el = await montar();
    const wc = el as unknown as { openBalance: string; openSession(e: Event): Promise<void> };
    wc.openBalance = '150.50';
    await wc.openSession(new Event('submit'));

    const abrir = comandos.find((c) => c.name === 'cash_register.session.open');
    expect(abrir, 'no se llamó a session.open').toBeTruthy();
    expect(abrir!.payload.opening_balance).toBe(15050);
  });
});

describe('el dinero de la lista habla céntimos → formatMoney (bug ×100)', () => {
  it('opening_balance 15050 céntimos se pinta «150.50 €», no «15050.00 €»', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; format?: (r: unknown) => string }[] }).columns;
    const abre = cols.find((c) => c.key === 'opening_balance');
    expect(abre!.format!({ opening_balance: 15050 })).toBe('150.50 €');
  });
});

describe('el CIERRE convierte euros→céntimos por la frontera con nombre (como la apertura)', () => {
  it('cerrar con «150,50» manda closing_balance=15050 (no 0 por la coma, no euros crudos)', async () => {
    const comandos: { name: string; payload: Record<string, unknown> }[] = [];
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    };
    const el = await montar();
    const wc = el as unknown as {
      target: { id: string } | null; closeBalance: string; closeSession(e: Event): Promise<void>;
    };
    wc.target = { id: 's1' };
    wc.closeBalance = '150,50';
    await wc.closeSession(new Event('submit'));
    const cierre = comandos.find((c) => c.name === 'cash_register.session.close');
    expect(cierre, 'no se llamó a session.close').toBeTruthy();
    expect(cierre!.payload.closing_balance).toBe(15050);
  });
});

// The third border of the same contract (cash_register#10). Opening and closing already converted;
// the MANUAL MOVEMENT did not — `Math.abs(Number(this.movAmount))` sent the typed euros straight to
// `cash_register._insert_movement`, whose `amount` column is INTEGER minor units. A 12,34 € cash-in
// was persisted as 12 minor units — 0,12 € — and the day's count came out short.
describe('the manual movement crosses the same border as opening and closing', () => {
  const spyCommands = () => {
    const seen: { name: string; payload: Record<string, unknown> }[] = [];
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = async (name: string, payload: Record<string, unknown>) => {
      seen.push({ name, payload });
      return {};
    };
    return seen;
  };

  const addMovement = async (amount: string, type: 'in' | 'out' = 'in') => {
    const el = await montar();
    const wc = el as unknown as {
      target: { id: string } | null; movAmount: string; movType: string; movDescription: string;
      addMovement(e: Event): Promise<void>;
    };
    wc.target = { id: 's1' };
    wc.movAmount = amount;
    wc.movType = type;
    wc.movDescription = 'Fondo extra';
    await wc.addMovement(new Event('submit'));
  };

  it('a 12,34 € cash-in travels as 1234 minor units, not as 12.34', async () => {
    const comandos = spyCommands();
    await addMovement('12,34');
    const mov = comandos.find((c) => c.name === 'cash_register.movement.add');
    expect(mov, 'movement.add was not called').toBeTruthy();
    expect(mov!.payload.amount).toBe(1234);
  });

  it('a cash-out keeps the sign AND the scale', async () => {
    const comandos = spyCommands();
    await addMovement('12,34', 'out');
    expect(comandos.find((c) => c.name === 'cash_register.movement.add')!.payload.amount).toBe(-1234);
  });

  // Same trap as every other border: the scale belongs to the hub's currency. In JPY the minor
  // unit IS the yen, so a fixed ×100 books a movement 100 times too big.
  it('uses the hub currency scale, not a hardcoded 2 decimals', async () => {
    const comandos = spyCommands();
    ((globalThis as Record<string, unknown>).erplora as Record<string, unknown>).currencyDecimals = 0;
    await addMovement('1999');
    expect(
      comandos.find((c) => c.name === 'cash_register.movement.add')!.payload.amount,
      '1999 ¥ are 1999 minor units, not 199900',
    ).toBe(1999);
  });

  // A hub that has not been redeployed yet may run a shell that does not inject the scale. The
  // amount must still be a number: a `NaN` reaching an INTEGER column is silent corruption.
  it('a shell that does not inject the scale falls back to 2, never to NaN', async () => {
    const comandos = spyCommands();
    delete ((globalThis as Record<string, unknown>).erplora as Record<string, unknown>).currencyDecimals;
    await addMovement('12,34');
    expect(comandos.find((c) => c.name === 'cash_register.movement.add')!.payload.amount).toBe(1234);
  });
});

// #272 — «No se puede cerrar la caja»: con locale es-ES el usuario teclea «150,50» (coma decimal),
// pero el input era `type="number"`. El navegador descarta la coma como valor inválido → el campo
// queda vacío → el botón «Cerrar sesión» permanece deshabilitado y `closeSession` retorna antes de
// llamar al backend. El handler y `aCentimos` están bien; el input es el que cortaba el valor.
// Solución: `type="text"` + `inputmode="decimal"` (teclado numérico en móvil) + el patrón deja pasar
// la coma para que llegue a `aCentimos`.
describe('cerrar caja: el campo acepta coma decimal (no es type=number, #272)', () => {
  it('el input de saldo contado NO es type=number (bloquea la coma en es-ES)', async () => {
    const el = await montar();
    // Abrir el panel de cierre para que renderice el input.
    (el as unknown as { panel: string | null; target: unknown }).panel = 'close';
    (el as unknown as { target: unknown }).target = { id: 's1', session_number: 'S-1', status: 'open' };
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const input = el.shadowRoot.querySelector('section.panel ion-input[label="ui.labelCountedCash"]') as HTMLElement | null;
    expect(input, 'no se encontró el input de saldo contado').toBeTruthy();
    // `type=number` rechaza la coma → el valor se pierde → botón disabled → «no se puede cerrar».
    // Cualquier cosa que no sea 'number' (text/tel…) deja pasar la coma hasta `aCentimos`.
    // Se lee el atributo (no `.type`: happy-dom no lo expone como propiedad en ion-input).
    expect(input!.getAttribute('type'), 'type=number bloquea la coma decimal; debe ser text/decimal').not.toBe('number');
  });
});

describe('el arqueo por denominaciones se suma en CÉNTIMOS enteros (exacto)', () => {
  it('3 monedas de 0,05 € son 15 céntimos exactos (no 0.15000000000000002 €)', async () => {
    const el = await montar();
    const wc = el as unknown as { denomCounts: Record<string, string>; countTotalCents(): number };
    wc.denomCounts = { '0.05': '3' };
    expect(wc.countTotalCents()).toBe(15);
  });
});

// cash_register#11 — one open session per hub. The database owns the invariant (partial unique
// index + `expect_rows` → `cash_register.session_already_open`); the dashboard must not INVITE the
// second open, and when the server refuses it, the person must read WHY in their language.
describe('una sola sesión abierta por hub (cash_register#11)', () => {
  const ABIERTA = { id: 's1', session_number: 'S-1', status: 'open', opening_balance: 0, expected_balance: null, closing_balance: null, difference: null };
  const CERRADA = { id: 's0', session_number: 'S-0', status: 'closed', opening_balance: 0, expected_balance: 0, closing_balance: 0, difference: 0 };

  function botonAbrir(el: HTMLElement): HTMLButtonElement {
    const btn = Array.from(el.shadowRoot!.querySelectorAll('header ion-button')).find(
      (b) => b.textContent?.trim() === 'ui.openSession',
    );
    if (!btn) throw new Error('header «Abrir sesión» button not found');
    return btn as HTMLButtonElement;
  }

  // The truth comes from `cash_register.current_session` (server, per hub), NOT from the paginated
  // list: the open session may sit on another page, and the list is sorted by id.
  it('con una sesión ABIERTA (current_session no vacía), «Abrir sesión» está deshabilitado', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.query = async (name: string) => (name === 'cash_register.current_session' ? [ABIERTA] : []);
    sdk.queryPage = async () => ({ rows: [CERRADA, ABIERTA], total: 2, limit: 50, offset: 0 });
    const el = await montar();
    expect(botonAbrir(el).hasAttribute('disabled')).toBe(true);
  });

  it('sin sesión abierta (current_session vacía), «Abrir sesión» está habilitado', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.query = async () => [];
    sdk.queryPage = async () => ({ rows: [CERRADA], total: 1, limit: 50, offset: 0 });
    const el = await montar();
    expect(botonAbrir(el).hasAttribute('disabled')).toBe(false);
  });

  it('si el servidor rechaza con `cash_register.session_already_open`, se muestra el texto traducido', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = async () => {
      const e = new Error('A cash session is already open for this business.') as Error & { code: string };
      e.code = 'cash_register.session_already_open';
      throw e;
    };
    const el = await montar();
    const wc = el as unknown as { formError: string; openSession(e: Event): Promise<void> };
    await wc.openSession(new Event('submit'));
    expect(wc.formError).toBe('ui.errSessionAlreadyOpen');
  });
});

// cash_register#38 — the drawer settings are enforced on the SERVER (WASM handler with `reads`), and
// each rule answers with its own domain code. The dashboard translates them instead of showing the
// English fallback message.
describe('los rechazos de dominio del servidor se traducen (cash_register#38)', () => {
  const rechazo = (code: string) => async () => {
    const e = new Error('server fallback message') as Error & { code: string };
    e.code = code;
    throw e;
  };
  const SESION_ABIERTA = { id: 's-open', session_number: 'S-OPEN', status: 'open', opening_balance: 0, expected_balance: null, closing_balance: null, difference: null };

  it('abrir sin fondo cuando el ajuste lo exige → ui.errOpeningBalanceRequired', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = rechazo('cash_register.opening_balance_required');
    const el = await montar();
    const wc = el as unknown as { formError: string; openSession(e: Event): Promise<void> };
    await wc.openSession(new Event('submit'));
    expect(wc.formError).toBe('ui.errOpeningBalanceRequired');
  });

  it('cerrar sin recuento cuando el ajuste lo exige → ui.errClosingBalanceRequired', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = rechazo('cash_register.closing_balance_required');
    const el = await montar();
    const wc = el as unknown as { formError: string; target: unknown; closeBalance: string; closeSession(e: Event): Promise<void> };
    wc.target = SESION_ABIERTA;
    wc.closeBalance = '10';
    await wc.closeSession(new Event('submit'));
    expect(wc.formError).toBe('ui.errClosingBalanceRequired');
  });

  it('una salida que deja la caja en negativo → ui.errNegativeBalanceNotAllowed', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.command = rechazo('cash_register.negative_balance_not_allowed');
    const el = await montar();
    const wc = el as unknown as { formError: string; target: unknown; movType: string; movAmount: string; addMovement(e: Event): Promise<void> };
    wc.target = SESION_ABIERTA;
    wc.movType = 'out';
    wc.movAmount = '500';
    await wc.addMovement(new Event('submit'));
    expect(wc.formError).toBe('ui.errNegativeBalanceNotAllowed');
  });
});

// cash_register#12 — touch targets. `ion-button size="small"` renders ~27 px high; a finger needs
// 44×44 (WCAG 2.5.5 / Ionic default size). The data-table already got its 44 px centrally in
// OutfitKit (`9927a4c`); these are the module's OWN buttons: header, and every panel's submit and
// cancel.
describe('los botones propios del módulo son táctiles (cash_register#12)', () => {
  it('ningún ion-button del dashboard usa size="small" (cabecera + los 4 paneles)', async () => {
    const el = await montar();
    const wc = el as unknown as { panel: string | null; target: unknown; updateComplete: Promise<unknown> };
    const small: string[] = [];
    for (const panel of ['open', 'close', 'movement', 'count']) {
      wc.panel = panel;
      wc.target = { id: 's1', session_number: 'S-1', status: 'open' };
      await wc.updateComplete;
      el.shadowRoot!.querySelectorAll('ion-button[size="small"]').forEach((b) => small.push(`${panel}: ${b.textContent?.trim()}`));
    }
    expect(small, 'size="small" = ~27 px, below the 44 px touch target').toEqual([]);
  });

  it('el CSS del componente garantiza 44 px de alto a los botones propios (Ionic md por defecto son 36 px)', async () => {
    const el = await montar();
    const styles = (el.constructor as unknown as { styles: { cssText: string } }).styles;
    expect(styles.cssText).toContain('header ion-button, .form ion-button { min-height: 44px;');
  });
});
