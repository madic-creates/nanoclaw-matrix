---
name: add-matrix
description: Add Matrix as a channel. Uses matrix-bot-sdk with a regular bot user on the user's own Synapse homeserver. Supports group rooms and DMs, with optional E2EE for encrypted rooms.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/matrix.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Matrix bot user and access token, or do you need help creating one?

If they have one, collect it now. If not, guide them through creation in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `matrix` is missing, add it:

```bash
git remote add matrix https://github.com/qwibitai/nanoclaw-matrix.git
```

### Merge the skill branch

```bash
git fetch matrix main
git merge matrix/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/matrix.ts` (MatrixChannel class with self-registration via `registerChannel`)
- `src/channels/matrix.test.ts` (unit tests with matrix-bot-sdk mock)
- `import './matrix.js'` appended to the channel barrel file `src/channels/index.ts`
- `outbound_events` table added to `src/db.ts` (for reaction targeting)
- `getAvailableGroups()` updated in `src/index.ts` (DMs now appear in discovery)
- `matrix-bot-sdk` npm dependency in `package.json`
- Matrix env vars in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npm test
```

All existing tests must still pass plus new Matrix-specific tests.

## Phase 3: Setup

### Step 1: Verify Node version

`matrix-bot-sdk` depends on `@matrix-org/matrix-sdk-crypto-nodejs` which requires Node >= 22 for E2EE support.

```bash
node --version
```

If Node < 22 and user wants E2EE, warn them to upgrade Node first.

### Step 2: Create bot user (if needed)

Guide the user through creating a Matrix bot user on their Synapse homeserver:

**Option A — Synapse Admin API (recommended):**
```bash
# From a machine with admin access to Synapse
curl -X PUT "https://matrix.example.com/_synapse/admin/v2/users/@nanoclaw:example.com" \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"password": "<strong_password>", "displayname": "NanoClaw", "admin": false}'
```

**Option B — Manual registration:**
1. Enable registration temporarily on Synapse or use `register_new_matrix_user`
2. Create user `@nanoclaw:example.com` with a strong password

Then get an access token:
```bash
curl -X POST "https://matrix.example.com/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type": "m.login.password", "user": "@nanoclaw:example.com", "password": "<password>"}'
```

The response `access_token` field is what goes in `MATRIX_ACCESS_TOKEN`.

### Step 3: Collect credentials

AskUserQuestion: Please provide the following Matrix credentials:

1. **Homeserver URL** (e.g., `https://matrix.example.com`)
2. **Access Token** (the `syt_...` token from login)
3. **Enable E2EE?** (yes/no — requires Node >= 22)
4. **Enable auto-join?** (yes/no — if yes, provide allowed sender list)
5. **Allowed senders** (comma-separated Matrix user IDs, e.g., `@alice:example.com,@bob:example.com`)

### Step 4: Write credentials

Write to both `.env` and `data/env/env`:

```
MATRIX_HOMESERVER_URL=<homeserver_url>
MATRIX_ACCESS_TOKEN=<access_token>
MATRIX_E2EE=<true|false>
MATRIX_AUTO_JOIN=<true|false>
MATRIX_ALLOWED_SENDERS=<comma_separated_user_ids>
MATRIX_MAX_FILE_SIZE=52428800
```

### Step 5: Build and start

```bash
npm run build
```

Restart NanoClaw:
```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 6: Verify connection

Check the logs for `Matrix: connected`:
```bash
journalctl --user -u nanoclaw --since "1 minute ago" | grep -i matrix
```

### Step 7: E2EE verification (if enabled)

If E2EE was enabled, verify the crypto store was created:
```bash
ls -la store/matrix-crypto/
```

**Important:** Include `store/matrix-crypto/` in regular host backups. This is the only recovery mechanism for E2EE keys. If this directory is lost, the bot creates a new device and cannot decrypt old messages.

### Step 8: Register a room

AskUserQuestion: Which Matrix room should I register? Please provide the Room ID (starts with `!`, e.g., `!abc123:server.example`).

You can find room IDs in Element: Room Settings > Advanced > Internal room ID.

Register:
```bash
npx tsx setup/index.ts --step register --channel matrix --jid '<room_id>'
```

If auto-join is disabled and the bot has a pending invite:
```bash
# The setup script will call client.joinRoom() to accept the invite
```

### Step 9: Test message

Send a test message in the registered Matrix room. If trigger is required, mention the bot name. Verify the bot processes and responds.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MATRIX_HOMESERVER_URL` | Yes | — | Synapse homeserver URL |
| `MATRIX_ACCESS_TOKEN` | Yes | — | Bot user access token |
| `MATRIX_E2EE` | No | `false` | Enable end-to-end encryption |
| `MATRIX_AUTO_JOIN` | No | `false` | Auto-join rooms on invite |
| `MATRIX_ALLOWED_SENDERS` | No | — | Comma-separated user IDs for auto-join allowlist |
| `MATRIX_MAX_FILE_SIZE` | No | `52428800` | Max file size in bytes (50 MB) |

## Storage Paths

| Path | Purpose | Backup? |
|------|---------|---------|
| `store/matrix/bot.json` | Sync state, filter IDs | Optional |
| `store/matrix-crypto/` | Device keys, Olm/Megolm sessions | **Critical** |

## E2EE Key Backup (User Responsibility)

There is **no recovery key** for this Matrix integration. Unlike Element, which uses server-side key backup with a recovery key, `matrix-bot-sdk` does not implement the key backup API. The **only** way to recover E2EE keys is a filesystem backup of `store/matrix-crypto/`.

**You are responsible for backing up this directory.** Without it, a lost crypto store means:
- The bot creates a new device on next start
- All previous Megolm sessions are permanently lost
- Messages from before the loss can never be decrypted

### Can I import the backup into Element?

No. The formats are incompatible:
- NanoClaw uses a Rust-based SQLite crypto store (`@matrix-org/matrix-sdk-crypto-nodejs`)
- Element uses IndexedDB (browser) or its own format (desktop)
- Keys are device-specific — they belong to the bot's device, not to an Element device

Element's server-side key backup (with recovery key) also cannot be read by the bot, since `matrix-bot-sdk` does not implement the key backup download API.

### Recommended backup approach

Include `store/matrix-crypto/` in your regular host backup (e.g., restic, borgbackup, rsync, or filesystem snapshots). The directory is small (typically < 10 MB) and changes infrequently.

## Limitations

- Bot appears as "unverified session" in Element (no cross-signing support in bot-sdk)
- No server-side key backup — see [E2EE Key Backup](#e2ee-key-backup-user-responsibility) above
- No late-decryption retry for UTD events
