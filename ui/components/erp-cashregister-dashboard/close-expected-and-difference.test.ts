// El cierre enseña el ESPERADO y cuadra en vivo — cuando el servidor deja (cash_register#83).
//
// El defecto: «Cerrar sesión» pide «Efectivo contado» y no dice en ningún sitio cuánto debería
// haber. La encargada cuenta el cajón a ciegas SIN que el negocio lo haya pedido: tiene que
// acordarse del fondo de apertura y sumar de cabeza los cobros en efectivo del turno. El número
// existe —la rejilla ya pinta la columna ESPERADO desde #65 y el widget del panel lo publica—,
// pero no está en el único sitio donde sirve para algo: delante de quien cuenta.
//
// LA DECISIÓN DE NEGOCIO (mercado, no nosotros). El sector NO es unánime y ahí está el trabajo:
// enseñar el esperado antes de contar invita a cuadrar la caja a ojo, que es justo lo que el
// arqueo trata de detectar.
//   · Square      → permiso «view expected amount in cash drawer» dentro de «view cash drawers».
//   · Toast       → permisos 3.17 Cash Drawers (Blind) vs 3.18 (Full): el ciego lo esconde en el
//                   Shift Review, en el cierre y en el Closed Drawer Report.
//   · Lightspeed  → ajuste «How to hide expected cash when closing the register».
//   · Loyverse    → visible por defecto; se quita retirando el derecho «View shift report».
//   · Sage 200 ES → «Arqueo Ciego» parametrizable; sin él se ve el importe teórico.
//   · Shopify POS → primero el contado, el esperado en la pantalla «Session complete» (ciego).
//   · D365 Commerce → «tender declaration»: se DECLARA y luego se compara.
//   · Odoo        → lo enseña siempre y no trae interruptor (su propio foro pide cómo taparlo).
// Gana el modelo de Square/Toast/Lightspeed, que es además el que este módulo YA eligió en #24:
// el esperado es un dato de SUPERVISIÓN gobernado por `require_blind_count` (por negocio) y por
// `cash_register.view_expected_totals` (por rol). Esconderlo SIEMPRE (Shopify) castigaría al 99 %
// de nuestros clientes —un salón o un bar donde cuenta la dueña— por un fraude que no existe; y
// enseñarlo SIEMPRE (Odoo) rompe el arqueo ciego que el módulo ya vende.
//
// De ahí el contrato que fija este fichero: **el panel de cierre no decide nada**. Pinta el número
// si y solo si el SERVIDOR se lo da, leyéndolo de `cash_register.current_session` —la misma puerta
// que ya aplica el ajuste ciego y que corre con el permiso que tiene cualquier cajero
// (`view_session`)—. Si el hub está en ciego, esa query devuelve `expected_total` a NULL y la
// pantalla no tiene de dónde sacarlo: el ciego no depende de que el cliente se porte bien.
import { beforeEach, describe, expect, it } from 'vitest';

/** La fila de la rejilla: RANCIA a propósito (se cargó al entrar en la pantalla, antes de vender). */
const ROW = {
  id: 's1',
  session_number: 'S-260909-0001',
  status: 'open',
  opening_balance: 10000,
  closing_balance: null,
  expected_balance: 10000,
  difference: null,
};

/** Lo que `cash_register.current_session` devuelve AHORA: fondo 100 € + una venta de 29,90 €. */
let currentSession: Array<Record<string, unknown>> = [];
let queryFails = false;
/** Resolutor manual de `current_session`, para provocar la carrera «cancelar mientras vuela». */
let holdCurrentSession: (() => void) | null = null;
let comandos: { name: string; payload: Record<string, unknown> }[] = [];
let consultadas: string[] = [];

