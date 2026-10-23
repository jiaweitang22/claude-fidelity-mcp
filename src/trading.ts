import type { Locator, Page } from "playwright";
import { findAccountOption } from "./accounts.js";
import { appears, openPage, openVisiblePage, waitForLoading } from "./session.js";
import type { OrderAction, OrderRequest, OrderResult, OrderType, QuoteResult } from "./types.js";

const TRADE_URL = "https://digital.fidelity.com/ftgw/digital/trade-equity/index/orderEntry";

// Always force-navigate for a clean ticket: after an order the URL still
// says trade-equity but the DOM is the confirmation page.
async function openTicket(): Promise<Page> {
  return openPage(TRADE_URL);
}

async function selectAccount(page: Page, accountNumber: string): Promise<boolean> {
  await page.locator("#dest-acct-dropdown").click({ timeout: 10000 });
  const options = page.locator("button[role='option']");
  await options.first().waitFor({ state: "visible", timeout: 5000 });
  const match = await findAccountOption(await options.all(), accountNumber);
  if (!match) return false;
  await match.option.click();
  await page.waitForTimeout(2000);
  return true;
}

async function enterSymbol(page: Page, symbol: string): Promise<void> {
  const input = page.getByLabel("Symbol", { exact: true });
  await input.fill(symbol);
  await input.press("Enter");
  await page.waitForSelector("#quote-panel", { timeout: 15000 });
  await waitForLoading(page);
  // Dismiss the autocomplete dropdown
  await page.locator("#quote-panel").click();
  await page.waitForTimeout(500);
}

async function readPrice(page: Page): Promise<{ price: number; isExtendedHours: boolean }> {
  const text = await page.locator("#eq-ticket__last-price > span.last-price").textContent({ timeout: 10000 });
  const price = parseFloat((text ?? "").replace(/[$,]/g, ""));
  if (isNaN(price)) throw new Error(`Could not read price: ${text}`);
  const toggle = await page
    .locator(".eq-ticket__extendedhour-toggle")
    .getAttribute("class", { timeout: 2000 })
    .catch(() => null);
  return { price, isExtendedHours: toggle?.includes("pvd-switch--on") ?? false };
}

// Turns on extended hours when the ticket offers it. Returns whether it is on.
async function enableExtendedHours(page: Page): Promise<boolean> {
  const toggle = page.locator("#eq-ticket_extendedhour");
  if (!(await appears(toggle, 2000))) return false;
  const classes = (await page.locator(".eq-ticket__extendedhour-toggle").getAttribute("class")) ?? "";
  if (!classes.includes("pvd-switch--on")) {
    await toggle.click();
    await page.waitForTimeout(2000);
  }
  return true;
}

export async function getQuote(symbol: string): Promise<QuoteResult> {
  const page = await openTicket();
  await enterSymbol(page, symbol);
  const { price, isExtendedHours } = await readPrice(page);
  const result: QuoteResult = { symbol: symbol.toUpperCase(), lastPrice: price, isExtendedHours };
  if (!isExtendedHours && (await enableExtendedHours(page))) {
    result.extendedHoursPrice = (await readPrice(page)).price;
  }
  return result;
}

// Order type policy. Penny stocks (< $1) and extended hours must be limit
// orders; without an explicit limit price, price one tick past the last trade.
export function resolveOrderType(
  action: OrderAction,
  price: number,
  isExtendedHours: boolean,
  requested?: { orderType?: OrderType; limitPrice?: number }
): { orderType: OrderType; limitPrice?: number; precision: number } {
  // Sub-penny limit prices are only accepted below $1
  const precision = price < 1 ? 4 : 2;
  const mustLimit = price < 1 || isExtendedHours;
  if (!mustLimit && requested?.orderType !== "limit" && requested?.limitPrice === undefined) {
    return { orderType: "market", precision };
  }
  if (requested?.limitPrice !== undefined) {
    return { orderType: "limit", limitPrice: requested.limitPrice, precision };
  }
  const tick = price < 0.1 ? 0.0001 : 0.01;
  const limit = action === "buy" ? price + tick : price - tick;
  return { orderType: "limit", limitPrice: parseFloat(limit.toFixed(precision)), precision };
}

