// cash_register#90 — the button that closes the till was invisible: white text on the pale panel.
//
// It declared `color="danger"`. Ionic implements `color=` with the GLOBAL rule
// `.ion-color-danger { --ion-color-base: … }` from `core.css`, which lives in the document stylesheet
// and does NOT reach into this Web Component's shadow root. Inside it the selector matches nothing,
// `--ion-color-base` stays empty and `:host(.button-solid.ion-color) .button-native { background:
// var(--ion-color-base) }` resolves to transparent. Measured by QA on Android (v1.1.26, module
// 1.3.49): `color: rgb(255,255,255)`, background `rgba(0,0,0,0)`, `--ion-color-base` empty. Same
// defect as kitchen#42 (the KDS «Ready» button).
//
// Both labels of the same button were hit: «Close session» and, once the shift review warned about
// pending work, «Close anyway». The market paints this action as the loudest button on the screen
// (Square «Close drawer», Toast «Close out»), so the contract here is: no `color=` (dead inside a
// shadow root), and a danger background declared by the component itself, where it does apply.
//
// happy-dom does not load Ionic's CSS nor paint, so the rendered colour cannot be measured here (QA
// measured it in a real WebView). What is pinned is the contract that makes the bug impossible.
import { beforeEach, describe, expect, it } from 'vitest';

const SESSION = {
  id: 's1',
  session_number: 'S-260918-0001',
  status: 'open',
  opening_balance: 15000,
  closing_balance: null,
  expected_balance: 14300,
  difference: null,
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async (name: string) =>
      name === 'cash_register.counts.list'
        ? { rows: [], total: 0, limit: 50, offset: 0 }
        : { rows: [SESSION], total: 1, limit: 50, offset: 0 },
    command: async () => ({}),
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    formatAmount: (units: number) => `${(units || 0).toFixed(2)} €`,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
  };
});

interface Wc extends HTMLElement {
  closeAcknowledged: boolean;
  openPanel(panel: string, session: unknown): void;
  updateComplete: Promise<unknown>;
}

async function mount(): Promise<Wc> {
  await import('./erp-cashregister-dashboard');
  const el = document.createElement('erp-cashregister-dashboard') as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

const submitOf = (el: Wc): HTMLElement | null =>
  el.shadowRoot!.querySelector('[data-testid="cash-register-close-submit"]');

/** Every rule of the component's own stylesheet — the only CSS that lives inside its shadow root. */
function stylesOf(el: Wc): string {
  const styles = (el.constructor as unknown as { styles: { cssText: string } | { cssText: string }[] }).styles;
  return Array.isArray(styles) ? styles.map((s) => s.cssText).join('\n') : styles.cssText;
}

/** The declarations of the rule(s) whose selector targets the close-submit button. */
function closeSubmitDeclarations(el: Wc): string {
  const css = stylesOf(el).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  return rules
    .filter(([, selector]) => /\[data-testid=["']?cash-register-close-submit["']?\]/.test(selector))
    .map(([, , body]) => body)
    .join(';');
}

describe('cash_register#90: the close-till button paints its own danger background', () => {
  it('«Close session» does not rely on color=, which paints nothing inside a shadow root', async () => {
    const el = await mount();
    el.openPanel('close', SESSION);
    await settle(el);

    const button = submitOf(el);
    expect(button, 'the close panel renders its submit button').not.toBeNull();
    expect(button!.textContent?.trim()).toBe('ui.closeSession');
    expect(
      button!.hasAttribute('color'),
      'color= inside a module shadow root leaves --ion-color-base empty: white text on a transparent button',
    ).toBe(false);
  });

  it('«Close anyway» (after the shift-review warning) is the same visible button', async () => {
    const el = await mount();
    el.openPanel('close', SESSION);
    await settle(el);
    el.closeAcknowledged = true;
    await settle(el);

    const button = submitOf(el);
    expect(button!.textContent?.trim()).toBe('ui.closeAnyway');
    expect(button!.hasAttribute('color')).toBe(false);
  });

  it('the component declares the danger background, contrast text and pressed states for that button', async () => {
    const el = await mount();
    const decl = closeSubmitDeclarations(el);

    expect(decl, 'a rule inside the shadow root must target the close-submit button').not.toBe('');
    expect(decl).toMatch(/--background\s*:\s*var\(--ion-color-danger\b/);
    expect(decl).toMatch(/--color\s*:\s*var\(--ion-color-danger-contrast\b/);
    expect(decl).toMatch(/--background-activated\s*:\s*var\(--ion-color-danger-shade\b/);
    expect(decl).toMatch(/--background-hover\s*:\s*var\(--ion-color-danger-tint\b/);
  });
});
