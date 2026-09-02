// shift-review — what is still half-done when the drawer closes (cash_register#68).
//
// The close was silent: rounds still on the pass and tickets still queued for a printer, and
// `cash_register.session.close` said nothing. Toast's *Shift Review*, Square's and Lightspeed's
// pre-Z report all list what is still open at close, and none of them BLOCK it — the close is the
// one moment somebody looks at the whole day, so it is where the system has to say what was left
// half-done. Refusing to close would just strand the drawer.
//
// MODULARITY (ADR-0127). `cash_register` does NOT depend on `kitchen` — a hair salon installs the
// till and never installs a kitchen — so the rounds come through the OPTIONAL door
// (`queryOptional`, `undefined` when the owner module is not in this hub) and the print queue
// through the runtime's reserved `hub.` namespace, which is core and not a module (ADR-0192).
//
// **Liveness is kitchen's definition, not ours.** This reads `kitchen.orders.display` — the KDS
// feed, already scoped by kitchen to what is on the line — and counts the tickets that come back.
// Re-deriving it here (`status IN ('pending','preparing','ready')`) would freeze kitchen's status
// vocabulary inside the till, and a status added there would go silently uncounted here. The feed
// is bounded by exactly the thing being warned about, which is why it is cheap at closing time:
// the normal answer is empty.

/** The KDS feed, ONE ROW PER LINE: a ticket with three dishes arrives three times. */
interface KitchenLine {
  order_id?: unknown;
  order_number?: unknown;
  label?: unknown;
}

/** One station of `hub.print.coverage`. `waiting` is jobs still `pending` — the runtime resolves
 *  `undrained` itself so no screen re-derives what "stuck" means (hub#987/#1107). */
interface PrintCoverage {
  role?: unknown;
  waiting?: unknown;
}

/** The subset of the SDK this read needs. Injected so the logic is testable without a shell. */
export interface ShiftReviewClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
}

export interface ShiftReview {
  /** Tickets on the pass that nobody has served yet. */
  liveOrders: number;
  /** How to name them on screen: the table label, or the ticket number when it has none. */
  orderLabels: string[];
  /** Print jobs still waiting for a host to take them. */
  pendingPrintJobs: number;
  /** The stations those jobs are waiting on. */
  printRoles: string[];
  /**
   * At least one of the two reads could NOT run — and that is not the same as "nothing pending".
   *
   * An absent module is NOT this: it is the normal case and stays quiet. This is a denied
   * permission, a renamed query, a runtime too old to serve `hub.print.coverage`. A mute catch is
   * how a screen silently stops helping, so the panel says the review is incomplete instead of
   * showing a reassuring blank.
   */
  incomplete: boolean;
}

/** How many ticket names the warning carries before it becomes a wall of text. */
export const MAX_LISTED_ORDERS = 6;

/** Rows out of either shape the runtime answers with: a bare array, or the list engine's
 *  `{ rows, total }` envelope. Anything else degrades to none — the close screen is the one that
 *  cannot break. */
function toRows<T>(answer: unknown): T[] {
  if (Array.isArray(answer)) return answer as T[];
  const rows = (answer as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function count(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** The KDS feed → distinct tickets, in the order the feed hands them out (oldest first). */
export function summariseLiveOrders(answer: unknown): { liveOrders: number; orderLabels: string[] } {
  const seen = new Map<string, string>();
  for (const row of toRows<KitchenLine>(answer)) {
    const id = text(row?.order_id);
    if (!id || seen.has(id)) continue;
    seen.set(id, text(row?.label) || text(row?.order_number) || id);
  }
  return { liveOrders: seen.size, orderLabels: [...seen.values()].slice(0, MAX_LISTED_ORDERS) };
}

/** Coverage per station → how much is waiting, and on which stations. */
export function summarisePrintQueue(answer: unknown): { pendingPrintJobs: number; printRoles: string[] } {
  let pendingPrintJobs = 0;
  const printRoles: string[] = [];
  for (const row of toRows<PrintCoverage>(answer)) {
    const waiting = count(row?.waiting);
    if (waiting <= 0) continue;
    pendingPrintJobs += waiting;
    const role = text(row?.role);
    if (role && !printRoles.includes(role)) printRoles.push(role);
  }
  return { pendingPrintJobs, printRoles };
}

/** Is there anything worth interrupting the close for? */
export function hasPendingWork(review: ShiftReview): boolean {
  return review.liveOrders > 0 || review.pendingPrintJobs > 0;
}

/**
 * Asks both doors at once and never throws: the close has to work even when the review cannot.
 *
 * `queryOptional` already turns "kitchen is not installed" into `undefined` (ADR-0127), so absence
 * needs no branch here — it simply contributes nothing and leaves `incomplete` false. Every OTHER
 * failure is a broken contract and is reported as such.
 */
export async function readShiftReview(client: ShiftReviewClient): Promise<ShiftReview> {
  /** Runs one read and turns ANY way it can go wrong into a verdict.
   *
   *  The `typeof` guard is not decoration: `queryOptional` arrived with ADR-0127 phase 3, so a hub
   *  still serving an older SDK bundle has no such method and calling it would reject OUTSIDE the
   *  promise chain — an unhandled rejection on the one screen that cannot break. A missing door is
   *  a read that did not run, which is exactly what `incomplete` already means. */
  const attempt = async (read: (() => Promise<unknown>) | undefined): Promise<{ answer: unknown; failed: boolean }> => {
    if (typeof read !== 'function') return { answer: undefined, failed: true };
    try {
      return { answer: await read(), failed: false };
    } catch {
      return { answer: undefined, failed: true };
    }
  };

  const [kitchen, print] = await Promise.all([
    attempt(client.queryOptional && (() => client.queryOptional('kitchen.orders.display'))),
    attempt(client.query && (() => client.query('hub.print.coverage'))),
  ]);

  return {
    ...summariseLiveOrders(kitchen.answer),
    ...summarisePrintQueue(print.answer),
    incomplete: kitchen.failed || print.failed,
  };
}
