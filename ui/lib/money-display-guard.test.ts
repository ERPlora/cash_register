import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GUARD (pm#289): money on screen is never formatted by hand in this module.
//
// Money travels as an integer in the currency's minor unit (ADR-0123). The screen gets it through
// the shell's single formatter — `erplora().formatMoney(minor)` (currency and scale of the hub,
// JPY 0 decimals, KWD 3) — or `<ok-money>` / `formatMinor` from OutfitKit (by string, no float).
// A `(cents / 100).toFixed(2)` — or `.toFixed(scale)`, same float path — or a hand-built
// `Intl.NumberFormat({ currency })` brings back what that contract removed: its own separators,
// its own rounding, and a hard `/100` that is wrong the day the hub is not in euros.
//
// The only hand formatting left is NOT display, and each one is listed below with the reason.
// A new occurrence (or an allowed one that moves to another file) turns this test red.

function moduleRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'module.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('module.json not found walking up from the test');
    dir = up;
  }
  return dir;
}

/** Production sources of the UI: tests and the test doubles in `ui/test/` do not reach a screen. */
function uiSources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'test' || n === 'node_modules' ? [] : uiSources(p);
    return /\.(ts|js|vue)$/.test(n) && !/\.test\.(ts|js)$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
  });
}

/** Comments may talk about `toFixed(2)`; only code counts. Crude but enough: strings never
 *  contain these patterns in this module, and a false positive fails loud, not silent. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Every `NumberFormat(…)` call whose arguments (up to the balancing paren, across lines) name a
 *  `currency`: the options object usually sits on its own lines, so a per-line match misses it. */
function currencyNumberFormatCalls(code: string): string[] {
  const calls: string[] = [];
  const open = /NumberFormat\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(code))) {
    let depth = 1;
    let i = open.lastIndex;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    const call = code.slice(m.index, i);
    if (/\bcurrency\b/.test(call)) calls.push(call.replace(/\s+/g, ' ').trim());
  }
  return calls;
}

/** Each hand-formatted number in the code: any `.toFixed(…)` (per line — `toFixed(scale)` is the
 *  same float path as `toFixed(2)`) or a `NumberFormat(…currency…)` call (collapsed to one line,
 *  however many it spans). */
export function handFormattedMoney(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  for (const line of code.split('\n')) {
    if (/\.toFixed\s*\(/.test(line)) hits.push(line.trim());
  }
  return hits.concat(currencyNumberFormatCalls(code));
}

/** Triaged pm#289: formatting that is not a screen amount. `file: exact code line → why`.
 *  Every amount on screen (balances, movements, count total, session detail) already goes through
 *  `erplora().formatMoney(minor)`. Add an entry only with the reason it is not a screen amount. */
const NOT_DISPLAY: Record<string, string> = {
  'components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts: return minorToMajor(minor, scale).toFixed(scale);':
    'value of the money ion-input (cash_register#65): a plain-dot string that must round-trip ' +
    'through toMinorUnits; a locale-formatted amount would parse back as NaN. Uses the hub scale.',
};

describe('money display goes through the shared formatter (pm#289)', () => {
  it('no hand-formatted amount in ui/ outside the triaged non-display cases', () => {
    const uiRoot = join(moduleRoot(), 'ui');
    const found: string[] = [];
    for (const f of uiSources(uiRoot)) {
      const rel = f.slice(uiRoot.length + 1);
      for (const h of handFormattedMoney(readFileSync(f, 'utf8'))) found.push(`${rel}: ${h}`);
    }
    const unexpected = found.filter((k) => !(k in NOT_DISPLAY));
    expect(
      unexpected,
      'amount formatted by hand: use erplora().formatMoney(minor) or <ok-money>/formatMinor',
    ).toEqual([]);
  });

  it('every triaged exception still exists (a stale entry would hide the next one)', () => {
    const uiRoot = join(moduleRoot(), 'ui');
    const found = new Set<string>();
    for (const f of uiSources(uiRoot)) {
      const rel = f.slice(uiRoot.length + 1);
      for (const h of handFormattedMoney(readFileSync(f, 'utf8'))) found.add(`${rel}: ${h}`);
    }
    expect(Object.keys(NOT_DISPLAY).filter((k) => !found.has(k))).toEqual([]);
  });

  it('the detector catches the positive (otherwise this guard is decorative)', () => {
    expect(handFormattedMoney('const s = `${(total / 100).toFixed(2)} €`;')).toHaveLength(1);
    expect(handFormattedMoney("const f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });")).toHaveLength(1);
    expect(handFormattedMoney('const s = (total / 10 ** scale).toFixed(scale) + " €";')).toHaveLength(1);
    expect(handFormattedMoney('const s = erplora().formatMoney(total);')).toHaveLength(0);
    expect(handFormattedMoney('// was (x / 100).toFixed(2)\nconst s = erplora().formatMoney(x);')).toHaveLength(0);
    expect(handFormattedMoney("new Intl.NumberFormat(locale, { maximumFractionDigits: 3 })")).toHaveLength(0);
    // The shape prettier produces: the options object on its own lines (this is how it comes back).
    expect(handFormattedMoney("new Intl.NumberFormat('es-ES', {\n  style: 'currency',\n  currency: 'EUR',\n});")).toHaveLength(1);
  });
});
