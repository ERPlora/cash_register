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
  total_refunds: number;
  total_cash_in: number;
  total_cash_out: number;
  total_gifts: number;
  expected_cash: number;
  movement_count: number;
}

interface Movement { id: string; movement_type: string; amount: number; payment_method: string; sale_reference: string; description: string; employee_id: string | null; created_at: string }
interface Count { id: string; count_type: string; total: number; denominations: string; notes: string; counted_at: string }

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  formatMoney(cents: number, opts?: { currency?: string; locale?: string }): string;
}

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
  }

  /** Reload everything (the dashboard calls it after a movement/count on this session). */
  async load(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.error = '';
    this.summary = null;
    try {
      const rows = await erplora().query<Summary[]>('cash_register.session.summary', { session_id: session.id });
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
      { label: t('ui.detailCashSales'), value: this.fmt(s?.total_sales) },
      { label: t('ui.detailRefunds'), value: this.fmt(s?.total_refunds) },
      { label: t('ui.detailCashIn'), value: this.fmt(s?.total_cash_in) },
      { label: t('ui.detailCashOut'), value: this.fmt(s?.total_cash_out) },
      { label: t('ui.detailGifts'), value: this.fmt(s?.total_gifts) },
      // Expected: what the row froze at closing when closed (the audited number), the live figure
      // otherwise (`session.summary` runs under `view_session`; the blind-count setting hides it
      // in the dashboard widget, not here — this is the manager's reconciliation view).
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
      { key: 'description', header: t('ui.labelConcept'), sortable: true },
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

  private table<T>(ctrl: ListController<T> | undefined, columns: DataTableColumn[], empty: string) {
    if (!ctrl) return nothing;
    return html`<ok-data-table .serverSide=${true} .columns=${columns} .rows=${ctrl.rows ?? []} .total=${ctrl.total ?? 0}
      .page=${ctrl.state.page} .pageSize=${ctrl.state.pageSize} .sort=${ctrl.state.sort} .sortDir=${ctrl.state.dir}
      .emptyMessage=${ctrl.loading ? erplora().t(CATALOG, 'ui.loading') : empty}
      @pageChange=${(e: CustomEvent<number>) => ctrl.setPage(e.detail)}
      @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => ctrl.setSort(e.detail.sort, e.detail.dir)}></ok-data-table>`;
  }

  render() {
    if (!this.session) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <h3>${t('ui.detailTitle')} · ${this.session.session_number}</h3>
      ${this.error ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.error}</ok-inline-feedback>` : nothing}
      <ok-detail-list columns="2" dense .items=${this.summaryItems}></ok-detail-list>
      <h4>${t('ui.detailMovements')}</h4>
      ${this.table(this.movements, this.movementColumns, t('ui.noMovements'))}
      <h4>${t('ui.detailCounts')}</h4>
      ${this.table(this.counts, this.countColumns, t('ui.noCounts'))}
    `;
  }
}

define('erp-cashregister-session-detail', ErpCashRegisterSessionDetail);
