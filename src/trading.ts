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

// Opens a ticket's account dropdown and picks the exact account number.
async function selectAccount(
  page: Page,
  dropdown: Locator,
  options: Locator,
  accountNumber: string
): Promise<boolean> {
  await dropdown.click({ timeout: 10000 });
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

type Preview = NonNullable<ReturnType<typeof readPreview>>;

// Returns how the preview differs from the request, or null when it matches.
// Fail closed: an unreadable preview counts as a mismatch.
export function previewMismatch(preview: Preview | null, order: OrderRequest | FundOrder): string | null {
  if (!preview) return "could not read the order preview";
  if (!preview.account?.includes(`(${order.accountNumber})`)) return `preview account is ${preview.account}`;
  if (preview.symbol?.toUpperCase() !== order.symbol.toUpperCase()) return `preview symbol is ${preview.symbol}`;
  if (preview.action?.toLowerCase() !== order.action) return `preview action is ${preview.action}`;
  if ("amount" in order) {
    const shown = parseFloat((preview.amount ?? "").replace(/[$,]/g, ""));
    if (shown !== parseFloat(order.amount.toFixed(2))) return `preview amount is ${preview.amount}`;
  } else if (parseFloat(preview.quantity ?? "") !== order.quantity) {
    return `preview quantity is ${preview.quantity}`;
  }
  return null;
}

type Failed = { ok: false; result: OrderResult };
type Filled =
  | Failed
  | { ok: true; summary: string; orderDetails: NonNullable<OrderResult["orderDetails"]>; placeButton: Locator };

function fail(message: string): Failed {
  return { ok: false, result: { success: false, message } };
}

// Clicks Preview on a filled ticket and checks the preview against the
// request. Stops on the preview screen; never places.
async function previewAndVerify(
  page: Page,
  order: OrderRequest | FundOrder
): Promise<Failed | { ok: true; estimatedValue?: string; placeButton: Locator }> {
  await page.getByRole("button", { name: "Preview order" }).click();
  await waitForLoading(page);
  const placeButton = page.getByRole("button", { name: "Place order" });
  if (!(await appears(placeButton, 15000))) return fail(await previewError(page));

  const preview = readPreview(await page.locator("body").innerText());
  const mismatch = previewMismatch(preview, order);
  if (mismatch) return fail(`Aborted: ${mismatch}.`);
  return { ok: true, estimatedValue: preview!.estimatedValue, placeButton };
}

// Fills the trade ticket on `page` and previews it (see previewAndVerify).
async function fillAndPreview(page: Page, order: OrderRequest): Promise<Filled> {
  const symbol = order.symbol.toUpperCase();
  if (!(await selectAccount(page, page.locator("#dest-acct-dropdown"), page.locator("button[role='option']"), order.accountNumber))) {
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

  const verified = await previewAndVerify(page, order);
  if (!verified.ok) return verified;

  const orderDetails = {
    estimatedValue: verified.estimatedValue,
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
  return { ok: true, summary, orderDetails, placeButton: verified.placeButton };
}

export async function placeOrder(order: OrderRequest): Promise<OrderResult> {
  const page = await openTicket();
  return placeAfterPreview(page, await fillAndPreview(page, order), order.dryRun);
}

// Clicks "Place order" on a verified preview, unless this is a dry run.
async function placeAfterPreview(page: Page, filled: Filled, dryRun: boolean | undefined): Promise<OrderResult> {
  if (!filled.ok) return filled.result;
  const { summary, orderDetails, placeButton } = filled;
  if (dryRun !== false) {
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

// Leaves a verified preview in the visible window for the user to click
// "Place order" (or Cancel) themselves.
async function leaveStaged(page: Page, filled: Filled): Promise<OrderResult> {
  if (!filled.ok) return filled.result;
  await page.bringToFront();
  await filled.placeButton.scrollIntoViewIfNeeded();
  return {
    success: true,
    message: `Staged, not placed: ${filled.summary}. The preview is open in the Fidelity window ("Nightly"); the user reviews it and clicks Place order or Cancel there.`,
    orderDetails: filled.orderDetails,
  };
}

// Fills and previews the order in a visible Fidelity window and stops there.
export async function stageOrder(order: OrderRequest): Promise<OrderResult> {
  const page = await openVisiblePage(TRADE_URL);
  return leaveStaged(page, await fillAndPreview(page, order));
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
  dryRun?: boolean;
}

export type OrderInput = Omit<OrderRequest, "quantity" | "dryRun"> & { quantity?: number; amount?: number };

// Mutual funds trade by dollar amount at the next NAV; stocks/ETFs by whole
// shares. Fields that don't apply are rejected, not ignored: a dropped limit
// price would fill a fund at NAV when the user meant a limit.
export function routeOrder(
  input: OrderInput
): { kind: "stock"; order: OrderRequest } | { kind: "fund"; order: FundOrder } | { kind: "error"; message: string } {
  const { quantity, amount, orderType, limitPrice, ...base } = input;
  const error = (message: string) => ({ kind: "error" as const, message });
  if (quantity !== undefined && amount !== undefined) {
    return error("Pass quantity (shares) or amount (dollars), not both.");
  }
  if (isMutualFund(base.symbol)) {
    if (amount === undefined) return error(`${base.symbol} is a mutual fund: pass amount (dollars), not quantity.`);
    if (orderType === "limit" || limitPrice !== undefined) {
      return error(`${base.symbol} is a mutual fund: it fills at the next NAV, so limit orders don't apply.`);
    }
    return { kind: "fund", order: { ...base, amount } };
  }
  if (quantity === undefined) return error(`${base.symbol} trades in shares: pass quantity.`);
  return { kind: "stock", order: { ...base, quantity, orderType, limitPrice } };
}

// Fills the mutual-fund ticket (bought and sold by dollar amount) and previews
// it (see previewAndVerify).
async function fillFundAndPreview(page: Page, order: FundOrder): Promise<Filled> {
  const symbol = order.symbol.toUpperCase();
  const dropdown = (label: string) => page.locator("#mf-dropdownlist-button").filter({ hasText: label });

  if (!(await selectAccount(page, dropdown("Account"), page.locator("[role='option']"), order.accountNumber))) {
    return fail(`Account ${order.accountNumber} not found on the mutual fund ticket.`);
  }

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

  const verified = await previewAndVerify(page, order);
  if (!verified.ok) return verified;

  const summary = `${order.action.toUpperCase()} $${order.amount.toFixed(2)} of ${symbol} at the next NAV in ${order.accountNumber}`;
  return {
    ok: true,
    summary,
    placeButton: verified.placeButton,
    orderDetails: {
      estimatedValue: verified.estimatedValue,
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
  return leaveStaged(page, await fillFundAndPreview(page, order));
}

// Same as placeOrder, for a mutual fund bought or sold by dollar amount.
export async function placeFundOrder(order: FundOrder): Promise<OrderResult> {
  const page = await openPage(MF_TRADE_URL);
  return placeAfterPreview(page, await fillFundAndPreview(page, order), order.dryRun);
}

export interface BatchOrder {
  symbol: string;
  quantity: number;
  action: OrderAction;
}

export async function placeBatchOrders(accountNumber: string, orders: BatchOrder[], dryRun: boolean) {
  const results: { symbol: string; quantity: number; success: boolean; message: string }[] = [];
  for (const o of orders) {
    if (isMutualFund(o.symbol)) {
      const message = `${o.symbol} is a mutual fund: place it with fidelity_place_order and a dollar amount.`;
      results.push({ symbol: o.symbol, quantity: o.quantity, success: false, message });
      continue;
    }
    const r = await placeOrder({ accountNumber, ...o, dryRun }).catch(
      (e): OrderResult => ({ success: false, message: e instanceof Error ? e.message : String(e) })
    );
    results.push({ symbol: o.symbol, quantity: o.quantity, success: r.success, message: r.message });
  }
  const succeeded = results.filter((r) => r.success).length;
  return { results, succeeded, failed: results.length - succeeded };
}
