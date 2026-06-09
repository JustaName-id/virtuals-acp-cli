import type { Command } from "commander";
import * as readline from "readline";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { printTable, prompt } from "../lib/prompt";
import { c } from "../lib/color";
import { CliError } from "../lib/errors";
import { getClient } from "../lib/api/client";
import { getActiveAgentId } from "../lib/activeAgent";
import { EnsLabelTakenError } from "../lib/api/ens";
import type {
  EnsRecords,
  EnsProfile,
  EnsClaimResult,
} from "../lib/api/ens";

interface RecordOpts {
  avatar?: string;
  description?: string;
  url?: string;
  twitter?: string;
  record?: string[];
}

function buildRecords(opts: RecordOpts): EnsRecords {
  const records: EnsRecords = {};
  if (opts.avatar) records.avatar = opts.avatar;
  if (opts.description) records.description = opts.description;
  if (opts.url) records.url = opts.url;
  if (opts.twitter) records["com.twitter"] = opts.twitter;
  for (const pair of opts.record ?? []) {
    const i = pair.indexOf("=");
    if (i <= 0) {
      throw new CliError(
        `Invalid --record "${pair}".`,
        "VALIDATION_ERROR",
        "Use key=value, e.g. --record com.github=alice"
      );
    }
    records[pair.slice(0, i).trim()] = pair.slice(i + 1);
  }
  return records;
}

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

function printProfile(p: EnsProfile | EnsClaimResult): void {
  const rows: [string, string | null][] = [
    ["ENS", p.ens ?? c.dim("(not claimed)")],
    ["Address", p.address ?? null],
  ];
  for (const [k, v] of Object.entries(p.records ?? {})) {
    rows.push([`  ${k}`, v]);
  }
  printTable(rows);
}

function addRecordOptions(cmd: Command): Command {
  return cmd
    .option("--avatar <url>", "avatar text record")
    .option("--description <text>", "description text record")
    .option("--url <url>", "url text record")
    .option("--twitter <handle>", "com.twitter text record")
    .option(
      "--record <key=value>",
      "extra text record (repeatable), e.g. --record com.github=alice",
      collect,
      []
    );
}

export function registerEnsCommands(program: Command): void {
  const ens = program
    .command("ens")
    .description(
      "Manage the active agent's ENS name (offchain subname via JustaName)"
    );

  // claim --------------------------------------------------------------------
  addRecordOptions(
    ens
      .command("claim")
      .description("Claim an ENS subname for the active agent")
      .option(
        "--label <label>",
        "subname label (defaults to a slug of the agent name)"
      )
  ).action(async (opts, cmd) => {
    const json = isJson(cmd);
    const agentId = getActiveAgentId(json);
    if (!agentId) return;
    try {
      const records = buildRecords(opts);
      const { ensApi } = await getClient();
      let label: string | undefined = opts.label;

      for (;;) {
        try {
          const result = await ensApi.claim(agentId, { label, records });
          if (json) {
            outputResult(json, { ...result });
          } else {
            console.log(
              c.green(`Claimed ${c.bold(result.ens)} for the active agent.`)
            );
            printProfile(result);
          }
          return;
        } catch (err) {
          if (!(err instanceof EnsLabelTakenError)) throw err;

          // Non-interactive: surface the collision + suggestion, then stop.
          if (json || !isTTY()) {
            outputError(
              json,
              new CliError(
                err.message,
                "ALREADY_EXISTS",
                err.suggestion
                  ? `Retry with a different label, e.g. --label ${err.suggestion}`
                  : "Pick a different --label."
              )
            );
            return;
          }

          // Interactive: let the user pick a different label and retry.
          console.log(c.yellow(err.message));
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer = (
            await prompt(
              rl,
              `Enter a different label${
                err.suggestion ? ` (Enter for "${err.suggestion}")` : ""
              }: `
            )
          ).trim();
          rl.close();
          label = answer || err.suggestion;
          if (!label) {
            console.log(c.dim("No label chosen — aborting."));
            return;
          }
        }
      }
    } catch (err) {
      outputError(json, err instanceof Error ? err : String(err));
    }
  });

  // whoami -------------------------------------------------------------------
  ens
    .command("whoami")
    .description("Show the active agent's ENS name + records")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;
      try {
        const { ensApi } = await getClient();
        const profile = await ensApi.whoami(agentId);
        if (json) {
          outputResult(json, { ...profile });
        } else if (!profile.ens) {
          console.log(
            c.yellow("No ENS name claimed yet.") +
              " Run " +
              c.bold("acp ens claim") +
              " to get one."
          );
        } else {
          printProfile(profile);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // set ----------------------------------------------------------------------
  addRecordOptions(
    ens.command("set").description("Update text records on the active agent's name")
  ).action(async (opts, cmd) => {
    const json = isJson(cmd);
    const agentId = getActiveAgentId(json);
    if (!agentId) return;
    try {
      const records = buildRecords(opts);
      if (Object.keys(records).length === 0) {
        throw new CliError(
          "No records provided.",
          "VALIDATION_ERROR",
          "Pass at least one of --avatar/--description/--url/--twitter/--record."
        );
      }
      const { ensApi } = await getClient();
      const profile = await ensApi.setRecords(agentId, records);
      if (json) outputResult(json, { ...profile });
      else {
        console.log(c.green("Records updated."));
        printProfile(profile);
      }
    } catch (err) {
      outputError(json, err instanceof Error ? err : String(err));
    }
  });

  // resolve ------------------------------------------------------------------
  ens
    .command("resolve <name>")
    .description("Resolve an ENS name to its address + records")
    .action(async (name, _opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { ensApi } = await getClient();
        const profile = await ensApi.resolve(name);
        if (json) outputResult(json, { ...profile });
        else printProfile(profile);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // reverse ------------------------------------------------------------------
  ens
    .command("reverse <address>")
    .description("Reverse-resolve an address to its ENS name")
    .action(async (address, _opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { ensApi } = await getClient();
        const profile = await ensApi.reverse(address);
        if (json) outputResult(json, { ...profile });
        else if (!profile.ens) console.log(c.yellow("No ENS name for that address."));
        else printProfile(profile);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // available ----------------------------------------------------------------
  ens
    .command("available <label>")
    .description("Check whether a subname label is free")
    .action(async (label, _opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { ensApi } = await getClient();
        const result = await ensApi.available(label);
        if (json) outputResult(json, { ...result });
        else {
          console.log(
            result.available
              ? c.green(`${label} is available`)
              : c.red(`${label} is taken`)
          );
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