async function selectAction(page: Page, action: OrderAction): Promise<boolean> {
  const name = action === "buy" ? "Buy" : "Sell";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.locator("#dest-dropdownlist-button-action").click({ timeout: 3000 });
      await page.locator(`[role='option']:has-text("${name}")`).first().click({ timeout: 3000 });
      return true;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  return false;
}

// Fidelity reports preview errors in a dialog, e.g. "Insufficient funds
// (313012) The Estimated Order Value ... exceeds your Cash Available to Trade."
async function previewError(page: Page): Promise<string> {
  for (const locator of [page.locator("[role='dialog']:visible, .pvd-modal:visible"), page.locator(".pvd-inline-alert__content")]) {
    const text = await locator.first().innerText({ timeout: 1000 }).catch(() => null);
    const clean = text?.replace(/Close dialog|Add funds|Edit order/g, "").replace(/\s+/g, " ").trim();
    if (clean) return `Order preview rejected: ${clean.slice(0, 400)}`;
  }
  return "Order preview failed.";
}

// Parses the preview block from the page text: a "Preview order" heading,
// label/value rows ("Account  ROTH IRA (123456789)", "Symbol  VT", "Amount
// $0.46", ...), an estimated value on the line after its label, then the
// "Place order" button. Same shape on the stock and mutual-fund tickets.
// Reading text keeps the check independent of class names.
export function readPreview(pageText: string) {
  const end = pageText.indexOf("Place order");
  const start = pageText.slice(0, Math.max(end, 0)).toLowerCase().lastIndexOf("preview order");
  if (start < 0 || end < 0) return null;
  const section = pageText.slice(start, end);
  const field = (label: string) =>
    section.match(new RegExp(`^${label}[\\t ]*\\n?[\\t ]*(\\S.*)$`, "m"))?.[1].trim();
  return {
    account: field("Account"),
    symbol: field("Symbol"),
    action: field("Action"),
    quantity: field("Quantity"),
    orderType: field("Order type"),
    limitPrice: field("Limit price"),
    amount: field("Amount"),
    estimatedValue: section.match(/Estimated (?:order )?value[^\n]*\n+\s*(\$[\d,.]+)/)?.[1],
  };
}

type Filled =
  | { ok: false; result: OrderResult }
  | { ok: true; summary: string; orderDetails: NonNullable<OrderResult["orderDetails"]>; placeButton: Locator };

