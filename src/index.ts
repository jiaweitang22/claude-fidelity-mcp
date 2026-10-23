#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { getAccountList, transfer } from "./accounts.js";
import { getPositions } from "./positions.js";
import { closeSession, currentPage, login, openPage, status } from "./session.js";
import { getQuote, isMutualFund, placeBatchOrders, placeOrder, stageFundOrder, stageOrder } from "./trading.js";

const server = new McpServer({ name: "fidelity", version: "2.0.0" });

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// What a tool handler returns: plain data (sent as JSON), or explicit content.
// isError is taken from `success: false` / `failed > 0` when present.
type ToolOutput = unknown | { content: Content[] };

// All tools drive one shared browser page, so calls run one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function tool<S extends ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolOutput>,
  queued = true
) {
  server.tool(name, description, schema, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
    try {
      const out = await (queued ? serialized(() => handler(args)) : handler(args));
      if (out && typeof out === "object" && "content" in out) return out;
      const r = out as { success?: boolean; failed?: number };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: r?.success === false || (r?.failed ?? 0) > 0,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `${name} failed: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  }) as never);
}

const dryRun = z
  .boolean()
  .optional()
  .default(true)
  .describe("true (default): fill the ticket and preview only. false: actually place. Only set false after the user confirmed the exact order.");

tool(
  "fidelity_status",
  "Report whether the browser is running, whether it is on a sign-in page, and when the session was last saved. Does not navigate.",
  {},
  async () => status(),
  false // Never navigates, so it answers even while fidelity_login waits
);

tool(
  "fidelity_login",
  "Open a visible browser window on Fidelity's sign-in page so the USER can log in and complete 2FA themselves. Waits up to 10 minutes, then saves the session. Never asks for or types credentials. Call once when a tool reports the session expired; don't retry in a loop.",
  {},
  async () => login()
);

tool(
  "fidelity_logout",
  "Close the browser. The saved session stays on disk for the next tool call.",
  {},
  async () => {
    await closeSession();
    return { success: true, message: "Browser closed." };
  }
);

tool(
  "fidelity_get_accounts",
  "List Fidelity accounts (number and nickname). For balances use fidelity_get_positions.",
  {},
  async () => getAccountList()
);

tool(
  "fidelity_get_positions",
  "Get holdings for every account from Fidelity's positions CSV: ticker, quantity, price, value, and cash balance (`balance`).",
  {},
  async () => getPositions()
);

tool(
  "fidelity_get_quote",
  "Get the last price (and extended-hours price when available) for a stock/ETF from the trade ticket.",
  { symbol: z.string().describe("Ticker, e.g. AAPL") },
  async ({ symbol }) => getQuote(symbol)
);

tool(
  "fidelity_place_order",
  "Buy or sell a stock/ETF. Dry run by default (preview only). Penny stocks (< $1) and extended hours always use limit orders; without limit_price the limit is one tick past the last price. The result shows the exact order (including limit price) for the user to confirm.",
  {
    account_number: z.string().describe("Exact Fidelity account number"),
    symbol: z.string(),
    action: z.enum(["buy", "sell"]),
    quantity: z.number().int().positive(),
    order_type: z.enum(["market", "limit"]).optional().describe("Default market"),
    limit_price: z.number().positive().optional(),
    dry_run: dryRun,
  },
  async (a) =>
    placeOrder({
      accountNumber: a.account_number,
      symbol: a.symbol,
      action: a.action,
      quantity: a.quantity,
      orderType: a.order_type,
      limitPrice: a.limit_price,
      dryRun: a.dry_run,
    })
);

tool(
  "fidelity_stage_order",
  "Set up a buy/sell for the USER to place: opens a visible Fidelity window, fills the trade ticket, clicks Preview, verifies it, and leaves it on the preview screen. The user clicks Place order (or Cancel) there; this tool never places. Stocks/ETFs take `quantity` (whole shares); mutual funds (5-letter tickers ending in X, e.g. FSKAX) take `amount` in dollars and fill at the next NAV. Tell the user the window is open.",
  {
    account_number: z.string().describe("Exact Fidelity account number"),
    symbol: z.string(),
    action: z.enum(["buy", "sell"]),
    quantity: z.number().int().positive().optional().describe("Shares, for stocks/ETFs"),
    amount: z.number().positive().optional().describe("Dollars, for mutual funds"),
    order_type: z.enum(["market", "limit"]).optional().describe("Stocks/ETFs only. Default market"),
    limit_price: z.number().positive().optional(),
  },
  async (a) => {
    if (isMutualFund(a.symbol)) {
      if (a.amount === undefined) return { success: false, message: `${a.symbol} is a mutual fund: pass amount (dollars), not quantity.` };
      return stageFundOrder({ accountNumber: a.account_number, symbol: a.symbol, action: a.action, amount: a.amount });
    }
    if (a.quantity === undefined) return { success: false, message: `${a.symbol} trades in shares: pass quantity.` };
    return stageOrder({
      accountNumber: a.account_number,
      symbol: a.symbol,
      action: a.action,
      quantity: a.quantity,
      orderType: a.order_type,
      limitPrice: a.limit_price,
    });
  }
);

tool(
  "fidelity_batch_orders",
  "Run several market/auto-limit orders one after another in one account. Dry run by default.",
  {
    account_number: z.string(),
    orders: z.array(
      z.object({
        symbol: z.string(),
        quantity: z.number().int().positive(),
        action: z.enum(["buy", "sell"]),
      })
    ),
    dry_run: dryRun,
  },
  async ({ account_number, orders, dry_run }) => placeBatchOrders(account_number, orders, dry_run)
);

tool(
  "fidelity_transfer",
  "Move cash between two of the user's Fidelity accounts. Has no dry run: it submits immediately, so only call after the user confirmed from, to and amount.",
  {
    from_account: z.string(),
    to_account: z.string(),
    amount: z.number().positive().describe("Dollars"),
  },
  async ({ from_account, to_account, amount }) => transfer(from_account, to_account, amount)
);

tool(
  "fidelity_screenshot",
  "Screenshot the browser page, optionally after opening a Fidelity URL. For debugging selectors.",
  { url: z.string().optional() },
  async ({ url }) => {
    const page = url ? await openPage(url, 2) : await currentPage();
    const png = await page.screenshot({ fullPage: true });
    return {
      content: [
        { type: "text", text: `Screenshot of: ${page.url()}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
);

tool(
  "fidelity_page_content",
  "List the page's buttons, links, form fields and tables (id, aria-label, text), optionally after opening a Fidelity URL. For fixing selectors.",
  { url: z.string().optional() },
  async ({ url }) => {
    const page = url ? await openPage(url, 2) : await currentPage();
    const summary = await page.evaluate(() => {
      const describe = (el: Element) => {
        const id = el.id ? `#${el.id}` : "";
        const label = el.getAttribute("aria-label");
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        return `<${el.tagName.toLowerCase()}${id}>${label ? ` [${label}]` : ""} ${text}`;
      };
      const elements = [
        ...document.querySelectorAll("button, a, input, select, label, [role='button'], [role='menuitem'], [role='tab']"),
      ]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .slice(0, 150)
        .map(describe);
      const tables = [...document.querySelectorAll("table, [role='table'], [role='grid']")].map((t, i) => {
        const headers = [...t.querySelectorAll("th, [role='columnheader']")]
          .map((h) => (h.textContent ?? "").trim())
          .filter(Boolean);
        return `Table ${i}: ${headers.join(" | ")} (${t.querySelectorAll("tr, [role='row']").length} rows)`;
      });
      return { elements, tables };
    });
    return {
      content: [
        {
          type: "text",
          text: [`URL: ${page.url()}`, `Title: ${await page.title()}`, "", "=== Elements ===", ...summary.elements, "", "=== Tables ===", ...summary.tables].join("\n"),
        },
      ],
    };
  }
);

await server.connect(new StdioServerTransport());
