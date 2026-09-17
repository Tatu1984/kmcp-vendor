#!/usr/bin/env node
/**
 * Starts Expo pointed at a locally-running kmcp-backend, instead of whatever
 * `EXPO_PUBLIC_API_URL` is set to in `.env`/`.env.local`.
 *
 * `localhost` means nothing on a physical phone running Expo Go — it means
 * the phone itself. What the phone can reach is this machine's LAN address,
 * so that's what gets detected and used, unless one is given explicitly.
 *
 * Usage:
 *   npm run dev:local                          # auto-detects the LAN IP
 *   npm run dev:local -- 192.168.1.23           # use this IP instead
 *   npm run dev:local -- --port 4001            # backend on a different port
 *   LOCAL_API_PORT=4001 npm run dev:local        # same, via env var
 */
const { networkInterfaces } = require("node:os");
const { spawn } = require("node:child_process");

/**
 * Finds every plausible LAN IP and picks one.
 *
 * A machine with a VPN, a virtual bridge, or a USB-tethered phone attached
 * has more than one non-internal IPv4 interface, and the wrong pick here is
 * silent — the phone just times out with no clue why. So this prefers an
 * interface actually named like Wi-Fi/Ethernet, but always lists every
 * candidate it saw, so a wrong guess is visible instead of assumed.
 */
function detectLanIp() {
  const nets = networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  if (candidates.length === 0) return { chosen: null, candidates };

  const preferred = candidates.find((c) => /^(en0|wlan0|wi-?fi)/i.test(c.name));
  return { chosen: preferred ?? candidates[0], candidates };
}

function parseArgs(argv) {
  let host = null;
  let port = process.env.LOCAL_API_PORT || "4000";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      port = argv[++i];
    } else if (arg === "--host") {
      host = argv[++i];
    } else if (!arg.startsWith("--")) {
      host = arg;
    }
  }
  return { host, port };
}

const { host: explicitHost, port } = parseArgs(process.argv.slice(2));

let host = explicitHost;
if (!host) {
  const { chosen, candidates } = detectLanIp();
  if (!chosen) {
    console.error(
      "Could not detect a LAN IP automatically. Pass one directly:\n" +
        "  npm run dev:local -- 192.168.1.23\n",
    );
    process.exit(1);
  }
  host = chosen.address;
  if (candidates.length > 1) {
    console.log(
      `Multiple network interfaces found, using ${chosen.name} (${chosen.address}):\n` +
        candidates.map((c) => `  ${c.name === chosen.name ? "→" : " "} ${c.name}: ${c.address}`).join("\n") +
        `\nWrong one? Run \`npm run dev:local -- <ip>\` with the right address instead.`,
    );
  }
}

const apiUrl = `http://${host}:${port}/api/v1`;
console.log(`Starting Expo against local backend: ${apiUrl}`);
console.log(
  "Make sure kmcp-backend is actually running (npm run dev in that repo) " +
    "and that this phone is on the same network as this machine.",
);

const child = spawn("npx", ["expo", "start", "--go"], {
  stdio: "inherit",
  env: { ...process.env, EXPO_PUBLIC_API_URL: apiUrl },
});
child.on("exit", (code) => process.exit(code ?? 0));
