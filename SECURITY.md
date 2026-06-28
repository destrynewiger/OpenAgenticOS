# Security

OpenAgenticOS is designed to run as a local-first dashboard.

## Defaults

- The server binds to `127.0.0.1` by default.
- Generated data, local databases, provider keys, logs, and `.env` are ignored by git.
- External provider pushes are off unless explicitly enabled.
- Privileged endpoints that can run local CLIs or read local files require loopback access or `X-Ops-Token`.
- Cockpit CORS only auto-allows Chrome extension origins. Use `COCKPIT_ALLOWED_ORIGINS` for trusted extra origins.

## Exposing The App

Only set `HOST=0.0.0.0` when you understand the network exposure and have set `OPS_TOKEN`.

```env
HOST=0.0.0.0
OPS_TOKEN=replace_with_a_long_random_secret
```

## Reporting Issues

Please open a GitHub issue with a minimal reproduction. Do not include API keys,
database files, exported CSVs, or private workflow data.
