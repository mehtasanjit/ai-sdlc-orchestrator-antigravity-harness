#!/usr/bin/env node
/**
 * The run-start pin check of an interactive (chat) run. A headless run passes
 * the pin to agy itself (run.mjs); a chat runs on whatever model agy was
 * started with. This reads the model calls agy's local conversation record
 * holds for the project's conversations active since the run started
 * (telemetry/conversationUsage.mjs) and refuses when any of them is not the
 * policy's driver pin, before anything is dispatched.
 *
 * Effort is not checked: the record names the model without its effort
 * (p1-agy-runtime.md check 14), and agy's cli.log writes its selected-model
 * label when a process starts, not per conversation.
 *
 * With --run-id it writes the run folder's policy_snapshot.yaml, which
 * manifest.mjs reads the pin from: in --output-dir when given (resolved
 * against --project-root), else in .sdlc/runs/<run-id>/. A run that already
 * has one (a resumed run) is checked against it, and it is kept.
 *
 * Usage:
 *   node plugin/agy/check-driver-pin.mjs --since=<iso> [--project-root=<path>] [--policy=<name>]
 *        [--run-id=<id>] [--output-dir=<path>] [--conversation=<id>[,<id>...]]
 *
 * Exit: 0 every recorded call is on the pin; 1 refused (a call is off the pin,
 * or the pin has no price today); 2 usage or policy error; 3 not checked (no
 * conversation or model call recorded yet, or a record that could not be read
 * and no off-pin call in the others).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { agyHome, projectConversations, readConversationRecord } from "./telemetry/conversationUsage.mjs";
import { driverPrice } from "./telemetry/driverPrice.mjs";
import { offPinModels } from "./telemetry/event-reader.mjs";
import { driverSlug, readPin } from "./telemetry/fairnessPin.mjs";
import { parseArgs, resolvePolicy } from "./run.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";

export const EXIT_CODES = Object.freeze({ ok: 0, refused: 1, unchecked: 3 });

export function restartCommand(pin) {
  return `agy --model ${driverSlug(pin)}`;
}

export function snapshotPath(projectRoot, runId, outputDir = null) {
  if (outputDir) return join(resolve(projectRoot, outputDir), "policy_snapshot.yaml");
  return join(projectRoot, ".sdlc", "runs", runId, "policy_snapshot.yaml");
}

/** The run's own snapshot when it has one, else the policy the project resolves to. */
export function runPolicy({ projectRoot, policyName = null, runId = null, outputDir = null }) {
  const snapshot = runId || outputDir ? snapshotPath(projectRoot, runId, outputDir) : null;
  if (snapshot && existsSync(snapshot)) {
    const policy = parseYaml(readFileSync(snapshot, "utf8"));
    if (policyName && policy?.name !== policyName) {
      throw new Error(`run ${runId ?? dirname(snapshot)} started under policy '${policy?.name}' (${snapshot}), not '${policyName}'. Continue it under '${policy?.name}', or start a new run.`);
    }
    return { name: policy?.name, path: snapshot, source: "policy_snapshot.yaml", policy, snapshot };
  }
  return { ...resolvePolicy({ projectRoot, flag: policyName }), snapshot };
}

const callsText = (counts) => [...counts].map(([model, n]) => `${model} (${n} call(s))`).join(", ");

/**
 * `{ status: "ok" | "refused" | "unchecked", reason, message, ... }`. Every
 * call of each conversation counts, not only those after `since`: the call
 * that ran the command recording `since` is dated before it.
 */
