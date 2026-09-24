import { LitElement, html, css, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-detail-list';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-inline-feedback';
import type { DataTableColumn, OkDetailItem } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

// Un solo catálogo para los dominios cerrados del módulo y para las fechas (cash_register#50): la
// ficha imprimía `Estado open` a dos centímetros de un rótulo que ya decía «Sesión abierta», y la
// columna CUÁNDO soltaba `2026-08-21T17:52:13.198500671+00:00` — el timestamp del motor con nueve
// decimales de segundo. Mismo patrón que `staff/ui/lib/enums.ts` (staff#37).
import { COUNT_TYPE_KEY, MOVEMENT_TYPE_KEY, SESSION_STATUS_KEY, enumLabel, formatDateTime, paymentMethodLabel } from '../../lib/enums';
import { movementConcept, resolveSaleDocument, type SaleDocument } from '../../lib/movement-concept';

/** The session row as the dashboard table has it (`cash_register.sessions.list`). */
export interface SessionRow {
  id: string;
  session_number: string;
  status: string;
  opening_balance: number;
  closing_balance: number | null;
  expected_balance: number | null;
  difference: number | null;
  opened_at?: string | null;
  closed_at?: string | null;
}

/** `cash_register.session.summary` — totals per movement type, as POSITIVE magnitudes. */
interface Summary {
  id: string;
  status: string;
  opening_balance: number;
  total_sales: number;
  /** Sales split by tender (cash_register#91). NULL for an OPEN session in a blind-count hub. */
  cash_sales?: number | null;
  card_sales?: number | null;
  other_sales?: number | null;
  total_refunds: number;
  total_cash_in: number;
  total_cash_out: number;
  total_gifts: number;
  /** NULL for an OPEN session in a blind-count hub (cash_register#84) — unless read through the twin. */
  expected_cash: number | null;
  movement_count: number;
}

interface Movement { id: string; movement_type: string; amount: number; payment_method: string; sale_reference: string; description: string; employee_id: string | null; created_at: string }
interface Count { id: string; count_type: string; total: number; denominations: string; notes: string; counted_at: string }

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  formatMoney(cents: number, opts?: { currency?: string; locale?: string }): string;
  hasPermission?(perm: string): boolean;
}

/** Who may read the live expected of an open session in a blind-count hub (cash_register#24/#84). */
const VIEW_EXPECTED_TOTALS = 'cash_register.view_expected_totals';

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK not initialised by the shell');
  return c;
}

/**
 * Detail of ONE cash session (cash_register#2) — what Square calls the "drawer report" and Toast the
 * "cash drawer details": the reconciliation summary on top (opening float, cash sales, refunds,
 * paid in / paid out, expected cash, counted, difference) and, below, the movements and the counts
 * of that session. Everything comes from the module's own queries scoped by `session_id`
 * (`session.summary`, `movements.list`, `counts.list`); nothing is recomputed on the client.
 *
 * On an OPEN session counted/difference are "—": the difference is revealed when the count is
 * declared (blind count, cash_register#24) — the row carries it only after `session.close`.
 */
export class ErpCashRegisterSessionDetail extends LitElement {
  static styles = css`
    :host { display: block; }
    h3 { margin: .25rem 0 .5rem; font-size: 1rem; }
    h4 { margin: 1rem 0 .5rem; font-size: .95rem; }
    ok-detail-list { margin-bottom: .5rem; }
    .muted { color: var(--ion-color-medium, #92949c); }
  `;

  /** The session to show. Setting it (re)loads summary + lists. */
  @property({ attribute: false }) session: SessionRow | null = null;

  @state() summary: Summary | null = null;

  @state() error = '';

  private movements?: ListController<Movement>;

  private counts?: ListController<Count>;

  /** cash_register#89 — the document of each sale on screen, by `sale_reference`: `null` = none
   *  resolvable, absent = not asked yet. One entry per SALE, so a mixed payment asks once. */
  private readonly saleDocuments = new Map<string, SaleDocument | null>();

