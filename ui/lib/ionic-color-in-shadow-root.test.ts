// cash_register#90 — «Close session» was white text on a transparent button: `color="danger"` on an
// `ion-button` that lives inside this module's shadow root.
//
// Ionic implements `color=` in two halves. The component adds `.ion-color .ion-color-danger` to its
// host and paints from `--ion-color-base`; the value of `--ion-color-base` comes from a GLOBAL rule in
// `@ionic/core/css/core.css`:
//
//     .ion-color-danger { --ion-color-base: var(--ion-color-danger, #c5000f) !important; … }
//
// Document stylesheets do not match elements inside a shadow tree, and every screen of this module is
// a Lit Web Component with its own shadow root. So the class is added, the rule never applies,
// `--ion-color-base` stays empty and the solid button's background resolves to transparent. It
// throws nothing and warns nothing — the same defect already shipped once in kitchen#42 (the KDS
// «Ready» button) and was fixed in that one button, not guarded.
//
// Colour is given the way that DOES cross the boundary: the component's own stylesheet sets the
// button's custom properties from the theme tokens (`--background: var(--ion-color-danger)`), which
// inherit through the shadow root like every other custom property.
//
// It is a SOURCE test on purpose, like `ionic-fill-needs-md` in inventory/staff/pricing: a template
// branch that no unit test renders is still scanned.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const UI = join(__dirname, '..');

function componentSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Opening tags of every `ion-*` element, whole. A Lit tag does NOT end at the first `>`:
 * `@click=${() => a > b}` puts one inside it, and cutting there would read every attribute after
 * an arrow function as absent — `color=` included. `${…}` is skipped by brace depth.
 */
function ionOpeningTags(source: string): string[] {
  const tags: string[] = [];
  const start = /<ion-[a-z-]+(?=[\s/>])/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '$' && source[i + 1] === '{') {
        depth++;
        i++;
      } else if (c === '{' && depth > 0) depth++;
      else if (c === '}' && depth > 0) depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
    start.lastIndex = i + 1;
  }
  return tags;
}

/** `color="danger"`, `color=${x}` and the property binding `.color=${x}` — all dead in a shadow root. */
const DECLARES_COLOR = /(?:^|\s)\.?color=/;

function tagsWithDeadColor(source: string): string[] {
  return ionOpeningTags(source)
    .filter((tag) => DECLARES_COLOR.test(tag))
    .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 120));
}

describe('no ion-* element of the module relies on color= (cash_register#90, kitchen#42)', () => {
  it('Ionic paints a coloured button from --ion-color-base, which only a GLOBAL class sets', () => {
    // Anchored to the dependency, not to a copy of it: the day Ionic sets the colour itself (or
    // stops using --ion-color-base), this fails and says the guard below has outlived its cause.
    const require = createRequire(import.meta.url);
    const core = dirname(require.resolve('@ionic/core/package.json'));
    const button = readFileSync(join(core, 'dist/collection/components/button/button.ios.css'), 'utf8');
    const global = readFileSync(join(core, 'css/core.css'), 'utf8');

    expect(button.replace(/\s+/g, ' '), 'a solid coloured button takes its background from --ion-color-base').toMatch(
      /:host\(\.button-solid\.ion-color\) \.button-native \{ background: var\(--ion-color-base\)/,
    );
    expect(button, 'the button never sets --ion-color-base itself').not.toMatch(/--ion-color-base\s*:/);
    expect(global, 'only the global .ion-color-* class does — and it does not reach a shadow root').toMatch(
      /\.ion-color-danger\s*\{\s*--ion-color-base\s*:/,
    );
  });

  it('no ion-* tag in ui/ declares color=', () => {
    const offenders: string[] = [];
    for (const file of componentSources(UI)) {
      for (const tag of tagsWithDeadColor(readFileSync(file, 'utf8'))) {
        offenders.push(`  ${relative(UI, file)}: ${tag}`);
      }
    }
    expect(
      offenders,
      [
        'these render with an empty --ion-color-base (transparent / uncoloured) inside the shadow root —',
        'drop color= and set --background/--color from the theme token in the component styles:',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('the scanner catches color= after an arrow function and ignores what is not the attribute', () => {
    const tpl = [
      '<ion-button @click=${() => this.count > 1 && this.go()} color="danger">x</ion-button>',
      '<ion-badge\n  .color=${this.tone}>y</ion-badge>',
      '<ion-icon style="color: var(--ion-color-warning)"></ion-icon>',
      '<ion-chip data-color="x" @click=${() => ({ a: 1 })}>z</ion-chip>',
    ].join('\n');
    const dead = tagsWithDeadColor(tpl);
    expect(dead).toHaveLength(2);
    expect(dead[0]).toContain('color="danger"');
    expect(dead[1]).toContain('.color=${this.tone}');
  });

  it('the scan really reaches the components — otherwise it would pass over an empty set', () => {
    const total = componentSources(UI).reduce((n, file) => n + ionOpeningTags(readFileSync(file, 'utf8')).length, 0);
    expect(total, 'no ion-* tags found: a refactor moved them and this guard stopped guarding').toBeGreaterThan(25);
  });
});
