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

describe('el arqueo por denominaciones se suma en CÉNTIMOS enteros (exacto)', () => {
  it('3 monedas de 0,05 € son 15 céntimos exactos (no 0.15000000000000002 €)', async () => {
    const el = await montar();
    const wc = el as unknown as { denomCounts: Record<string, string>; countTotalCents(): number };
    wc.denomCounts = { '0.05': '3' };
    expect(wc.countTotalCents()).toBe(15);
  });
});
