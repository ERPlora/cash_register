import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-detail-list';
import '../erp-cashregister-session-detail/erp-cashregister-session-detail';
import type { DataTableColumn, DataTableAction, OkDetailItem } from '@erplora/outfitkit';
import { createListController, majorToMinor, minorToMajor } from '@erplora/module-sdk';
// Un solo catálogo para los dominios cerrados del módulo y para las fechas (cash_register#50):
// la celda y el desplegable leen de aquí, así que no tienen dónde separarse. Mismo patrón que
// `staff/ui/lib/enums.ts` (staff#37).
import { MOVEMENT_TYPE_KEY, SESSION_STATUS_KEY, denominationLabel, enumLabel, enumOptions } from '../../lib/enums';
// La revisión del turno (cash_register#68): qué queda a medias cuando se cierra el cajón. Vive en
// su propio fichero porque es lógica pura —contar comandas vivas y trabajos encolados— y la
// pantalla solo la pinta.
import { hasPendingWork, readShiftReview, type ShiftReview } from '../../lib/shift-review';
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

/** What the person typed in «Efectivo contado» → MINOR units, or `null` if it is not an amount
 *  (cash_register#83).
 *
 *  `majorToMinor` answers **0** for anything it cannot parse — the right safety net for a reader,
 *  the wrong one for this border: «abc» in the counted-cash field used to close the shift declaring
 *  0,00 €, i.e. a fabricated shortage of the entire drawer, with no error anywhere. So the border
 *  validates the STRING and refuses; the SDK keeps converting.
 *
 *  Same normalisation as `toMinorUnits` (es-ES types «129,90»), so what is validated is exactly
 *  what is sent. Negative is not a count: nobody can count minus five euros. */
function parseCountedCash(raw: string): number | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return toMinorUnits(text);
}

/** MINOR units → the string the money `ion-input` takes back (cash_register#65). The inverse of
 *  `toMinorUnits`, and it has to round-trip through it exactly: 25130 → «251.30» → 25130. A plain
 *  dot on purpose — `toMinorUnits` accepts both separators, and building a locale-formatted string
 *  here (thousands separator, currency symbol) would come back as `NaN` and close the till on 0. */
function fromMinorUnits(minor: number): string {
  const decimals = erplora().currencyDecimals;
  const scale = typeof decimals === 'number' ? decimals : 2;
  return minorToMajor(minor, scale).toFixed(scale);
}

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** TODAS las filas (sin tope). Para lo que no es «una página»: la rejilla del TPV, un
   *  `<ion-select>` de categorías… El viejo `page_size` NO existía y truncaba a 50. */
  queryAll<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T[]>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  /** Puerta OPCIONAL (ADR-0127): `undefined` cuando el módulo dueño NO está instalado en este hub.
   *  Un contrato roto, un permiso denegado o un handler caído siguen explotando — la opcionalidad
   *  es del MÓDULO, no del contrato. */
  queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
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

