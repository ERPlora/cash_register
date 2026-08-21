import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import '../erp-cashregister-session-detail/erp-cashregister-session-detail';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
import { createListController, majorToMinor } from '@erplora/module-sdk';
// Un solo catálogo para los dominios cerrados del módulo y para las fechas (cash_register#50):
// la celda y el desplegable leen de aquí, así que no tienen dónde separarse. Mismo patrón que
// `staff/ui/lib/enums.ts` (staff#37).
import { MOVEMENT_TYPE_KEY, SESSION_STATUS_KEY, denominationLabel, enumLabel, enumOptions } from '../../lib/enums';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

/** Typed major units → MINOR units (money is INTEGER, ADR-0007/0123). «150,50» → 15050.
 *
 *  Two things this border has to get right, and both were bugs here:
 *  - the **decimal comma** (es-ES types «150,50»): without normalising it, `Number` gives `NaN`;
 *  - the **scale**, which belongs to the hub's currency — `majorToMinor` from the module-sdk with
 *    `erplora.currencyDecimals`, not a fixed ×100. In JPY the minor unit IS the yen, and a ×100
 *    here books 100 times too much. */
function toMinorUnits(v: string | number): number {
  // A shell too old to inject the scale would give `undefined` here, and `10 ** undefined` is NaN —
  // silent corruption in an INTEGER column. Same fallback the SDK client uses: 2.
  const decimals = erplora().currencyDecimals;
  return majorToMinor(String(v ?? '').replace(',', '.'), typeof decimals === 'number' ? decimals : 2);
}

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** TODAS las filas (sin tope). Para lo que no es «una página»: la rejilla del TPV, un
   *  `<ion-select>` de categorías… El viejo `page_size` NO existía y truncaba a 50. */
  queryAll<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T[]>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  /** Moneda del hub + formateo de dinero (ADR-0059). */
  currency: string;
  formatAmount(units: number, opts?: { currency?: string; locale?: string }): string;
  /** Dinero (ADR-0123): `formatMoney` recibe CÉNTIMOS y divide según la moneda. */
  formatMoney(cents: number, opts?: { currency?: string; locale?: string }): string;
  /** Decimals of the hub's currency — the scale of money. 2 in EUR, 0 in JPY, 3 in KWD. */
  currencyDecimals: number;
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


/** Domain codes the server answers with (`expect_rows` gates and the WASM handler, cash_register#38)
 *  → the module's own translation. Anything else falls back to the error message / a generic key. */
const DOMAIN_MESSAGES: Record<string, string> = {
  'cash_register.session_already_open': 'ui.errSessionAlreadyOpen',
  'cash_register.opening_balance_required': 'ui.errOpeningBalanceRequired',
  'cash_register.closing_balance_required': 'ui.errClosingBalanceRequired',
  'cash_register.negative_balance_not_allowed': 'ui.errNegativeBalanceNotAllowed',
  'cash_register.session_unavailable': 'ui.errSessionUnavailable',
  'cash_register.movement_type_unknown': 'ui.errMovementTypeUnknown',
  'cash_register.amount_required': 'ui.errAmountRequired',
};
export function domainMessage(e: unknown, fallbackKey: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  const key = typeof code === 'string' ? DOMAIN_MESSAGES[code] : undefined;
  if (key) return erplora().t(CATALOG, key);
  return e instanceof Error ? e.message : erplora().t(CATALOG, fallbackKey);
}

