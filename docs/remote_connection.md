# Remote Connection Template

This document describes the public, sanitized remote-agent setup for Loopy.
Keep real hostnames, usernames, SSH key paths, and workspace paths in
`config/loopy.local.json`, which is ignored by git.

## Local Private Config

Copy the example file and edit it for your own machine:

```bash
cp config/loopy.example.json config/loopy.local.json
```

Example shape:

```json
{
  "defaults": {
    "workspace": "/path/to/local/workspace",
    "remoteTarget": {
      "label": "Remote machine",
      "host": "user@example.com",
      "sshKey": "~/.ssh/example",
      "remoteCwd": "/home/user/git"
    }
  }
}
```

`LOOPY_LOCAL_CONFIG` can point Loopy at another JSON file:

```bash
LOOPY_LOCAL_CONFIG=/path/to/private/loopy.local.json npm run dev
```

## Remote Agent Expectations

- `host` is the SSH target that `ssh` can connect to from the local Mac.
- `sshKey` is optional; omit it if your SSH config already selects the key.
- `remoteCwd` is the directory where remote agent commands run.
- Loopy uploads prompts to `/tmp/loopy-prompts/` and runs remote jobs through SSH.
- Do not commit real remote connection details, database files, session logs, or build artifacts.

## Manual Smoke Test

Before using a remote profile in the UI, verify the target manually:

```bash
ssh -i ~/.ssh/example user@example.com "cd /home/user/git && node -v && npm -v && git status --short"
```

Then start Loopy and open Agent Settings. When `config/loopy.local.json` has a
valid `remoteTarget`, the remote defaults button will fill the SSH fields for
new remote profiles.