  private readonly onLocaleChange = (): void => this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('session')) void this.load();
    this.resolveDocuments();
  }

  /** Ask, once per sale, which document the sales on the current page produced (cash_register#89).
   *  Only rows the concept cell names by their sale; a manual movement asks nobody. */
  private resolveDocuments(): void {
    for (const row of this.movements?.rows ?? []) {
      const ref = row.sale_reference ? String(row.sale_reference) : '';
      if (!ref || (row.movement_type !== 'sale' && row.movement_type !== 'refund') || this.saleDocuments.has(ref)) continue;
      this.saleDocuments.set(ref, null);
      void resolveSaleDocument(erplora(), ref).then((doc) => {
        this.saleDocuments.set(ref, doc);
        if (doc) this.requestUpdate();
      });
    }
  }

  /** Reload everything (the dashboard calls it after a movement/count on this session). */
  async load(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.error = '';
    this.summary = null;
    try {
      // cash_register#84: `session.summary` (view_session) gags the live expected of an OPEN session
      // when the hub counts blind — the cashier about to count must not read it here either. A
      // supervisor reads the ungagged twin instead; the server enforces the permission on both, this
      // only picks the door so a supervisor is not left with «—».
      const sdk = erplora();
      const canSeeExpected = typeof sdk.hasPermission === 'function' && sdk.hasPermission(VIEW_EXPECTED_TOTALS);
      // Two literal calls, not a variable name: the contracts scan (ADR-0127) reads query names off the
      // SDK call itself.
      const rows = canSeeExpected
        ? await sdk.query<Summary[]>('cash_register.session.summary.expected', { session_id: session.id })
        : await sdk.query<Summary[]>('cash_register.session.summary', { session_id: session.id });
      this.summary = Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errLoadDetail');
    }
    // Both lists are server-side pages scoped by the session (`:session_id` is a context param of the
    // base SQL, not a filter). A new session → new controllers (state and page reset).
    this.movements = createListController<Movement>(erplora(), 'cash_register.movements.list', () => this.requestUpdate(), {
      pageSize: 50, sort: 'created_at', dir: 'desc', context: { session_id: session.id },
    });
    this.counts = createListController<Count>(erplora(), 'cash_register.counts.list', () => this.requestUpdate(), {
      pageSize: 50, sort: 'id', dir: 'asc', context: { session_id: session.id },
    });
    await Promise.all([this.movements.load(), this.counts.load()]);
    this.requestUpdate();
  }

  private fmt(n: number | null | undefined): string {
    return n == null ? '—' : erplora().formatMoney(Number(n));
  }

  private get summaryItems(): OkDetailItem[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const s = this.summary;
    const row = this.session;
    const closed = (row?.status ?? s?.status) === 'closed';
    return [
      { label: t('ui.colStatus'), value: enumLabel(SESSION_STATUS_KEY, row?.status ?? s?.status) || '—' },
      { label: t('ui.detailMovements'), value: s ? String(s.movement_count) : '—' },
      { label: t('ui.labelOpeningBalance'), value: this.fmt(s?.opening_balance ?? row?.opening_balance) },
      { label: t('ui.detailSales'), value: this.fmt(s?.total_sales) },
      // Per tender, like an X/Z report (cash_register#91): cash is what the drawer holds. Absent
      // when the server withholds the split (blind count on an open session): no figure of our own.
      ...(s?.cash_sales == null ? [] : [
        { label: t('ui.detailCashSales'), value: this.fmt(s.cash_sales) },
        { label: t('ui.detailCardSales'), value: this.fmt(s.card_sales) },
        ...(Number(s.other_sales) > 0 ? [{ label: t('ui.detailOtherSales'), value: this.fmt(s.other_sales) }] : []),
      ]),
      { label: t('ui.detailRefunds'), value: this.fmt(s?.total_refunds) },
      { label: t('ui.detailCashIn'), value: this.fmt(s?.total_cash_in) },
      { label: t('ui.detailCashOut'), value: this.fmt(s?.total_cash_out) },
      { label: t('ui.detailGifts'), value: this.fmt(s?.total_gifts) },
      // Expected: what the row froze at closing when closed (the audited number), the live figure
      // otherwise — NULL («—») for an open session in a blind-count hub unless the person holds
      // `view_expected_totals` (cash_register#84: this detail was the door left open by #24).
      { label: t('ui.colExpected'), value: this.fmt(closed ? row?.expected_balance ?? s?.expected_cash : s?.expected_cash) },
      { label: t('ui.detailCounted'), value: closed ? this.fmt(row?.closing_balance) : '—' },
      { label: t('ui.colDifference'), value: closed ? this.fmt(row?.difference) : '—' },
    ];
  }

  private get movementColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'created_at', header: t('ui.colWhen'), sortable: true, format: (r) => formatDateTime(r.created_at) },
      { key: 'movement_type', header: t('ui.labelType'), sortable: true, format: (r) => enumLabel(MOVEMENT_TYPE_KEY, r.movement_type) },
      { key: 'amount', header: t('ui.labelAmount'), align: 'right', sortable: true, format: (r) => this.fmt(r.amount as number) },
      { key: 'payment_method', header: t('ui.colMethod'), sortable: true, format: (r) => paymentMethodLabel(r.payment_method) },
      { key: 'description', header: t('ui.labelConcept'), sortable: true,
        format: (r) => movementConcept(r, this.saleDocuments.get(String(r.sale_reference ?? '')), (k, p) => erplora().t(CATALOG, k, p)) },
    ];
  }

  private get countColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'counted_at', header: t('ui.colWhen'), sortable: true, format: (r) => formatDateTime(r.counted_at) },
      { key: 'count_type', header: t('ui.labelCountType'), sortable: true, format: (r) => enumLabel(COUNT_TYPE_KEY, r.count_type) },
      { key: 'total', header: t('ui.totalCounted'), align: 'right', sortable: true, format: (r) => this.fmt(r.total as number) },
      { key: 'notes', header: t('ui.labelNotes') },
    ];
  }

  /**
   * The two lists are written apart, not built by one helper, because each carries its OWN
   * `testid` namespace: `<ok-data-table>` derives every hook it paints — each row, the pager —
   * from that one attribute (outfitkit#143), so a spec that asks for a movement row and a spec
   * that asks for a count row have to be asking two different questions. A shared namespace would
   * answer both with whichever table rendered first.
   */
  private renderMovements() {
    const ctrl = this.movements;
    if (!ctrl) return nothing;
    return html`<ok-data-table testid="cash-register-session-movements-table" .serverSide=${true} .columns=${this.movementColumns} .rows=${ctrl.rows ?? []} .total=${ctrl.total ?? 0}
      .page=${ctrl.state.page} .pageSize=${ctrl.state.pageSize} .sort=${ctrl.state.sort} .sortDir=${ctrl.state.dir}
      .emptyMessage=${ctrl.loading ? erplora().t(CATALOG, 'ui.loading') : erplora().t(CATALOG, 'ui.noMovements')}
      @pageChange=${(e: CustomEvent<number>) => ctrl.setPage(e.detail)}
      @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => ctrl.setSort(e.detail.sort, e.detail.dir)}></ok-data-table>`;
  }

  private renderCounts() {
    const ctrl = this.counts;
    if (!ctrl) return nothing;
    return html`<ok-data-table testid="cash-register-session-counts-table" .serverSide=${true} .columns=${this.countColumns} .rows=${ctrl.rows ?? []} .total=${ctrl.total ?? 0}
      .page=${ctrl.state.page} .pageSize=${ctrl.state.pageSize} .sort=${ctrl.state.sort} .sortDir=${ctrl.state.dir}
      .emptyMessage=${ctrl.loading ? erplora().t(CATALOG, 'ui.loading') : erplora().t(CATALOG, 'ui.noCounts')}
      @pageChange=${(e: CustomEvent<number>) => ctrl.setPage(e.detail)}
      @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => ctrl.setSort(e.detail.sort, e.detail.dir)}></ok-data-table>`;
  }

  render() {
    if (!this.session) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <h3>${t('ui.detailTitle')} · ${this.session.session_number}</h3>
      ${this.error ? html`<ok-inline-feedback data-testid="cash-register-session-error" tone="danger" icon="alert-circle-outline">${this.error}</ok-inline-feedback>` : nothing}
      <ok-detail-list data-testid="cash-register-session-summary" columns="2" dense .items=${this.summaryItems}></ok-detail-list>
      <h4>${t('ui.detailMovements')}</h4>
      ${this.renderMovements()}
      <h4>${t('ui.detailCounts')}</h4>
      ${this.renderCounts()}
    `;
  }
}

define('erp-cashregister-session-detail', ErpCashRegisterSessionDetail);
