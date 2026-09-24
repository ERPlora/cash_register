// cash_register#89 — the CONCEPT of a sale movement read «Sale 3c9ccc35-550d-4905-8b98-bfcb0b09b5f4»:
// an English word and a uuid the owner cannot match against anything she holds. What she holds is
// the DOCUMENT — the invoice or receipt number printed on the paper — so that is what the concept
// names, in the hub's language.
//
// The stored `description` stays as it is ON PURPOSE: `'[VOID] Sale ' || :sale_id` is the
// idempotency key of `_reverse_movement_for_open_session.sql`, so rewriting it would let a replayed
// void book the reversal twice. The fix is where the person reads it.
import { describe, expect, it } from 'vitest';
import { movementConcept, resolveSaleDocument, type SaleDocument } from './movement-concept';

// Echo translator: the key plus its params, so every assert pins WHICH text and WHICH number.
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

const SALE_ID = '3c9ccc35-550d-4905-8b98-bfcb0b09b5f4';
const saleRow = { movement_type: 'sale', sale_reference: SALE_ID, description: `Sale ${SALE_ID}` };

describe('el concepto de un movimiento de venta nombra el documento (cash_register#89)', () => {
  it('una venta con factura completa se lee «Factura <número>»', () => {
    const doc: SaleDocument = { kind: 'invoice', number: 'FACT-2026-000001' };
    expect(movementConcept(saleRow, doc, t)).toBe('ui.conceptInvoice(number=FACT-2026-000001)');
  });

  it('una venta con factura simplificada se lee «Tique <número>»', () => {
    expect(movementConcept(saleRow, { kind: 'receipt', number: 'T-2026-000042' }, t))
      .toBe('ui.conceptReceipt(number=T-2026-000042)');
  });

  it('sin app de facturación, el número de la venta', () => {
    expect(movementConcept(saleRow, { kind: 'sale', number: '20260916-0007' }, t))
      .toBe('ui.conceptSale(number=20260916-0007)');
  });

  it('sin documento resoluble (o aún resolviéndose) dice «Venta» y NUNCA el uuid', () => {
    for (const doc of [null, undefined]) {
      const shown = movementConcept(saleRow, doc, t);
      expect(shown).toBe('ui.conceptSaleUnnumbered');
      expect(shown).not.toContain(SALE_ID);
      expect(shown).not.toContain('Sale ');
    }
  });

  it('la anulación de una venta se lee «Anulación de <documento>»', () => {
    const row = { movement_type: 'refund', sale_reference: SALE_ID, description: `[VOID] Sale ${SALE_ID}` };
    expect(movementConcept(row, { kind: 'invoice', number: 'FACT-2026-000001' }, t))
      .toBe('ui.conceptVoidOf(document=ui.conceptInvoice(number=FACT-2026-000001))');
  });

  it('una devolución se lee «Devolución de <documento>», sin el uuid', () => {
    const row = { movement_type: 'refund', sale_reference: SALE_ID, description: `Refund refund-doc-0001 · sale ${SALE_ID}` };
    const shown = movementConcept(row, { kind: 'receipt', number: 'T-2026-000042' }, t);
    expect(shown).toBe('ui.conceptRefundOf(document=ui.conceptReceipt(number=T-2026-000042))');
    expect(movementConcept(row, null, t)).toBe('ui.conceptRefundOf(document=ui.conceptSaleUnnumbered)');
  });

  it('un movimiento manual enseña lo que tecleó la persona, tal cual', () => {
    expect(movementConcept({ movement_type: 'out', sale_reference: '', description: 'supplier bread' }, null, t)).toBe('supplier bread');
    // A manual movement that names a sale keeps the words the person wrote: they are hers.
    expect(movementConcept({ movement_type: 'in', sale_reference: 'T-1', description: 'change float' }, null, t)).toBe('change float');
    expect(movementConcept({ movement_type: 'in', sale_reference: null, description: null }, null, t)).toBe('');
  });
});

type Sdk = Parameters<typeof resolveSaleDocument>[0];

function sdkWith(answers: Record<string, unknown>, calls: string[] = []): Sdk {
  const answer = async (name: string) => {
    calls.push(name);
    const a = answers[name];
    if (a instanceof Error) throw a;
    return a;
  };
  return { queryOptional: answer } as unknown as Sdk;
}

describe('de qué documento sale el número (cash_register#89)', () => {
  it('F1/F3 → factura; F2 → tique (lo que va impreso en el papel)', async () => {
    for (const [type, kind] of [['F1', 'invoice'], ['F3', 'invoice'], ['F2', 'receipt']] as const) {
      const sdk = sdkWith({ 'invoice.by_source': [{ id: 'i1', invoice_type: type, number: 'N-1' }] });
      expect(await resolveSaleDocument(sdk, SALE_ID)).toEqual({ kind, number: 'N-1' });
    }
  });

  it('pregunta a la factura por la VENTA (source_id = sale_reference)', async () => {
    const seen: Record<string, unknown>[] = [];
    const sdk = { queryOptional: async (_n: string, p: Record<string, unknown>) => { seen.push(p); return [{ invoice_type: 'F1', number: 'X' }]; } } as unknown as Sdk;
    await resolveSaleDocument(sdk, SALE_ID);
    expect(seen[0]).toEqual({ source_id: SALE_ID });
  });

  it('sin app de facturación (o sin factura todavía) cae al número de la venta', async () => {
    const calls: string[] = [];
    const absent = sdkWith({ 'invoice.by_source': undefined, 'sales.get': [{ id: SALE_ID, sale_number: '20260916-0007' }] }, calls);
    expect(await resolveSaleDocument(absent, SALE_ID)).toEqual({ kind: 'sale', number: '20260916-0007' });
    expect(calls).toEqual(['invoice.by_source', 'sales.get']);

    const pending = sdkWith({ 'invoice.by_source': [], 'sales.get': [{ sale_number: '20260916-0008' }] });
    expect(await resolveSaleDocument(pending, SALE_ID)).toEqual({ kind: 'sale', number: '20260916-0008' });
  });

  it('sin permiso para leer facturas tampoco se rinde: número de la venta', async () => {
    const sdk = sdkWith({ 'invoice.by_source': new Error('forbidden'), 'sales.get': [{ sale_number: '20260916-0009' }] });
    expect(await resolveSaleDocument(sdk, SALE_ID)).toEqual({ kind: 'sale', number: '20260916-0009' });
  });

  it('si nada responde devuelve null (la pantalla dice «Venta»), sin lanzar', async () => {
    const sdk = sdkWith({ 'invoice.by_source': new Error('x'), 'sales.get': new Error('y') });
    expect(await resolveSaleDocument(sdk, SALE_ID)).toBeNull();
    expect(await resolveSaleDocument(sdkWith({ 'invoice.by_source': undefined, 'sales.get': undefined }), SALE_ID)).toBeNull();
  });
});
