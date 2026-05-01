# Cross-OS Drev test: Windows producer → Mac consumer

## What we're testing

End-to-end validation that Drev's session-share pipeline works **across operating systems**, specifically Windows producer → Mac consumer. This is T27 in the Drev v0 plan and the last gate before tagging v0.1.1.

### Goal

Capture a Claude Code session on Windows. Share it via Drev. Pull and resume it on a Mac. Verify Claude Code on the Mac has full transcript context AND the rewritten paths are valid POSIX paths (not Windows paths with backslashes).

### Why this matters

Two things only became real with the v0.1.x cross-OS rewrite work:

1. **Path prefix swap**, `F:\Nuts Projects\drev` → `/Users/<you>/work/test`. Was already working in v0.1.0.
2. **Mid-path separator translation**, `\src\foo.ts` → `/src/foo.ts` after the prefix swap. New in v0.1.x. Without this, file references in tool calls are malformed on the Mac side and Claude can't resume actions that touch files.

The test below confirms both.

### Test procedure (run after the auth setup below works)

#### On Windows (producer: already set up)

1. Have a real Claude Code session of decent size, ≥30 turns and ≥5 tool calls. The Drev build conversation itself qualifies, or pick any recent project session.
2. Find its session id:
   ```bash
   ls -t ~/.claude/projects/*/*.jsonl | head -1
   # the filename (minus .jsonl) is the session id
   ```
3. Share it:
   ```bash
   drev share --session-id <id> --name xos-test
   ```
4. Confirm it pushed:
   ```bash
   drev list
   # Should show 'xos-test' with id-prefix and your username
   ```

#### On Mac (consumer)

1. Get drev installed and auth'd (see auth setup below if you haven't)
2. Init against the same repo:
   ```bash
   drev init git@github-<label>:Codeturion/drev-test-sessions.git
   # Or the URL form if you went the gh-switch route
   ```
3. Pull the latest and confirm the share is visible:
   ```bash
   drev list
   # Should see 'xos-test' shared by you from the Windows machine
   ```
4. Pick a destination directory and resume:
   ```bash
   mkdir -p ~/work/drev-xos-test
   cd ~/work/drev-xos-test
   drev resume xos-test
   ```
5. Drev should print:
   - "Resuming 'xos-test' in /Users/<you>/work/drev-xos-test..."
   - then spawn `claude --resume <id>`
6. Claude Code launches with the resumed session.

#### Verify

In the resumed Claude Code session on the Mac, ask:

> "What were we working on in the last session, and what files did we touch?"

Expected: Claude answers with details from the Windows session, same project, same tasks, same files. The file paths it remembers will be the **rewritten** ones (`/Users/<you>/work/drev-xos-test/...`), not the original Windows ones.

If you want to push further, ask Claude to read one of the files it remembers. The path will be POSIX-valid (forward slashes throughout). The file won't actually exist on the Mac (this is a test machine, not a clone of the Windows project), but Claude's `Read` call will hit the filesystem with a well-formed path and get a clean "file not found", not a "ENOENT: invalid path" or similar separator-confusion error.

### Pass criteria

- ✓ `drev resume` exits without errors
- ✓ Claude Code launches with the session
- ✓ Recall question answered with details from the Windows session
- ✓ A file path Claude tries to read is a valid POSIX path (`/Users/.../src/foo.ts`, not `/Users/.../src\foo.ts`)

### Failure modes to flag

- **"Repository not found" during `drev init` on Mac** → see auth setup below; usually a missing collaborator invite or wrong account active in `gh`.
- **`drev list` shows nothing on Mac** → producer didn't push, OR Mac is talking to the wrong remote, OR collaborator invite still pending.
- **Resume succeeds but Claude says it has no memory of prior session** → JSONL didn't land at the encoded-cwd path. Check `~/.claude/projects/<encoded>/<id>.jsonl` exists.
- **Claude tries to read a file with mixed-separator path** → the cross-OS separator translation regressed. Check `core/path-rewriter.ts` and run `npm test -- path-rewriter` to verify the cross-OS test cases pass.

