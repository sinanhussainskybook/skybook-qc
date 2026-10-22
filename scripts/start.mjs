/**
 * npm run start — the app in production mode (after `npm run build`).
 *
 * Listens on the port the host gives in PORT (Render, Railway…), or 3200 when
 * none is set (this PC), on every interface (0.0.0.0) so the host can reach it.
 * Extra arguments are passed on and win: `npm run start -- --port 3300`.
 *
 * A plain script rather than shell syntax in package.json, so it works the same
 * on Windows (cmd) and on Linux hosts.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const port = process.env.PORT?.trim() || "3200";

const child = spawn(process.execPath, [nextBin, "start", "--port", port, "--hostname", "0.0.0.0", ...process.argv.slice(2)], {
  stdio: "inherit",
});

// Hosts stop the app with SIGTERM (Ctrl+C sends SIGINT): pass it on, so Next.js shuts down cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
