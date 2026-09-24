import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

// erp-cashregister-open — pantalla de APERTURA de caja (ADR-0130).
//
// La monta el SHELL, no el dashboard de caja: cuando la caja está activada
// (`enable_cash_register`) y no hay sesión abierta, el guard `protects` del manifest interpone esta
// pantalla EN la ruta del TPV (`protected_pos_url`). El cajero abre la caja y el shell remonta el
// TPV en la misma ruta — es el «Opening Control» de Odoo, y lo mismo hacen Lightspeed, Loyverse y
// SumUp: no se vende sin abrir caja.
//
// La sesión es del TERMINAL, no del cajero: con un solo cajón (el caso del salón y del bar pequeño)
// se asume y no se pregunta; con varios hay que elegir, porque una sesión sin terminal no cuadra con
// ningún arqueo físico.

interface Register { id: string; name: string; }

interface ErploraLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

function erplora(): ErploraLike {
  const c = (globalThis as { erplora?: ErploraLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

function rows<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: T[] }).rows)) return (r as { rows: T[] }).rows;
  return [];
}

/** Euros tecleados → céntimos (el dinero es INTEGER, ADR-0007/0123). «150,50» → 15050. */
function aCentimos(v: string): number {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export class ErpCashregisterOpen extends LitElement {
  static styles = css`
    :host { display:flex; align-items:center; justify-content:center; height:100%; padding:1rem;
            font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    .card { width:min(94vw, 26rem); background:var(--ion-card-background,#fff); border-radius:var(--ok-radius-lg, 16px);
            padding:1.5rem; box-shadow:var(--ok-shadow-md, 0 8px 32px rgba(0,0,0,.12)); text-align:center; }
    .ico { font-size:3rem; color:var(--ion-color-primary,#0091ce); }
    h2 { margin:.4rem 0 .2rem; font-size:1.3rem; }
    .sub { color:var(--ion-color-medium,#8b897f); font-size:.9rem; margin-bottom:1.2rem; }
    .form { display:flex; flex-direction:column; gap:.8rem; text-align:left; }
    .error { color:var(--ion-color-danger,#d9480f); font-size:.85rem; margin-top:.6rem; }
  `;

  @state() private registers: Register[] = [];
  @state() private registerId = '';
  @state() private balance = '';
  @state() private notes = '';
  @state() private saving = false;
  @state() private error = '';

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.registers = rows<Register>(
      await erplora().query('cash_register.registers.list').catch(() => []),
    );
    // Un solo cajón → se asume. Preguntar «¿cuál?» cuando solo hay uno es fricción diaria inútil.
    if (this.registers.length === 1) this.registerId = this.registers[0].id;
  }

  private async openSession() {
    // Con varios cajones, abrir «sin terminal» produce una sesión que no cuadra con ningún arqueo
    // físico: se para aquí, no se adivina.
    if (this.registers.length > 1 && !this.registerId) {
      this.error = erplora().t(CATALOG, 'ui.labelRegister');
      return;
    }
    this.saving = true;
    this.error = '';
    try {
      // Sin `session_number`: lo acuña el servidor (cash_register#49). Esta pantalla componía
      // `CS-YYMMDD-HHMM`, un TERCER formato distinto del que componía el dashboard.
      await erplora().command('cash_register.session.open', {
        register_id: this.registerId || null,
        opening_balance: aCentimos(this.balance),
        opening_notes: this.notes,
      });
      // El comando emite `cash_register.session_opened`; el shell lo escucha (`resume_on` del bloque
      // `protects`) y remonta el TPV en esta misma ruta.
    } catch (e) {
      // cash_register#11: the database keeps ONE open session per hub; a lost race comes back as
      // the domain code `cash_register.session_already_open` — shown translated, not as the raw
      // English fallback. The winning session emits `session_opened`, so the shell resumes anyway.
      const code = (e as { code?: unknown } | null)?.code;
      this.error = code === 'cash_register.session_already_open'
        ? erplora().t(CATALOG, 'ui.errSessionAlreadyOpen')
        : e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errOpenSession');
    } finally {
      this.saving = false;
    }
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <div class="card">
        <ion-icon class="ico" name="cash-outline"></ion-icon>
        <h2>${t('ui.openSessionTitle')}</h2>
        <p class="sub">${t('ui.subOpenToContinue')}</p>

        <div class="form">
          ${this.registers.length > 1
            ? html`<ion-select data-testid="cash-register-opening-register" fill="outline" label=${t('ui.labelRegister')} label-placement="floating"
                .value=${this.registerId}
                @ionChange=${(e: CustomEvent) => { this.registerId = (e.target as HTMLInputElement).value; }}>
                ${this.registers.map((r) => html`<ion-select-option value=${r.id}>${r.name}</ion-select-option>`)}
              </ion-select>`
            : nothing}

          <ion-input data-testid="cash-register-opening-balance" fill="outline" type="number" min="0" step="0.01"
            label=${t('ui.labelOpeningBalance')} label-placement="floating"
            .value=${this.balance}
            @ionInput=${(e: CustomEvent) => { this.balance = (e.target as HTMLInputElement).value; }}></ion-input>

          <ion-input data-testid="cash-register-opening-notes" fill="outline" label=${t('ui.labelNotes')} label-placement="floating"
            placeholder=${t('ui.optional')} .value=${this.notes}
            @ionInput=${(e: CustomEvent) => { this.notes = (e.target as HTMLInputElement).value; }}></ion-input>

          <ion-button data-testid="cash-register-opening-submit" class="open-session" expand="block" ?disabled=${this.saving}
            @click=${() => void this.openSession()}>
            ${this.saving ? t('ui.opening') : t('ui.openSession')}
          </ion-button>

          ${this.error ? html`<p data-testid="cash-register-opening-error" class="error">${this.error}</p>` : nothing}
        </div>
      </div>
    `;
  }
}

define('erp-cashregister-open', ErpCashregisterOpen);

declare global {
  interface HTMLElementTagNameMap {
    'erp-cashregister-open': ErpCashregisterOpen;
  }
}
