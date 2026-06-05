import { Component, State, h } from '@stencil/core';
// Importa el DataTable compartido (Stencil) para que se auto-registre y esbuild
// lo empaquete dentro del bundle del módulo. El shell provee los `ion-*`.
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn } from '../../../../_shared/ui/components/data-table/data-table';

// WC del módulo `cash_register` (Stencil). Mini-app: sesiones de caja con su estado
// y reconciliación (esperado/contado/diferencia). 90% lógica en Rust; reactivo a
// los eventos de apertura/cierre de sesión. El listado usa el DataTable compartido.

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
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

@Component({
  tag: 'erp-cashregister-dashboard',
  shadow: true,
  styles: `
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color,#1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .err { color:#d9480f; font-weight:600; }
  `,
})
export class ErpCashRegisterDashboard {
  @State() sessions: Session[] = [];
  @State() loading = true;
  @State() error = '';
  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'session_number', header: 'Sesión' },
    { key: 'status', header: 'Estado' },
    { key: 'opening_balance', header: 'Apertura', align: 'right', format: (r) => this.fmt(r.opening_balance as number | null) },
    { key: 'expected_balance', header: 'Esperado', align: 'right', format: (r) => this.fmt(r.expected_balance as number | null) },
    { key: 'closing_balance', header: 'Contado', align: 'right', format: (r) => this.fmt(r.closing_balance as number | null) },
    { key: 'difference', header: 'Diferencia', align: 'right', format: (r) => this.fmt(r.difference as number | null) },
  ];

  async componentWillLoad() {
    await this.refresh();
    try {
      const a = erplora().on('cash_register.session_opened', () => this.refresh());
      const b = erplora().on('cash_register.session_closed', () => this.refresh());
      this.unsub = () => { a(); b(); };
    } catch { /* preview */ }
  }
  disconnectedCallback() { this.unsub?.(); }

  private async refresh() {
    this.loading = true; this.error = '';
    try { this.sessions = (await erplora().query<Session[]>('cash_register.sessions.list')) ?? []; }
    catch (e) { this.error = e instanceof Error ? e.message : 'Error cargando sesiones'; }
    finally { this.loading = false; }
  }

  private fmt(n: number | null): string { return n == null ? '—' : Number(n).toFixed(2); }

  render() {
    return (
      <div>
        <header>
          <h2>Caja</h2>
        </header>

        {this.error && <p class="err">{this.error}</p>}

        <data-table
          columns={this.columns}
          rows={this.sessions as unknown as Record<string, unknown>[]}
          searchKeys={['session_number', 'status']}
          searchPlaceholder="Buscar sesión o estado…"
          emptyMessage={this.loading ? 'Cargando…' : 'Sin sesiones de caja.'}
        />
      </div>
    );
  }
}
