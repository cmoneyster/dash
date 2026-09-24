// Runs the API server and the website together on this machine, outside
// Replit. Usage (from the repo root):  pnpm run dev:local
//
// Settings come from `.env` at the repo root (copy `.env.example`). Safe
// defaults keep local runs from texting customers or charging real cards.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
else console.warn("[dev-local] No .env found — copy .env.example to .env and fill it in.");

const env = process.env;
// Blank values in .env count as unset.
const setDefault = (key, value) => { if (!env[key]?.trim()) env[key] = value; };
setDefault("NODE_ENV", "development");
setDefault("SMS_OUTBOUND_MODE", "shadow");
setDefault("SQUARE_ENVIRONMENT", "sandbox");
setDefault("LOCAL_STORAGE_DIR", path.join(root, ".local-storage"));
setDefault("API_PORT", "8080");
setDefault("WEB_PORT", "5173");
const apiPort = env.API_PORT;
const webPort = env.WEB_PORT;

if (!env.DATABASE_URL) {
  console.error("[dev-local] DATABASE_URL is not set in .env — the API server needs a database.");
  process.exit(1);
}
// The OpenAI client refuses to load without these, which would stop the
// whole API server; only the AI helpers (menu descriptions etc.) need them.
setDefault("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://api.openai.com/v1");
if (!env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim()) {
  env.AI_INTEGRATIONS_OPENAI_API_KEY = "not-configured";
  console.warn("[dev-local] No OpenAI key in .env — AI menu-description buttons won't work locally.");
}
if (env.SMS_OUTBOUND_MODE !== "shadow") {
  console.warn(`[dev-local] SMS_OUTBOUND_MODE=${env.SMS_OUTBOUND_MODE}: this run WILL send real texts.`);
}
if (env.SQUARE_ENVIRONMENT === "production") {
  console.warn("[dev-local] SQUARE_ENVIRONMENT=production: this run can charge real cards.");
}

const children = [];
function run(name, cmd, args, cwd, extraEnv) {
  const child = spawn(cmd, args, {
    cwd: path.join(root, cwd),
    env: { ...env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[dev-local] ${name} exited (${code ?? "signal"}); stopping.`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));

// API: build once, then run the bundle (same as the Replit dev workflow).
const build = spawn("node", ["build.mjs"], {
  cwd: path.join(root, "artifacts/api-server"),
  env,
  stdio: "inherit",
});
build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev-local] API build failed.");
    process.exit(code ?? 1);
  }
  run("API server", "node", ["--enable-source-maps", "dist/index.mjs"], "artifacts/api-server", {
    PORT: apiPort,
  });
  run("website", "npx", ["vite", "--config", "vite.config.ts"], "artifacts/catering-web", {
    PORT: webPort,
    BASE_PATH: "/",
    API_PROXY_TARGET: `http://localhost:${apiPort}`,
  });
  console.log(`[dev-local] Website: http://localhost:${webPort}  (API on ${apiPort})`);
});
