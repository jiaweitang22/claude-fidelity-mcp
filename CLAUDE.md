# Notes for AI agents

MCP server that drives Fidelity's website with Playwright (Firefox). There is no API: every tool is DOM automation against the user's live brokerage account, so a wrong click can move real money or lock the account.

## Hard rules

- **Real money moves only on explicit user confirmation** of the exact account, symbol, side, quantity and limit price (or transfer from/to/amount). Run `fidelity_place_order` / `fidelity_batch_orders` with the default `dry_run: true` first, show the user the returned `orderDetails`, and set `dry_run: false` only after they approve that exact order. When the user wants to place it themselves, use `fidelity_stage_order`: it leaves the previewed order in a visible window and the user clicks Place order. `fidelity_transfer` has no dry run: it submits immediately.
- **The user types their own credentials.** Login is always the user in a visible browser window (`fidelity_login` or `npm run login`). Credentials and TOTP secrets never go into config, scripts, commits or chat.
- **One login attempt, then report.** Repeated attempts trigger Fidelity's "Something went wrong" 2FA page and risk a lockout.
- **The session file holds live auth cookies** (`~/.fidelity-mcp/fidelity_session_*.json`). Check its mtime/size only; leave its contents unread.

## Running it (new machine or new agent)

1. `npm install && npx playwright install firefox && npm run build`. Done when `dist/index.js` exists.
2. Register once: `claude mcp add fidelity -s user -- node "$(pwd)/dist/index.js"`. The user reloads MCP servers (`/mcp` or restart) after this and after every rebuild; a running server keeps the old `dist/`.
3. Call `fidelity_status`. `savedAt` is when the session was last confirmed logged in.
4. Call a read tool (`fidelity_get_accounts`). If it returns "session expired", call `fidelity_login` once: a Firefox window branded "Nightly" opens and the user logs in and completes 2FA there (up to 10 minutes). Tell the user the window is open before calling it. Done when it returns `success: true`; then retry the read tool.

## Tools

| Tool | Notes |
|------|-------|
| `fidelity_status` | No navigation |
| `fidelity_login` | Visible window, user logs in; blocks other tools while waiting |
| `fidelity_logout` | Closes the browser; saved session stays |
| `fidelity_get_accounts` | Numbers and nicknames from the transfer page; no balances |
| `fidelity_get_positions` | Positions CSV download; per-account cash in `balance` |
| `fidelity_get_quote` | Via the trade ticket |
| `fidelity_place_order` / `fidelity_batch_orders` | `dry_run` defaults to true; result includes `estimatedValue` and `limitPrice` read from Fidelity's preview |
| `fidelity_stage_order` | Fills and previews the order in a visible window and stops; the user clicks Place order. Use this when the user wants to finalize a trade themselves. Stocks/ETFs by `quantity`; mutual funds (`isMutualFund`: 5 letters ending in X) by dollar `amount` |
| `fidelity_transfer` | Submits immediately |
| `fidelity_screenshot` / `fidelity_page_content` | Debugging selectors; optional `url` opens it first |

Tool calls run one at a time (they share one browser page).

## Code layout

| File | Owns |
|------|------|
| `src/session.ts` | Session module: browser launch, saved session, sign-in detection, `openPage(url)`, `login()` |
| `src/index.ts` | Tool definitions through one `tool()` adapter (JSON output, `isError`, serialization) |
| `src/accounts.ts` | Account list, exact account-number matching, transfers |
| `src/positions.ts` | Positions CSV download and `parsePositionsCsv()` |
| `src/trading.ts` | Quotes, order type policy (`resolveOrderType`), order ticket |
| `src/scripts/login.ts` | `npm run login`, same code path as `fidelity_login` |

Flows get a page only through `openPage(url)`. It throws `SessionExpiredError` on a sign-in redirect, saves the session after confirming the page is logged in, and closes promo dialogs (e.g. "add a beneficiary") with their X. Wait for elements with `appears(locator, ms)`: Playwright's `isVisible({ timeout })` ignores the timeout.

## Session invariants (bugs that have bitten before)

- The session is written to disk only after a page is confirmed logged in (`openPage`, `login`). Writing on close or on a sign-in page replaced a good session with a logged-out one.
- URL checks use the pathname (`isOnLoginPage`): sign-in redirects carry the destination in `?AuthRedUrl=…portfolio%2Fsummary`.
- Fidelity's Akamai cookies (`_abck`, `bm_*`) are fingerprint-bound. The login window and the server browser share `launch()` in `session.ts` (args, user agent, init script); keep them identical.
- Accounts match by exact account number via `findAccountOption()`; one account number can be a substring of another.
- `readPreview()` parses the "Preview Order" block as text; `previewMismatch()` checks its account, symbol, action and quantity (or dollar amount for funds) against the request, and any difference aborts the order (fail closed).

## Site map (verified 2026-10-23)

- Positions: `portfolio/positions` → "Available Actions" → `#kebabmenuitem-download`. CSV headers are lower-case after the first word (`Account number`, `Last price`); parsing is case-insensitive.
- Transfers: `transfer/?quicktransfer=cash-shares`. Native selects labelled From / To, then `#one-time`, `#transfer-amount`, Continue, Submit. The Continue → Submit → "Request submitted" steps were not exercised (no live transfers).
- Mutual fund ticket: `trade-mutualfund?ORDER_TYPE=M&CURRENT_PAGE=TradeMF&DEST_TRADE=Y`. `#mf-dropdownlist-button` (Account / Action), `#mf-ticket-dest-symbol-Symbol`, `#mf-shared-quantity` (dollars). Fidelity accepts amounts under $1 (a $0.46 FSKAX buy previewed fine).
- Trade ticket: `trade-equity/index/orderEntry`. Preview errors (e.g. insufficient funds) come back in a dialog. The limit-order path (order type → Limit, "Limit price") was not exercised live.

## Changing the code

- `npm run build` must pass, and the server must answer `tools/list` over stdio. There is no test suite; `parsePositionsCsv`, `parseAccountText`, `readPreview`, `previewMismatch` and `resolveOrderType` are pure and the place to start one.
- When Fidelity ships UI changes, selectors break. Look before guessing: `fidelity_page_content` / `fidelity_screenshot` with the page URL, or a scratch script importing `dist/session.js` (`openPage`, `closeSession`). Prefer ids and `exact: true` role/label matches.
- Live testing is read-only: accounts, positions, quotes, and dry-run order previews. Orders with `dry_run: false` and transfers are never part of testing.