export class ErpCashRegisterDashboard extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    h3 { margin:.25rem 0 .5rem; font-size:1rem; }
    .panel { border:1px solid var(--ion-border-color,#e7e2d6); border-radius: var(--ok-radius-sm, 10px); padding:.75rem 1rem; margin:0 0 1rem; background:var(--ok-surface-2, var(--ion-color-step-50, rgba(var(--ion-text-color-rgb, 24, 24, 27), 0.04))); }
    .form { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; }
    .form ion-input, .form ion-select { flex:1 1 11rem; min-width:9rem; }
    /* Touch targets (cash_register#12): Ionic md buttons default to 36 px; a finger needs 44×44
       (WCAG 2.5.5). Same rule OutfitKit applied to the data-table actions. */
    header ion-button, .form ion-button { min-height: 44px; min-width: 44px; margin: 0; }
    .denoms { display:grid; grid-template-columns:repeat(auto-fill, minmax(5.5rem, 1fr)); gap:.75rem; margin:.5rem 0; }
    .total { font-weight:700; margin:.25rem 0; }
    .err { color:#d9480f; font-weight:600; }
    .ok { color:#2b8a3e; font-weight:600; }
  `;

  @state() tick = 0;

  @state() formError = '';

  @state() formMsg = '';

  @state() saving = false;

  /** Panel activo: null | 'open' | 'close' | 'movement' | 'count' | 'detail'. */
  @state() panel: 'open' | 'close' | 'movement' | 'count' | 'detail' | null = null;

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

  // One open session per hub (cash_register#11). The database owns the invariant (partial unique
  // index + `cash_register.session_already_open`); this flag only keeps the dashboard from INVITING
  // the second open. Source: `cash_register.current_session` (server, per hub) — not the paginated
  // list, where the open session may sit on another page.
  @state() hasOpenSession = false;

  private ctrl!: ListController<Session>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'session_number', header: t('ui.colSession'), sortable: true, filterable: true, filterType: 'text' },
      {
        key: 'status',
        header: t('ui.colStatus'),
        sortable: true,
        filterable: true,
        // Dominio CERRADO: el estado se ELIGE, no se teclea (Odoo, Square y Business Central lo
        // resuelven igual en sus listados). El desplegable enseña la etiqueta traducida y manda al
        // servidor el valor crudo, que es contra lo que filtra el `eq` de `sessions.list`. El
        // buscador libre sigue siendo por número: es lo ÚNICO que el `search` del servidor mira, y
        // prometer «o estado» en su placeholder era una promesa que la pantalla no podía cumplir.
        filterType: 'select',
        options: enumOptions(SESSION_STATUS_KEY),
        format: (r) => enumLabel(SESSION_STATUS_KEY, r.status),
      },
      { key: 'opening_balance', header: t('ui.colOpening'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.opening_balance as number | null) },
      { key: 'expected_balance', header: t('ui.colExpected'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.expected_balance as number | null) },
      { key: 'closing_balance', header: t('ui.colCounted'), align: 'right', sortable: true, filterable: true, filterType: 'range', format: (r) => this.fmt(r.closing_balance as number | null) },
      { key: 'difference', header: t('ui.colDifference'), align: 'right', sortable: true, filterable: true, filterType: 'text', format: (r) => this.fmt(r.difference as number | null) },
    ];
  }

  private get rowActions(): DataTableAction[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      // Solo icono (ADR-0133): el `label` viaja como title + aria-label del botón, no como texto.
      // `detail` (cash_register#2) works on ANY session — a closed one is read-only, not invisible.
      { id: 'detail', label: t('ui.actionDetail'), icon: 'document-text-outline' },
      { id: 'movement', label: t('ui.actionMovement'), icon: 'swap-vertical-outline' },
      { id: 'count', label: t('ui.actionCount'), icon: 'calculator-outline' },
      { id: 'close', label: t('ui.actionClose'), icon: 'lock-closed-outline', color: 'danger' },
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
    await Promise.all([this.ctrl.load(), this.loadRegisters(), this.loadCurrentSession()]);
    try {
      const refresh = () => { void this.ctrl.load(); void this.loadCurrentSession(); };
      const a = erplora().on('cash_register.session_opened', refresh);
      const b = erplora().on('cash_register.session_closed', refresh);
      this.unsub = () => { a(); b(); };
    } catch { /* preview */ }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback(); this.unsub?.(); }

  // Saldos en UNIDADES mayores → formateados con la MONEDA DEL HUB (ADR-0059). `null` → guion.
  /** Balances de sesión en CÉNTIMOS (ADR-0123) → formatMoney divide. Con formatAmount
   *  (que NO divide) 15050 céntimos se pintaban como «15050.00 €» (bug ×100). */
  private fmt(n: number | null): string { return n == null ? '—' : erplora().formatMoney(Number(n)); }

  private async loadRegisters() {
    try {
      // `queryAll` devuelve EL ARRAY, no el sobre `{rows,total}`. Leer `.rows` aquí daba `undefined`
      // → la lista de cajas salía vacía y no se podía abrir sesión de caja. `Array.isArray` y no
      // `?? []`: si la respuesta no es una lista, se degrada a vacío en vez de reventar el render.
      const res = await erplora().queryAll<Register>('cash_register.registers.list');
      this.registers = Array.isArray(res) ? res : [];
    } catch { /* lista de cajones opcional; el form sigue funcionando sin ella */ }
  }

  private async loadCurrentSession() {
    try {
      const rows = await erplora().query<Session[]>('cash_register.current_session');
      this.hasOpenSession = Array.isArray(rows) && rows.length > 0;
    } catch { /* preview: the button stays enabled and the server keeps the invariant */ }
  }

  private resetPanel() {
    this.panel = null;
    this.target = null;
    this.formError = '';
  }

  private openPanel(panel: 'close' | 'movement' | 'count' | 'detail', session: Session) {
    if (panel !== 'detail' && session.status !== 'open') {
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
    if (id === 'close' || id === 'movement' || id === 'count' || id === 'detail') this.openPanel(id, session);
  }

  // — Abrir sesión → cash_register.session.open —
  private async openSession(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      // El NÚMERO DE TURNO no viaja: lo acuña el servidor (`S-YYMMDD-NNNN`, contador atómico por
      // hub y día — cash_register#49). Esta pantalla componía `S-YYMMDD-HHMMSS`, la de apertura del
      // TPV componía `CS-YYMMDD-HHMM` y la API no componía nada (caía a `S-<uuid>`): tres formatos
      // vivos para el mismo turno, según por dónde se abriera la caja.
      await erplora().command('cash_register.session.open', {
        register_id: this.openRegisterId || null,
        opening_balance: toMinorUnits(this.openBalance),
        opening_notes: this.openNotes.trim(),
      });
      this.openRegisterId = '';
      this.openBalance = '0';
      this.openNotes = '';
      this.resetPanel();
      this.formMsg = erplora().t(CATALOG, 'ui.msgSessionOpened');
      await Promise.all([this.ctrl.load(), this.loadCurrentSession()]);
    } catch (e) {
      // The domain refusal travels as `code`: translate it (cash_register#11/#38), and re-read the
      // server so the button reflects the session that DID win.
      this.formError = domainMessage(e, 'ui.errOpenSession');
      if ((e as { code?: unknown } | null)?.code === 'cash_register.session_already_open') {
        void Promise.all([this.ctrl.load(), this.loadCurrentSession()]);
      }
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
        // Misma frontera con nombre que la apertura (218): euros tecleados → céntimos.
        // `Number(...)` crudo mandaba EUROS a la columna INTEGER (150,50 € → 1,50 €) y
        // con coma decimal directamente 0 (Number('150,50') = NaN).
        closing_balance: toMinorUnits(this.closeBalance),
        closing_notes: this.closeNotes.trim(),
      });
      this.closeBalance = '';
      this.closeNotes = '';
      this.resetPanel();
      await Promise.all([this.ctrl.load(), this.loadCurrentSession()]);
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
      this.formError = domainMessage(e, 'ui.errCloseSession');
    } finally {
      this.saving = false;
    }
  }

  // — Movimiento manual → cash_register.movement.add —
  // El SIGNO lo pone el SERVIDOR desde `movement_type` (cash_register#48): esta pantalla mandaba
  // `-amount` para una salida y era la ÚNICA que lo hacía bien, porque el signo era una convención
  // no escrita. Cualquier otro llamante (el asistente, la app instalable, una integración) mandaba
  // la salida en positivo y SUMABA al cajón. Ahora se manda la MAGNITUD y el tipo.
  private async addMovement(ev: Event) {
    ev.preventDefault();
    if (!this.target || !this.movAmount) return;
    // Same named border as opening and closing: typed major units → MINOR units. It used to send
    // `Number(this.movAmount)` — the raw euros — into an INTEGER minor-units column, so a 12,34 €
    // cash-in was booked as 0,12 €; and with a decimal comma `Number` gave `NaN`, which collapsed
    // to 0 and the movement was rejected without ever reaching the server (#272, same class).
    const amount = Math.abs(toMinorUnits(this.movAmount));
    if (amount <= 0) { this.formError = erplora().t(CATALOG, 'ui.errInvalidAmount'); return; }
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.movement.add', {
        session_id: this.target.id,
        movement_type: this.movType,
        amount,
        payment_method: 'cash',
        sale_reference: '',
        description: this.movDescription.trim(),
      });
      const msg = erplora().t(CATALOG, this.movType === 'in' ? 'ui.msgMovementIn' : 'ui.msgMovementOut', {
        amount: erplora().formatMoney(amount), // minor units in, hub currency out
      });
      this.movAmount = '';
      this.movDescription = '';
      this.resetPanel();
      this.formMsg = msg;
      await this.ctrl.load();
    } catch (e) {
      this.formError = domainMessage(e, 'ui.errAddMovement');
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

  /** Total del recuento en CÉNTIMOS enteros: cada denominación se convierte una vez
   *  (0,05 € = 5 céntimos, exacto) y se suma en entero — nada de acumular euros en f64
   *  (0,05×3 = 0.15000000000000002). */
  private countTotalCents(): number {
    let cents = 0;
    for (const k of [...BILLS, ...COINS]) cents += Math.round(Number(k) * 100) * (Number(this.denomCounts[k] ?? 0) || 0);
    return cents;
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
      const totalCents = this.countTotalCents();
      this.denomCounts = {};
      this.countNotes = '';
      this.resetPanel();
      this.formMsg = erplora().t(CATALOG, 'ui.msgCountAdded', { total: erplora().formatMoney(totalCents) });
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
        <ion-input fill="outline" type="text" inputmode="decimal" label=${t('ui.labelOpeningBalance')} label-placement="floating" .value=${this.openBalance} @ionInput=${(e: any) => (this.openBalance = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.openNotes} @ionInput=${(e: any) => (this.openNotes = e.target.value)}></ion-input>
        <ion-button type="submit" ?disabled=${this.saving}>${this.saving ? t('ui.opening') : t('ui.openSession')}</ion-button>
        <ion-button fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderClosePanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <h3>${t('ui.closeSessionTitle')} · ${this.target.session_number}</h3>
      <form class="form" @submit=${(e: Event) => this.closeSession(e)}>
        <ion-input fill="outline" type="text" inputmode="decimal" label=${t('ui.labelCountedCash')} label-placement="floating" .value=${this.closeBalance} @ionInput=${(e: any) => (this.closeBalance = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelClosingNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.closeNotes} @ionInput=${(e: any) => (this.closeNotes = e.target.value)}></ion-input>
        <ion-button type="submit" color="danger" ?disabled=${this.saving || this.closeBalance === ''}>${this.saving ? t('ui.closing') : t('ui.closeSession')}</ion-button>
        <ion-button fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
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
          ${/* Mismo catálogo que las tablas (cash_register#50): el desplegable ya decía
                «Entrada»/«Salida» mientras la columna TIPO imprimía `in`/`out`, dos fuentes para el
                mismo enum. El formulario ofrece el dominio OPERATIVO —lo que una persona mete o
                saca a mano—; `sale`/`refund` los escribe el sistema al cobrar o al anular. */ ''}
          ${enumOptions({ in: MOVEMENT_TYPE_KEY.in, out: MOVEMENT_TYPE_KEY.out }).map(
            (o) => html`<ion-select-option value=${o.value}>${o.label}</ion-select-option>`,
          )}
        </ion-select>
        <ion-input fill="outline" type="text" inputmode="decimal" label=${t('ui.labelAmount')} label-placement="floating" .value=${this.movAmount} @ionInput=${(e: any) => (this.movAmount = e.target.value)}></ion-input>
        <ion-input fill="outline" label=${t('ui.labelConcept')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.movDescription} @ionInput=${(e: any) => (this.movDescription = e.target.value)}></ion-input>
        <ion-button type="submit" ?disabled=${this.saving || !this.movAmount}>${this.saving ? t('ui.saving') : t('ui.register')}</ion-button>
        <ion-button fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderCountPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    // La etiqueta es DINERO, así que se formatea como dinero (cash_register#50): era el literal
    // `${k} €`, y en un hub español convivían «0.50 €» con punto y «Total contado 141,50 €» con
    // coma en la misma tarjeta. La CLAVE no cambia (es el contrato con el handler WASM, que la lee
    // como euros); solo lo que lee la persona.
    const denomInput = (k: string) => html`<ion-input fill="outline" type="number" label=${denominationLabel(k)} label-placement="floating" min="0" step="1" .value=${this.denomCounts[k] ?? ''} @ionInput=${(e: any) => (this.denomCounts = { ...this.denomCounts, [k]: e.target.value })}></ion-input>`;
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
        <p class="total">${t('ui.totalCounted')}: ${erplora().formatMoney(this.countTotalCents())}</p>
        <div class="form">
          <ion-button type="submit" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.registerCount')}</ion-button>
          <ion-button fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
        </div>
      </form>
    </section>`;
  }

  private renderDetailPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <erp-cashregister-session-detail .session=${this.target}></erp-cashregister-session-detail>
      <div class="form"><ion-button fill="outline" @click=${() => this.resetPanel()}>${t('ui.back')}</ion-button></div>
    </section>`;
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        <header>
          <h2>${t('ui.title')}</h2>
          <ion-button ?disabled=${this.hasOpenSession} title=${this.hasOpenSession ? t('ui.errSessionAlreadyOpen') : ''} @click=${() => { this.panel = this.panel === 'open' ? null : 'open'; this.target = null; this.formError = ''; this.formMsg = ''; }}>${t('ui.openSession')}</ion-button>
        </header>
        ${this.panel === 'open' ? this.renderOpenPanel() : nothing}
        ${this.panel === 'close' ? this.renderClosePanel() : nothing}
        ${this.panel === 'movement' ? this.renderMovementPanel() : nothing}
        ${this.panel === 'count' ? this.renderCountPanel() : nothing}
        ${this.panel === 'detail' ? this.renderDetailPanel() : nothing}
        ${this.formMsg ? html`<p class="ok">${this.formMsg}</p>` : nothing}
        ${this.formError ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
        ${this.ctrl?.error ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .views=${true} .cardTitle=${(r: Record<string, unknown>) => String(r.session_number ?? '—')} .cardIcon=${() => 'cash-outline'} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.noSessions')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-cashregister-dashboard', ErpCashRegisterDashboard);
