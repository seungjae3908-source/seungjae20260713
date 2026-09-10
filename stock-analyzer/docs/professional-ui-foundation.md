# Professional UI Foundation

Status: Draft implementation contract  
Scope owner: `draft/pro-ui-foundation-20260906`  
Base when created: `9dcb09e54ac13dac4d13b303c22f2042d2fe3631`

This document defines the product-wide visual rules for the investment application. It does not change trading authority, provider contracts, research evidence semantics, or profitability claims.

## 1. Product principle

The default surface must be simple, compact, and trustworthy. Technical evidence remains available behind detail or expert views.

- Never invent a financial value to fill visual space.
- Missing data must stay missing; missing is not zero.
- Prefer one-line user-facing status text over raw internal tokens.
- Preserve raw provider, SHA, dataset, evidence, and authority values in expert/detail surfaces when required.
- Visual polish must not weaken fail-closed behavior.

## 2. Alignment

Center-first is the default presentation rule, not a blanket rule for all text.

Center:
- page titles
- section titles
- primary metrics
- status badges
- tabs
- buttons
- empty/loading/error state headlines
- short one-line status text

Left:
- long explanations
- news/disclosure copy
- research narrative
- list descriptions

Right:
- financial table amounts
- quantity/price columns
- aligned PnL values in tables

## 3. Typography

Use semantic roles instead of page-local arbitrary values.

| Role | Size | Weight |
| --- | ---: | ---: |
| Primary metric | 24px | 700 |
| Page title | 20px mobile / 24px desktop | 700 |
| Section title | 16px / 18px | 700 |
| Card title | 14px / 15px | 600–700 |
| Body | 14px / 15px | 500 |
| Caption | 12px minimum | 500 |
| Badge | 12px | 600 |

Rules:
- Do not add new 9px, 10px, or 11px user-facing text without an explicit accessibility reason.
- Avoid `font-black` / 900 for ordinary interface copy.
- Use 700 for strong hierarchy and 600 for controls/card titles.
- Use tabular numerals for financial metrics where possible.

## 4. Responsive policy

One canonical breakpoint policy is used by product UI:

- Compact: 320–359
- Phone: 360–599
- Medium / fold-open: 600–899
- Tablet: 900–1199
- Desktop: 1200+

Rules:
- Touch/tablet composition continues through 1199px.
- Desktop-only floating/shell geometry begins at 1200px.
- Page-local 1024px desktop switches are prohibited unless they are intentionally isolated and tested.
- A page must not mix touch body composition with desktop navigation geometry.

## 5. Geometry safety

A green document-overflow check is not enough. UI is accepted only when visible elements do not collide.

Required widths:
- 320
- 360
- 390
- 430
- 600
- 768
- 900
- 1024
- 1180/1199
- 1200
- 1440
- 1920 when the final visual gate is run

Required checks:
- document horizontal overflow
- popup/menu viewport bounds
- modal viewport bounds
- fixed/sticky control occlusion
- BottomNav content occlusion
- card internal overflow
- long-token stress
- element-to-element collision for critical surfaces
- landscape/fold short-height states

## 6. Navigation

- Persistent navigation labels use at least 12px text and 600 weight.
- Touch targets stay at least 44px high.
- Desktop controls may use a 48px target.
- Edge popovers must anchor inward; they must never rely on center placement when the trigger is near a viewport edge.
- Keyboard navigation, Escape close, and focus restoration remain mandatory.

## 7. Home dashboard

Home is a decision dashboard, not a menu directory.

Default summary:
- market data state
- current AI signal state when genuine current evidence exists
- watchlist count
- portfolio entry point

Home must not fabricate account totals. Personal balance/PnL may appear only after an authoritative account/portfolio read model is deliberately connected by its owner.

Desktop:
- multi-column dashboard composition
- market/signal work area
- portfolio/watchlist side rail

Mobile:
- compact professional overview remains visible
- detail sections may remain tabbed to control density
- no horizontal overflow

## 8. Research surfaces

Research preserves expert evidence but the default presentation should remain readable.

- Long authority tokens must wrap or move to detail/expert presentation.
- Raw internal tokens may never force a 5-column collision on tablet widths.
- User-facing summaries should prefer Korean status labels.
- Evidence/verification tabs may retain exact technical identifiers.
- Profitability remains `미검증` unless authoritative evidence proves otherwise.

## 9. Explanation diet

Default visible UI:
1. title
2. status/value
3. at most one short support line

Move long explanations to:
- `상세`
- `근거 보기`
- `전문가 정보`
- disclosure/details panels

Do not delete evidence merely to simplify the screen.

## 10. Future professional shell

The following are intentionally not forced into the first foundation slice because they affect application-wide scrolling and layout owners:

- desktop sidebar
- global command bar
- global status bar
- command palette
- keyboard shortcut map
- resizeable workspace panels
- workspace presets
- multi-chart layout
- focus mode
- density selector
- notification center

These should be integrated after the other active owners finish, then aligned to the latest main and validated by the full Visual Geometry + Full Product Browser E2E gates.

## 11. Integration boundary

Current Draft work may include implementation and focused regression tests only.

Do not perform as part of this UI foundation without separate authorization:
- live trading
- private trading API activation
- real order/cancel/transfer/withdrawal
- production deployment
- production DB mutation
- secret/env mutation
- server restart/activation

Final integration sequence after other work settles:

1. fetch latest main
2. non-force, history-preserving alignment
3. resolve owner conflicts with minimum diff
4. focused UI tests
5. Visual Geometry matrix
6. Full Product Browser E2E
7. Required CI 6/6
8. unresolved review threads = 0
9. Ready only after approval/gate
10. Merge only after approval/gate
11. Production deployment remains a separate authorization
