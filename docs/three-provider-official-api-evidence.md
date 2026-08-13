# Official provider API evidence

Validated against current official documentation on 2026-08-14 KST.

## Toss Securities

Canonical provider for KR and US stocks. Official Open API supports OAuth2 client credentials, account list, holdings, order creation, order modification, order cancellation, order history, buying power, sellable quantity, and commissions. Account and order calls require the account identity header in addition to the bearer token.

## Upbit

Canonical provider for crypto spot. Existing main already contains authenticated account and order request builders. Order creation uses the authenticated order endpoint and supports client identifiers for idempotent order tracking.

## Bitget

Canonical provider for crypto futures. Existing main already contains signed USDT futures account, position, order, cancellation, and order-detail request builders.

This Draft only records capability and predeploy evidence. It does not register credentials, call private endpoints, submit orders, or change deployment settings.
