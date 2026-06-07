import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

interface Session {
  id: string; session_number: string; status: string;
  opening_balance: number; closing_balance: number | null;
  expected_balance: number | null; difference: number | null;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpCashRegisterDashboard extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .err { color:#d9480f; font-weight:600; }
  `;

  @state() tick = 0;

  private ctrl!: ListController<Session>;

  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'session_number', header: 'Sesión', sortable: true, filterable: true, filterType: 'text' },
    { key: 'status', header: 'Estado', sortable: true, filterable: true, filterType: 'text' },
    { key: 'opening_balance', header: 'Apertura', align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.opening_balance as number | null) },
    { key: 'expected_balance', header: 'Esperado', align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.expected_balance as number | null) },
    { key: 'closing_balance', header: 'Contado', align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.closing_balance as number | null) },
    { key: 'difference', header: 'Diferencia', align: 'right', sortable: true, filterable: true, filterType: 'text', format: (r) => this.fmt(r.difference as number | null) },
  ];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    this.ctrl = createListController<Session>(erplora(), 'cash_register.sessions.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await this.ctrl.load();
    try {
      const a = erplora().on('cash_register.session_opened', () => this.ctrl.load());
      const b = erplora().on('cash_register.session_closed', () => this.ctrl.load());
      this.unsub = () => { a(); b(); };
    } catch { /* preview */ }
  }

  disconnectedCallback() {
    super.disconnectedCallback(); this.unsub?.(); }

  private fmt(n: number | null): string { return n == null ? '—' : Number(n).toFixed(2); }

  render() {
    return html`<div>
        <header>
          <h2>Caja</h2>
        </header>
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${"Buscar sesión o estado…"} .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin sesiones de caja.'} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-cashregister-dashboard', ErpCashRegisterDashboard);
