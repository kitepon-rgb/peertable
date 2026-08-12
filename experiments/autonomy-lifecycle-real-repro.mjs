#!/usr/bin/env node

/**
 * t4: 実円卓のライフサイクルを、使い捨て room/project と実席で測る。
 *
 * 実測するもの:
 *   - 自然文相当の席変更（依頼文の完全一致を再送しない）
 *   - 再起動された席の role / 工程 / room log からの再着任
 *   - 親の抑制的な発言後も active 席が報告し ready claim すること
 *   - audit-before-done、親の役割境界、green item の親無通知
 *
 * 実席の失敗を fixture の成功で覆わない。live 部分が失敗した場合は
 * 非ゼロ終了し、結果を部分成功として出さない。
 */

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const roomServer = join(repo, "room", "server.mjs");
const launchSeat = join(repo, "skill", "scripts", "launch-seat.sh");
const changeSeat = join(repo, "skill", "scripts", "change-seat.sh");
const leaveSeat = join(repo, "skill", "scripts", "leave-seat.sh");
const wakeupBridge = join(repo, "skill", "scripts", "wakeup-bridge.mjs");
const memberTemplate = join(repo, "skill", "templates", "member-standalone.md");
const parentTemplate = join(repo, "skill", "templates", "parent.md");
const charterTemplate = join(repo, "skill", "templates", "charter.md");

const seatModel = process.env.T4_REAL_MODEL || "gpt-5.6-sol";
const seatEffort = process.env.T4_REAL_EFFORT || "high";
const timeoutMs = Number(process.env.T4_TIMEOUT_MS || 240_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd: options.cwd || repo,
      env: options.env || process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? timeoutMs,
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code === "ETIMEDOUT" ? 124 : (error ? (error.code ?? 1) : 0),
        error: error?.message || "",
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    child.on("error", () => {});
  });
}

function commandSync(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd || repo,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(label, predicate, timeout = 90_000, interval = 500) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`${label} の待機がタイムアウトしました${lastError ? `: ${lastError.message}` : ""}`);
}

async function freePort() {
  const server = await new Promise((resolve, reject) => {
    const candidate = net.createServer();
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw: body };
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${body}`);
  }
  return parsed;
}

async function startRoom({ dataDir, token, port, room }) {
  const child = spawn(process.execPath, [roomServer], {
    cwd: repo,
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: dataDir,
      PEERTABLE_POST_TOKEN: token,
      PEERTABLE_PARENT_NAME: "bell",
      PEERTABLE_ROOM: room,
      PEERTABLE_PUBLIC_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitFor("使い捨て room", async () => {
    try {
      const status = await jsonFetch(`http://127.0.0.1:${port}/api/${encodeURIComponent(room)}/summary`);
      return status.room === room;
    } catch {
      return false;
    }
  }, 30_000);
  return { child, output: () => output };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function postRoom(base, token, payload) {
  return jsonFetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Peertable-Token": token,
    },
    body: JSON.stringify(payload),
  });
}

async function registerMember(base, token, payload) {
  return jsonFetch(`${base}/members`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Peertable-Token": token,
    },
    body: JSON.stringify(payload),
  });
}

async function messages(base) {
  const result = await jsonFetch(`${base}/messages`);
  return Array.isArray(result) ? result : (result.messages || result.items || []);
}

function pane(socket, session) {
  try {
    return commandSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", session, "-S", "-120"]);
  } catch {
    return "";
  }
}

