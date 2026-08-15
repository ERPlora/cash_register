// Un movimiento solo cuelga de una sesión del MISMO hub (pm#146).
//
// Aquí la fila cruzada no es un dato feo: es **dinero mal contado**. `session_summary` suma los
// movimientos de una sesión para dar el arqueo, y su JOIN sobre `cash_register_movement` ganó la
// igualdad de hub en pm#89 — pero acotar la lectura deja de ENSEÑAR la fila del vecino, no impide
// escribirla. Con `:session_id` viniendo del payload sin comprobar, un movimiento de este hub podía
// quedar apuntando a la sesión de otro.
//
// Las dos mitades de la receta (services#7):
//
//   1. la sesión se resuelve contra el `:hub_id` que **inyecta el runtime**, nunca contra el
//      payload;
//   2. y si no casa, **falla**. Un INSERT condicional sin `expect_rows` es peor que el bug: no
//      escribe, devuelve OK y **emite `cash_register.movement_added`** — quien escuche ese evento
//      contará un movimiento que no existe.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8')) as {
  id: string;
  commands: Record<
    string,
    {
      sql?: string[];
      emit?: string[];
      expect_rows?: { op: string; n: number; error: string; message?: string };
    }
  >;
};

const COMMAND = 'cash_register.movement.add';

const sqlOf = (name: string) =>
  (manifest.commands[name].sql ?? [])
    .map((rel) =>
      readFileSync(join(ROOT, rel), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n'),
    )
    .join('\n');

describe('un movimiento solo cuelga de una sesión del mismo hub (pm#146)', () => {
  it('la sesión se resuelve contra el hub inyectado, no contra el payload', () => {
    const sql = sqlOf(COMMAND);

    expect(sql, 'toma cualquier session_id: también el de otro hub').toMatch(
      /cash_register_session/,
    );
    expect(sql, 'la sesión tiene que ser de ESTE hub').toMatch(/hub_id\s*=\s*:hub_id/);
  });

  it('falla en vez de no escribir, decir que sí y emitir el evento igual', () => {
    const gate = manifest.commands[COMMAND].expect_rows;

    expect(
      manifest.commands[COMMAND].emit,
      'este command emite: por eso un no-op silencioso engaña también a quien escucha',
    ).toContain('cash_register.movement_added');

    expect(gate, 'un INSERT condicional sin `expect_rows` es un no-op que aun así emite').toBeTruthy();
    expect(gate!.op).toBe('min');
    expect(gate!.n).toBeGreaterThanOrEqual(1);
    expect(gate!.error.split('.')[0], 'el instalador exige el namespace del módulo').toBe(
      manifest.id,
    );
    expect(gate!.message, 'ningún shell traduce estos códigos todavía: hace falta el texto').toBeTruthy();
  });
});
