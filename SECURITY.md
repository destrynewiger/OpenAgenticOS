# Security

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting feature on this repository.

Include the affected version, a minimal reproduction, and the impact you observed. Remove credentials and personal data from logs or screenshots.

## Security model

OpenAgenticOS binds to `127.0.0.1` and accepts browser requests for loopback hosts and origins. It reads probes from a private startup config. Browser requests cannot add commands or URLs.

The app rejects config and state files that are not owned by the current user or that grant access to group or other users. It limits JSON request bodies to 24 KB and sets a restrictive Content Security Policy.

Do not expose OpenAgenticOS through a public reverse proxy. Review authentication, authorization, CSRF protection, TLS, audit logging, and command isolation before adapting it for remote access.