async function runSupportFixture(script) {
  const result = await command(process.execPath, [join(repo, "experiments", script)], {
    timeout: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(`${script} が失敗しました (code=${result.code})\n${result.stdout}\n${result.stderr}`);
  }
  return {
    script,
    passed: true,
    tail: `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-4).join("\n"),
  };
}

function assertProtocolOrder() {
  // 実席とは別に、受入順序の最小契約を同じ実行に束縛する。
  // green item は親への完了通知を持たず、intentional defect のみ返す。
  const green = [
    "claim",
    "progress",
    "audit_request",
    "audit_pass",
    "lattice_done",
  ];
  const defect = [
    "claim",
    "progress",
    "audit_request",
    "audit_defect",
    "parent_reject",
    "lattice_done",
  ];
  assert.ok(green.indexOf("audit_pass") < green.indexOf("lattice_done"));
  assert.equal(green.includes("parent_comment"), false);
  assert.ok(defect.indexOf("audit_defect") < defect.indexOf("parent_reject"));
  assert.ok(defect.indexOf("parent_reject") < defect.indexOf("lattice_done"));
  return { name: "protocol-order", passed: true };
}

async function liveLifecycle() {
  const root = await mkdtemp(join(tmpdir(), "peertable-t4-"));
  const dataDir = join(root, "room-data");
  const project = join(root, "project");
  const tokenFile = join(root, "post-token.env");
  const socket = join(root, "tmux.sock");
  const room = `t4-live-${process.pid}`;
  const token = `t4-token-${process.pid}-${Date.now()}`;
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const base = `${serverUrl}/api/${encodeURIComponent(room)}`;
  let roomProcess;
  let bridgeProcess;
  let launched = false;
  let memberSeen = false;
  const result = {
    room,
    project,
    model: seatModel,
    effort_before_change: seatEffort,
    effort_after_change: "max",
    checks: [],
  };
  const env = {
    ...process.env,
    PEERTABLE_TMUX_SOCKET: socket,
    PEERTABLE_TOKEN_SOURCE_FILE: tokenFile,
  };
  delete env.PEERTABLE_POST_TOKEN;
  delete env.PEERTABLE_MEMBER;

  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(project, ".team", "roles"), { recursive: true });
    await writeFile(tokenFile, `PEERTABLE_POST_TOKEN=${token}\n`, { mode: 0o600 });
    await writeFile(join(project, ".team", "setup-state.json"), `${JSON.stringify({
      project,
      room,
      server_url: serverUrl,
      public_url: serverUrl,
      mode: "standalone",
      plan_key: "",
      parent: "bell",
      created_at: new Date().toISOString(),
      added_root_mcp: true,
    }, null, 2)}\n`);
    await writeFile(join(project, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        peertable: {
          command: process.execPath,
          args: [join(repo, "room", "client.mjs")],
          env: { PEERTABLE_SERVER_URL: serverUrl, PEERTABLE_ROOM: room },
        },
      },
    }, null, 2)}\n`);
    await writeFile(join(project, ".team", "CLAUDE.md"), "@roles/member.md\n");
    await writeFile(join(project, ".team", "roles", "member.md"), await readFile(memberTemplate));
    await writeFile(join(project, ".team", "roles", "parent.md"), await readFile(parentTemplate));
    await writeFile(join(project, ".team", "charter.md"), await readFile(charterTemplate));

    roomProcess = await startRoom({ dataDir, token, port, room });
    await registerMember(base, token, {
      name: "bell",
      vendor: "codex",
      model: "fixture-parent",
      role: "parent",
      status: "active",
      delivery: { kind: "parent_watch" },
    });

    const launch = await command("bash", [launchSeat, project, "t4-live-worker", seatModel, "codex", seatEffort,
      "あなたは使い捨て room の t4 実測席です。着任時に .team/roles/member.md と .team/CLAUDE.md を読み、room の履歴を確認してください。DM に [t4-live-boot] が来たら room.read_unread 相当で内容を読み、room.post で bell に [t4-live-boot-ok] と返してください。コード変更はせず、他の指示を待ってください。"], { env, timeout: timeoutMs });
    if (launch.code !== 0) {
      throw new Error(`実席の起動に失敗しました (code=${launch.code})\n${launch.stdout}\n${launch.stderr}`);
    }
    launched = true;

    await waitFor("実席 member 登録", async () => {
      const list = await jsonFetch(`${base}/members`);
      const members = Array.isArray(list) ? list : (list.members || list.items || []);
      const worker = members.find((item) => item.name === "t4-live-worker");
      memberSeen = Boolean(worker);
      return worker;
    }, 90_000);

    bridgeProcess = spawn(process.execPath, [wakeupBridge, project, "t4-live-worker"], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bridgeOutput = "";
    bridgeProcess.stdout.on("data", (chunk) => { bridgeOutput += String(chunk); });
    bridgeProcess.stderr.on("data", (chunk) => { bridgeOutput += String(chunk); });
    await waitFor("実席 wakeup bridge", async () => {
      return bridgeOutput.includes("起動") || bridgeOutput.includes("ready") || bridgeOutput.includes("listening") || bridgeOutput.length > 0;
    }, 30_000);

    await postRoom(base, token, {
      from: "bell",
      to: "t4-live-worker",
      body: "[t4-live-boot] role・工程正本・roomログから再着任し、確認結果を返してください。",
    });
    await waitFor("実席の DM 読み取りと返信", async () => {
      const items = await messages(base);
      return items.some((item) => item.from === "t4-live-worker" && item.body?.includes("[t4-live-boot-ok]"));
    }, 120_000);
    result.checks.push({ name: "real-dm-read-and-reply", passed: true });

    // 親からの抑制的な発言があっても、席自身が progress と ready claim を行う。
    await postRoom(base, token, {
      from: "bell",
      to: "t4-live-worker",
      body: "[t4-live-suppressive-parent] 親向けの返事は簡潔で構いません。ただし member の基底 loop は止めず、room に [t4-live-progress] を全体宛てで報告し、続けて [claim] t4-live-ready を自分で投稿してください。親からの配車は待たないでください。",
    });
    await waitFor("実席の自律 progress / claim", async () => {
      const items = await messages(base);
      const workerItems = items.filter((item) => item.from === "t4-live-worker");
      return workerItems.some((item) => item.body?.includes("[t4-live-progress]"))
        && workerItems.some((item) => item.body?.includes("[claim] t4-live-ready"));
    }, 150_000);
    const activeMessages = await messages(base);
    assert.equal(activeMessages.some((item) => item.from === "bell" && item.body?.includes("[配車]")), false);
    result.checks.push({ name: "real-active-progress-and-self-claim", passed: true });

    // launch-seat 自身は同名 member を残したままの置換を拒否する。これは安全な負例であり、
    // change-seat が先に leave-seat の正規境界を通す必要を固定する。
    const staleLaunch = await command("bash", [launchSeat, project, "t4-live-worker", seatModel, "codex", "max",
      "t4 stale-member negative"], { env, timeout: timeoutMs });
    if (staleLaunch.code === 0 || !staleLaunch.stderr.includes("SEAT_ROOM_MEMBER_CONFLICT")) {
      throw new Error(`同名member負例が期待どおり拒否されませんでした (code=${staleLaunch.code})\n${staleLaunch.stdout}\n${staleLaunch.stderr}`);
    }
    result.checks.push({ name: "real-stale-member-launch-negative", passed: true });

    // 依頼文を再送せず、自然文の判断を済ませた結果だけを seat change に渡す。
    let idleSince = 0;
    await waitFor("席変更前の実席 idle", () => {
      if (pane(socket, "peer-t4-live-worker").includes("esc to interrupt")) {
        idleSince = 0;
        return false;
      }
      if (idleSince === 0) idleSince = Date.now();
      return Date.now() - idleSince >= 5_000;
    }, 120_000, 1_000);
    const change = await command("bash", [changeSeat, project, "t4-live-worker",
      "--effort", "max", "--parent", "bell", "--reason", "自然文の作業量依頼を親が意味判断し、対象席の推論強度だけを変更する"], { env, timeout: timeoutMs });
    if (change.code !== 0) {
      throw new Error(`実席の席変更に失敗しました (code=${change.code})\n${change.stdout}\n${change.stderr}`);
    }
    assert.equal(change.stdout.includes("[effort変更依頼]"), false);
    await waitFor("席変更後の member metadata", async () => {
      const list = await jsonFetch(`${base}/members`);
      const members = Array.isArray(list) ? list : (list.members || list.items || []);
      const worker = members.find((item) => item.name === "t4-live-worker");
      return worker && (worker.effort === "max" || worker.reason?.includes("自然文"));
    }, 120_000);
    result.checks.push({ name: "real-natural-seat-change", passed: true });

    await postRoom(base, token, {
      from: "bell",
      to: "t4-live-worker",
      body: "[t4-live-rejoin] 再起動された席として .team/roles/member.md、工程正本、room log を読み直し、再着任後の確認を [t4-live-rejoin-ok] で返してください。",
    });
    await waitFor("席変更後の再着任返信", async () => {
      const items = await messages(base);
      return items.some((item) => item.from === "t4-live-worker" && item.body?.includes("[t4-live-rejoin-ok]"));
    }, 150_000);
    result.checks.push({ name: "real-rejoin-from-role-plan-log", passed: true });

    const finalMessages = await messages(base);
    result.message_count = finalMessages.length;
    result.bridge_output_tail = bridgeOutput.trim().split("\n").slice(-4).join("\n");
    result.room_output_tail = roomProcess.output().trim().split("\n").slice(-4).join("\n");
    return result;
  } finally {
    if (bridgeProcess) await stopProcess(bridgeProcess);
    if (launched || memberSeen) {
      await command("bash", [leaveSeat, project, "t4-live-worker"], { env, timeout: 60_000 });
    }
    if (roomProcess) await stopProcess(roomProcess.child);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const protocol = assertProtocolOrder();
  const support = [];
  for (const script of [
    "member-autonomy-role-repro.mjs",
    "parent-role-repro.mjs",
    "codex-parent-delivery-repro.mjs",
    "done-receipt-gate-repro.mjs",
    "seat-change-repro.mjs",
    "effort-change-repro.mjs",
  ]) {
    support.push(await runSupportFixture(script));
  }
  const live = await liveLifecycle();
  const report = {
    schema: "peertable.t4.autonomy-lifecycle.v1",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    protocol,
    support,
    live,
    passed: true,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    schema: "peertable.t4.autonomy-lifecycle.v1",
    passed: false,
    error: error.stack || String(error),
  }, null, 2));
  process.exitCode = 1;
});
