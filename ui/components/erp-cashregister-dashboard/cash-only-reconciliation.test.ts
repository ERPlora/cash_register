// The drawer holds PHYSICAL cash, and only that (cash_register#9).
//
// The issue is closed as already fixed — both halves landed before this file existed:
//   * the reversal has filtered `payment_method = 'cash'` since ADR-0075 (2026-06-25);
//   * `expected_balance`/`difference` count only cash since `eba909f` (2026-07-26),
//     «el cajón es efectivo FÍSICO».
//
// What was missing is this: **nothing protected it**. Neither half had a test, so the next person
// who touches the arqueo — to add a payment method, to change the reversal, to "simplify" a CASE —
// gets no warning. And the failure is silent by nature: the drawer just does not match at close,
// and the cashier is the one who eats it.
//
// So the guard lives here, at the level the module actually controls: the SQL it ships.
//
// ⚠️ **Actualizado el 2026-08-15 (cash_register#33).** Este fichero llevaba 3 de sus 6 casos en ROJO
// en `main`: comprobaban `payment_method` —el nombre LOCALIZADO del método— y el arqueo se movió al
// tipo canónico `payment_method_type` (`cash`|`card`|`transfer`|`other`, hub#778). La intención era
// correcta; la columna, vieja.
//
// Y el rojo tapó algo peor: **nadie comprobaba la ESCRITURA**. El handler calculaba
// `payment_method_type` y el INSERT no lo llevaba en su lista de columnas, así que la columna se
// quedaba con su `DEFAULT 'cash'` y el arqueo contaba las ventas con TARJETA como efectivo. Los
// tests del handler pasaban porque afirman sobre el *parámetro*, un eslabón antes de donde fallaba.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const sqlOf = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

describe('only cash reaches the expected balance', () => {
  const close = () => sqlOf('commands/close_session.sql');

  it('the expected balance sums cash movements and nothing else', () => {
    // A card sale is money the business took, but not money in the drawer. If it counted here, the
    // count would come up short by exactly the card takings and look like a theft.
    expect(
      close(),
      'expected_balance sums every movement: a card sale would inflate the cash expected',
    ).toMatch(/payment_method_type\s*,\s*'cash'\s*\)\s*=\s*'cash'|payment_method_type\s*=\s*'cash'/i);
  });

  it('the difference is measured against that same expected, not against a second formula', () => {
    const sql = close();
    const cashFilters = sql.match(/=\s*'cash'/gi) ?? [];
    // `expected_balance` and `difference` each carry the filter: if one drifted from the other, the
    // session would report a difference against a total it never showed.
    expect(cashFilters.length, 'expected_balance and difference must apply the SAME cash filter').toBeGreaterThanOrEqual(2);
  });

  it('a missing payment_method counts as cash — the old rows predate the column', () => {
    expect(close(), 'without COALESCE, legacy movements with NULL method would vanish from the count').toMatch(/COALESCE\(\s*m\.payment_method_type\s*,\s*'cash'\s*\)/i);
  });
});

describe('voiding a sale is symmetric with recording it', () => {
  const reverse = () => sqlOf('commands/_reverse_sale.sql');

  it('only cash movements are reversed', () => {
    // The reversal writes its row as `'cash'`. If it summed card movements too, voiding a card sale
    // would DEFLATE the expected cash — the mirror image of the bug, and just as invisible.
    expect(reverse(), 'the reversal takes every movement of the sale, whatever it was paid with').toMatch(/orig\.payment_method_type\s*,\s*'cash'\s*\)\s*=\s*'cash'|orig\.payment_method_type\s*=\s*'cash'/i);
  });

  it('it only reverses sales, not other movements of the same reference', () => {
    expect(reverse()).toMatch(/orig\.movement_type\s*=\s*'sale'/i);
  });

  it('voiding twice does not refund twice', () => {
    // Idempotency by the reversal's own description: the second void finds it and writes nothing.
    expect(reverse(), 'without the NOT EXISTS, a repeated sale.voided event refunds again').toMatch(/NOT\s+EXISTS/i);
  });
});

// La mitad que faltaba: que la columna se ESCRIBA (cash_register#33).
//
// Los tres bloques de arriba comprueban que el arqueo LEE por `payment_method_type`. Ninguno
// comprobaba que alguien la escriba — y no la escribía nadie. El resultado es el peor de los dos
// mundos: la lectura distingue tarjeta de efectivo con toda corrección, sobre una columna que
// siempre vale `'cash'` porque su migración la creó con `DEFAULT 'cash'` y sin backfill.
//
// El fallo era invisible por construcción: el handler pone el parámetro, sus tests afirman que lo
// pone, y salen en verde. La aserción vivía un eslabón antes del sitio donde se perdía el dato.
describe('el movimiento GUARDA con qué se pagó, no solo lo lee', () => {
  const WRITERS = [
    // El camino automático: una venta cobrada crea su movimiento en la sesión abierta.
    'commands/_movement_for_open_session.sql',
    // El espejo: anular esa venta. Ya lo llevaba, y ese contraste fue lo que delató al de arriba.
    'commands/_reverse_sale.sql',
  ];

  it.each(WRITERS)('%s escribe payment_method_type', (file) => {
    const sql = sqlOf(file);

    expect(sql, 'el INSERT no nombra la columna: se queda con el DEFAULT `cash` de la migración 003')
      .toMatch(/INSERT\s+INTO\s+cash_register_movement[\s\S]*?payment_method_type/i);
    expect(sql, 'y tiene que tomar el valor del parámetro, no un literal').toMatch(
      /:payment_method_type|'cash'\s+AS\s+payment_method_type|orig\.payment_method_type/i,
    );
  });

  it('el tipo que guarda la venta es el MISMO que el arqueo suma', () => {
    // Si la escritura usara el nombre localizado (`Tarjeta`, `Efectivo`) y la lectura el tipo
    // canónico, cuadrarían solo en español y solo por casualidad.
    const written = sqlOf('commands/_movement_for_open_session.sql');
    const read = sqlOf('commands/close_session.sql');

    expect(written).toMatch(/payment_method_type/);
    expect(read).toMatch(/payment_method_type/);
  });
});
