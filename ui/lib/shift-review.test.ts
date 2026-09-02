// The shift review that the close was missing (cash_register#68).
//
// The till closed the day in silence: two rounds still on the pass and two tickets still queued for
// a printer, and `cash_register.session.close` said nothing. The manager found out the next
// morning, when there was nothing left to do about it.
//
// What the market does: Toast's *Shift Review*, Square's and Lightspeed's pre-Z report all list
// what is still open at close — and none of them BLOCK it. The close is the one moment somebody
// looks at the whole day, so it is where the system has to say what was left half-done; refusing
// to close would just strand the drawer.
//
// MODULARITY (ADR-0127). `cash_register` must not depend on `kitchen`: a hair salon installs the
// till and never installs a kitchen. So the two facts come through OPTIONAL doors —
// `queryOptional`, which answers `undefined` when the owner module is not in this hub — and the
// runtime's own reserved `hub.` namespace for the print queue, which is core, not a module
// (ADR-0192/ADR-0196).
//
// And "which orders are still live" is KITCHEN's definition, not ours: this reads
// `kitchen.orders.display` — the KDS feed, already scoped by kitchen to what is on the line — and
// counts the tickets that come back. Re-deriving liveness here (`status IN pending, preparing,
// ready`) would freeze kitchen's status vocabulary inside the till, and a status added there would
// go silently uncounted here.
import { describe, expect, it } from 'vitest';
import { hasPendingWork, readShiftReview } from './shift-review';

/** One row of `kitchen.orders.display`: the feed is ONE ROW PER LINE, so a ticket with three
 *  dishes arrives three times. */
function line(orderId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: orderId,
    order_number: `K-${orderId}`,
    order_status: 'pending',
    label: null,
    item_id: `${orderId}-${Math.random()}`,
    product_name: 'Tortilla',
    ...extra,
  };
}

/** A client whose two optional reads answer whatever the test hands it. */
function client(answers: {
  kitchen?: unknown | (() => Promise<unknown>);
  print?: unknown | (() => Promise<unknown>);
}) {
  const asked: string[] = [];
  const resolve = async (v: unknown): Promise<unknown> => (typeof v === 'function' ? (v as () => Promise<unknown>)() : v);
  return {
    asked,
    queryOptional: async (name: string): Promise<unknown> => {
      asked.push(name);
      if (name === 'kitchen.orders.display') return resolve(answers.kitchen);
      throw new Error(`unexpected optional query ${name}`);
    },
    query: async (name: string): Promise<unknown> => {
      asked.push(name);
      if (name === 'hub.print.coverage') return resolve(answers.print);
      throw new Error(`unexpected query ${name}`);
    },
  };
}

describe('shift review — what is still pending when the drawer closes (cash_register#68)', () => {
  it('counts TICKETS, not lines: the KDS feed repeats a ticket once per dish', async () => {
    const review = await readShiftReview(
      client({ kitchen: [line('a'), line('a'), line('b')], print: [] }),
    );

    expect(review.liveOrders, 'two tickets on the pass, five lines between them').toBe(2);
    expect(hasPendingWork(review)).toBe(true);
  });

  it('names the tickets, because "2 pending" does not tell anybody WHICH table to chase', async () => {
    const review = await readShiftReview(
      client({
        kitchen: [line('a', { label: 'S1' }), line('b', { label: null, order_number: 'K-0042' })],
        print: [],
      }),
    );

    expect(review.orderLabels).toEqual(['S1', 'K-0042']);
  });

  it('adds up the print jobs still WAITING, per station', async () => {
    const review = await readShiftReview(
      client({
        kitchen: [],
        print: [
          { role: 'kitchen', waiting: 2, liveHosts: 0, waitingSeconds: 900, undrained: true },
          { role: 'receipt', waiting: 1, liveHosts: 1, waitingSeconds: 4, undrained: false },
          { role: 'bar', waiting: 0, liveHosts: 1, waitingSeconds: 0, undrained: false },
        ],
      }),
    );

    expect(review.pendingPrintJobs).toBe(3);
    expect(review.printRoles, 'only the stations with work waiting are worth naming').toEqual(['kitchen', 'receipt']);
    expect(hasPendingWork(review)).toBe(true);
  });

  it('a hub WITHOUT kitchen closes exactly as before: absence is not a warning', async () => {
    const c = client({ kitchen: undefined, print: [] });
    const review = await readShiftReview(c);

    expect(review.liveOrders).toBe(0);
    expect(review.incomplete, 'a module that is not installed is not a failed check').toBe(false);
    expect(hasPendingWork(review), 'nothing pending → the close must not add a single step').toBe(false);
  });

  it('a broken read is NOT silence: it degrades AND says the review is incomplete', async () => {
    const review = await readShiftReview(
      client({
        kitchen: () => Promise.reject(Object.assign(new Error('boom'), { code: 'permission_denied' })),
        print: [],
      }),
    );

    expect(review.liveOrders).toBe(0);
    expect(review.incomplete, 'a check that could not run must reach the screen, never a mute catch').toBe(true);
    expect(hasPendingWork(review), 'we have no evidence of pending work: do not invent a step').toBe(false);
  });

  it('one door failing does not blind the other', async () => {
    const review = await readShiftReview(
      client({
        kitchen: [line('a')],
        print: () => Promise.reject(new Error('old runtime without hub.print.coverage')),
      }),
    );

    expect(review.liveOrders).toBe(1);
    expect(review.pendingPrintJobs).toBe(0);
    expect(review.incomplete).toBe(true);
    expect(hasPendingWork(review), 'the half that DID answer still has to be shown').toBe(true);
  });

  it('an answer that is not a list degrades to zero instead of throwing on the close screen', async () => {
    const review = await readShiftReview(client({ kitchen: { rows: 'nope' }, print: null }));

    expect(review.liveOrders).toBe(0);
    expect(review.pendingPrintJobs).toBe(0);
  });

  it('reads the KDS feed through the OPTIONAL door and the print queue through the core one', async () => {
    const c = client({ kitchen: [], print: [] });
    await readShiftReview(c);

    expect(c.asked).toContain('kitchen.orders.display');
    expect(c.asked).toContain('hub.print.coverage');
  });

  it('a shell too old to have the OPTIONAL door does not blow up the close screen', async () => {
    // `queryOptional` arrived with ADR-0127 phase 3. A hub still serving an older SDK bundle has no
    // such method, and calling it would reject OUTSIDE the promise chain — an unhandled rejection
    // on the one screen that cannot break. It degrades to "could not check", like any other read
    // that did not run.
    const legacy = { query: async () => [] } as unknown as Parameters<typeof readShiftReview>[0];

    const review = await readShiftReview(legacy);

    expect(review.liveOrders).toBe(0);
    expect(review.incomplete).toBe(true);
    expect(hasPendingWork(review)).toBe(false);
  });

  it('accepts the list-engine envelope as well as a bare array', async () => {
    const review = await readShiftReview(
      client({ kitchen: { rows: [line('a'), line('b')], total: 2 }, print: { rows: [{ role: 'receipt', waiting: 4 }] } }),
    );

    expect(review.liveOrders).toBe(2);
    expect(review.pendingPrintJobs).toBe(4);
  });
});
