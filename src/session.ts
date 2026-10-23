// Session module: owns the one Firefox browser, the saved session on disk and
// sign-in detection. Flows ask for an authenticated page with openPage(url);
// everything else (launch, fingerprint, persistence) stays in here.
import { firefox, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const LOGIN_URL = "https://digital.fidelity.com/prgw/digital/login/full-page";
const LOGIN_WAIT_MS = 10 * 60 * 1000;

export interface Config {
  headless: boolean;
  sessionFile: string;
  timeout: number;
}

export function loadConfig(): Config {
  const dir =
    process.env.FIDELITY_SESSION_DIR ?? path.join(os.homedir(), ".fidelity-mcp");
  const title = process.env.FIDELITY_SESSION_TITLE ?? "default";
  return {
    headless: process.env.FIDELITY_HEADLESS !== "false",
    sessionFile: path.join(dir, `fidelity_session_${title}.json`),
    timeout: parseInt(process.env.FIDELITY_TIMEOUT ?? "30000", 10),
  };
}

export class SessionExpiredError extends Error {
  constructor() {
    super(
      "Fidelity session expired or not logged in. Call fidelity_login (opens a " +
        "browser window for the user) or have the user run `npm run login`, then retry."
    );
    this.name = "SessionExpiredError";
  }
}

// Match on the pathname only: sign-in redirects carry the destination URL
// (e.g. ?AuthRedUrl=...portfolio%2Fsummary) in the query string.
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function isOnLoginPage(url: string): boolean {
  const p = pathnameOf(url);
  return p.includes("/login") || p.includes("/signin");
}

function isOnSummaryPage(url: string): boolean {
  return pathnameOf(url).includes("/portfolio/summary");
}

const config = loadConfig();
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let launching: Promise<Page> | null = null;

// Fidelity's Akamai cookies are fingerprint-bound, so every launch (server,
// login window, staging window) must use the same args, user agent and init script.
async function launchBrowser(headless: boolean) {
  fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });
  const b = await firefox.launch({
    headless,
    args: ["--disable-webgl", "--disable-software-rasterizer"],
  });
  const c = await b.newContext({
    storageState: fs.existsSync(config.sessionFile) ? config.sessionFile : undefined,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });
  const p = await c.newPage();
  p.setDefaultTimeout(config.timeout);
  await p.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  return { browser: b, context: c, page: p };
}

// Launches the shared browser all tools use.
async function launch(headless: boolean): Promise<Page> {
  ({ browser, context, page } = await launchBrowser(headless));
  return page!;
}

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // The user may have closed a visible window; don't leak its browser
  await browser?.close().catch(() => {});
  // Concurrent callers share one launch instead of starting two browsers
  launching ??= launch(config.headless).finally(() => {
    launching = null;
  });
  return launching;
}

// Only called right after a page was confirmed logged in (openPage, login),
// never on close: a rejected session must not overwrite the good one on disk.
async function save(): Promise<void> {
  if (!context || !page || page.isClosed() || isOnLoginPage(page.url())) return;
  try {
    fs.writeFileSync(config.sessionFile, JSON.stringify(await context.storageState()));
  } catch {
    // Context already closed
  }
}

const SPINNERS = [
  ".pvd-spinner__mask-inner",
  "pvd-loading-spinner",
  ".loading-spinner-mask-after",
];

// Waits for Fidelity's loading spinners to go away. Pages that render in two
// passes (positions) pass passes=2.
export async function waitForLoading(p: Page, timeoutMs = 30000, passes = 1): Promise<void> {
  for (let i = 0; i < passes; i++) {
    if (i > 0) await p.waitForTimeout(1000);
    for (const selector of SPINNERS) {
      await p
        .waitForSelector(selector, { state: "hidden", timeout: timeoutMs })
        .catch(() => {});
    }
    await p.waitForTimeout(500);
  }
}

// Waits up to timeoutMs for the element to show. (Playwright's isVisible()
// ignores its timeout and checks once.)
export function appears(locator: Locator, timeoutMs: number): Promise<boolean> {
  return locator.first().waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
}

