import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  /** Moneda del hub + formateo de dinero (ADR-0059). */
  currency: string;
  formatAmount(units: number, opts?: { currency?: string; locale?: string }): string;
}

interface Session {
  id: string; session_number: string; status: string;
  opening_balance: number; closing_balance: number | null;
  expected_balance: number | null; difference: number | null;
}

interface Register { id: string; name: string; is_active: number }

/** Denominaciones EUR para el arqueo (billetes y monedas). */
const BILLS = ['500', '200', '100', '50', '20', '10', '5'];
const COINS = ['2', '1', '0.50', '0.20', '0.10', '0.05', '0.02', '0.01'];

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** Nº de sesión generado por la UI: S-YYMMDD-HHMMSS (open_session.sql espera :session_number). */
function sessionNumber(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `S-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class ErpCashRegisterDashboard extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    h3 { margin:.25rem 0 .5rem; font-size:1rem; }
    .panel { border:1px solid var(--ion-border-color,#e7e2d6); border-radius:10px; padding:.75rem 1rem; margin:0 0 1rem; background:var(--ok-surface-2, var(--ion-color-step-50, rgba(var(--ion-text-color-rgb, 24, 24, 27), 0.04))); }
    .form { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; }
    .form ion-input, .form ion-select { flex:1 1 11rem; min-width:9rem; }
    .denoms { display:grid; grid-template-columns:repeat(auto-fill, minmax(5.5rem, 1fr)); gap:.75rem; margin:.5rem 0; }
    .total { font-weight:700; margin:.25rem 0; }
    .err { color:#d9480f; font-weight:600; }
    .ok { color:#2b8a3e; font-weight:600; }
  `;

  @state() tick = 0;

  @state() formError = '';

  @state() formMsg = '';

  @state() saving = false;

  /** Panel activo: null | 'open' | 'close' | 'movement' | 'count'. */
  @state() panel: 'open' | 'close' | 'movement' | 'count' | null = null;

  /** Sesión objetivo de cerrar/movimiento/arqueo. */
  @state() target: Session | null = null;

  // — Abrir sesión —
  @state() openRegisterId = '';

  @state() openBalance = '0';

  @state() openNotes = '';

  // — Cerrar sesión —
  @state() closeBalance = '';

  @state() closeNotes = '';

  // — Movimiento —
  @state() movType: 'in' | 'out' = 'in';

  @state() movAmount = '';

  @state() movDescription = '';

  // — Arqueo —
  @state() countType: 'opening' | 'closing' = 'closing';

  @state() countNotes = '';

  @state() denomCounts: Record<string, string> = {};

  @state() registers: Register[] = [];

  private ctrl!: ListController<Session>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'session_number', header: t('ui.colSession'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'status', header: t('ui.colStatus'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'opening_balance', header: t('ui.colOpening'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.opening_balance as number | null) },
      { key: 'expected_balance', header: t('ui.colExpected'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.expected_balance as number | null) },
      { key: 'closing_balance', header: t('ui.colCounted'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.closing_balance as number | null) },
      { key: 'difference', header: t('ui.colDifference'), align: 'right', sortable: true, filterable: true, filterType: 'text', format: (r) => this.fmt(r.difference as number | null) },
    ];
  }

  private get rowActions(): DataTableAction[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { id: 'movement', label: t('ui.actionMovement') },
      { id: 'count', label: t('ui.actionCount') },
      { id: 'close', label: t('ui.actionClose'), color: 'danger' },
    ];
  }

  // Re-render al cambiar el idioma del shell (ADR-0055): los getters `columns`/`rowActions` y el
  // texto del template se re-evalúan con el nuevo `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<Session>(erplora(), 'cash_register.sessions.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await Promise.all([this.ctrl.load(), this.loadRegisters()]);
    try {
      const a = erplora().on('cash_register.session_opened', () => this.ctrl.load());
      const b = erplora().on('cash_register.session_closed', () => this.ctrl.load());
      this.unsub = () => { a(); b(); };
    } catch { /* preview */ }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback(); this.unsub?.(); }

  // Saldos en UNIDADES mayores → formateados con la MONEDA DEL HUB (ADR-0059). `null` → guion.
  private fmt(n: number | null): string { return n == null ? '—' : erplora().formatAmount(Number(n)); }

  private async loadRegisters() {
    try {
      const page = await erplora().queryPage<Register>('cash_register.registers.list', { page: 0, page_size: 50 });
      this.registers = page?.rows ?? [];
    } catch { /* lista de cajones opcional; el form sigue funcionando sin ella */ }
  }

  private resetPanel() {
    this.panel = null;
    this.target = null;
    this.formError = '';
  }

  private openPanel(panel: 'close' | 'movement' | 'count', session: Session) {
    if (session.status !== 'open') {
      this.formMsg = '';
      this.formError = erplora().t(CATALOG, 'ui.errSessionNotOpen', { session: session.session_number });
      return;
    }
    this.target = session;
    this.panel = panel;
    this.formError = '';
    this.formMsg = '';
  }

  private onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const session = ev.detail.row as unknown as Session;
    const id = ev.detail.actionId;
    if (id === 'close' || id === 'movement' || id === 'count') this.openPanel(id, session);
  }

  // — Abrir sesión → cash_register.session.open —
  private async openSession(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.session.open', {
        register_id: this.openRegisterId || null,
        session_number: sessionNumber(),
        opening_balance: Number(this.openBalance) || 0,
        opening_notes: this.openNotes.trim(),
      });
      this.openRegisterId = '';
      this.openBalance = '0';
      this.openNotes = '';
      this.resetPanel();
      this.formMsg = erplora().t(CATALOG, 'ui.msgSessionOpened');
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errOpenSession');
    } finally {
      this.saving = false;
    }
  }

  // — Cerrar sesión → cash_register.session.close (reconcilia esperado/diferencia en SQL) —
  private async closeSession(ev: Event) {
    ev.preventDefault();
    if (!this.target || this.closeBalance === '') return;
    const sessionId = this.target.id;
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.session.close', {
        session_id: sessionId,
        closing_balance: Number(this.closeBalance) || 0,
        closing_notes: this.closeNotes.trim(),
      });
      this.closeBalance = '';
      this.closeNotes = '';
      this.resetPanel();
      await this.ctrl.load();
      const row = (this.ctrl.rows ?? []).find((r) => String(r.id) === String(sessionId));
      this.formMsg = row
        ? erplora().t(CATALOG, 'ui.msgSessionClosedDetail', {
            session: row.session_number,
            expected: this.fmt(row.expected_balance),
            counted: this.fmt(row.closing_balance),
            difference: this.fmt(row.difference),
          })
        : erplora().t(CATALOG, 'ui.msgSessionClosed');
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCloseSession');
    } finally {
      this.saving = false;
    }
  }

  // — Movimiento manual → cash_register.movement.add (out se registra en negativo) —
  private async addMovement(ev: Event) {
    ev.preventDefault();
    if (!this.target || !this.movAmount) return;
    const amount = Math.abs(Number(this.movAmount) || 0);
    if (amount <= 0) { this.formError = erplora().t(CATALOG, 'ui.errInvalidAmount'); return; }
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.movement.add', {
        session_id: this.target.id,
        movement_type: this.movType,
        amount: this.movType === 'out' ? -amount : amount,
        payment_method: 'cash',
        sale_reference: '',
        description: this.movDescription.trim(),
      });
      const msg = erplora().t(CATALOG, this.movType === 'in' ? 'ui.msgMovementIn' : 'ui.msgMovementOut', {
        amount: amount.toFixed(2),
      });
      this.movAmount = '';
      this.movDescription = '';
      this.resetPanel();
      this.formMsg = msg;
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errAddMovement');
    } finally {
      this.saving = false;
    }
  }

  // — Arqueo → cash_register.count.add (el handler WASM calcula el total desde denominaciones) —
  private denominationsPayload(): { bills: Record<string, number>; coins: Record<string, number> } {
    const pick = (keys: string[]) => {
      const out: Record<string, number> = {};
      for (const k of keys) {
        const n = Number(this.denomCounts[k] ?? 0);
        if (n > 0) out[k] = n;
      }
      return out;
    };
    return { bills: pick(BILLS), coins: pick(COINS) };
  }

  private countTotal(): number {
    let total = 0;
    for (const k of [...BILLS, ...COINS]) total += Number(k) * (Number(this.denomCounts[k] ?? 0) || 0);
    return Math.round(total * 100) / 100;
  }

  private async addCount(ev: Event) {
    ev.preventDefault();
    if (!this.target) return;
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.count.add', {
        session_id: this.target.id,
        count_type: this.countType,
        denominations: this.denominationsPayload(),
        notes: this.countNotes.trim(),
      });
      const total = this.countTotal();
      this.denomCounts = {};
      this.countNotes = '';
      this.resetPanel();
      this.formMsg = erplora().t(CATALOG, 'ui.msgCountAdded', { total: erplora().formatAmount(total) });
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errAddCount');
    } finally {
      this.saving = false;
    }
  }

  private renderOpenPanel() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <h3>${t('ui.openSessionTitle')}</h3>
      <form class="form" @submit=${(e: Event) => this.openSession(e)}>
        <ion-select fill="outline" label=${t('ui.labelRegister')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.openRegisterId} @ionChange=${(e: any) => (this.openRegisterId = e.target.value)}>
          ${this.registers.map((r) => html`<ion-select-option value=${r.id}>${r.name}</ion-select-option>`)}
        </ion-select>
        <ion-input fill="outline" type="number" label=${t('ui.labelOpeningBalance')} label-placement="floating" min="0" step="0.01" .value=${this.openBalance} @ionInput=${(e: any) => (this.openBalance = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.openNotes} @ionInput=${(e: any) => (this.openNotes = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.opening') : t('ui.openSession')}</ion-button>
        <ion-button size="small" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderClosePanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <h3>${t('ui.closeSessionTitle')} · ${this.target.session_number}</h3>
      <form class="form" @submit=${(e: Event) => this.closeSession(e)}>
        <ion-input fill="outline" type="number" label=${t('ui.labelCountedCash')} label-placement="floating" min="0" step="0.01" .value=${this.closeBalance} @ionInput=${(e: any) => (this.closeBalance = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelClosingNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.closeNotes} @ionInput=${(e: any) => (this.closeNotes = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" color="danger" ?disabled=${this.saving || this.closeBalance === ''}>${this.saving ? t('ui.closing') : t('ui.closeSession')}</ion-button>
        <ion-button size="small" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderMovementPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <h3>${t('ui.movementTitle')} · ${this.target.session_number}</h3>
      <form class="form" @submit=${(e: Event) => this.addMovement(e)}>
        <ion-select fill="outline" label=${t('ui.labelType')} label-placement="floating" .value=${this.movType} @ionChange=${(e: any) => (this.movType = e.target.value)}>
          <ion-select-option value="in">${t('ui.movementIn')}</ion-select-option>
          <ion-select-option value="out">${t('ui.movementOut')}</ion-select-option>
        </ion-select>
        <ion-input fill="outline" type="number" label=${t('ui.labelAmount')} label-placement="floating" min="0.01" step="0.01" .value=${this.movAmount} @ionInput=${(e: any) => (this.movAmount = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelConcept')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.movDescription} @ionInput=${(e: any) => (this.movDescription = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.saving || !this.movAmount}>${this.saving ? t('ui.saving') : t('ui.register')}</ion-button>
        <ion-button size="small" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderCountPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    const denomInput = (k: string) => html`<ion-input fill="outline" type="number" label=${`${k} €`} label-placement="floating" min="0" step="1" .value=${this.denomCounts[k] ?? ''} @ionInput=${(e: any) => (this.denomCounts = { ...this.denomCounts, [k]: e.target.value })}></ion-input>`;
    return html`<section class="panel">
      <h3>${t('ui.countTitle')} · ${this.target.session_number}</h3>
      <form @submit=${(e: Event) => this.addCount(e)}>
        <div class="form">
          <ion-select fill="outline" label=${t('ui.labelCountType')} label-placement="floating" .value=${this.countType} @ionChange=${(e: any) => (this.countType = e.target.value)}>
            <ion-select-option value="opening">${t('ui.countOpening')}</ion-select-option>
            <ion-select-option value="closing">${t('ui.countClosing')}</ion-select-option>
          </ion-select>
          <ion-input fill="outline" label=${t('ui.labelNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.countNotes} @ionInput=${(e: any) => (this.countNotes = e.target.value)}></ion-input>
        </div>
        <h3>${t('ui.bills')}</h3>
        <div class="denoms">${BILLS.map(denomInput)}</div>
        <h3>${t('ui.coins')}</h3>
        <div class="denoms">${COINS.map(denomInput)}</div>
        <p class="total">${t('ui.totalCounted')}: ${erplora().formatAmount(this.countTotal())}</p>
        <div class="form">
          <ion-button type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.registerCount')}</ion-button>
          <ion-button size="small" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
        </div>
      </form>
    </section>`;
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        <header>
          <h2>${t('ui.title')}</h2>
          <ion-button size="small" @click=${() => { this.panel = this.panel === 'open' ? null : 'open'; this.target = null; this.formError = ''; this.formMsg = ''; }}>${t('ui.openSession')}</ion-button>
        </header>
        ${this.panel === 'open' ? this.renderOpenPanel() : nothing}
        ${this.panel === 'close' ? this.renderClosePanel() : nothing}
        ${this.panel === 'movement' ? this.renderMovementPanel() : nothing}
        ${this.panel === 'count' ? this.renderCountPanel() : nothing}
        ${this.formMsg ? html`<p class="ok">${this.formMsg}</p>` : nothing}
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.noSessions')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-cashregister-dashboard', ErpCashRegisterDashboard);