/** A till count of a session (`cash_register.counts.list`). `total` is MINOR units (ADR-0007/0400). */
interface Count { id: string; count_type: string; total: number; counted_at: string }

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
  'cash_register.payment_method_unknown': 'ui.errPaymentMethodUnknown',
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
    /* cash_register#90 — the close-till button paints its own danger background HERE, inside the
       shadow root, and not with \`color="danger"\`: Ionic backs \`color=\` with the GLOBAL rule
       \`.ion-color-danger { --ion-color-base: … }\`, which does not reach this shadow root, so the
       button rendered white text on a transparent background. Custom properties do inherit through
       the boundary, so the theme tokens are read fine. Same defect as kitchen#42. */
    ion-button[data-testid="cash-register-close-submit"] {
      --background: var(--ion-color-danger, #c5000f);
      --background-activated: var(--ion-color-danger-shade, #ad000d);
      --background-focused: var(--ion-color-danger-shade, #ad000d);
      --background-hover: var(--ion-color-danger-tint, #cb1a27);
      --color: var(--ion-color-danger-contrast, #fff);
    }
    .denoms { display:grid; grid-template-columns:repeat(auto-fill, minmax(5.5rem, 1fr)); gap:.75rem; margin:.5rem 0; }
    /* The painted (md) box pads 16px a side; in a 5.5rem cell that truncates «500,00 €» before anything is
       typed. Ionic sets the padding on .sc-ion-input-md-h.input-fill-outline (two classes), so the override
       needs the same class to win. No backticks in here: this comment lives inside the css tagged template. */
    .denoms ion-input.input-fill-outline { --padding-start:.5rem; --padding-end:.5rem; }
    .total { font-weight:700; margin:.25rem 0; }
    .err { color:#d9480f; font-weight:600; }
    .ok { color:#2b8a3e; font-weight:600; }
    /* Revisión del turno (cash_register#68): va DENTRO del aviso, así que no lleva color propio —
       el tono lo pone ok-inline-feedback y la lista solo tiene que leerse. */
    .review-box { display:block; margin:0 0 .75rem; }
    ul.review { margin:.25rem 0 0; padding-inline-start:1.1rem; }
    ul.review li { margin:.15rem 0; }
    .review-list { display:block; opacity:.85; font-size:.9em; }
    .review-confirm { margin:.5rem 0 0; font-weight:600; }
    .review-checking { margin:0 0 .5rem; opacity:.75; }
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

  /** Lo que queda a medias en el turno que se va a cerrar (cash_register#68). `null` = todavía no
   *  se ha preguntado, o el panel no es el del cierre. */
  @state() shiftReview: ShiftReview | null = null;

  @state() shiftReviewLoading = false;

  /** El operador YA vio el aviso y volvió a pulsar «Cerrar». El aviso informa, nunca impide: es la
   *  forma del *Shift Review* de Toast y del informe previo a la Z de Square. Se consume por
   *  sesión — la confirmación de un turno no puede cerrar el siguiente a la primera. */
  @state() closeAcknowledged = false;

  /** Efectivo que el SERVIDOR dice que debería haber en el cajón del turno que se está cerrando
   *  (céntimos), o `null` cuando no hay número que enseñar: arqueo ciego, otro turno, lectura
   *  fallida o panel cerrado. Nunca se calcula aquí — ver `loadExpectedForClose`. */
  @state() expectedForClose: number | null = null;

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
    this.clearShiftReview();
  }

  /** La revisión pertenece al panel de cierre de UNA sesión: al salir de él se va con él. */
  private clearShiftReview() {
    this.shiftReview = null;
    this.shiftReviewLoading = false;
    this.closeAcknowledged = false;
    this.expectedForClose = null;
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
    // The close starts from the drawer that was already counted (cash_register#65). It also starts
    // CLEAN: whatever was typed for another session (or abandoned with Cancel) must never carry
    // over into this one — a leftover amount is a fake difference somebody has to answer for.
    if (panel === 'close') {
      this.closeBalance = '';
      this.clearShiftReview();
      // Síncrono a propósito: el panel se pinta en el mismo tick que se abre, y un hueco en blanco
      // donde va a aparecer un aviso es peor que decir que se está comprobando.
      this.shiftReviewLoading = true;
      void this.prefillCountedCash(session.id);
      void this.loadExpectedForClose(session.id);
      void this.loadShiftReview(session.id);
    }
  }

  /** Lo que queda a medias en el turno, por las puertas que NO atan la caja a nadie
   *  (cash_register#68).
   *
   *  `readShiftReview` no lanza: el cierre tiene que funcionar aunque la revisión no se pueda
   *  hacer. Lo que sí hace es distinguir «cocina no está instalada» (normal, silencio) de «la
   *  lectura falló» (`incomplete`), que la pantalla dice en voz alta. */
  private async loadShiftReview(sessionId: string): Promise<void> {
    const review = await readShiftReview(erplora());
    // El panel puede haberse movido (otra fila, Cancelar) mientras esto volaba: nunca se pinta la
    // revisión de un turno sobre el cierre de otro.
    if (this.panel !== 'close' || this.target?.id !== sessionId) return;
    this.shiftReview = review;
    this.shiftReviewLoading = false;
  }

  /** «Esperado en el cajón» ← the SERVER, at the moment of counting (cash_register#83).
   *
   *  Counting a drawer without knowing what it should hold is a real technique — a *blind count* —
   *  but it is a decision the BUSINESS makes, not a side effect of the screen forgetting to say it.
   *  Square gates it with the «view expected amount in cash drawer» permission, Toast with 3.17
   *  (Blind) vs 3.18 (Full), Lightspeed and Sage with a setting; Shopify hides it always and Odoo
   *  shows it always (and its own forum is full of people asking how to hide it). This module chose
   *  the majority model back in cash_register#24: `require_blind_count` per hub +
   *  `cash_register.view_expected_totals` per role.
   *
   *  So the panel decides NOTHING. It reads `cash_register.current_session` — the same door that
   *  already applies the blind setting, under `view_session`, which any till user holds — and paints
   *  what comes back. Blind hub → `expected_total` is NULL and there is nothing to paint. A client
   *  that computed the figure itself would hand the cashier exactly what the setting took away.
   *
   *  Re-read on OPEN, never inherited from the grid row: that row was loaded when the screen was
   *  opened —before the shift's sales— and the whole point of the number is to be true NOW. It only
   *  ever describes the OPEN session (`current_session.sql` filters `status = 'open'`), and the id
   *  is matched anyway: one shift's expected shown over another's close is a fake difference
   *  somebody has to answer for. */
  private async loadExpectedForClose(sessionId: string): Promise<void> {
    try {
      const rows = await erplora().query<Session[]>('cash_register.current_session');
      const row = Array.isArray(rows) ? rows.find((r) => String(r?.id) === String(sessionId)) : undefined;
      const expected = (row as unknown as { expected_total?: unknown } | undefined)?.expected_total;
      // The panel may have moved on (another row, Cancel) while this was in flight.
      if (this.panel !== 'close' || this.target?.id !== sessionId) return;
      this.expectedForClose = typeof expected === 'number' && Number.isFinite(expected) ? expected : null;
    } catch (e) {
      // The close works without this: it is an aid, not the reconciliation (the server recomputes
      // and stores expected/difference). But a screen that quietly stops helping is a mute failure,
      // so it says so — and it does NOT fall back to a number of its own.
      this.expectedForClose = null;
      this.formError = domainMessage(e, 'ui.errLoadDetail');
    }
  }

  /** «Efectivo contado» ← the session's last CLOSING count (cash_register#65).
   *
   *  Counting the same drawer twice is the cheapest way to book a difference nobody made: the
   *  second pass only has to disagree by one coin. Square, Toast and Lightspeed all carry the
   *  closing count into the close for exactly that reason.
   *
   *  Only a `closing` count seeds it. An `opening` one is the start-of-shift float check; pushing
   *  a figure from eight hours ago into the close — silently, prefilled, looking authoritative —
   *  is worse than an empty field. No count → the field stays empty and the person counts. */
  private async prefillCountedCash(sessionId: string): Promise<void> {
    try {
      const page = await erplora().queryPage<Count>('cash_register.counts.list', {
        limit: 50,
        offset: 0,
        sort: 'counted_at',
        dir: 'desc',
        // `:session_id` is a CONTEXT param of the base SQL, not a filter: it travels verbatim.
        params: { session_id: sessionId },
      });
      const rows = Array.isArray(page?.rows) ? page.rows : [];
      const last = rows.find((c) => c?.count_type === 'closing');
      // The panel may have moved on (another row, Cancel) while this was in flight — never write
      // one session's count into another session's close.
      if (last && this.panel === 'close' && this.target?.id === sessionId) {
        this.closeBalance = fromMinorUnits(Number(last.total));
      }
    } catch (e) {
      // Not fatal: the close still works by typing the amount. But a mute catch is how a screen
      // silently stops helping, so it says so instead of leaving an unexplained empty field.
      this.formError = domainMessage(e, 'ui.errLoadDetail');
    }
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
    if (!this.target) return;
    // The primary action of the close stays LIVE (Odoo, Shopify and Square all keep it pressable)
    // and the form says what is missing. Disabling it while the field was empty made a `danger`
    // button render as pale grey text on the panel's light surface — QA read it as «un texto
    // apagado», not a button — and it only covered ONE invalid case: «abc» sailed through and
    // reached an INTEGER money column as NaN.
    const counted = parseCountedCash(this.closeBalance);
    if (counted == null) {
      this.formMsg = '';
      this.formError = erplora().t(CATALOG, 'ui.errCountedCashRequired');
      return;
    }
    const sessionId = this.target.id;
    // Revisión del turno (cash_register#68): si queda trabajo vivo, el PRIMER clic no cierra —
    // pregunta. El segundo cierra igual: Toast, Square y Lightspeed listan lo que queda abierto y
    // piden confirmación, ninguno lo impide. Negarse dejaría el cajón sin cuadrar y el dinero sin
    // contar, que es peor que una comanda sin servir.
    if (this.shiftReview && hasPendingWork(this.shiftReview) && !this.closeAcknowledged) {
      this.closeAcknowledged = true;
      this.formError = '';
      this.formMsg = '';
      return;
    }
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.session.close', {
        session_id: sessionId,
        // Misma frontera con nombre que la apertura (218): euros tecleados → céntimos.
        // `Number(...)` crudo mandaba EUROS a la columna INTEGER (150,50 € → 1,50 €) y
        // con coma decimal directamente 0 (Number('150,50') = NaN).
        closing_balance: counted,
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
    const session = this.target;
    const wasClosingCount = this.countType === 'closing';
    this.saving = true;
    this.formError = '';
    this.formMsg = '';
    try {
      await erplora().command('cash_register.count.add', {
        session_id: session.id,
        count_type: this.countType,
        denominations: this.denominationsPayload(),
        notes: this.countNotes.trim(),
      });
      const totalCents = this.countTotalCents();
      this.denomCounts = {};
      this.countNotes = '';
      this.resetPanel();
      // A count typed as «Cierre» has to lead somewhere (cash_register#65): it used to be filed and
      // forgotten — the session stayed open, the grid kept showing dashes and the close asked for
      // the same drawer all over again. Square, Toast and Lightspeed make the closing count the
      // step BEFORE the close and carry its total into it; so does this. It does not close by
      // itself: closing is `session.close`, its own command with its own permission, and the
      // operator still has to confirm it — one count, one decision, no permission collapsed.
      // (Before the message: `openPanel` clears it, and the confirmation is the point.)
      if (wasClosingCount) this.openPanel('close', session);
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
      <form data-testid="cash-register-open-form" class="form" @submit=${(e: Event) => this.openSession(e)}>
        <ion-select data-testid="cash-register-open-register" fill="outline" mode="md" label=${t('ui.labelRegister')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.openRegisterId} @ionChange=${(e: any) => (this.openRegisterId = e.target.value)}>
          ${this.registers.map((r) => html`<ion-select-option value=${r.id}>${r.name}</ion-select-option>`)}
        </ion-select>
        <ion-input data-testid="cash-register-open-balance" fill="outline" mode="md" type="text" inputmode="decimal" label=${t('ui.labelOpeningBalance')} label-placement="floating" .value=${this.openBalance} @ionInput=${(e: any) => (this.openBalance = e.target.value)}></ion-input>
        <ion-input data-testid="cash-register-open-notes" fill="outline" mode="md" label=${t('ui.labelNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.openNotes} @ionInput=${(e: any) => (this.openNotes = e.target.value)}></ion-input>
        <ion-button data-testid="cash-register-open-submit" type="submit" ?disabled=${this.saving}>${this.saving ? t('ui.opening') : t('ui.openSession')}</ion-button>
        <ion-button data-testid="cash-register-open-cancel" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  /** El aviso del turno (cash_register#68): loading, nada, «no se pudo comprobar», o el detalle.
   *
   *  Sin nada pendiente NO pinta nada — el criterio es que un turno limpio no gane ni un paso ni
   *  una línea de ruido. */
  private renderShiftReview() {
    const t = (k: string, p?: Record<string, unknown>): string => erplora().t(CATALOG, k, p);
    if (this.shiftReviewLoading) {
      return html`<p data-testid="cash-register-close-review-checking" class="review-checking">${t('ui.shiftReviewChecking')}</p>`;
    }
    const review = this.shiftReview;
    if (!review) return nothing;
    if (!hasPendingWork(review)) {
      // Una revisión que no se pudo hacer NO es «no queda nada»: se dice, y aun así no se añade un
      // paso — sin evidencia de trabajo vivo, cobrar un clic extra castiga al operador por una
      // lectura rota que no es suya.
      return review.incomplete
        ? html`<ok-inline-feedback data-testid="cash-register-close-review-unavailable" class="review-box" tone="neutral" icon="help-circle-outline">${t('ui.shiftReviewUnavailable')}</ok-inline-feedback>`
        : nothing;
    }
    return html`<ok-inline-feedback data-testid="cash-register-close-review" class="review-box" tone="warning" icon="alert-circle-outline" heading=${t('ui.shiftReviewTitle')}>
      <ul class="review">
        ${review.liveOrders > 0
          ? html`<li>
              ${t('ui.shiftReviewOrders', { count: review.liveOrders })}
              <span class="review-list">${review.orderLabels.join(' · ')}</span>
            </li>`
          : nothing}
        ${review.pendingPrintJobs > 0
          ? html`<li>${t('ui.shiftReviewPrints', { count: review.pendingPrintJobs, stations: review.printRoles.join(' · ') })}</li>`
          : nothing}
        ${review.incomplete ? html`<li>${t('ui.shiftReviewUnavailable')}</li>` : nothing}
      </ul>
      ${this.closeAcknowledged ? html`<p data-testid="cash-register-close-review-confirm" class="review-confirm">${t('ui.shiftReviewConfirm')}</p>` : nothing}
    </ok-inline-feedback>`;
  }

  /** Céntimos → dinero CON SIGNO explícito: «+5,10 €» sobra, «-4,90 €» falta (0 no lleva signo).
   *  `formatMoney` ya trae el menos; el más hay que ponerlo, y sin él un sobrante y un faltante se
   *  leen igual de un vistazo — que es justo lo que un arqueo tiene que distinguir. */
  private signedMoney(cents: number): string {
    const money = this.fmt(cents);
    return cents > 0 ? `+${money}` : money;
  }

  /** Esperado + diferencia en vivo, o nada. Vacío cuando el servidor no dio el número (arqueo
   *  ciego, otro turno, lectura fallida): la diferencia REVELA el esperado, así que se va con él. */
  private get closeReconcileItems(): OkDetailItem[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const expected = this.expectedForClose;
    if (expected == null) return [];
    // La misma frontera que usa el comando, así que la diferencia que se lee mientras se teclea es
    // la que el servidor va a guardar. Sin importe válido todavía: guion, nunca un cero inventado.
    const counted = parseCountedCash(this.closeBalance);
    return [
      { label: t('ui.labelExpectedInDrawer'), value: this.fmt(expected) },
      { label: t('ui.colDifference'), value: counted == null ? '—' : this.signedMoney(counted - expected) },
    ];
  }

  private renderClosePanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    const reconcile = this.closeReconcileItems;
    // Con trabajo vivo ya confirmado, el botón DICE lo que hace: «Cerrar de todos modos». Es la
    // confirmación explícita, y a la vez la promesa de que el turno se cierra igual.
    const closeLabel = this.saving
      ? t('ui.closing')
      : this.closeAcknowledged ? t('ui.closeAnyway') : t('ui.closeSession');
    return html`<section class="panel">
      <h3>${t('ui.closeSessionTitle')} · ${this.target.session_number}</h3>
      ${this.renderShiftReview()}
      ${reconcile.length ? html`<ok-detail-list data-testid="cash-register-close-expected" columns="2" dense .items=${reconcile}></ok-detail-list>` : nothing}
      <form data-testid="cash-register-close-form" class="form" @submit=${(e: Event) => this.closeSession(e)}>
        <ion-input data-testid="cash-register-close-counted" fill="outline" mode="md" type="text" inputmode="decimal" label=${t('ui.labelCountedCash')} label-placement="floating" .value=${this.closeBalance} @ionInput=${(e: any) => (this.closeBalance = e.target.value)}></ion-input>
        <ion-input data-testid="cash-register-close-notes" fill="outline" mode="md" label=${t('ui.labelClosingNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.closeNotes} @ionInput=${(e: any) => (this.closeNotes = e.target.value)}></ion-input>
        <ion-button data-testid="cash-register-close-submit" type="submit" ?disabled=${this.saving}>${closeLabel}</ion-button>
        <ion-button data-testid="cash-register-close-cancel" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
      </form>
    </section>`;
  }

  private renderMovementPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <h3>${t('ui.movementTitle')} · ${this.target.session_number}</h3>
      <form data-testid="cash-register-movement-form" class="form" @submit=${(e: Event) => this.addMovement(e)}>
        <ion-select data-testid="cash-register-movement-type" fill="outline" mode="md" label=${t('ui.labelType')} label-placement="floating" .value=${this.movType} @ionChange=${(e: any) => (this.movType = e.target.value)}>
          ${/* Mismo catálogo que las tablas (cash_register#50): el desplegable ya decía
                «Entrada»/«Salida» mientras la columna TIPO imprimía `in`/`out`, dos fuentes para el
                mismo enum. El formulario ofrece el dominio OPERATIVO —lo que una persona mete o
                saca a mano—; `sale`/`refund` los escribe el sistema al cobrar o al anular. */ ''}
          ${enumOptions({ in: MOVEMENT_TYPE_KEY.in, out: MOVEMENT_TYPE_KEY.out }).map(
            (o) => html`<ion-select-option value=${o.value}>${o.label}</ion-select-option>`,
          )}
        </ion-select>
        <ion-input data-testid="cash-register-movement-amount" fill="outline" mode="md" type="text" inputmode="decimal" label=${t('ui.labelAmount')} label-placement="floating" .value=${this.movAmount} @ionInput=${(e: any) => (this.movAmount = e.target.value)}></ion-input>
        <ion-input data-testid="cash-register-movement-concept" fill="outline" mode="md" label=${t('ui.labelConcept')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.movDescription} @ionInput=${(e: any) => (this.movDescription = e.target.value)}></ion-input>
        <ion-button data-testid="cash-register-movement-submit" type="submit" ?disabled=${this.saving || !this.movAmount}>${this.saving ? t('ui.saving') : t('ui.register')}</ion-button>
        <ion-button data-testid="cash-register-movement-cancel" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
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
    const denomInput = (k: string) => html`<ion-input data-testid=${`cash-register-count-denom-${k}`} fill="outline" mode="md" type="number" label=${denominationLabel(k)} label-placement="floating" min="0" step="1" .value=${this.denomCounts[k] ?? ''} @ionInput=${(e: any) => (this.denomCounts = { ...this.denomCounts, [k]: e.target.value })}></ion-input>`;
    return html`<section class="panel">
      <h3>${t('ui.countTitle')} · ${this.target.session_number}</h3>
      <form data-testid="cash-register-count-form" @submit=${(e: Event) => this.addCount(e)}>
        <div class="form">
          <ion-select data-testid="cash-register-count-type" fill="outline" mode="md" label=${t('ui.labelCountType')} label-placement="floating" .value=${this.countType} @ionChange=${(e: any) => (this.countType = e.target.value)}>
            <ion-select-option value="opening">${t('ui.countOpening')}</ion-select-option>
            <ion-select-option value="closing">${t('ui.countClosing')}</ion-select-option>
          </ion-select>
          <ion-input data-testid="cash-register-count-notes" fill="outline" mode="md" label=${t('ui.labelNotes')} label-placement="floating" placeholder=${t('ui.optional')} .value=${this.countNotes} @ionInput=${(e: any) => (this.countNotes = e.target.value)}></ion-input>
        </div>
        <h3>${t('ui.bills')}</h3>
        <div class="denoms">${BILLS.map(denomInput)}</div>
        <h3>${t('ui.coins')}</h3>
        <div class="denoms">${COINS.map(denomInput)}</div>
        <p data-testid="cash-register-count-total" class="total">${t('ui.totalCounted')}: ${erplora().formatMoney(this.countTotalCents())}</p>
        <div class="form">
          <ion-button data-testid="cash-register-count-submit" type="submit" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.registerCount')}</ion-button>
          <ion-button data-testid="cash-register-count-cancel" fill="outline" @click=${() => this.resetPanel()}>${t('ui.cancel')}</ion-button>
        </div>
      </form>
    </section>`;
  }

  private renderDetailPanel() {
    if (!this.target) return nothing;
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<section class="panel">
      <erp-cashregister-session-detail .session=${this.target}></erp-cashregister-session-detail>
      <div class="form"><ion-button data-testid="cash-register-detail-back" fill="outline" @click=${() => this.resetPanel()}>${t('ui.back')}</ion-button></div>
    </section>`;
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        <header>
          <h2>${t('ui.title')}</h2>
          <ion-button data-testid="cash-register-new-session" ?disabled=${this.hasOpenSession} title=${this.hasOpenSession ? t('ui.errSessionAlreadyOpen') : ''} @click=${() => { this.panel = this.panel === 'open' ? null : 'open'; this.target = null; this.formError = ''; this.formMsg = ''; }}>${t('ui.openSession')}</ion-button>
        </header>
        ${this.panel === 'open' ? this.renderOpenPanel() : nothing}
        ${this.panel === 'close' ? this.renderClosePanel() : nothing}
        ${this.panel === 'movement' ? this.renderMovementPanel() : nothing}
        ${this.panel === 'count' ? this.renderCountPanel() : nothing}
        ${this.panel === 'detail' ? this.renderDetailPanel() : nothing}
        ${this.formMsg ? html`<p data-testid="cash-register-form-msg" class="ok">${this.formMsg}</p>` : nothing}
        ${this.formError ? html`<ok-inline-feedback data-testid="cash-register-form-error" tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
        ${this.ctrl?.error ? html`<ok-inline-feedback data-testid="cash-register-load-error" tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
        <!-- The «detail» button is not the only door: rowClickable makes the whole row open the
             same panel (outfitkit#67) — on ANY session: a closed one is read-only, not invisible. -->
        <ok-data-table testid="cash-register-table" .serverSide=${true} .columns=${this.columns} .views=${true} .cardTitle=${(r: Record<string, unknown>) => String(r.session_number ?? '—')} .cardIcon=${() => 'cash-outline'} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.noSessions')} .actions=${this.rowActions} .rowClickable=${true} @rowAction=${(e: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => this.onRowAction(e)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.openPanel('detail', e.detail.row as unknown as Session)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-cashregister-dashboard', ErpCashRegisterDashboard);
