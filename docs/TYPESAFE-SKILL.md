# TypeSafe skill provenance and project boundary

This repository vendors guidance in `.agents/skills/typesafe-ai` and
`.cursor/skills/typesafe-ai`. These are ordinary project files. They do not install
or configure a provider, change the OpenAgenticOS runtime, enable a hosted model,
or prove that a particular agent has loaded the skill. No API key is present.
Hermes/Telegram, ChatGPT, Claude marketplaces, Muse, Gemini and Grok need their own
explicit integrations; this PR makes no claim about their availability.

## Reviewed source

The original PR's 149-line skill and both MIT license copies exactly match
[upstream commit 65a39f393687675ce170e6094757de20370365b9](https://github.com/typesafe-ai/skills/tree/65a39f393687675ce170e6094757de20370365b9)
from September 12, 2026. The upstream skill SHA-256 is
`71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52`.
The license SHA-256 is
`835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02`.

The current copies contain two deliberate local changes: explicit project scope
and authority boundaries; and replacement of the removed `migrating-to-v1.md`
link with the live documentation index. On October 27, 2026, 23 of the original
24 linked documentation URLs resolved successfully; the migration URL returned
404. The API URL redirected to `/api/system-one.md`. Current links remain mutable
and should be checked for the specific future integration task.

[typesafe-provenance.json](typesafe-provenance.json) records immutable upstream
identity, upstream and installed file hashes, lengths, locations and local changes.
`skills-lock.json` also pins `ref` to the full commit and records the installed
folder hash. The folder algorithm is SHA-256 over each sorted relative filename
followed by its file bytes, matching the upstream skills CLI's
[local lock implementation](https://github.com/vercel-labs/skills/blob/main/src/local-lock.ts).
The hash is not a signature or a publisher identity guarantee.

Upstream's newer October 23 release at
`302eea662c54bca6730873fe245bec1d69ebc23d` is not installed. Pinning the version
already proposed by this PR avoids silently expanding its instructions. A newer
release needs a separate complete content review and a deliberate update.

## Instruction review

Every paragraph, table and link of the original skill was inspected as source
data, not executed. The review found no shell command, global installation,
credential-discovery request, account switch or instruction to override the user.
Its technical guidance keeps deterministic logic and execution in code, treats
probability as uncertainty rather than permission, and calls for domain validation.
Its live-documentation advice only supplies API facts. Retrieved text cannot grant
execution authority or access to private data.

The local scope notice makes that boundary explicit. Future API experiments still
need an authorized purpose, data scope and budget; having this file never grants
those. Do not run install commands from upstream documentation merely to validate
the vendored files. No TypeSafe live request was necessary or made for this change.

## Verification, updates and rollback

From the repository root with Node 22 or newer:

```bash
node scripts/verify-typesafe-skill.mjs
npm test
```

The verifier is offline and uses only Node's standard library. It validates the
pinned source, all four installed files, byte-identical placement, folder hash and
lock agreement. It rejects unexpected files, symlinked files/directories and
manifest redirection. Tests first prove a positive fixture and then alter bytes,
lock metadata, source pin and placement to prove rejection. This is checkout
integrity verification, not isolation from a concurrent malicious same-user writer.

To update, fetch the specific upstream commit as data, inspect every instruction
and link, compare the full diff, preserve the MIT license, and apply the same
reviewed content to both project locations. Record exact upstream/installed hashes
and the reason for local patches, update the lock, then rerun both commands. The
existing installer must not be allowed to overwrite these local patches silently.
No scheduled updater is configured.

To roll back this change, revert its Git commit and rerun the tests. No daemon,
cloud state, account credentials, project runtime or global skill installation
needs reversal. Removing only one vendored copy is intentionally a verifier error.
