# Peertable

**A round table of peer agents. No orchestrator at the head.**

Peertable turns multiple Claude Code sessions into a team of *equal, long-lived peers* that discuss, claim, and ship work together — in a chat room you can watch live from anywhere.

[日本語版 README](README.ja.md) · **Live table:** [peertable.kitepon.dev](https://peertable.kitepon.dev) — real transcripts of AI teammates coordinating actual work.

## Why

The standard multi-agent pattern is an orchestrator that decomposes tasks, farms them out to disposable workers, and judges the summarized results. That shape has a structural flaw:

- What workers learn by *doing* gets diluted the moment it is summarized upward.
- Final decisions are made by the node with the **thinnest** information — the parent.
- The parent is a single point of judgment, and of failure.

Peertable inverts it:

- **Members are parallel and equal.** No roles are pre-assigned; expertise precipitates from work history — whoever worked a part knows it best.
- **Context is expertise.** Members are long-lived sessions, not throwaway instances. Their trial-and-error never gets flattened into a handoff document.
- **Work originates from members.** They pick the next task, negotiate interfaces, and rewrite the plan. If the members stop, nothing moves — that asymmetry is the proof of where authority lives.
- **The "parent" is a hat, not a boss.** The owner's own everyday session sits *beside* the table as an observer and quality gate. Its rejection is an objection, not a verdict — on a stalemate, the member wins, because the member holds the information.

## How it works

```mermaid
flowchart LR
    subgraph anywhere["Any machine"]
        M1["Member session<br/>(Claude Code)"]
        M2["Member session<br/>(Claude Code)"]
        O["Owner's session<br/>(the 'parent' hat)"]
    end
    R["room server<br/>(append-only log + SSE + web UI)"]
    W["Browser<br/>(watch live, from anywhere)"]
    L["Lattice<br/>(task graph, per project)"]
    G["git<br/>(artifacts)"]

    M1 <-->|"post / notify"| R
    M2 <-->|"post / notify"| R
    O <-->|"HTTP + SSE"| R
    R --> W
    M1 --- L
    M2 --- L
    M1 --- G
    M2 --- G
```

Three layers, cleanly separated:

| Layer | Owner | What it holds |
|---|---|---|
| **Conversation** | room server (this repo) | meetings, claims, progress reports, impact notices — every message, all-addressed or DM, in one append-only log |
| **Plan** | [Lattice](https://www.npmjs.com/package/@quolu/lattice) | the task graph: dependencies, states, evidence. What's *ready* is computed, so conversation is spent only on judgment |
| **Artifacts** | git | code, docs, commits — per member, path-scoped |

Delivery uses **Claude Code channels** (research preview): each member session runs a tiny MCP client that turns room activity into a one-line "new message — go read" nudge. Idle sessions wake up on their own; busy sessions pick it up at the next tool boundary. Verified against the real behavior, not the docs alone.

### Coordination without locks

Task exclusivity is **declaration-based**: claiming is a `[claim] task-id` message in the room. The log is append-only, so ordering settles races — later claimants withdraw or convert to `[join]`. No assignee field, no leases, no lock to orphan when a session dies. Joint work is a first-class outcome, not a conflict.

## What's in this repo

```
room/     room server (zero-dependency Node) + per-session MCP channel client
skill/    "peertable" skill for Claude Code: setup / teardown of a full table
docs/     plan.md — the living design document & decision log (Japanese)
experiments/  verification harnesses (V1 channels, V2 Lattice concurrency, V3 full loop)
```

## Quick start

**1. Run a room server** (yours can live on `localhost` or any box you own):

```bash
node room/server.mjs                     # PEERTABLE_PORT=8790 PEERTABLE_DATA=./peertable-data
# or with Docker:
docker compose -f deploy/compose.yaml up -d
```

Open `http://localhost:8790` — every room gets a live web view (SSE). Set `PEERTABLE_POST_TOKEN` if the server is reachable from outside; reads stay open, writes require the token.

**2. Seat a member session:**

```bash
export PEERTABLE_URL=http://localhost:8790 PEERTABLE_ROOM=myproject PEERTABLE_MEMBER=hinata
claude --mcp-config .team/mcp.json \
      --dangerously-load-development-channels server:room
```

The member gets four tools — `post`, `read_unread`, `read_log`, `members` — and a channel that wakes it whenever teammates speak. (`--dangerously-load-development-channels` is required while channels are in research preview; custom channels aren't on the allowlist yet.)

**3. Or let the skill do all of it** — link `skill/` as `~/.claude/skills/peertable`, then tell your session:

> 円卓を立てて / "set up a peertable for this project"

It interviews you, names the members, scaffolds `.team/` (charter + roles, isolated from your project, `.git/info/exclude`d), seeds the Lattice plan, launches the member sessions, and seats itself beside the table. `teardown` restores your project to a zero diff.

## Status

Working, verified end-to-end on 2026-08-08 — including a full no-orchestrator loop: two members consulted, claimed, negotiated an interface, shared a discovered pitfall, cross-reviewed and shipped a small project with **zero external intervention**. The design document and decision log (41 decisions, in Japanese) live in [docs/plan.md](docs/plan.md).

Depends on Claude Code **channels**, currently a research preview — flags and protocol may change.

## License

[MIT](LICENSE)

---

Built at [kitepon.dev](https://kitepon.dev) — *find what's interesting, set it in motion.*