// Fills the trade ticket on `page`, clicks Preview, and checks the preview
// against the request. Stops on the preview screen; never places.
async function fillAndPreview(page: Page, order: OrderRequest): Promise<Filled> {
  const fail = (message: string): Filled => ({ ok: false, result: { success: false, message } });
  const symbol = order.symbol.toUpperCase();
  if (!(await selectAccount(page, order.accountNumber))) {
    return fail(`Account ${order.accountNumber} not found on the trade ticket.`);
  }
  await enterSymbol(page, symbol);

  const expand = page.getByRole("button", { name: "View expanded ticket" });
  if (await appears(expand, 2000)) {
    await expand.click();
    await page.waitForTimeout(1000);
  }

  let { price, isExtendedHours } = await readPrice(page);
  if (!isExtendedHours && (await enableExtendedHours(page))) {
    ({ price, isExtendedHours } = await readPrice(page));
  }

  if (!(await selectAction(page, order.action))) {
    return fail("Could not select buy/sell on the trade ticket.");
  }

  await page.locator("#eqt-mts-stock-quatity div").filter({ hasText: "Quantity" }).click();
  await page
    .locator("#eqt-mts-stock-quatity input, #eqt-mts-stock-quatity [role='spinbutton']")
    .fill(order.quantity.toString());

  const resolved = resolveOrderType(order.action, price, isExtendedHours, order);
  if (resolved.orderType === "limit") {
    await page.locator("#dest-dropdownlist-button-ordertype > span:nth-child(1)").click({ timeout: 5000 });
    await page.getByRole("option", { name: "Limit", exact: true }).click({ timeout: 3000 });
    await page.getByLabel("Limit price").fill(resolved.limitPrice!.toFixed(resolved.precision));
  } else {
    await page.locator("#order-type-container-id").click({ timeout: 5000 });
    await page.getByRole("option", { name: "Market", exact: true }).click({ timeout: 3000 });
  }

  await page.getByRole("button", { name: "Preview order" }).click();
  await waitForLoading(page);
  const placeButton = page.getByRole("button", { name: "Place order" });
  if (!(await appears(placeButton, 15000))) {
    return fail(await previewError(page));
  }

  // Fail closed: if the preview can't be read or doesn't match the request,
  // don't report success and never place.
  const preview = readPreview(await page.locator("body").innerText());
  const mismatch = !preview
    ? "could not read the order preview"
    : !preview.account?.includes(`(${order.accountNumber})`)
      ? `preview account is ${preview.account}`
      : preview.symbol?.toUpperCase() !== symbol
        ? `preview symbol is ${preview.symbol}`
        : preview.action?.toLowerCase() !== order.action
          ? `preview action is ${preview.action}`
          : parseFloat(preview.quantity ?? "") !== order.quantity
            ? `preview quantity is ${preview.quantity}`
            : null;
  if (mismatch) return fail(`Aborted: ${mismatch}.`);

  const orderDetails = {
    estimatedValue: preview!.estimatedValue,
    account: order.accountNumber,
    symbol,
    action: order.action,
    quantity: order.quantity,
    price,
    orderType: resolved.orderType,
    limitPrice: resolved.limitPrice,
    extendedHours: isExtendedHours,
  };
  const summary = `${order.action.toUpperCase()} ${order.quantity} ${symbol} @ ${
    resolved.orderType === "limit" ? `$${resolved.limitPrice!.toFixed(resolved.precision)} limit` : "market"
  } in ${order.accountNumber}`;
  return { ok: true, summary, orderDetails, placeButton };
}

export async function placeOrder(order: OrderRequest): Promise<OrderResult> {
  const page = await openTicket();
  const filled = await fillAndPreview(page, order);
  if (!filled.ok) return filled.result;
  const { summary, orderDetails, placeButton } = filled;
  if (order.dryRun !== false) {
    return { success: true, message: `Dry run: previewed, not placed. ${summary}.`, orderDetails };
  }

  await placeButton.click();
  await waitForLoading(page);
  const confirmed = await page
    .getByText("Order received", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true, () => false);
  return confirmed
    ? { success: true, message: `Order placed: ${summary}.`, orderDetails }
    : { success: false, message: "Order may not have been confirmed. Check Fidelity directly before retrying." };
}

// Fills and previews the order in a visible Fidelity window and leaves it on
// the preview screen for the user to click "Place order" (or Cancel) themselves.
export async function stageOrder(order: OrderRequest): Promise<OrderResult> {
  const page = await openVisiblePage(TRADE_URL);
  const filled = await fillAndPreview(page, order);
  if (!filled.ok) return filled.result;
  await page.bringToFront();
  await filled.placeButton.scrollIntoViewIfNeeded();
  return {
    success: true,
    message: `Staged, not placed: ${filled.summary}. The preview is open in the Fidelity window ("Nightly"); the user reviews it and clicks Place order or Cancel there.`,
    orderDetails: filled.orderDetails,
  };
}

const MF_TRADE_URL =
  "https://digital.fidelity.com/ftgw/digital/trade-mutualfund?ORDER_TYPE=M&CURRENT_PAGE=TradeMF&DEST_TRADE=Y";

// Mutual fund tickers are five letters ending in X (FSKAX, FXAIX).
export function isMutualFund(symbol: string): boolean {
  return /^[A-Z]{4}X$/.test(symbol.toUpperCase());
}

export interface FundOrder {
  accountNumber: string;
  symbol: string;
  action: OrderAction;
  amount: number; // dollars
}

