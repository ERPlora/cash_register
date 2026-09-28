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
// * notDisplay — the one triaged in pm#289 (`fromMinorUnits`, the value of the money ion-input) and
//   the input's `step` (`amountStep`, cash_register#106), both in `lib/money.ts`. The first is
//   also the witness on the detector's OUTPUT: if the scan were fed empty or cut content, it would
//   come back as `stale_exception` (rv-taxes-78). Add an entry (`'file: exact code line'` → why)
//   only with the reason it is not a screen amount.
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
        'lib/money.ts': 'export function toMinorUnits(',
      },
      notDisplay: {
        'lib/money.ts: return minorToMajor(minor, scale).toFixed(scale);':
          'value of the money ion-input (cash_register#65): a plain-dot string that must round-trip ' +
          'through toMinorUnits; a locale-formatted amount would parse back as NaN. Uses the hub scale.',
        'lib/money.ts: return (10 ** -scale).toFixed(scale);':
          'the `step` attribute of the money ion-input (cash_register#106): one minor unit of the hub ' +
          'currency as a plain-dot number («1», «0.01», «0.001»), never painted as an amount.',
      },
      outfitkitImporters: [
        'components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts',
        'components/erp-cashregister-session-detail/erp-cashregister-session-detail.ts',
        'components/erp-cashregister-open/erp-cashregister-open.ts',
      ],
    }),
  ).toEqual([]);
});
