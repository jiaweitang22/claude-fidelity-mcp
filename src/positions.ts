import * as fs from "fs";
import { parse } from "csv-parse/sync";
import type { Page } from "playwright";
import { openPage } from "./session.js";
import type { Account } from "./types.js";

const POSITIONS_URL = "https://digital.fidelity.com/ftgw/digital/portfolio/positions";
const CASH_TICKERS = new Set(["SPAXX", "FCASH", "FDRXX", "FZFXX", "CORE"]);

export function isCashTicker(symbol: string): boolean {
  return CASH_TICKERS.has(symbol.toUpperCase());
}

// Positions come from the page's "Available Actions → Download" CSV, the
// format Fidelity keeps stable across UI redesigns.
export async function getPositions(): Promise<Account[]> {
  const page = await openPage(POSITIONS_URL, 2);
  return parsePositionsCsv(await downloadCsv(page));
}

async function downloadCsv(page: Page): Promise<string> {
  const download = page.waitForEvent("download", { timeout: 20000 });
  download.catch(() => {}); // Rejection handled below if the clicks fail
  await page.getByRole("button", { name: "Available Actions" }).click({ timeout: 10000 });
  await page.locator("#kebabmenuitem-download").click({ timeout: 5000 });
  const file = await (await download).path();
  const csv = fs.readFileSync(file, "utf-8");
  fs.rmSync(file, { force: true });
  return csv;
}

function toNumber(s: string | undefined): number {
  return toOptionalNumber(s) ?? 0;
}

// For columns where "no figure" (blank, "--", "n/a") must not read as 0.
function toOptionalNumber(s: string | undefined): number | undefined {
  const n = parseFloat((s ?? "").replace(/[$,%+]/g, "").trim());
  return isNaN(n) ? undefined : n;
}

// Builds accounts from the positions CSV. Column names are matched
// case-insensitively (Fidelity has renamed "Account Number" → "Account number").
// Footer disclaimer rows have no symbol and are skipped.
export function parsePositionsCsv(csv: string): Account[] {
  const records: Record<string, string>[] = parse(csv.replace(/^﻿/, ""), {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const accounts = new Map<string, Account>();
  for (const r of records) {
    const accountNumber = (r["account number"] ?? "").trim();
    // Fidelity marks the core position "SPAXX**"
    const ticker = (r["symbol"] ?? "").replace(/\*+$/, "").trim().toUpperCase();
    if (!accountNumber || !ticker || ticker === "PENDING ACTIVITY") continue;

    let account = accounts.get(accountNumber);
    if (!account) {
      const name = (r["account name"] ?? "").trim();
      account = { accountNumber, accountName: name, nickname: name, balance: 0, withdrawalBalance: 0, stocks: [] };
      accounts.set(accountNumber, account);
    }

    const description = (r["description"] ?? "").trim();
    const currentValue = toNumber(r["current value"]);
    const isCash = CASH_TICKERS.has(ticker) || /\bcash\b|money market/i.test(description);
    if (isCash) {
      account.balance += currentValue;
      account.withdrawalBalance += currentValue;
    }
    account.stocks.push({
      ticker,
      description,
      quantity: isCash && !r["quantity"]?.trim() ? currentValue : toNumber(r["quantity"]),
      lastPrice: toNumber(r["last price"]),
      lastPriceChange: toNumber(r["last price change"]),
      currentValue,
      isCash,
      costBasis: toOptionalNumber(r["cost basis total"]),
      averageCost: toOptionalNumber(r["average cost basis"]),
      totalGainLoss: toOptionalNumber(r["total gain/loss dollar"]),
      totalGainLossPercent: toOptionalNumber(r["total gain/loss percent"]),
    });
  }
  return [...accounts.values()];
}
