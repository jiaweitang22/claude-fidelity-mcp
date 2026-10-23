import { getPositions, isCashTicker } from "./positions.js";
import { getQuote, isMutualFund } from "./trading.js";
import type { Account, OrderAction } from "./types.js";

export interface Target {
  symbol: string;
  weight: number; // percent of the account's total value
}

interface Holding {
  symbol: string;
  quantity: number;
  currentValue: number;
  lastPrice: number;
}

type Failure = { success: false; message: string };

export interface RebalancePlan {
  accountNumber: string;
  totalValue: number;
  cash: { current: number; target: number; afterTrades: number };
  holdings: {
    symbol: string;
    currentValue: number;
    currentPercent: number;
    targetPercent: number;
    targetValue: number;
    difference: number;
  }[];
  orders: { symbol: string; action: OrderAction; quantity: number; estimatedValue: number }[];
  fundOrders: { symbol: string; action: OrderAction; amount: number }[];
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Non-cash positions by symbol. Fidelity can list one symbol on several rows
// (e.g. cash and margin lots), so they are summed.
function holdingsOf(account: Account): Map<string, Holding> {
  const holdings = new Map<string, Holding>();
  for (const s of account.stocks) {
    if (s.isCash) continue;
    const h = holdings.get(s.ticker) ?? { symbol: s.ticker, quantity: 0, currentValue: 0, lastPrice: 0 };
    h.quantity += s.quantity;
    h.currentValue += s.currentValue;
    h.lastPrice ||= s.lastPrice;
    holdings.set(s.ticker, h);
  }
  return holdings;
}

// Rejects targets that can't make a safe plan. Every non-cash holding needs an
// explicit weight (0 to sell it), so a partial list never liquidates the rest.
export function checkTargets(account: Account, targets: Target[]): string | null {
  const symbols = targets.map((t) => t.symbol.trim().toUpperCase());
  const duplicate = symbols.find((s, i) => symbols.indexOf(s) !== i);
  if (duplicate) return `${duplicate} is listed twice.`;
  const cashHeld = new Set(account.stocks.filter((s) => s.isCash).map((s) => s.ticker));
  const cash = symbols.find((s) => isCashTicker(s) || cashHeld.has(s));
  if (cash) return `${cash} is the cash position: leave it out; cash is whatever the weights don't cover.`;
  const total = targets.reduce((sum, t) => sum + t.weight, 0);
  if (total > 100 + 1e-9) return `Weights add up to ${total}%, more than 100%.`;
  const unlisted = [...holdingsOf(account).keys()].filter((s) => !symbols.includes(s));
  if (unlisted.length) {
    return `Account holds ${unlisted.join(", ")} but the targets don't mention ${unlisted.length > 1 ? "them" : "it"}. Give each a weight (0 to sell it all).`;
  }
  return null;
}

// Computes the trades that move `account` toward `targets` at the prices in
// the positions CSV (or `quotes` for stocks not held yet). Plans only; places
// nothing. Share counts are whole: buys round down and sells round up (capped
// at whole shares held), so the plan never spends more cash than it has.
export function planRebalance(
  account: Account,
  targets: Target[],
  quotes: Map<string, number> = new Map(),
  minTrade = 1
): RebalancePlan | Failure {
  const problem = checkTargets(account, targets);
  if (problem) return { success: false, message: problem };

  const holdings = holdingsOf(account);
  const totalValue = account.stocks.reduce((sum, s) => sum + s.currentValue, 0);
  if (totalValue <= 0) return { success: false, message: `Account ${account.accountNumber} has no value to rebalance.` };
  const plan: RebalancePlan = {
    accountNumber: account.accountNumber,
    totalValue: round2(totalValue),
    cash: { current: round2(account.balance), target: 0, afterTrades: 0 },
    holdings: [],
    orders: [],
    fundOrders: [],
    notes: [
      "Estimates at the last price from the positions download; actual fills will differ.",
      "Run sells before buys. fidelity_batch_orders doesn't wait for fills, so buys can fail for insufficient funds if the sells haven't filled (e.g. outside market hours).",
    ],
  };

  let cashAfter = account.balance;
  const buys: RebalancePlan["orders"] = [];
  for (const t of targets) {
    const symbol = t.symbol.trim().toUpperCase();
    const held = holdings.get(symbol);
    const currentValue = held?.currentValue ?? 0;
    const targetValue = (totalValue * t.weight) / 100;
    const difference = targetValue - currentValue;
    plan.holdings.push({
      symbol,
      currentValue: round2(currentValue),
      currentPercent: round2((currentValue / totalValue) * 100),
      targetPercent: t.weight,
      targetValue: round2(targetValue),
      difference: round2(difference),
    });
    if (!held && t.weight === 0) continue; // Nothing to buy or sell
    const action: OrderAction = difference > 0 ? "buy" : "sell";
    // A full sell the plan can't express shouldn't vanish silently
    const noOrderNote = `${symbol}: no order (under min_trade or less than one share), so it isn't fully sold; sell the rest on Fidelity's site.`;

    if (isMutualFund(symbol)) {
      const amount = round2(action === "buy" ? difference : Math.min(-difference, currentValue));
      if (amount >= minTrade) {
        plan.fundOrders.push({ symbol, action, amount });
        cashAfter += action === "buy" ? -amount : amount;
        if (t.weight === 0) {
          plan.notes.push(`${symbol}: a dollar-amount sell priced at the last NAV can leave a remainder (or fall short) at the next NAV; selling all shares on Fidelity's site avoids that.`);
        }
      } else if (t.weight === 0) {
        plan.notes.push(noOrderNote);
      }
      continue;
    }

    const price = held?.lastPrice || quotes.get(symbol);
    if (!price) return { success: false, message: `No price for ${symbol}.` };
    const quantity =
      action === "buy"
        ? Math.floor(difference / price)
        : Math.min(Math.ceil(-difference / price), Math.floor(held?.quantity ?? 0));
    if (t.weight === 0 && held && !Number.isInteger(held.quantity)) {
      plan.notes.push(`${symbol}: orders are whole shares, so ${round2(held.quantity % 1)} of a share stays; sell it on Fidelity's site.`);
    }
    const estimatedValue = round2(quantity * price);
    if (quantity > 0 && estimatedValue >= minTrade) {
      (action === "buy" ? buys : plan.orders).push({ symbol, action, quantity, estimatedValue });
      cashAfter += action === "buy" ? -estimatedValue : estimatedValue;
    } else if (t.weight === 0) {
      plan.notes.push(noOrderNote);
    }
  }
  plan.orders.push(...buys);

  const targetPercent = targets.reduce((sum, t) => sum + t.weight, 0);
  plan.cash.target = round2((totalValue * (100 - targetPercent)) / 100);
  plan.cash.afterTrades = round2(cashAfter);
  if (plan.fundOrders.length) {
    plan.notes.push(
      "Fund orders fill at the next NAV (end of day), so cash from fund sells isn't there for same-day buys. Place each with fidelity_place_order (amount); fidelity_batch_orders takes stocks/ETFs only."
    );
  }
  return plan;
}

// Fetches positions (and quotes for stocks not held yet) and plans; never trades.
export async function rebalancePlan(
  accountNumber: string,
  targets: Target[],
  minTrade?: number
): Promise<RebalancePlan | Failure> {
  const account = (await getPositions()).find((a) => a.accountNumber === accountNumber);
  if (!account) return { success: false, message: `Account ${accountNumber} not found in positions.` };
  const problem = checkTargets(account, targets);
  if (problem) return { success: false, message: problem };

  const held = holdingsOf(account);
  const quotes = new Map<string, number>();
  for (const t of targets) {
    const symbol = t.symbol.trim().toUpperCase();
    if (t.weight > 0 && !held.has(symbol) && !isMutualFund(symbol)) {
      quotes.set(symbol, (await getQuote(symbol)).lastPrice);
    }
  }
  return planRebalance(account, targets, quotes, minTrade);
}
