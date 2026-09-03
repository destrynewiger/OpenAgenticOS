# OpenAgenticOS

OpenAgenticOS is a local dashboard for the agent tools on your computer. It checks which surfaces respond, stores private notes on disk, and gives you a four-angle review of an idea without calling a hosted model.

The app ships with generic probes for Claude Code, Codex, Hermes, OpenClaw, and Ollama. Add or replace tools through a private config file. The browser cannot create probes or run commands.

## What you get

- A status board for local agent commands and loopback HTTP services
- Owner-only local memory with add and delete controls
- An offline council with Builder, Operator, Critic, and Memory lenses
- A loopback-only server with host and origin checks
- Zero runtime dependencies

OpenAgenticOS does not discover your network, control remote machines, send messages, or sync data. Those capabilities belong in separate adapters with explicit security boundaries.

## Run it

You need Node.js 22 or newer.

```bash
git clone https://github.com/destrynewiger/OpenAgenticOS.git
cd OpenAgenticOS
npm test
npm start
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180). The server binds to `127.0.0.1`, so other devices cannot connect to it.

## Configure surfaces

OpenAgenticOS works without a config file. To add a local tool:

```bash
mkdir -p ~/.config/openagenticos
cp examples/config.example.json ~/.config/openagenticos/config.json
chmod 600 ~/.config/openagenticos/config.json
```

Edit the copied file. Command probes use a fixed executable and argument list. HTTP probes accept plain HTTP URLs on `127.0.0.1`, `localhost`, or `[::1]` only.

Set `OPEN_AGENTIC_OS_CONFIG` if you want the config elsewhere. OpenAgenticOS rejects config files owned by another user or readable by a group or other users.

## Local data

Notes live at `~/.local/share/openagenticos/state.json`. The directory uses mode `0700`; the file uses `0600`. Set `OPEN_AGENTIC_OS_STATE` to choose a different path.

The status API returns labels, descriptions, states, and short results. It does not return configured commands, URLs, or command output.

## Develop

```bash
npm test
npm run dev
```

The project uses Node's built-in test runner and standard library. Start with a failing test for behavior changes.

## Project boundary

This repository contains generic product code and examples. Keep machine names, private network details, credentials, company data, and personal workflows in your private config or a private adapter repository.

Read [SECURITY.md](SECURITY.md) before exposing the process through a proxy or changing the loopback boundary.

## License

MIT. See [LICENSE](LICENSE).