---

# Using Drev with multiple GitHub accounts on one machine

If you have two GitHub accounts on the same machine (e.g., a work account and a personal account), and only one of them has access to your Drev session repo, you need to make sure `drev`/`git` use the right credentials without disrupting the other account's repos.

This guide assumes the standard case: a work account is the "default" identity for everything, and you want a second (personal) account to access a specific Drev repo cleanly.

## Why this is needed

`drev` is a CLI; it shells out to `git`. `git` uses macOS Keychain (or Windows Credential Manager / Linux libsecret) to cache credentials per host. The Keychain typically stores **one credential set per host**, so whichever account was last used for `github.com` becomes the default for everything else.

GUI Git clients like Fork, GitHub Desktop, GitKraken keep their own per-account credential stores. Those don't help here, `drev` doesn't see them.

You need to configure `git` and/or `gh` directly, not the GUI client.

## Symptom

Running `drev init <Codeturion/some-repo>` (or any URL pointing at a repo only the second account has access to) fails with:

```
ERROR: Repository not found.
fatal: Could not read from remote repository.
```

GitHub returns "not found" rather than "no access" for private repos, so this error usually means **wrong account is authenticated**, not that the repo is missing.

---

## Recipe: SSH host alias (recommended)

This gives the second account its own SSH key, accessed via a fake hostname. The default account's setup stays completely untouched.

### 1. Generate a key for the second account

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_<account-label> -N "" -C "<your-email-for-that-account>"
```

Replace `<account-label>` with anything memorable (e.g., `personal`, `gmail`, `codeturion`). Replace the email with whatever email is associated with the second GitHub account.

### 2. Add the public key to the second GitHub account

```bash
cat ~/.ssh/id_ed25519_<account-label>.pub
```

Copy the output. In a browser **logged in as the second account**, go to https://github.com/settings/keys → New SSH key → paste it.

Verify the right account:
```
https://github.com/settings/profile
```
should show the second account's username.

### 3. Add a host alias to your SSH config

```bash
cat >> ~/.ssh/config <<'EOF'

Host github-<account-label>
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_<account-label>
    IdentitiesOnly yes
EOF
```

`IdentitiesOnly yes` is important, it tells SSH to use **only** this key for this alias, not whatever else is in your agent.

### 4. Test the connection

```bash
ssh -T git@github-<account-label>
```

You should see:
```
Hi <second-account-username>! You've successfully authenticated, but GitHub does not provide shell access.
```

If you see "Permission denied" or it greets you with the wrong username, the key didn't get added correctly, re-check step 2.

### 5. Use the alias with drev

Instead of:
```bash
drev init <Org>/<Repo>
# or
drev init https://github.com/<Org>/<Repo>.git
```

Use the SSH alias form:
```bash
drev init git@github-<account-label>:<Org>/<Repo>.git
```

drev will clone via SSH using only the second account's key. The local clone's `origin` is set to the SSH-aliased URL, so all subsequent `drev share`, `drev resume`, etc. continue using the second account.

### 6. Verify nothing else broke

Pick any other repo cloned via the default account on the same machine, `cd` into it and run `git pull`, `git fetch`, `git push`. Should work exactly as before. The host alias only intercepts URLs that explicitly use it; everything else still goes through `github.com` with whatever credentials Keychain holds.

---

## Pre-flight: confirm the invite landed on the right account

If the second account hasn't been invited to the Drev repo, no auth setup will help, the repo really is "not found" for that account.

From the **producer's** machine (the one that owns the repo):

```bash
# List current collaborators on the repo
gh api /repos/<Org>/<Repo>/collaborators

