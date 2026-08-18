#!/usr/bin/env node
// Runs after Claude edits a frontend file. Smoke-tests the running dev
// server with agent-browser: desktop + mobile screenshots, console/page
// error check, pixel diff against a local baseline.
//
// No-ops silently (exit 0, no output) when no dev server is reachable yet.
// Exits 2 with a summary on stdout when it finds console/page errors or a
// meaningful visual diff, so the PostToolUse hook can wake Claude with it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASELINE_DIR = join(ROOT, ".agent-browser", "baselines");
const SESSION = "claude-hook";
const DIFF_THRESHOLD_PCT = 1.0;

const FRONTEND_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less",
  ".html", ".vue", ".svelte", ".mdx",
]);

async function readStdinJson() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function extOf(path) {
  const m = /\.[a-zA-Z0-9]+$/.exec(path || "");
  return m ? m[0].toLowerCase() : "";
}

async function reachable(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function findTargetUrl() {
  // Only ever probe an explicit target: AGENT_BROWSER_TARGET_URL, or the
  // conventional localhost:3000 default. Guessing across other common dev
  // ports (5173, 8080, 4321, ...) risks hitting an unrelated local service
  // on this machine and misreporting it as this project's UI — set
  // AGENT_BROWSER_TARGET_URL once the dashboard's dev server uses a
  // different port.
  const url = process.env.AGENT_BROWSER_TARGET_URL || "http://localhost:3000";
  return (await reachable(url)) ? url : null;
}

// Node's execFile(shell:true) on Windows builds the cmd.exe command line
// itself, and its quoting mishandles non-ASCII characters (this repo's
// OneDrive path contains "Área") — arguments silently get truncated at
// word boundaries. Passing cmd.exe as the target binary with each argument
// as its own array element lets Node's normal (correct) Windows argv
// quoting do the work for the cmd.exe call; cmd.exe then re-parses that
// command line itself (standard, well-behaved cmd.exe quoting) to invoke
// the .cmd shim.
async function ab(args, { json = false } = {}) {
  const fullArgs = ["--session", SESSION, ...args];
  if (json) fullArgs.push("--json");
  try {
    let stdout;
    if (process.platform === "win32") {
      ({ stdout } = await execFileP(
        "cmd.exe",
        ["/d", "/s", "/c", "agent-browser.cmd", ...fullArgs],
        { timeout: 30000, windowsHide: true }
      ));
    } else {
      ({ stdout } = await execFileP("agent-browser", fullArgs, {
        timeout: 30000,
        windowsHide: true,
      }));
    }
    return json ? JSON.parse(stdout) : stdout;
  } catch (err) {
    if (process.env.AB_DEBUG) {
      console.error("DEBUG ab() error", JSON.stringify({
        code: err?.code,
        killed: err?.killed,
        signal: err?.signal,
        stdout: err?.stdout,
        stderr: err?.stderr,
        message: err?.message,
      }));
    }
    return json
      ? { success: false, data: null, error: String(err?.message || err) }
      : String(err?.stdout || err?.message || err);
  }
}

async function checkViewport(label, setupArgs, baselineFile) {
  await ab(setupArgs);
  const shot = join(BASELINE_DIR, `${label}-current.png`);
  await ab(["screenshot", shot, "--full"], { json: true });
  if (!existsSync(shot)) {
    return { ok: true, note: `${label}: screenshot failed, skipping visual check` };
  }
  if (!existsSync(baselineFile)) {
    copyFileSync(shot, baselineFile);
    return { ok: true, note: `${label}: baseline created (${baselineFile})` };
  }
  const result = await ab(
    ["diff", "screenshot", "--baseline", baselineFile, "--full"],
    { json: true }
  );
  const data = result?.data;
  if (!result?.success || !data) {
    return { ok: true, note: `${label}: diff check skipped (${result?.error ?? "no data"})` };
  }
  if (data.dimensionMismatch) {
    return { ok: false, note: `${label}: viewport dimensions changed vs baseline` };
  }
  const pct = data.mismatchPercentage ?? 0;
  if (!data.match && pct > DIFF_THRESHOLD_PCT) {
    return {
      ok: false,
      note: `${label}: visual diff ${pct.toFixed(2)}% of pixels changed vs baseline (current: ${shot})`,
    };
  }
  return { ok: true, note: `${label}: OK (${pct.toFixed(2)}% diff)` };
}

async function main() {
  const input = await readStdinJson();
  const filePath =
    input?.tool_input?.file_path || input?.tool_response?.filePath || "";

  if (!FRONTEND_EXT.has(extOf(filePath))) {
    process.exit(0);
  }

  const targetUrl = await findTargetUrl();
  if (!targetUrl) {
    // No dev server running yet — nothing to validate against.
    process.exit(0);
  }

  mkdirSync(BASELINE_DIR, { recursive: true });

  const notes = [];
  let fail = false;
  let opened = false;

  try {
    const openResult = await ab(["open", targetUrl], { json: true });
    opened = !!openResult?.success;

    if (opened) {
      await ab(["wait", "--load", "networkidle"]);
      await ab(["errors", "--clear"]);
      await ab(["console", "--clear"]);
      await ab(["reload"]);
      await ab(["wait", "--load", "networkidle"]);

      const errorsRes = await ab(["errors"], { json: true });
      const pageErrors = errorsRes?.data?.errors ?? [];
      if (pageErrors.length > 0) {
        fail = true;
        notes.push(
          `Page errors on ${targetUrl}:\n` +
            pageErrors.slice(0, 5).map((e) => `  - ${e.text || e.message || e}`).join("\n")
        );
      }

      const consoleRes = await ab(["console"], { json: true });
      const consoleErrors = (consoleRes?.data?.messages ?? []).filter(
        (m) => m.type === "error"
      );
      if (consoleErrors.length > 0) {
        fail = true;
        notes.push(
          `Console errors on ${targetUrl}:\n` +
            consoleErrors.slice(0, 5).map((m) => `  - ${m.text || m}`).join("\n")
        );
      }

      const desktop = await checkViewport(
        "desktop",
        ["set", "viewport", "1440", "900"],
        join(BASELINE_DIR, "desktop-baseline.png")
      );
      if (!desktop.ok) fail = true;
      notes.push(desktop.note);

      const mobile = await checkViewport(
        "mobile",
        ["set", "device", "iPhone 16"],
        join(BASELINE_DIR, "mobile-baseline.png")
      );
      if (!mobile.ok) fail = true;
      notes.push(mobile.note);
    }
  } finally {
    await ab(["close"]);
  }

  if (!opened) {
    // Browser/daemon unavailable — don't fail the hook over our own tooling.
    process.exit(0);
  }

  const header = `[agent-browser-check] ${targetUrl} after editing ${filePath}`;
  console.log([header, ...notes].join("\n"));
  process.exit(fail ? 2 : 0);
}

main().catch((err) => {
  console.error(`[agent-browser-check] internal error: ${err?.message || err}`);
  process.exit(0); // never block the agent on our own bugs
});
