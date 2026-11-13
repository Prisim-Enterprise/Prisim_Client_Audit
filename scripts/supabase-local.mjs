import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const localMigrationApproval = "PRISIM_ALLOW_LOCAL_MIGRATION_0002";
const commands = {
  start: ["start"],
  stop: ["stop"],
  status: ["status"],
  reset: ["db", "reset", "--no-seed"],
  test: ["test", "db"],
  lint: ["db", "lint"],
  "functions-serve": [
    "functions",
    "serve",
    "--env-file",
    "supabase/functions/.env.example",
  ],
  "functions-check": ["functions-check"],
};

function redact(text) {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g, "[REDACTED SUPABASE KEY]")
    .split(/\r?\n/)
    .map((line) => /(?:service[_ -]?role|anon key|secret key|database password|postgres(?:ql)?:\/\/)/i.test(line)
      ? line.replace(/([:=|]\s*).+$/, "$1[REDACTED]")
      : line)
    .join("\n");
}

function runCli(args) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(executable, ["--no-install", "supabase", ...args, "--workdir", root], {
    cwd: root,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["inherit", "pipe", "pipe"],
  });

  const pipeRedacted = (stream, destination) => {
    stream.setEncoding("utf8");
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) destination.write(`${redact(line)}\n`);
    });
    stream.on("end", () => {
      if (pending) destination.write(redact(pending));
    });
  };
  pipeRedacted(child.stdout, process.stdout);
  pipeRedacted(child.stderr, process.stderr);

  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const [action, ...extraArgs] = process.argv.slice(2);
if (extraArgs.length > 0) {
  fail("This wrapper accepts no extra arguments; remote or linked targets are not supported.");
} else if (action === "functions-check") {
  // Deno comes from the `deno` npm dev dependency (no global install needed).
  const runDeno = (args) => new Promise((resolveExit) => {
    let spawnFailed = false;
    const executable = process.platform === "win32" ? "npx.cmd" : "npx";
    const deno = spawn(executable, ["--no-install", "deno", ...args], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    deno.once("error", (error) => {
      spawnFailed = true;
      fail(`Unable to run Deno (run npm install at the repository root): ${error.message}`);
      resolveExit(1);
    });
    deno.once("close", (code) => {
      if (!spawnFailed) resolveExit(code ?? 1);
    });
  });
  const functions = ["invite-tenant-member", "ad-connections", "sync-ad-data", "run-audit", "generate-report"];
  let code = 0;
  for (const name of functions) {
    const config = `supabase/functions/${name}/deno.json`;
    const args = ["check", "--no-lock"];
    if (existsSync(resolve(root, config))) args.push("--config", config);
    args.push(`supabase/functions/${name}/index.ts`);
    code = await runDeno(args);
    if (code !== 0) break;
  }
  if (code === 0) {
    code = await runDeno(["test", "--no-lock", "supabase/functions/invite-tenant-member/index.test.ts"]);
  }
  process.exitCode = code;
} else if ((action === "reset" || action === "verify") && process.env[localMigrationApproval] !== "1") {
  fail(`Refusing to apply migrations without ${localMigrationApproval}=1. Set it only after migration 0002 is approved for local validation.`);
} else if (action === "verify") {
  for (const command of ["start", "reset", "lint", "test"]) {
    const result = await runCli(commands[command]);
    if (result !== 0) {
      process.exitCode = result;
      break;
    }
  }
} else if (!Object.hasOwn(commands, action)) {
  fail(`Unknown local Supabase command: ${action ?? "(missing)"}`);
} else {
  const code = await runCli(commands[action]);
  process.exitCode = code;
}
