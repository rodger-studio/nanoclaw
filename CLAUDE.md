# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Deployment

Production runs on a VPS (`celian@85.190.242.114`) as a Docker container at `~/nanoclaw`. The local Mac instance is **stopped** (launchd unloaded).

Architecture: NanoClaw host container spawns agent containers as siblings via Docker socket mount (not Docker-in-Docker). `HOST_PROJECT_ROOT` env var maps container paths to host paths for volume mounts.

```bash
# Deploy changes to VPS
ssh celian@85.190.242.114 "cd ~/nanoclaw && git pull && sg docker -c 'docker build -t nanoclaw:latest . && docker compose down && docker compose up -d'"

# Rebuild agent container on VPS
ssh celian@85.190.242.114 "cd ~/nanoclaw && sg docker -c 'docker build -t nanoclaw-agent:latest -f container/Dockerfile container/'"

# Check logs
ssh celian@85.190.242.114 "sg docker -c 'docker logs nanoclaw --tail 30'"

# Restart
ssh celian@85.190.242.114 "sg docker -c 'cd ~/nanoclaw && docker compose restart'"
```

Key files: `Dockerfile` (host image), `docker-compose.yml` (compose config), `.dockerignore`.

The main agent mounts the project root read-only: never leave a secret there. `.env*` files, `secrets/` and `data/env/` are shadowed (`src/secret-shadows.ts`); keep `.env` backups in `~/.config/nanoclaw-backups/`.

Non-sensitive `.env` vars are auto-forwarded to agent containers. Vars prefixed with `ANTHROPIC_`, `CLAUDE_CODE_`, `SLACK_`, `WHATSAPP_`, `TELEGRAM_`, `DISCORD_`, or `GMAIL_` are blocked (handled by credential proxy or host-only).

Slack channels auto-register when the bot is @mentioned. DMs auto-register without needing a trigger.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
