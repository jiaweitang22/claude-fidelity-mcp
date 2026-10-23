# fidelity-mcp

MCP server for Fidelity brokerage accounts via Playwright browser automation.

> **Warning**: Fidelity has no public API. This automates the website, which may violate their Terms of Service. Use at your own risk.

## Setup

Requires Node 22+.

```bash
npm install
npx playwright install firefox
npm run build
claude mcp add fidelity -s user -- node "$(pwd)/dist/index.js"
```

## Logging in

You always log in yourself; the server never sees your password.

- From Claude: ask it to log in. `fidelity_login` opens a browser window (Playwright's Firefox, branded **"Nightly"**). Log in and complete 2FA there; the window closes when the portfolio summary loads.
- From a terminal: `npm run login` does the same.

The session is saved to `~/.fidelity-mcp/fidelity_session_default.json` and reused by later tool calls. When it expires, tools say so; log in again.

## Tools

`fidelity_status`, `fidelity_login`, `fidelity_logout`, `fidelity_get_accounts`, `fidelity_get_positions`, `fidelity_get_quote`, `fidelity_place_order`, `fidelity_stage_order`, `fidelity_batch_orders`, `fidelity_rebalance_plan`, `fidelity_transfer`, `fidelity_screenshot`, `fidelity_page_content`.

Orders and transfers default to `dry_run: true` (preview or review step only). Stocks/ETFs trade by share quantity, mutual funds by dollar amount. `fidelity_stage_order` fills and previews an order in a visible window and leaves the final Place order click to you. `fidelity_rebalance_plan` turns target weights into a list of orders without placing any. Positions include cost basis and total gain/loss when Fidelity shows them.

## Environment variables

All optional.

| Variable | Description |
|----------|-------------|
| `FIDELITY_HEADLESS` | `"false"` to show the server's browser (default: headless) |
| `FIDELITY_SESSION_DIR` | Session directory (default: `~/.fidelity-mcp`) |
| `FIDELITY_SESSION_TITLE` | Session file suffix, for multiple logins |
| `FIDELITY_TIMEOUT` | Default timeout in ms (default: `30000`) |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Session expired or not logged in" | Log in again (`fidelity_login` or `npm run login`) |
| Code changes have no effect | `npm run build`, then reload the MCP server (`/mcp` or restart) |
| "Something went wrong" during 2FA | Stop retrying (lockout risk); wait and try once later |

See [CLAUDE.md](CLAUDE.md) for architecture and rules for AI agents.
