#!/usr/bin/env node
// `npm run login`: opens a visible browser, the user logs in and finishes 2FA,
// and the session is saved for the MCP server. Same code path as fidelity_login.
import { loadConfig, login } from "../session.js";

console.log(`Session file: ${loadConfig().sessionFile}`);
const result = await login(() => {
  console.log(
    'A browser window opened (Playwright\'s Firefox, branded "Nightly").\n' +
      "Log in and complete 2FA there. Waiting up to 10 minutes..."
  );
});
console.log(result.message);
process.exit(result.success ? 0 : 1);