// Fills the mutual-fund ticket (bought and sold by dollar amount), clicks
// Preview, and checks the preview against the request. Stops on the preview.
async function fillFundAndPreview(page: Page, order: FundOrder): Promise<Filled> {
  const fail = (message: string): Filled => ({ ok: false, result: { success: false, message } });
  const symbol = order.symbol.toUpperCase();
  const dropdown = (label: string) => page.locator("#mf-dropdownlist-button").filter({ hasText: label });

  await dropdown("Account").click({ timeout: 10000 });
  const options = page.locator("[role='option']");
  await options.first().waitFor({ state: "visible", timeout: 5000 });
  const match = await findAccountOption(await options.all(), order.accountNumber);
  if (!match) return fail(`Account ${order.accountNumber} not found on the mutual fund ticket.`);
  await match.option.click();
  await page.waitForTimeout(2000);

  const input = page.locator("#mf-ticket-dest-symbol-Symbol");
  await input.fill(symbol);
  await input.press("Enter");
  await waitForLoading(page);
  await page.waitForTimeout(2000);

  await dropdown("Action").click({ timeout: 10000 });
  await page.getByRole("option", { name: order.action === "buy" ? "Buy" : "Sell", exact: true }).click({ timeout: 5000 });
  const amount = page.locator("#mf-shared-quantity");
  await amount.waitFor({ state: "visible", timeout: 10000 });
  await amount.fill(order.amount.toFixed(2));
  await amount.press("Tab");

  await page.getByRole("button", { name: "Preview order" }).click();
  await waitForLoading(page);
  const placeButton = page.getByRole("button", { name: "Place order" });
  if (!(await appears(placeButton, 15000))) return fail(await previewError(page));

  const preview = readPreview(await page.locator("body").innerText());
  const mismatch = !preview
    ? "could not read the order preview"
    : !preview.account?.includes(`(${order.accountNumber})`)
      ? `preview account is ${preview.account}`
      : preview.symbol?.toUpperCase() !== symbol
        ? `preview symbol is ${preview.symbol}`
        : preview.action?.toLowerCase() !== order.action
          ? `preview action is ${preview.action}`
          : parseFloat((preview.amount ?? "").replace(/[$,]/g, "")) !== parseFloat(order.amount.toFixed(2))
            ? `preview amount is ${preview.amount}`
            : null;
  if (mismatch) return fail(`Aborted: ${mismatch}.`);

  const summary = `${order.action.toUpperCase()} $${order.amount.toFixed(2)} of ${symbol} at the next NAV in ${order.accountNumber}`;
  return {
    ok: true,
    summary,
    placeButton,
    orderDetails: {
      estimatedValue: preview!.estimatedValue,
      account: order.accountNumber,
      symbol,
      action: order.action,
      amount: order.amount,
      orderType: "market",
      extendedHours: false,
    },
  };
}

// Same as stageOrder, for a mutual fund bought or sold by dollar amount.
export async function stageFundOrder(order: FundOrder): Promise<OrderResult> {
  const page = await openVisiblePage(MF_TRADE_URL);
  const filled = await fillFundAndPreview(page, order);
  if (!filled.ok) return filled.result;
  await page.bringToFront();
  await filled.placeButton.scrollIntoViewIfNeeded();
  return {
    success: true,
    message: `Staged, not placed: ${filled.summary}. The preview is open in the Fidelity window ("Nightly"); the user reviews it and clicks Place order or Cancel there.`,
    orderDetails: filled.orderDetails,
  };
}

export interface BatchOrder {
  symbol: string;
  quantity: number;
  action: OrderAction;
}

export async function placeBatchOrders(accountNumber: string, orders: BatchOrder[], dryRun: boolean) {
  const results: { symbol: string; quantity: number; success: boolean; message: string }[] = [];
  for (const o of orders) {
    const r = await placeOrder({ accountNumber, ...o, dryRun }).catch(
      (e): OrderResult => ({ success: false, message: e instanceof Error ? e.message : String(e) })
    );
    results.push({ symbol: o.symbol, quantity: o.quantity, success: r.success, message: r.message });
  }
  const succeeded = results.filter((r) => r.success).length;
  return { results, succeeded, failed: results.length - succeeded };
}
