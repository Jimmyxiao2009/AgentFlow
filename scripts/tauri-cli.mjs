import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const configFlag = "--config";
const configPath = "apps/desktop/src-tauri/tauri.conf.json";
const commandsUsingProjectConfig = new Set(["dev", "build", "bundle"]);
const cliArgs =
  args.includes(configFlag) || !commandsUsingProjectConfig.has(args[0])
    ? args
    : [...args, configFlag, configPath];
const require = createRequire(import.meta.url);
const cliScript = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cliScript, ...cliArgs], { stdio: "inherit" });

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
