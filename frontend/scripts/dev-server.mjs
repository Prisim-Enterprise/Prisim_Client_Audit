// Starts the Vite dev server for this package, regardless of shell.
//
// `npm run dev:demo -- --host 127.0.0.1 --port 5174 --strictPort` behaves
// differently per shell. In PowerShell the `--` separator is consumed by the
// shell, so npm parses --host/--port/--strictPort as *npm* config and passes
// only the bare values on. `vite 127.0.0.1 5174` then treats "127.0.0.1" as the
// project root and serves 404 for every path. This launcher pins the root to
// this package and accepts the options from either place:
//   * real flags:          --host 127.0.0.1 --port 5174 --strictPort (or --x=y)
//   * npm config (PowerShell): npm_config_host / npm_config_port / npm_config_strictport
// Bare values npm left behind (a host or a port number) are recognised too.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseDevArgs(argv, env = {}) {
  const options = { mode: undefined, host: undefined, port: undefined, strictPort: undefined, open: undefined };
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [null, null];
    if (flag === null) {
      positionals.push(arg);
      continue;
    }
    const next = () => (inline !== undefined && inline !== null ? inline : argv[++index]);
    switch (flag.toLowerCase()) {
      case "mode":
        options.mode = next();
        break;
      case "host":
        // `--host` alone means all interfaces, as in the Vite CLI.
        options.host = inline ?? (argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true);
        break;
      case "port":
        options.port = Number(next());
        break;
      case "strictport":
      case "strict-port":
        options.strictPort = inline === undefined || inline === null ? true : inline !== "false";
        break;
      case "open":
        options.open = true;
        break;
      default:
        throw new Error(`Unsupported dev server option: ${arg}`);
    }
  }

  const config = (name) => {
    const key = Object.keys(env).find((item) => item.toLowerCase() === `npm_config_${name}`);
    return key ? env[key] : undefined;
  };
  // npm records a swallowed flag as "true" and leaves its value as a bare
  // argument (handled below); a real value is used directly.
  const hostFromNpm = config("host");
  const portFromNpm = config("port");
  if (options.host === undefined && hostFromNpm && hostFromNpm !== "true") options.host = hostFromNpm;
  if (options.port === undefined && portFromNpm && portFromNpm !== "true") options.port = Number(portFromNpm);
  if (options.strictPort === undefined && (config("strictport") ?? config("strict_port") ?? config("strict-port"))) {
    options.strictPort = (config("strictport") ?? config("strict_port") ?? config("strict-port")) !== "false";
  }

  for (const value of positionals) {
    // npm leaves the values of the flags it swallowed; they repeat what npm_config_* already said.
    if (value === "true" || value === String(options.port) || value === options.host) continue;
    if (/^\d{2,5}$/.test(value) && options.port === undefined) options.port = Number(value);
    else if (/^[\w.:[\]-]+$/.test(value) && options.host === undefined) options.host = value;
    else throw new Error(`Unexpected argument: ${value} (a project root cannot be passed here)`);
  }
  // `--host` with no value left behind means all interfaces, as in the Vite CLI.
  if (options.host === undefined && hostFromNpm === "true") options.host = true;
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseDevArgs(process.argv.slice(2), process.env);
  const server = await createServer({
    root,
    configFile: resolve(root, "vite.config.ts"),
    mode: options.mode,
    server: {
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.strictPort !== undefined ? { strictPort: options.strictPort } : {}),
      ...(options.open ? { open: true } : {}),
    },
  });
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}