# If the second account isn't there, invite it
gh repo add-collaborator <Org>/<Repo> <second-account-username> --permission write
```

On the Mac (or whichever machine has the second account), accept the invite:

```bash
gh api /user/repository_invitations
# Find the invite_id (e.g., 12345678), then:
gh api -X PATCH /user/repository_invitations/12345678
```

Or just click the invite email link in a browser logged in as the second account.

---

## Alternative: `gh auth login` with multiple accounts

If you'd rather not deal with SSH keys, `gh` natively supports multiple GitHub accounts since v2.40. Both accounts are kept logged in; you switch between them with `gh auth switch`.

```bash
# On Mac, while already logged in as the work account
gh auth login
# Choose: github.com → HTTPS → web browser
# Authenticate as the second account in the browser
# When prompted, allow it to set up git credentials

gh auth status
# Lists both accounts; the most recently-added is active
```

To use the second account for drev:

```bash
gh auth switch --user <second-account-username>
drev init <Org>/<Repo>
# … do drev work …
gh auth switch --user <work-account-username>
# back to your normal setup
```

**Caveat:** while the second account is active, *all* `git` operations against `github.com` (in any directory, any repo) use the second account's token. If the second account doesn't have access to your work repos, pulls/pushes there will fail until you switch back. The SSH-alias path doesn't have this caveat.

---

## Alternative: Personal Access Token in clone URL (one-off)

Quickest, dirtiest option for a one-shot test. Generate a PAT on the second account and embed it in the clone URL.

1. While logged in as the second account at https://github.com/settings/tokens, generate a fine-grained PAT with `repo` scope, restricted to the Drev repo only.
2. Use it directly:

```bash
drev init https://x-access-token:<PAT>@github.com/<Org>/<Repo>.git
```

The token gets baked into `~/.drev/repos/<name>/.git/config`. Pushes from drev use it.

**Drawbacks:**
- Token visible in shell history and process list during init
- Token persists in the local repo's git config until you remove the clone
- Manual rotation if the PAT expires

Use this only for a quick test. SSH alias is the long-term answer.

---

## Cleanup

When you're done with the second-account setup:

### SSH alias path

```bash
# Remove the host alias (edit ~/.ssh/config and delete the "Host github-<label>" block)

# Remove the key
rm ~/.ssh/id_ed25519_<account-label> ~/.ssh/id_ed25519_<account-label>.pub

# Revoke the key on GitHub: Settings → SSH and GPG keys → Delete the key
```

### gh auth path

```bash
gh auth logout --user <second-account-username>
# leaves the work account logged in, untouched
```

### PAT path

```bash
# Remove the local clone
rm -rf ~/.drev/repos/<name>

# Revoke the PAT at https://github.com/settings/tokens
```

---

## Quick reference

| Goal | Command |
|---|---|
| Diagnose: which account is git auth'd as on Mac? | `gh auth status` |
| Diagnose: does the second account see the repo? | `gh repo view <Org>/<Repo>` (while auth'd as second) |
| Invite second account from producer machine | `gh repo add-collaborator <Org>/<Repo> <user> --permission write` |
| Accept invite on Mac | `gh api /user/repository_invitations` then `gh api -X PATCH /user/repository_invitations/<id>` |
| Init drev via SSH alias | `drev init git@github-<label>:<Org>/<Repo>.git` |
| Init drev via gh-active account | `gh auth switch --user <second>` then `drev init <Org>/<Repo>` |

---

## Why Fork (or any GUI Git client) doesn't help

Fork stores per-account OAuth tokens in its own settings file (`~/Library/Application Support/com.DanPristupov.Fork/`). It applies these tokens only to operations performed inside Fork. When drev shells out to `git clone`, the system's `git` binary uses the system's credential helper (Keychain on Mac, NOT Fork's store). The two are independent.

If you want drev's git operations to follow the same account Fork uses, you have to mirror Fork's auth into one of:
- macOS Keychain (the default `git` credential helper)
- An SSH key (per the recipe above)
- A `gh` login (which then writes to Keychain via `gh auth setup-git`)

The SSH alias path is cleanest because it sidesteps the "one credential per host" Keychain limitation, different host aliases get different keys, no conflict.
