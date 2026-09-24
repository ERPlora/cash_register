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
      handler?: { type: string; file: string; function: string };
      reads?: (string | { query: string; params?: Record<string, string>; required?: boolean })[];
      expect_rows?: { op: string; n: number; error: string; message?: string };
    }
  >;
  queries: Record<string, { sql: string }>;
};

const COMMAND = 'cash_register.movement.add';
// cash_register#38: the public command is a WASM handler (settings enforced on the server) that
// resolves to this internal SQL. The two halves of the recipe move doors: hub scoping stays in the
// SQL; "fail instead of a silent no-op" is now the handler refusing an unknown session BEFORE
// writing (`reads` of `cash_register.session.summary` for the payload's session, required) —
// covered by the handler's own tests (`add_movement_refuses_an_unknown_session`).
const INSERT = 'cash_register._movement_insert';

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
    const sql = sqlOf(INSERT);

    expect(sql, 'toma cualquier session_id: también el de otro hub').toMatch(
      /cash_register_session/,
    );
    expect(sql, 'la sesión tiene que ser de ESTE hub').toMatch(/hub_id\s*=\s*:hub_id/);
  });

  it('falla en vez de no escribir, decir que sí y emitir el evento igual', () => {
    const cmd = manifest.commands[COMMAND];

    expect(
      cmd.emit,
      'este command emite: por eso un no-op silencioso engaña también a quien escucha',
    ).toContain('cash_register.movement_added');

    // The door on the WASM path: the host preloads the payload's session (this hub only — the
    // query scopes by :hub_id) and the handler refuses when it is not there.
    expect(cmd.handler, 'movement.add es un handler WASM (cash_register#38)').toBeTruthy();
    const read = (cmd.reads ?? []).find(
      (r) => typeof r === 'object' && r.query === 'cash_register.session.summary.expected',
    ) as { query: string; params?: Record<string, string>; required?: boolean } | undefined;
    expect(read, 'el handler tiene que recibir la sesión del payload precargada por el host').toBeTruthy();
    expect(read!.params?.session_id).toBe('payload.session_id');
    expect(read!.required, 'una read obligatoria que falla aborta en vez de degradar').toBe(true);
    const summarySql = readFileSync(join(ROOT, manifest.queries['cash_register.session.summary.expected'].sql), 'utf8');
    expect(summarySql, 'la sesión precargada tiene que ser de ESTE hub').toMatch(/s\.hub_id\s*=\s*:hub_id/);
  });
});