beforeEach(() => {
  comandos = [];
  consultadas = [];
  queryFails = false;
  holdCurrentSession = null;
  currentSession = [{ id: 's1', session_number: 'S-260909-0001', opening_balance: 10000, expected_total: 12990, total_sales: 2990, movement_count: 1 }];
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => {
      consultadas.push(name);
      if (name === 'cash_register.current_session') {
        if (queryFails) throw new Error('boom');
        if (holdCurrentSession) await new Promise<void>((r) => { holdCurrentSession = r; });
        return currentSession;
      }
      return [];
    },
    queryAll: async () => [],
    queryPage: async () => ({ rows: [ROW], total: 1, limit: 50, offset: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
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
  target: { id: string } | null;
  closeBalance: string;
  formError: string;
  expectedForClose: number | null;
  openPanel(panel: string, session: unknown): void;
  resetPanel(): void;
  closeSession(e: Event): Promise<void>;
  updateComplete: Promise<unknown>;
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
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

/** El bloque esperado/diferencia del panel de cierre, como pares etiqueta→valor. */
function cuadre(el: HTMLElement): Record<string, string> {
  const list = el.shadowRoot!.querySelector('section.panel ok-detail-list');
  if (!list) return {};
  const items = (list as unknown as { items?: { label: string; value: string }[] }).items ?? [];
  return Object.fromEntries(items.map((i) => [i.label, i.value]));
}

async function abrirCierre(): Promise<HTMLElement & Wc> {
  const el = await montar();
  el.openPanel('close', ROW);
  await asentar(el);
  return el;
}

describe('el cierre dice cuánto debería haber (cash_register#83)', () => {
  it('enseña el ESPERADO del servidor, no el de la fila rancia de la rejilla', async () => {
    const el = await abrirCierre();

    expect(
      consultadas.filter((n) => n === 'cash_register.current_session').length,
      'el panel relee el esperado al abrirse: la fila de la rejilla se cargó antes de vender',
    ).toBeGreaterThanOrEqual(2);
    expect(cuadre(el)['ui.labelExpectedInDrawer'], 'fondo 100 € + venta 29,90 € = 129,90 €').toBe('129.90 €');
  });

  it('la DIFERENCIA se calcula en vivo mientras se teclea, con su signo', async () => {
    const el = await abrirCierre();

    expect(cuadre(el)['ui.colDifference'], 'sin nada tecleado no se inventa una diferencia').toBe('—');

    el.closeBalance = '129,90';
    await el.updateComplete;
    expect(cuadre(el)['ui.colDifference'], 'cuadra al céntimo').toBe('0.00 €');

    el.closeBalance = '125,00';
    await el.updateComplete;
    expect(cuadre(el)['ui.colDifference'], 'faltan 4,90 €').toBe('-4.90 €');

    el.closeBalance = '135,00';
    await el.updateComplete;
    expect(cuadre(el)['ui.colDifference'], 'sobran 5,10 €: el signo + distingue sobrante de faltante').toBe('+5.10 €');
  });

  it('ARQUEO CIEGO: si el servidor no da el esperado, la pantalla no lo enseña ni lo deduce', async () => {
    // `require_blind_count = 1` → `current_session.sql` devuelve la sesión con `expected_total` NULL.
    currentSession = [{ id: 's1', session_number: 'S-260909-0001', opening_balance: 10000, expected_total: null, total_sales: 2990, movement_count: 1 }];
    const el = await abrirCierre();

    expect(
      cuadre(el)['ui.labelExpectedInDrawer'],
      'el ciego no puede depender de que el cliente se porte bien: sin número del servidor, no hay número',
    ).toBeUndefined();
    el.closeBalance = '129,90';
    await el.updateComplete;
    expect(cuadre(el)['ui.colDifference'], 'ni diferencia en vivo: revelarla equivale a revelar el esperado').toBeUndefined();
  });

  // El panel se abre, la lectura vuela, y la persona pulsa «Cancelar» (o abre otra fila) antes de
  // que aterrice. Sin la guarda, el número de un turno se pinta encima del cierre de otro.
  it('cancelar mientras la lectura vuela NO deja el esperado pegado al panel siguiente', async () => {
    const el = await montar();
    holdCurrentSession = () => {};
    el.openPanel('close', ROW);
    await new Promise((r) => setTimeout(r, 0));
    el.resetPanel();
    holdCurrentSession?.();
    await asentar(el);

    expect(el.expectedForClose, 'una respuesta que llega tarde no manda sobre el panel que hay ahora').toBeNull();
  });

  it('nunca el esperado de OTRO turno: si la sesión abierta no es la que se cierra, no se pinta', async () => {
    currentSession = [{ id: 's2', session_number: 'S-260909-0002', opening_balance: 5000, expected_total: 7777, total_sales: 2777, movement_count: 1 }];
    const el = await abrirCierre();

    expect(cuadre(el)['ui.labelExpectedInDrawer'], 'un número de otro cajón es un descuadre que alguien paga').toBeUndefined();
  });

  it('si la lectura del esperado falla, el cierre sigue funcionando y el fallo NO es mudo', async () => {
    queryFails = true;
    const el = await abrirCierre();

    expect(cuadre(el)['ui.labelExpectedInDrawer'], 'sin dato fiable no se pinta un dato').toBeUndefined();
    expect(el.formError, 'una pantalla que deja de ayudar en silencio es un fallo invisible').toBeTruthy();
    el.closeBalance = '129,90';
    await el.closeSession(new Event('submit'));
    expect(comandos.find((c) => c.name === 'cash_register.session.close'), 'el cierre no depende del adorno').toBeTruthy();
  });

  it('el esperado es un ADORNO: al servidor solo viaja lo contado (él recalcula y audita)', async () => {
    const el = await abrirCierre();
    el.closeBalance = '129,90';
    await el.closeSession(new Event('submit'));

    const cierre = comandos.find((c) => c.name === 'cash_register.session.close')!;
    expect(cierre.payload.closing_balance).toBe(12990);
    expect(Object.keys(cierre.payload), 'el cliente no dicta el esperado ni la diferencia').not.toContain('expected_balance');
    expect(Object.keys(cierre.payload)).not.toContain('difference');
  });
});

// El botón «Cerrar sesión» estaba DESHABILITADO mientras el campo estuviera vacío, y un botón
// `color="danger"` deshabilitado sobre el fondo claro del panel se lee como un texto apagado: QA lo
// describió como «gris muy claro… cuesta encontrarlo». El mercado no apaga la acción principal del
// cierre (Odoo, Shopify y Square la mantienen viva y validan al pulsar), y nuestra propia regla
// prohíbe la pantalla que solo contempla el camino feliz. Además, deshabilitar por «campo vacío»
// solo tapaba UN caso inválido: «abc» pasaba el filtro y llegaba al servidor como NaN.
describe('la acción de cerrar no se queda muerta (cash_register#83)', () => {
  it('el botón de cerrar NO se deshabilita por tener el campo vacío', async () => {
    const el = await abrirCierre();
    const boton = el.shadowRoot!.querySelector('section.panel ion-button[type="submit"]')!;
    expect(el.closeBalance, 'sin arqueo previo el campo nace vacío').toBe('');
    expect(boton.hasAttribute('disabled'), 'un botón apagado sin explicación es un callejón sin salida').toBe(false);
  });

  it('pulsar sin importe explica qué falta, en el idioma del hub, y no llama al servidor', async () => {
    const el = await abrirCierre();
    await el.closeSession(new Event('submit'));

    expect(el.formError).toBe('ui.errCountedCashRequired');
    expect(comandos.find((c) => c.name === 'cash_register.session.close'), 'no se cierra un turno sin contarlo').toBeFalsy();
  });

  // `majorToMinor` devuelve 0 para lo que no sabe leer. Es la red correcta para una LECTURA y la
  // equivocada para esta frontera: «abc» cerraba el turno declarando 0,00 € contados —un faltante
  // inventado del cajón entero— sin un solo error por ninguna parte. Since pm#521 the reason is the
  // specific one (not an amount / negative), no longer the «enter the count» of an empty field.
  it.each([
    ['abc', 'ui.errNotAnAmount'],
    ['12,3,4', 'ui.errNotAnAmount'],
    ['- ', 'ui.errNotAnAmount'],
    ['-5', 'ui.errNegativeAmount'],
  ])('«%s» no es un recuento: no se cierra y se explica', async (tecleado, motivo) => {
    const el = await abrirCierre();
    el.closeBalance = tecleado;
    await el.closeSession(new Event('submit'));

    expect(el.formError).toBe(motivo);
    expect(
      comandos.find((c) => c.name === 'cash_register.session.close'),
      'cerrar declarando 0,00 € por un dedo mal puesto es un descuadre fabricado por la pantalla',
    ).toBeFalsy();
  });

  it('un recuento de 0,00 € SÍ se acepta: un cajón vacío es un dato, no un error', async () => {
    const el = await abrirCierre();
    el.closeBalance = '0';
    await el.closeSession(new Event('submit'));

    expect(comandos.find((c) => c.name === 'cash_register.session.close')!.payload.closing_balance).toBe(0);
  });
});
