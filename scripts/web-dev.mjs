import {spawn} from "node:child_process";

const commands = [
  ["api", "tsx", ["watch", "src/backend/server.ts"]],
  ["vite", "vite", ["--config", "web/vite.config.ts"]],
];

const children = commands.map(([label, command, args]) => {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("exit", (code) => {
    if (code && !shuttingDown) {
      process.exitCode = code;
      shutdown();
    }
  });
  return child;
});

let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
