// Starts the console backend (port 4000) and frontend (port 5173) together,
// in one terminal. Press Ctrl+C once to stop both.
// Usage from the repository root: npm run dev
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// npm supplies its CLI path on every supported OS, including Windows where
// spawning "npm" directly cannot execute the npm.cmd wrapper.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Start the console with npm run dev from the repository root.");
  process.exit(1);
}
const parts = [
  { name: "backend ", dir: `${root}backend` },
  { name: "frontend", dir: `${root}frontend` },
];

const children = parts.map(({ name, dir }) => {
  const child = spawn(process.execPath, [npmCli, "run", "dev"], { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    console.log(`[${name}] stopped${code ? ` (exit code ${code})` : ""}`);
    shutdown(code ?? 0);
  });
  return child;
});

console.log("Starting Zoiko Pay Console: backend http://localhost:4000, frontend http://localhost:5173 (Ctrl+C to stop)");

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
