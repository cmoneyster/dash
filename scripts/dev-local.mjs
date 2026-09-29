// Runs the API server and the website together on this machine, outside
// Replit. Usage (from the repo root):  pnpm run dev:local
//
// Settings come from `.env` at the repo root (copy `.env.example`). Safe
// defaults keep local runs from texting customers or charging real cards.

import { spawn, spawnSync } from "node:child_process";
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
  if (!env.SMS_TEST_NUMBERS?.trim()) {
    console.error("[dev-local] Live texting needs SMS_TEST_NUMBERS in .env (only those numbers can be texted).");
    process.exit(1);
  }
  console.warn(`[dev-local] Live texting is ON, limited to SMS_TEST_NUMBERS: ${env.SMS_TEST_NUMBERS}`);
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

// Children run through a shell on Windows, so kill whole process trees —
// otherwise the servers underneath keep holding their ports.
function shutdown(code) {
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill();
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));

// Optional public HTTPS address for webhooks (SMS gateway, Square sandbox):
// `pnpm run dev:local -- --tunnel` opens a Cloudflare quick tunnel to the
// website port and uses its URL as PUBLIC_BASE_URL. The URL changes on
// every start.
function findCloudflared() {
  for (const p of [
    "C:/Program Files (x86)/cloudflared/cloudflared.exe",
    "C:/Program Files/cloudflared/cloudflared.exe",
  ]) if (existsSync(p)) return p;
  return "cloudflared";
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const child = spawn(findCloudflared(), ["tunnel", "--no-autoupdate", "--url", `http://localhost:${webPort}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const timer = setTimeout(() => reject(new Error("tunnel did not report a URL within 30s")), 30_000);
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      console.log(`[dev-local] tunnel exited (${code ?? "signal"}); stopping.`);
      shutdown(code ?? 1);
    });
  });
}

let tunnelUrl = null;
if (process.argv.includes("--tunnel")) {
  try {
    tunnelUrl = await startTunnel();
    env.PUBLIC_BASE_URL = tunnelUrl;
  } catch (err) {
    console.error(`[dev-local] Could not start the Cloudflare tunnel: ${err.message}`);
    shutdown(1);
  }
}

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
  run("website", "npx", ["vite", "--config", "vite.config.ts", "--strictPort"], "artifacts/catering-web", {
    PORT: webPort,
    BASE_PATH: "/",
    API_PROXY_TARGET: `http://localhost:${apiPort}`,
  });
  console.log(`[dev-local] Website: http://localhost:${webPort}  (API on ${apiPort})`);
  if (tunnelUrl) {
    console.log(`[dev-local] Public tunnel: ${tunnelUrl}`);
    console.log(`[dev-local]   SMS push URL:   ${tunnelUrl}/api/sms/inbound?secret=<SMS_WEBHOOK_SECRET>`);
    console.log(`[dev-local]   Square webhook: ${tunnelUrl}/api/webhooks/square`);
  }
});