// Navigate to an authenticated page and return it. Throws SessionExpiredError
// if Fidelity redirects to sign-in. Saves the session afterwards so rolled
// cookies survive a server restart.
export async function openPage(url: string, passes = 1): Promise<Page> {
  const p = await getPage();
  await p.goto(url, { waitUntil: "domcontentloaded" });
  if (isOnLoginPage(p.url())) throw new SessionExpiredError();
  await waitForLoading(p, config.timeout, passes);
  if (isOnLoginPage(p.url())) throw new SessionExpiredError();
  await save();
  await dismissPromos(p);
  return p;
}

// Fidelity sometimes covers a page with a promo dialog (e.g. "Take a minute
// to add a beneficiary"). Close it with its X; never click through it.
async function dismissPromos(p: Page): Promise<void> {
  const close = p.locator(".pvd-modal__close-button:visible");
  if (await close.count()) {
    await close.first().click().catch(() => {});
    await p.waitForTimeout(500);
  }
}

let staging: Browser | null = null;

// Opens an authenticated page in a separate visible window the user can act
// in, e.g. a staged order waiting for them to click "Place order". It stays
// open after the tool returns and doesn't disturb the shared headless page.
// Opening another closes the previous one. Never saves the session.
export async function openVisiblePage(url: string): Promise<Page> {
  await staging?.close().catch(() => {});
  const launched = await launchBrowser(false);
  staging = launched.browser;
  const p = launched.page;
  p.on("close", () => {
    launched.browser.close().catch(() => {});
  });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await waitForLoading(p, config.timeout);
  if (isOnLoginPage(p.url())) {
    await launched.browser.close().catch(() => {});
    throw new SessionExpiredError();
  }
  await dismissPromos(p);
  return p;
}

// The page as it is now, without navigating (for screenshots/debugging).
export async function currentPage(): Promise<Page> {
  return getPage();
}

// Closes the shared browser and any staging window.
export async function closeSession(): Promise<void> {
  await staging?.close().catch(() => {});
  await browser?.close().catch(() => {});
  staging = null;
  browser = null;
  context = null;
  page = null;
}

// Opens a visible browser on the sign-in page and waits for the user to log
// in and finish 2FA themselves. Never types credentials. On success the
// session is saved and the window closed; the next openPage() relaunches with
// the configured headless setting.
export async function login(
  onWaiting?: () => void
): Promise<{ success: boolean; message: string }> {
  await closeSession();
  const p = await launch(false);
  try {
    await p.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    onWaiting?.();
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      if (p.isClosed()) {
        return { success: false, message: "Login window was closed before login finished." };
      }
      if (isOnSummaryPage(p.url()) && !isOnLoginPage(p.url())) {
        // Let post-login cookies settle before saving
        await p.waitForTimeout(3000);
        await save();
        return { success: true, message: `Logged in. Session saved to ${config.sessionFile}.` };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { success: false, message: "Timed out after 10 minutes waiting for login." };
  } finally {
    await closeSession();
  }
}

export function status() {
  let savedAt: string | null = null;
  try {
    savedAt = fs.statSync(config.sessionFile).mtime.toISOString();
  } catch {
    // No saved session
  }
  const active = page !== null && !page.isClosed();
  const url = active ? page!.url() : null;
  const onLoginPage = url !== null && isOnLoginPage(url);
  const message = statusMessage(active, savedAt !== null, onLoginPage);
  return { browserActive: active, currentUrl: url, onLoginPage, sessionFile: config.sessionFile, savedAt, message };
}

function statusMessage(active: boolean, hasSavedSession: boolean, onLoginPage: boolean): string {
  if (active && onLoginPage) return "Browser is on the sign-in page: the session expired. Call fidelity_login.";
  if (active) return "Browser session is active.";
  if (hasSavedSession) return "Browser not started. Tools start it from the saved session on first use.";
  return "No saved session. Call fidelity_login or run `npm run login`.";
}
