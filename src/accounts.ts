import type { Locator, Page } from "playwright";
import { appears, openPage, waitForLoading } from "./session.js";

const TRANSFERS_URL =
  "https://digital.fidelity.com/ftgw/digital/transfer/?quicktransfer=cash-shares";

export interface AccountListItem {
  accountNumber: string;
  nickname: string;
}

// Fidelity accounts appear in option text as "Nickname (Z12345678)". Linked
// banks ("MY BANK (****1234)") and menu actions have no number and return null.
export function parseAccountText(text: string): AccountListItem | null {
  const number = text.match(/\(([A-Z]?\d{6,})\)/)?.[1];
  if (!number) return null;
  return { accountNumber: number, nickname: text.slice(0, text.indexOf("(")).trim() };
}

// Picks the option whose account number equals accountNumber exactly. Never
// substring-matches: one account number can contain another.
export async function findAccountOption(
  options: Locator[],
  accountNumber: string
): Promise<{ option: Locator; text: string } | null> {
  for (const option of options) {
    const text = ((await option.textContent()) ?? "").trim();
    if (parseAccountText(text)?.accountNumber === accountNumber) return { option, text };
  }
  return null;
}

async function selectAccount(page: Page, select: Locator, accountNumber: string): Promise<boolean> {
  await select.waitFor({ state: "visible", timeout: 15000 });
  const match = await findAccountOption(await select.locator("option").all(), accountNumber);
  if (!match) return false;
  await select.selectOption({ label: match.text });
  await waitForLoading(page);
  return true;
}

// Lists the Fidelity accounts the user can move money between (the transfer
// page's From list). Balances come from fidelity_get_positions.
export async function getAccountList(): Promise<AccountListItem[]> {
  const page = await openPage(TRANSFERS_URL);
  const from = page.getByLabel("From");
  await from.waitFor({ state: "visible", timeout: 15000 });
  const accounts: AccountListItem[] = [];
  for (const text of await from.locator("option").allTextContents()) {
    const account = parseAccountText(text.trim());
    if (account) accounts.push(account);
  }
  return accounts;
}

// One-time cash transfer between two Fidelity accounts. The form steps are
// From → To → amount → Continue (review) → Submit. Fidelity validates the
// amount against the available balance on the review step. A dry run stops
// on the review step and returns its text; it never clicks Submit.
export async function transfer(
  fromAccount: string,
  toAccount: string,
  amount: number,
  dryRun: boolean
): Promise<{ success: boolean; message: string; review?: string }> {
  const page = await openPage(TRANSFERS_URL);
  if (!(await selectAccount(page, page.getByLabel("From"), fromAccount))) {
    return { success: false, message: `Source account ${fromAccount} not found.` };
  }
  if (!(await selectAccount(page, page.getByLabel("To", { exact: true }), toAccount))) {
    return { success: false, message: `Destination account ${toAccount} not found.` };
  }

  await page.locator("#one-time").check({ timeout: 10000 });
  await page.locator("#transfer-amount").fill(amount.toFixed(2));
  await page.getByRole("button", { name: "Continue" }).click();
  await waitForLoading(page);

  const submit = page.getByRole("button", { name: "Submit" });
  if (!(await appears(submit, 10000))) {
    const alert = await page.locator(".pvd-inline-alert__content, [role='alert']").first().textContent({ timeout: 2000 }).catch(() => null);
    return {
      success: false,
      message: `Transfer did not reach the review step (${alert?.trim() || "no Submit button"}). Check Fidelity activity before retrying.`,
    };
  }
  if (dryRun) {
    return {
      success: true,
      message: `Dry run: reached the review step, not submitted. $${amount.toFixed(2)} from ${fromAccount} to ${toAccount}.`,
      review: await reviewText(page),
    };
  }
  await submit.click();
  await waitForLoading(page);
  const confirmed = await page
    .getByText("Request submitted")
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true, () => false);
  return confirmed
    ? { success: true, message: `Transferred $${amount.toFixed(2)} from ${fromAccount} to ${toAccount}.` }
    : { success: false, message: "Transfer may not have completed. Check Fidelity directly before retrying." };
}

// The review step's layout has not been mapped yet, so this returns the main
// content as text for the user to check against the request.
async function reviewText(page: Page): Promise<string> {
  const text = await page
    .locator("main")
    .first()
    .innerText({ timeout: 2000 })
    .catch(() => page.locator("body").innerText());
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}
