// El cierre HEREDA el arqueo que ya se hizo (cash_register#65).
//
// El defecto que esto fija: se cuenta el cajón por denominaciones, se pulsa «Registrar arqueo»,
// sale el toast con el total… y al abrir «Cerrar» el campo «Efectivo contado» aparece VACÍO. Hay
// que volver a contar y reteclear el importe. Contar dos veces el mismo cajón es la forma más
// barata de introducir un descuadre: cualquier dedo distinto en la segunda pasada sale como
// diferencia de caja y alguien la paga.
//
// El mercado no cuenta dos veces: en Square, Toast y Lightspeed el recuento de cierre ES el paso
// previo del cierre y su total viaja al cierre. Por eso, además, un arqueo de tipo «Cierre» deja al
// operador EN el cierre — «Cierre» tenía que significar algo, y hasta ahora no significaba nada
// (la sesión seguía abierta y el número contado se quedaba en su tabla).
//
// El de tipo «Apertura» NO: ése es la verificación del fondo al empezar el turno. Prellenar el
// cierre con él metería en la caja un número de hace ocho horas sin que nadie lo pidiera.
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

/** Arqueos de la sesión tal y como los devuelve `cash_register.counts.list` (céntimos, ADR-0400). */
type CountRow = { id: string; count_type: string; total: number; denominations: string; notes: string; counted_at: string };

let counts: CountRow[] = [];
let comandos: { name: string; payload: Record<string, unknown> }[] = [];
let pedidas: { name: string; params: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos = [];
  pedidas = [];
  counts = [
    { id: 'c1', count_type: 'opening', total: 15000, denominations: '{}', notes: '', counted_at: '2026-08-25T08:00:00Z' },
    { id: 'c2', count_type: 'closing', total: 25130, denominations: '{}', notes: '', counted_at: '2026-08-25T14:00:00Z' },
  ];
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async (name: string, params: Record<string, unknown>) => {
      pedidas.push({ name, params });
      if (name === 'cash_register.counts.list') {
        const rows = [...counts].sort((a, b) => (a.counted_at < b.counted_at ? 1 : -1));
        return { rows, total: rows.length, limit: 50, offset: 0 };
      }
      return { rows: [SESSION], total: 1, limit: 50, offset: 0 };
    },
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
  countType: 'opening' | 'closing';
  denomCounts: Record<string, string>;
  openPanel(panel: string, session: unknown): void;
  addCount(e: Event): Promise<void>;
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

/** Deja correr los `await` que el panel lanza sin bloquear el render. */
async function asentar(el: Wc): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

describe('el cierre hereda el arqueo ya registrado (cash_register#65)', () => {
  it('abrir «Cerrar» PRERRELLENA el efectivo contado con el último arqueo de cierre', async () => {
    const el = await montar();
    el.openPanel('close', SESSION);
    await asentar(el);

    expect(
      el.closeBalance,
      'el cajón ya se contó (251,30 €): volver a teclearlo a mano es como se cuela un descuadre',
    ).toBe('251,30');
    expect(pedidas.some((p) => p.name === 'cash_register.counts.list'), 'el panel lee los arqueos de ESA sesión').toBe(true);
    const q = pedidas.find((p) => p.name === 'cash_register.counts.list')!;
    expect((q.params.params as Record<string, unknown>).session_id, 'acotado a la sesión que se cierra').toBe('s1');
  });

  it('el importe heredado vuelve al servidor EN CÉNTIMOS, sin desvíos (ADR-0400)', async () => {
    const el = await montar();
    el.openPanel('close', SESSION);
    await asentar(el);
    await el.closeSession(new Event('submit'));

    const cierre = comandos.find((c) => c.name === 'cash_register.session.close');
    expect(cierre, 'se cierra con lo heredado, sin pedir que se teclee otra vez').toBeTruthy();
    expect(cierre!.payload.closing_balance).toBe(25130);
  });

  // pm#521: the field is written back in the hub locale, UNGROUPED — es does not group four
  // digits, so a five-digit total is what proves no thousands separator sneaks in («12.345,50»
  // would be read back as ambiguous by the very gate that sends it).
  it('prefills in the hub locale without grouping, and sends back the same minor units', async () => {
    counts = [{ id: 'c3', count_type: 'closing', total: 1234550, denominations: '{}', notes: '', counted_at: '2026-08-25T15:00:00Z' }];
    const el = await montar();
    el.openPanel('close', SESSION);
    await asentar(el);
    expect(el.closeBalance).toBe('12345,50');
    await el.closeSession(new Event('submit'));
    expect(comandos.find((c) => c.name === 'cash_register.session.close')!.payload.closing_balance).toBe(1234550);
  });

  it('sin arqueo de cierre no se inventa nada: el campo se queda vacío', async () => {
    counts = [counts[0]]; // solo el de apertura
    const el = await montar();
    el.openPanel('close', SESSION);
    await asentar(el);

    expect(
      el.closeBalance,
      'un arqueo de APERTURA es la verificación del fondo, no el conteo del cierre',
    ).toBe('');
  });

  it('registrar un arqueo de «Cierre» deja al operador EN el cierre con el total puesto', async () => {
    counts = [];
    const el = await montar();
    el.openPanel('count', SESSION);
    el.countType = 'closing';
    el.denomCounts = { '100': '2', '50': '1', '1': '1', '0.20': '1', '0.10': '1' }; // 251,30 €
    // El servidor devolverá el arqueo recién escrito la próxima vez que se le pregunte.
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, unknown>).erplora as Record<string, unknown>),
      command: async (name: string, payload: Record<string, unknown>) => {
        comandos.push({ name, payload });
        counts.push({ id: 'c9', count_type: 'closing', total: 25130, denominations: '{}', notes: '', counted_at: '2026-08-25T14:30:00Z' });
        return {};
      },
    };
    await el.addCount(new Event('submit'));
    await asentar(el);

    expect(el.panel, 'un arqueo de CIERRE que deja la sesión abierta y el número escondido no es un cierre').toBe('close');
    expect(el.target?.id, 'sigue apuntando a la sesión que se estaba contando').toBe('s1');
    expect(el.closeBalance, 'el total recién contado llega al cierre').toBe('251,30');
  });

  it('un arqueo de «Apertura» NO empuja al cierre (es la verificación del fondo)', async () => {
    counts = [];
    const el = await montar();
    el.openPanel('count', SESSION);
    el.countType = 'opening';
    el.denomCounts = { '100': '1', '50': '1' };
    await el.addCount(new Event('submit'));
    await asentar(el);

    expect(el.panel, 'contar el fondo al empezar el turno no cierra ni invita a cerrar').not.toBe('close');
    expect(el.closeBalance).toBe('');
  });
});
