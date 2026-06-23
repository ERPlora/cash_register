import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

/** Settings de caja (singleton por hub). Espejo de schemas/settings_update.json. */
interface CashRegisterSettings {
  enable_cash_register: boolean;
  require_opening_balance: boolean;
  require_closing_balance: boolean;
  allow_negative_balance: boolean;
  auto_open_session_on_login: boolean;
  auto_close_session_on_logout: boolean;
  protected_pos_url: string;
}

/** Defaults idénticos a migrations/sqlite/001_init.sql (cuando aún no hay fila). */
const DEFAULT_SETTINGS: CashRegisterSettings = {
  enable_cash_register: true,
  require_opening_balance: false,
  require_closing_balance: true,
  allow_negative_balance: false,
  auto_open_session_on_login: true,
  auto_close_session_on_logout: true,
  protected_pos_url: '/m/sales/pos/',
};

type BoolKey = Exclude<keyof CashRegisterSettings, 'protected_pos_url'>;

// `labelKey` es una clave del catálogo `ui` (ADR-0055); el texto se resuelve en render con
// `erplora.t()`, así reacciona al idioma activo del shell.
const TOGGLES: Array<{ key: BoolKey; labelKey: string }> = [
  { key: 'enable_cash_register', labelKey: 'ui.toggleEnable' },
  { key: 'require_opening_balance', labelKey: 'ui.toggleRequireOpening' },
  { key: 'require_closing_balance', labelKey: 'ui.toggleRequireClosing' },
  { key: 'allow_negative_balance', labelKey: 'ui.toggleAllowNegative' },
  { key: 'auto_open_session_on_login', labelKey: 'ui.toggleAutoOpen' },
  { key: 'auto_close_session_on_logout', labelKey: 'ui.toggleAutoClose' },
];

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpCashRegisterSettings extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .panel { border:1px solid var(--line,#e7e2d6); border-radius:10px; padding:.75rem 1rem; background:var(--surface-2,#faf8f2); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(16rem, 1fr)); gap:.25rem .75rem; }
    .url { margin-top:.5rem; }
    .url ion-input { --background:#fff; border:1px solid var(--line,#e7e2d6); border-radius:8px; max-width:24rem; }
    footer { display:flex; gap:.5rem; align-items:center; margin-top:.75rem; }
    .err { color:#d9480f; font-weight:600; }
    .ok { color:#2b8a3e; font-weight:600; }
  `;

  @state() settings: CashRegisterSettings = { ...DEFAULT_SETTINGS };

  @state() loading = true;

  @state() saving = false;

  @state() msg = '';

  @state() error = '';

  // Re-render al cambiar el idioma del shell (ADR-0055): los labels y el texto del template se
  // re-evalúan con el nuevo `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    await this.loadSettings();
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
  }

  private async loadSettings() {
    this.loading = true;
    this.error = '';
    try {
      const rows = await erplora().query<Array<Record<string, unknown>>>('cash_register.settings.get');
      const row = rows?.[0];
      if (row) {
        this.settings = {
          enable_cash_register: Boolean(Number(row.enable_cash_register)),
          require_opening_balance: Boolean(Number(row.require_opening_balance)),
          require_closing_balance: Boolean(Number(row.require_closing_balance)),
          allow_negative_balance: Boolean(Number(row.allow_negative_balance)),
          auto_open_session_on_login: Boolean(Number(row.auto_open_session_on_login)),
          auto_close_session_on_logout: Boolean(Number(row.auto_close_session_on_logout)),
          protected_pos_url: String(row.protected_pos_url ?? DEFAULT_SETTINGS.protected_pos_url),
        };
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errLoadSettings');
    } finally {
      this.loading = false;
    }
  }

  private async save(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.msg = '';
    this.error = '';
    try {
      await erplora().command('cash_register.settings.update', { ...this.settings });
      this.msg = erplora().t(CATALOG, 'ui.msgSettingsSaved');
    } catch (e) {
      this.error = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errSaveSettings');
    } finally {
      this.saving = false;
    }
  }

  private setBool(key: BoolKey, value: boolean) {
    this.settings = { ...this.settings, [key]: value };
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
      <header>
        <h2>${t('ui.settingsTitle')}</h2>
      </header>
      <form class="panel" @submit=${(e: Event) => this.save(e)}>
        <div class="grid">
          ${TOGGLES.map(
            (f) => html`<ion-toggle .checked=${this.settings[f.key]} ?disabled=${this.loading} @ionChange=${(e: any) => this.setBool(f.key, e.detail.checked)}>${t(f.labelKey)}</ion-toggle>`,
          )}
        </div>
        <div class="url">
          <ion-input label=${t('ui.labelProtectedPosUrl')} label-placement="stacked" placeholder="/m/sales/pos/" .value=${this.settings.protected_pos_url} ?disabled=${this.loading} @ionInput=${(e: any) => (this.settings = { ...this.settings, protected_pos_url: e.target.value })}></ion-input>
        </div>
        <footer>
          <ion-button type="submit" size="small" ?disabled=${this.saving || this.loading}>${this.saving ? t('ui.saving') : t('ui.saveSettings')}</ion-button>
          ${this.msg ? html`<span class="ok">${this.msg}</span>` : nothing}
          ${this.error ? html`<span class="err">${this.error}</span>` : nothing}
        </footer>
      </form>
    </div>`;
  }
}

define('erp-cashregister-settings', ErpCashRegisterSettings);
