#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { getAccountList, transfer } from "./accounts.js";
import { getPositions } from "./positions.js";
import { rebalancePlan } from "./rebalance.js";
import { closeSession, currentPage, login, openPage, status } from "./session.js";
import {
  getQuote,
  placeBatchOrders,
  placeFundOrder,
  placeOrder,
  routeOrder,
  stageFundOrder,
  stageOrder,
} from "./trading.js";

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
  "Get holdings for every account from Fidelity's positions CSV: ticker, quantity, price, value, cost basis and total gain/loss (when Fidelity shows them), and cash balance (`balance`).",
  {},
  async () => getPositions()
);

tool(
  "fidelity_get_quote",
  "Get the last price (and extended-hours price when available) for a stock/ETF from the trade ticket.",
  { symbol: z.string().describe("Ticker, e.g. AAPL") },
  async ({ symbol }) => getQuote(symbol)
);

// Order fields shared by place and stage. Stocks/ETFs take `quantity`; mutual
// funds (5-letter tickers ending in X, e.g. FSKAX) take `amount` (see routeOrder).
const orderFields = {
  account_number: z.string().describe("Exact Fidelity account number"),
  symbol: z.string(),
  action: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive().optional().describe("Shares, for stocks/ETFs"),
  amount: z.number().positive().optional().describe("Dollars, for mutual funds"),
  order_type: z.enum(["market", "limit"]).optional().describe("Stocks/ETFs only. Default market"),
  limit_price: z.number().positive().optional().describe("Stocks/ETFs only"),
};

function routeOrderArgs(a: z.objectOutputType<typeof orderFields, z.ZodTypeAny>) {
  return routeOrder({
    accountNumber: a.account_number,
    symbol: a.symbol,
    action: a.action,
    quantity: a.quantity,
    amount: a.amount,
    orderType: a.order_type,
    limitPrice: a.limit_price,
  });
}

tool(
  "fidelity_place_order",
  "Buy or sell a stock/ETF by shares, or a mutual fund by dollar amount (fills at the next NAV). Dry run by default (preview only). Penny stocks (< $1) and extended hours always use limit orders; without limit_price the limit is one tick past the last price. The result shows the exact order (including limit price) for the user to confirm.",
  { ...orderFields, dry_run: dryRun },
  async (a) => {
    const routed = routeOrderArgs(a);
    if (routed.kind === "error") return { success: false, message: routed.message };
    return routed.kind === "fund"
      ? placeFundOrder({ ...routed.order, dryRun: a.dry_run })
      : placeOrder({ ...routed.order, dryRun: a.dry_run });
  }
);

tool(
  "fidelity_stage_order",
  "Set up a buy/sell for the USER to place: opens a visible Fidelity window, fills the trade ticket, clicks Preview, verifies it, and leaves it on the preview screen. The user clicks Place order (or Cancel) there; this tool never places. Stocks/ETFs take `quantity` (whole shares); mutual funds (5-letter tickers ending in X, e.g. FSKAX) take `amount` in dollars and fill at the next NAV. Tell the user the window is open.",
  orderFields,
  async (a) => {
    const routed = routeOrderArgs(a);
    if (routed.kind === "error") return { success: false, message: routed.message };
    return routed.kind === "fund" ? stageFundOrder(routed.order) : stageOrder(routed.order);
  }
);

tool(
  "fidelity_batch_orders",
  "Run several stock/ETF market/auto-limit orders one after another in one account. Dry run by default. Mutual funds are rejected: use fidelity_place_order with an amount. Orders don't wait for each other to fill.",
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
  "fidelity_rebalance_plan",
  "Plan the trades that move one account to target weights (percent of total account value; whatever the weights don't cover stays cash). Plans only, never trades. Every non-cash holding must be listed (weight 0 to sell it). Returns stock `orders` (sells first) for fidelity_batch_orders and mutual fund `fundOrders` for fidelity_place_order; run those as dry runs and show the user before placing anything.",
  {
    account_number: z.string().describe("Exact Fidelity account number"),
    targets: z
      .array(z.object({ symbol: z.string(), weight: z.number().min(0).max(100).describe("Percent of account value") }))
      .min(1),
    min_trade: z.number().min(0).optional().describe("Skip trades smaller than this many dollars. Default 1"),
  },
  async ({ account_number, targets, min_trade }) => rebalancePlan(account_number, targets, min_trade)
);

tool(
  "fidelity_transfer",
  "Move cash between two of the user's Fidelity accounts. Dry run by default: fills the form and stops on Fidelity's review step, returning its text in `review`. Show the user that review; set dry_run false only after they confirmed from, to and amount.",
  {
    from_account: z.string(),
    to_account: z.string(),
    amount: z.number().positive().describe("Dollars"),
    dry_run: z
      .boolean()
      .optional()
      .default(true)
      .describe("true (default): stop on the review step, never submit. false: submit the transfer. Only set false after the user confirmed from, to and amount."),
  },
  async ({ from_account, to_account, amount, dry_run }) => transfer(from_account, to_account, amount, dry_run)
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
