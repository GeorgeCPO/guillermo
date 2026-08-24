import process from "node:process";
import { runCli } from "./cli-main.js";

runCli(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
