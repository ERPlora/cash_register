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
