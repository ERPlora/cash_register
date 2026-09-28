import { it, expect } from 'vitest';
import { checkMoneyDisplay } from '@erplora/module-toolkit/money-display-guard';

// GUARD (pm#289, shared since pm#505/pm#508): money on screen is never formatted by hand in this
// module, and OutfitKit comes in by entry point, never as a value from the barrel.
//
// The rules live in `@erplora/module-toolkit/money-display-guard` (one piece for every module,
// tested there against its own positives); this test only says what is specific to Caja:
//
// * witnesses — every amount this module paints goes through the shell's formatter: in the
//   dashboard the `fmt()` helper of the balances/history columns, the movement confirmation, the
//   «count added» message and the count total; in the session detail its `fmt()` helper; in `lib/`
//   the denomination labels of the arqueo card. They count the CALL, not the name: both screens and
//   `lib/enums.ts` also declare `formatMoney(…)` in their `erplora()` interface, and a scan over
//   empty or over-stripped content must not stay green on that declaration (rv-combos-22). The
//   other helpers of `lib/` are witnesses too: a shared money helper would land there first, so the
//   scan must provably read them (rv-taxes-78).
// * notDisplay — none: every money FIELD reads and rewrites its text with the toolkit's
//   `money-input` through `lib/money.ts` (pm#521) — the plain-dot `fromMinorUnits` and the input's
//   `step` (`amountStep`) that were triaged here are gone with it. `lib/money.ts` stays a witness,
//   so the scan provably reads it. Add an entry (`'file: exact code line'` → why) only with the
//   reason it is not a screen amount.
// * outfitkitImporters — each of the three screens imports OutfitKit (entry points + types), so the
//   barrel scan provably read all three (rv-pricing-53).
it('money on screen goes through the shared formatter and OutfitKit by entry point (pm#289)', () => {
  expect(
    checkMoneyDisplay({
      from: import.meta.url,
      witnesses: {
        'components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts': {
          text: 'erplora().formatMoney(',
          atLeast: 4,
        },
        'components/erp-cashregister-session-detail/erp-cashregister-session-detail.ts':
          'erplora().formatMoney(',
        'lib/enums.ts': 'client.formatMoney(',
        'lib/movement-concept.ts': 'export function movementConcept(',
        'lib/shift-review.ts': 'export function summariseLiveOrders(',
        'lib/money.ts': 'export function readMoneyField(',
      },
      outfitkitImporters: [
        'components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts',
        'components/erp-cashregister-session-detail/erp-cashregister-session-detail.ts',
        'components/erp-cashregister-open/erp-cashregister-open.ts',
      ],
    }),
  ).toEqual([]);
});
