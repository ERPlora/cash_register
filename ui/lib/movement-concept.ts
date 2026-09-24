// The CONCEPT of a cash movement as the person reads it (cash_register#89).
//
// A sale movement stores `Sale <sale uuid>` (and a void `[VOID] Sale <uuid>`, a refund
// `Refund <ref> · sale <uuid>`). That text is NOT for people: the void one is the idempotency key of
// `commands/_reverse_movement_for_open_session.sql`, so it stays as it is in the row. What the owner
// matches a line against is the DOCUMENT she holds — the invoice or receipt number printed on the
// paper — so the screen names that document, in the hub's language.

/** The document a sale produced, as it is printed: an invoice (F1/F3), a receipt (F2, simplified
 *  invoice) or — with no invoicing app — the sale's own number. */
export interface SaleDocument {
  kind: 'invoice' | 'receipt' | 'sale';
  number: string;
}

export interface MovementLike {
  movement_type?: unknown;
  sale_reference?: unknown;
  description?: unknown;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

const DOCUMENT_KEY: Record<SaleDocument['kind'], string> = {
  invoice: 'ui.conceptInvoice',
  receipt: 'ui.conceptReceipt',
  sale: 'ui.conceptSale',
};

/** The stored prefix of a VOID reversal (`_reverse_movement_for_open_session.sql`). */
const VOID_PREFIX = '[VOID] ';

/**
 * What the CONCEPT cell prints. `doc` is the resolved document of the row's sale: `null` when none
 * could be resolved, `undefined` while it is being resolved — both read «Sale», never the uuid.
 * A manual movement (`in`/`out`) prints what the person typed, even if it names a sale.
 */
export function movementConcept(row: MovementLike, doc: SaleDocument | null | undefined, t: Translate): string {
  const description = row.description == null ? '' : String(row.description);
  const saleRef = row.sale_reference == null ? '' : String(row.sale_reference);
  const type = String(row.movement_type ?? '');
  if (!saleRef || (type !== 'sale' && type !== 'refund')) return description;
  const document = doc ? t(DOCUMENT_KEY[doc.kind], { number: doc.number }) : t('ui.conceptSaleUnnumbered');
  if (type === 'sale') return document;
  return t(description.startsWith(VOID_PREFIX) ? 'ui.conceptVoidOf' : 'ui.conceptRefundOf', { document });
}

interface OptionalQueryClient {
  queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
}

function firstRow(rows: unknown): Record<string, unknown> | undefined {
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
}

/**
 * The document of one sale. Neither `invoice` nor `sales` is a dependency of this module (ADR-0127),
 * so both are asked through `queryOptional` and every failure degrades to the next source:
 * the invoice (`invoice.by_source`) → the sale's number (`sales.get`) → `null`. A missing app, an
 * invoice not issued yet or a role without permission to read invoices all end on the sale number.
 */
export async function resolveSaleDocument(sdk: OptionalQueryClient, saleId: string): Promise<SaleDocument | null> {
  try {
    const invoice = firstRow(await sdk.queryOptional('invoice.by_source', { source_id: saleId }));
    const number = invoice?.number == null ? '' : String(invoice.number);
    if (number) return { kind: invoice?.invoice_type === 'F2' ? 'receipt' : 'invoice', number };
  } catch {
    // No permission to read invoices / broken contract: the sale number still identifies it.
  }
  try {
    const sale = firstRow(await sdk.queryOptional('sales.get', { sale_id: saleId }));
    const number = sale?.sale_number == null ? '' : String(sale.sale_number);
    if (number) return { kind: 'sale', number };
  } catch {
    // Nothing else to ask: the screen reads «Sale» without a number.
  }
  return null;
}