export async function checkDriverPin({ projectRoot, since, policyName = null, runId = null, outputDir = null, conversationIds = null, home = agyHome(), today = new Date().toISOString() }) {
  const root = resolve(projectRoot);
  const resolved = runPolicy({ projectRoot: root, policyName, runId, outputDir });
  const pin = readPin(resolved.policy);
  const slug = driverSlug(pin);
  const named = `policy '${resolved.name}' pins the driver to ${pin.model} at effort ${pin.effort} (slug ${slug})`;
  const base = { policy: resolved.name, pin: { model: pin.model, effort: pin.effort, slug }, effort_checked: false };
  const snapshot = () => {
    if (!resolved.snapshot || resolved.source === "policy_snapshot.yaml") return {};
    mkdirSync(dirname(resolved.snapshot), { recursive: true });
    copyFileSync(resolved.path, resolved.snapshot);
    return { snapshot_written: resolved.snapshot };
  };
  const unchecked = (reason, why, detail = {}) => ({
    ...base, ...detail, status: "unchecked", reason, ...snapshot(),
    message: `check-driver-pin: NOT CHECKED. ${why} This chat's conductor model is unknown, which is not a pass; ${named}.`,
  });

  const price = driverPrice(resolved.policy.driver, today);
  if (price.unpriced) {
    return {
      ...base, status: "refused", reason: "pin_unpriced",
      message: `check-driver-pin: REFUSED. The driver model '${pin.model}' has no price on ${today.slice(0, 10)}: ${price.reason}. The modeled driver line could not be priced, so the run is refused before anything is dispatched.`,
    };
  }

  const ids = conversationIds ?? (await projectConversations(home, root, since)).map((c) => c.id);
  if (!ids.length) return unchecked("no_conversation", `agy has recorded no conversation for ${root} since ${since} (${home}).`);

  const counts = new Map();
  const conversations = [];
  const unreadable = [];
  for (const id of ids) {
    const path = join(home, "conversations", `${id}.db`);
    if (!existsSync(path)) { conversations.push({ id, found: false }); continue; }
    let calls;
    try {
      calls = await readConversationRecord(path);
    } catch (err) {
      unreadable.push({ id, error: String(err?.message ?? err) });
      conversations.push({ id, found: true, unreadable: true });
      continue;
    }
    conversations.push({ id, found: true, calls: calls.length });
    for (const c of calls) if (c.model) counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  }
  const unreadText = unreadable.length
    ? `agy's record of conversation(s) ${unreadable.map((u) => `${u.id} could not be read (${u.error})`).join("; ")}.`
    : "";

  const offPin = offPinModels([...counts.keys()], pin, slug);
  const detail = { conversations, models: Object.fromEntries(counts), ...(unreadable.length ? { unreadable } : {}) };
  if (offPin.length) {
    return {
      ...base, ...detail, status: "refused", reason: "off_pin", off_pin: offPin,
      message:
        `check-driver-pin: REFUSED. This chat's conductor ran on ${callsText([...counts].filter(([m]) => offPin.includes(m)))}, ` +
        `but ${named}. ${unreadText ? `${unreadText} ` : ""}Dispatch nothing more in this chat. Quit agy and start it again on the pin, from ${root}:\n\n` +
        `  ${restartCommand(pin)}\n\nthen invoke the same /mmo: command again.`,
    };
  }
  if (unreadable.length) return unchecked("record_unreadable", `${unreadText} It may be this chat's.`, detail);
  if (!counts.size) return unchecked("no_model_call", `agy's record holds no model call naming a model for conversation(s) ${ids.join(", ")} yet.`, detail);
  return {
    ...base, ...detail, status: "ok", reason: "on_pin", ...snapshot(),
    message: `check-driver-pin ok: ${callsText(counts)} in agy's record, the driver pin of policy '${resolved.name}' (${slug}). Effort is not checked: agy's record names the model without its effort.`,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.since !== "string" || Number.isNaN(Date.parse(args.since))) {
    console.error("Usage: node plugin/agy/check-driver-pin.mjs --since=<iso> [--project-root=<path>] [--policy=<name>] [--run-id=<id>] [--output-dir=<path>] [--conversation=<id>]");
    process.exit(2);
  }
  try {
    const result = await checkDriverPin({
      projectRoot: args["project-root"] ?? process.cwd(),
      since: args.since,
      policyName: typeof args.policy === "string" ? args.policy : null,
      runId: typeof args["run-id"] === "string" ? args["run-id"] : null,
      outputDir: typeof args["output-dir"] === "string" ? args["output-dir"] : null,
      conversationIds: typeof args.conversation === "string" ? args.conversation.split(",").filter(Boolean) : null,
    });
    (result.status === "ok" ? console.log : console.error)(result.message);
    if (result.snapshot_written) console.log(`check-driver-pin: wrote ${result.snapshot_written}`);
    process.exit(EXIT_CODES[result.status]);
  } catch (err) {
    console.error(`check-driver-pin failed: ${err?.message ?? err}`);
    process.exit(2);
  }
}
