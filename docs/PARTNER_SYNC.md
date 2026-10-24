# Partner sharing and multi-device sync (design)

**Status:** design; phase 0 spike done (§15); phase 1 local data model done (§16). Nothing syncs yet. **Decided by the product owner on 2026-10-21:**
1. Online sharing uses **end-to-end encrypted sync**. The server stores only ciphertext.
2. **Memories, photos included, are visible to every member** of the shared space.
3. **After leaving or a breakup, each person keeps everything** they have locally.
4. Lost devices are recovered with a **recovery key**, not a password.
5. When a partner joins with existing data, their dates and memories are **merged in**. If the two start dates differ, the joiner chooses which one becomes the shared date.
6. Both people can edit and delete everything. Deletions go to a **trash** ("Recently deleted") for 30 days, and either person can restore from it.
7. Dates added by the partner arrive **without reminders**, with a "New date from Sam" badge. A per-device setting can apply your default reminders to them automatically.

This departs from the spec, which lists partner sync and encrypted sync as later features (§16) and excludes any cloud backend in the first release (§1.5, §0.7). The departure is recorded here the same way as `USAGE_ANALYTICS.md`. Solo use stays fully offline: nothing in this document runs until the user turns sharing on.

---

## 1. Goals and non-goals

**Goals**
- Invite a partner. Both phones then show the same start date, both names ("Matthieu & Sam"), the same dates and the same memories.
- One person can use several devices (phone, tablet, a second phone) with the same data.
- The server cannot read names, dates, notes or photos.
- The app stays offline-first. Local SQLite remains the source of truth for the UI, widgets and watches.
- Leaving dissolves sharing cleanly: each person keeps a full local copy, and the server copy is deleted.

**Non-goals (v1)**
- Real-time collaboration and typing indicators.
- More than two people in a space.
- Web access.
- Private memories, since all memories are shared.
- Push notifications. Sync runs on launch, on resume, after a local change, and on pull-to-refresh.
- Watches as members. Watches keep receiving the snapshot from their phone, as today.

## 2. Concepts

```text
Space "Matthieu & Sam"  ──  space key K (epoch n)
├── Person: Matthieu  ── recovery envelope (K wrapped with Matthieu's recovery key)
│   ├── Device: Pixel      (X25519 + Ed25519 keys, private keys in Keystore)
│   └── Device: tablet
└── Person: Sam       ── recovery envelope
    └── Device: iPhone     (private keys in Keychain, this device only)
```

- **Space:** the shared couple. It holds the profile, persons, milestones, memories and media. There is at most one space per device in v1.
- **Person:** a human member, with their own display name. An author is always a person, never a device.
- **Device:** an installation. It has a long-term identity created on first sync and stored in secure storage. It is a member of exactly one person.
- **Space key `K`:** 32 random bytes with an **epoch** number. It is replaced on every membership removal (§7).

## 3. Cryptography

Library: **libsodium.js** (`libsodium-wrappers`, standard build, WASM). It runs in the WebView, so iOS and Android share the same code.

| Purpose | Construction |
|---|---|
| Device identity | `crypto_sign` (Ed25519) for request signatures; `crypto_box` keypair (X25519) to receive keys |
| Record encryption | `crypto_aead_xchacha20poly1305_ietf` with key `K[epoch]`, a random 24-byte nonce, and AAD = `spaceId ‖ recordType ‖ recordId ‖ epoch ‖ version ‖ deleted`. Authenticating the server-visible version and tombstone flag stops rollback (replaying an old ciphertext under newer metadata) and tombstone flipping. |
| Key delivery to a device | `crypto_box_seal(K[epoch], devicePublicKey)` |
| Photos | Per-file random key; `crypto_secretstream_xchacha20poly1305` in 64 KiB chunks (resumable, constant memory); the file key is stored inside the encrypted media record |
| Invite secret | 32 random bytes, sent only in a URL fragment or QR code; `crypto_kdf` derives the invite key |
| Recovery key | 184 random bits plus a 16-bit checksum, shown as grouped Crockford base32 (§8); BLAKE2b then `crypto_kdf` derive the lookup ID and the seed of an X25519 key pair; each epoch's key is sealed to its public half (revised in phase 4, §8). No password stretching is needed, which matters because the standard build has no `crypto_pwhash`. |
| Safety code | Keyed `crypto_generichash`, keyed with a subkey of the invite secret, over both devices' **signing and encryption** public keys and the invite ID. Shown as 6 digits on both screens. The server never sees the secret, so it can't swap an encryption key unnoticed or grind key pairs offline to match the digits. |

**Key storage:** `@aparajita/capacitor-secure-storage` 8.x (iOS Keychain, Android Keystore). To verify in the spike:
- the Keychain item is *ThisDeviceOnly* and excluded from iCloud backup;
- the Android key is hardware-backed where available.

Keys are decrypted into WebView memory while the app runs. That's acceptable for this threat model; see §11.

## 4. Server

**Recommended:** Supabase, EU region (Frankfurt), used as a store for encrypted data plus a few Edge Functions. Self-hosting (Postgres + S3-compatible storage + a small Bun service) is the fallback. The API is kept small so it can move.

**Device authentication**
- Supabase anonymous sign-in gives each device a JWT. The **device's keys are the real identity**; the JWT is only the transport credential, and the session is kept in the secure store. If it is lost or expired, the device signs in anonymously again and **re-attaches** its device row by proving a random 32-byte secret that only it holds (the server stores its SHA-256, and the secret is replaced on every re-attach). As built in phase 2 this replaces the signed challenge planned here, because Postgres cannot verify Ed25519 signatures without an extra service; signed requests for membership changes remain an option (§17).
- Abuse protection comes from Play Integrity and App Attest, or captcha, plus rate limits on registration and invites. Abandoned anonymous users and devices are cleaned up after 180 days without a sync.

**Tables** (row-level security limits every row to devices that are members of its space):

| Table | Contents (server-readable fields → everything else encrypted) |
|---|---|
| `spaces` | id, current epoch, created_at |
| `persons` | id, space_id → name and metadata in `records` |
| `devices` | id, person_id, public keys, platform, last_seen_at, revoked_at |
| `key_envelopes` | space_id, epoch, device_id or recovery_lookup_id, sealed key |
| `records` | space_id, record_type, record_id, version (HLC), deleted flag, epoch, nonce, ciphertext |
| `blobs` | space_id, blob_id, size, ciphertext (Supabase Storage, per-space prefix) |
| `invites` | id, space_id, inviter_device_id, expires_at, used_at, envelope (K wrapped with the invite key), joiner public keys, approved_at |

**Sync protocol:** a pull and push of records with `version > cursor`, paged. Records are upserted only when the version is newer. Blobs are uploaded before the record that references them.

## 5. Local data model changes (migration v2, implemented — see §16)

IDs are already random UUIDv4 (`core/persistence/ids.ts`), so no re-keying is needed.

- New tables:
  - `sync_state`: space ID, the device's own person ID, cursor, epoch.
  - `persons`: ID, display name, is-self.
  - `outbox`: pending local changes.
- **Synced tables:** `relationship_profile`, `milestones`, `memories`, `memory_media`, `persons`. Each gets the columns `version` (HLC), `deleted_at` (tombstone) and `author_person_id`.
- **Local only, never synced:**
  - settings: theme, accent, language, counter format, widget privacy and counter mode, timeline order, usage consent, leap-day default;
  - `reminder_rules` and notification IDs;
  - `calendarTimeZoneId`, because long-distance couples have different "todays";
  - widget and watch snapshots;
  - media file paths. Each device writes its own decrypted copy, and the files are synced as encrypted blobs.
- **Profile:** the start date, optional start time and its zone, and the relationship label are shared. `display_name` is replaced by **persons**, and the UI shows "Matthieu & Sam". The device's own person can show "You" where the wording needs it.
- **Clock:** a hybrid logical clock (wall time, counter, device ID). **v1: the newest version of a whole record wins** (changed from per-field during phase 2, see §17). A delete is a tombstone, and trashing and restoring are ordinary versioned writes, so between a delete and an edit the newer one wins too; an item is never lost because it sits in the trash for 30 days (§6.6). Per-field merging for the profile and milestones can come later without a format change, because records stay whole. Media in a memory are separate records, so adding and removing photos never conflict.

## 6. Flows

### 6.1 Turn on sharing (inviter)
1. In Settings, choose Share with my partner, then **Invite**. This creates the device identity, the space, the person ("What's your name?") and `K[1]`.
2. Local data is uploaded as encrypted records and blobs.
3. The **recovery key** is shown (§8). This step can't be skipped.
4. An invite is created: single-use, valid for 24 hours. It's shown as a **QR code** (in person) or a **link**:
   - The link is `https://<domain>/join#<inviteId>.<secret>`. The fragment is never sent to the server.
   - Links need a domain plus Android App Links and iOS Universal Links. **This is blocked until a domain exists.**
   - QR codes work without a domain.
   - A plain `harmonia://` scheme is not used for invite secrets, because another app can claim it on Android.

### 6.2 Join (partner)
1. Open the link or scan the code. The app installs if needed, then the deferred link opens.
2. The **consent screen** states:
   - everything in the space is visible to both of you, memories and photos included;
   - if you leave, each of you keeps a full copy and nothing can be taken back.
3. The joiner enters their name. The device registers, and its public keys are posted to the invite.
4. The **inviter's device asks for approval** ("Sam wants to join"), and both screens show the same **6-digit safety code**. Only after approval is `K` sealed to the joiner's device.
5. **Existing data on the joiner's phone** (decided, see 5 above):
   - the start date, start time and label come from the space;
   - if the joiner's start date differs, they choose which one becomes the shared date;
   - the joiner's dates and memories are **merged in**, with no duplicates by ID.
   
   A "Start from the shared space only" option first writes the joiner's data to an export file.
6. The joiner's earlier "partner name" becomes only a suggestion. **Each person's own entered name wins.**

### 6.3 Add one of my devices
On an existing device, choose **Add a device** to show an invite code (QR later). The new device enters it, registers, shows the safety code, and is approved on the existing device. It becomes a device of the **same person** (§7.6). A recovery key also works (§8).

### 6.4 Remove a device (lost or replaced)
From any device in the space:
1. The server revokes the device, so its JWT and signature no longer work.
2. A new epoch `K[n+1]` is sealed to the remaining devices on the verified device list and to every recovery envelope (§7.4).
3. Future writes use the new epoch.

**The removed device keeps what it already downloaded.** This is unavoidable, and it's why the app lock exists (`docs/APP_LOCK.md`, phone unlock).

### 6.5 Leave or dissolve (breakup)
Either person can choose **Leave the space**. The space is **dissolved** for both people:
- Each device converts its local data to solo mode, so **everyone keeps everything**.
- The server deletes all records, blobs, envelopes and devices of the space.
- The other person's devices detect the dissolution on their next sync and switch to solo mode with a gentle notice.

This choice is irreversible. It's offered with clear wording and, as an option, an export first.

### 6.6 Edits and deletions
Both people can edit and delete everything; partners are equal (decided). Deleted items go to the **trash** ("Recently deleted") for 30 days, and either person can restore them. Deleting from the trash, or reaching 30 days, removes the item for good, including its photos on the server. The trash is synced: a restore on one device restores the item everywhere.

### 6.7 Reminders for shared dates
Reminder rules are per device. When the partner adds a date, it arrives **without reminders** and shows a "New date from Sam" badge. A per-device setting, "Remind me about dates my partner adds", applies the default offsets (decided). Notifications keep using the reserved local ID ranges.

## 7. Devices and key rotation

*Revised 2026-10-23 (phase 3), before building it: rotation now seals only to devices on an end-to-end encrypted device list, never to keys read from the server.*

### 7.1 Why a verified device list
Removing a device seals a new space key `K[n+1]` to every remaining device. If the sealing device took their public keys from the server's `devices` table, a hostile server could slip in a key of its own and read everything written from then on: the same attack as unsigned envelopes (§17). So devices learn each other's keys only from **device records inside the space**, encrypted with `K` like every other record. The server can't write those, because it never has `K`.

### 7.2 Device records
- A new synced record type `device`, one per device. Its ID is the device's server ID (stable: re-attaching keeps it).
- Shared fields: `person_id`, `sign_public_key`, `box_public_key`, `platform`, `revoked_at`. Locally a new table `space_devices` (migration 4). No name or model: the screen says "Sam's Android phone" or "This device".
- **Each device writes only its own record**, when it creates or joins the space and again on any sync where it finds its record missing or out of date. The one exception: the device that removes another writes `revoked_at` into the removed device's record (§7.4). Nobody copies another device's keys from the server into a record, not even after comparing the safety code: if nobody compared it, the server could have swapped those keys.
- **Trust:** only members hold `K`, and the server never does, so a device record is either written by that device or by another member. Members are trusted by design (§11). The server can neither read nor forge these records.
- Received device records follow the usual rules: last writer wins per record; the payload rules check the keys (32 bytes each), the platform and the dates; `SYNC_CAPABILITY` goes up, so older builds pull them again once updated.
- **Schema:** the server's `records.record_type` check gains `device` (a migration). The local `outbox` table checks `record_type` too, and SQLite can't change a check, so migration 4 rebuilds that table (copy, drop, rename). Going solo also clears `space_devices`.
- **Existing spaces** (test servers only so far): each device writes its own record on its first sync with this version.

### 7.3 Envelopes signed by the device that sealed them
Envelopes gain a `signer_device_id`. A device trusts an envelope only if its signature verifies with the signer's signing key, and the signer is:
- this device itself (as today); or
- a device on the verified list that has not been removed.

A device whose signer was itself removed later can't verify that older envelope. That happens only if the device missed two rotations and the first remover was removed afterwards. It then shows that it can't open the new key, and adding it again fixes it.

### 7.4 Removing a device (§6.4)
0. The removing device records the removal locally (it is resumed on every sync until the server has rotated, and the device shows as "Removal pending" meanwhile). It then writes the removed device's record with `revoked_at` **under the current key `K[n]`** and uploads **only device records**: other changes wait for the new key. While a removal is pending, a sync only downloads, and a second removal is refused until the first is done. Every other device can read that record with the key it already holds, so it knows who was removed before it is offered a new key.
1. The removing device creates `K[n+1]` and **stores it locally first**.
2. It seals `K[n+1]` to every remaining device on its verified list (and to itself), signing each envelope.
3. **One server call does the rest, all or nothing:** `rotate(target, expected_epoch, envelopes)`. In one transaction it checks that the space is still at `expected_epoch`, marks X revoked (its requests stop working), starts epoch `n+1` and stores the envelopes. Each target must be a non-revoked device of the space, and the signer must be the caller (`current_device_id()`). If another removal got there first, the epochs no longer match and it refuses: the device syncs to the new epoch and tries again. The server says *target not in space* when the device was already removed (the removal is then done) and *unknown recipient* when one of the envelopes was for a device it has removed meanwhile; the sealing device also leaves out devices the server reports as removed (sealing to fewer devices can't leak a key). Offline, a refusal, or a crash before the call: the removal stays pending and is retried on the next sync, from whatever epoch the space is at then (if the server already removed the device, there is nothing left to do). A crash after the call is finished by the next sync.
4. (X's record already says it was removed: step 0.)
5. **From then on the server skips record writes under an older epoch silently**, like stale and far-future ones, so one such row never fails an upload. The engine sees that the write didn't land, and the change stays queued until the device has the new key.
6. Every other device notices on its next sync: `membership()` reports a newer epoch. It **first pulls everything the keys it holds can read**, which brings in X's removal (step 0). It then opens its envelope for the new epoch, checks the signer as in 7.3 (X no longer counts) and moves to the new epoch. If the envelope can't be trusted, it doesn't adopt it, writes nothing, and shows that it can't open the new key.

**Repair:** on each sync, after pulling, a member asks which devices of the space have no envelope for the current epoch (a members-only function). It seals the current key to those that are on its verified list and not revoked. This covers a device added just before a rotation, a device whose record hadn't arrived yet, and a partial failure.

The removed device keeps what it already downloaded (§6.4). It can't read anything new: it never receives `K[n+1]`, and the server stops serving it.

### 7.5 Old epochs
Records keep the epoch they were written under; members keep old keys to read history. A device that joins later needs every epoch, not only the current one: **the invite envelope carries all epoch keys** (a small key bundle instead of one key), and the joiner files its own sealed envelope for each (`store_own_envelopes`). The alternative, re-encrypting history at every rotation, would rewrite every record and race with concurrent edits.

### 7.6 Adding one of my devices (§6.3)
- *Add a device* in the shared state creates the same kind of invite, marked locally as "for me". Approving it uses `approve_invite(invite, as_person = me)`.
- The new device claims as usual, with its own local person ID. After approval, `accept_invite` tells it which person it now is.
- If that's not its own local ID, it **becomes that person**: its onboarding self-person is replaced by a local row for the space's person (kept as "self", with the space's name once it arrives), and its authors are rewritten. Then it adopts the space's profile **without asking about the start date** (it's the same person), merges its dates in and writes its own device record.
- Both screens show the same safety code, exactly as with a partner.

### 7.7 Whose devices can be removed (decided 2026-10-23)
Removing the partner's only phone would end sharing for them without dissolving the space: a second, harsher kind of breakup next to *Leave* (§6.5). **Decided by the product owner: the screen offers removal only for my own devices; a partner ends things with Leave.** The server still allows any member to remove any device of the space, so a lost phone can be removed even from the partner's device if ever needed. That is intentional, not an oversight (security reviews flagged it).

### 7.8 Rotation and recovery
Every rotation also re-wraps each person's recovery envelope (§8, phase 4). Without that, recovery breaks after a removal.

### 7.9 Order of work
1. The device list: records, local table, each device writing its own at creation, at join and whenever its record is missing.
2. Adding one of my devices.
3. Removing a device: `rotate`, signed envelopes from other devices, skipping old-epoch writes, repair, and the key bundle in invites.

## 8. Recovery key

*Revised 2026-10-23 (phase 4), before building it. The first version wrapped `K` with a symmetric key derived from the recovery key, which only its owner can compute, so no other device could re-wrap a new key after a rotation (§7.8). Recovery would have broken at the first removal. The recovery key now also yields a key pair, and anyone in the space can seal new keys to its public half.*

**The key**
- 184 random bits plus a 16-bit checksum (25 bytes), shown as **8 groups of 5 Crockford base32 characters**, for example `K7QX2-…`. It's language-neutral (no English word list) and typo-tolerant: O reads as 0, I and L as 1, and the checksum rejects typos.
- It derives three things:
  - a **lookup ID** that the server stores to find the person's envelopes;
  - an **X25519 key pair**;
  - (nothing else; no password stretching is needed, the key is already random).

**Where things live**
- The **recovery public key** has its own end-to-end encrypted record (`recovery`, one per person, keyed by the person). It is written only when the key is set up or replaced, never by the name edits that rewrite the person record, so an old (perhaps exposed) public key can't come back through last-writer-wins. Other devices learn it from the space, never from the server.
- The server keeps, per person, **only a hash of the lookup ID and a hash of the recovery public key**, in a table no member can read or change, reachable only through functions (like `device_credentials`), and the **recovery envelopes**: each epoch's `K` sealed to the recovery public key **and signed by the device that sealed it**. It never sees the key, the public key or the private half.
- Each recovery envelope names the hash of the public key it was sealed to, and the server skips one that doesn't match the person's current key. Without this, a device that hadn't yet received a replaced public key would seal to the old one, and that envelope could never be repaired.
- **The key is shown once and never stored on any device** (decided by the product owner, 2026-10-23). A stored copy would let a stolen phone that was removed from the space read it and recover itself straight back in. If the key is lost or may be exposed, any of my devices can create a new one with *Replace*.

**When it's created**
- When sharing is turned on (the inviter), and when a partner joins (each person has their own).
- The step can't be skipped. The key is shown in 8 numbered groups with *Copy key* and *Save or send*, and the user confirms by typing back two of its groups.
- *Save or send* hands the key to the share sheet as text (a password manager, notes, a file app): the app itself never writes it to a file. In the browser preview it downloads a text file.
- Confirming makes **a key change that removes no device**: a new epoch, sealed to every device and to every recovery key, with the new lookup and public key hashes. Setting up and replacing are the same call. This way the newest key a recovering device receives was always signed by a device listed under an older key (see *To recover*).
- A device that joins as one of my devices, or by recovery, doesn't create one: the person already has it.

**Keeping it working:**
- Every rotation also seals the new key to every person's recovery public key (§7.8), in the same all-or-nothing call. That covers removing a device, resuming an interrupted removal, *Delete all data* while sharing, and *Replace*.
- **Repair** is also a key change that removes no device. After a sync, if the server reports a person with no recovery envelope for the current epoch and this device knows a public key with the hash the server expects, it rotates. (A single envelope would be signed by whoever repairs, possibly a device added in the current epoch, which a recovering device couldn't check.)
- Only the public parts of a confirmed key are stored while its key change is pending (public key and the two hashes), in the same slot as a pending removal. So an interrupted setup or Replace is finished by the next sync, and the recovery key itself is never stored.
- A person without a recovery key (setup interrupted, or a space from before phase 4) is skipped by rotations. They see a banner they can't dismiss until the key is set up.

**To recover** (all my devices lost):
1. On a new device, choose *Recover with your recovery key* and type it.
2. The device registers, then calls `recover(lookup ID)`. The server admits it as a device of that person and returns that person's recovery envelopes for every epoch.
3. It checks what it received before using it. It opens the envelopes (only members ever read the recovery public key, so an envelope that opens was sealed by one) and pulls with the **older keys** first. The **newest key** is accepted only if the device that signed its envelope is on the device list read so far and not removed (§7.3), with a valid signature. After pulling with it, the person the server named must hold the recovery record with this public key. Otherwise the device goes back to solo.
   - If the newest epoch has no envelope yet for this person, recovery stops with "not ready yet": a device that knows the key repairs it on its next sync.
   - Interrupted (closed mid-way), the recovery doesn't count: the screen offers it again and the server answers the same.
   - Once `recover()` has answered, the server counts this device in that space even if the check then fails. Inviting or joining from it is refused until a recovery with that key completes (or the space is left).
4. Then it becomes that person (as in §7.6), adopts the space's profile, files its own envelopes and syncs. No other device has to approve: holding the key is the proof.
5. The server can't abuse this: it only has a hash of the lookup ID, and it can't open the envelopes.

**Also possible:** the partner re-invites you from their device. In a couple, data isn't lost while either person has a device.

**Replacing the key** (if it may have been exposed):
1. A new key is made and kept as pending.
2. It is shown and confirmed (two groups typed back).
3. **Only then** one server call commits it: the new lookup hash, the old envelopes deleted, and a new epoch (a rotation that removes no device) with every device and recovery envelope.

If confirmation never happens, the old key keeps working. The old key can open nothing written after the replacement, even if a hostile server kept its old envelopes.

**Replace** refuses while a removal is pending, and when this device lacks an older epoch's key (the old recovery envelopes are deleted, so that history would be lost to recovery).

**Anyone who ever saw the recovery key can come back** (recover a new device) until it is replaced (§11). After removing a lost or stolen device, the app suggests replacing the key.

## 9. Sync behaviour and limits
- Sync runs on launch, on resume, after local changes (debounced), on pull-to-refresh, and when the network comes back. iOS doesn't allow background sync without push, so **the partner's widget updates only after the partner opens the app**. This is documented as a limit.
- Photos: a 2048 px image plus a thumbnail on each device. **Only the 2048 px version is uploaded, encrypted** (not the camera original, which is often 3–5 MB), so a space holds roughly 2,000–4,000 photos.
- **Storage limit: 2 GB per space** (decided by the product owner, 2026-10-23). It counts only the encrypted photos on the server, for the couple together; text records and photos on each phone don't count. The server enforces it on every upload, and it is one server setting, so it can change without an app update. When it's reached, a new photo stays on the phone that took it and isn't shared, with a message; everything else keeps syncing, and deleting shared photos frees space.
- Offline edits wait in the outbox and are merged by HLC when the device reconnects.

## 10. What the server can and cannot see

| Cannot see | Can see (metadata) |
|---|---|
| Names, start date, titles, notes, dates, photos, which reminder settings you use | That a space exists and how many persons and devices it has; device platform; when each device syncs; record counts, types and sizes; blob sizes; IP addresses of requests; invite timing |

The privacy policy must describe the right-hand column. It is not accurate to say "the server knows nothing".

## 11. Threat model (summary)
- **Server breach or an honest-but-curious operator:** gets only metadata and ciphertext. ✔
- **Intercepted invite link:** single-use, 24-hour expiry, requires the inviter's approval and the safety code. ✔
- **Lost or stolen phone:** remove it from another device, which also changes the key. Data already on it is behind the app lock if it was on (`docs/APP_LOCK.md`), and the phone's own screen lock.
- **Malicious member:** they can read and edit everything by design. Recently deleted limits the damage from destructive edits.
- **Compromised device (malware):** out of scope, since keys live in the app's memory while it runs.
- **Recovery key leaked:** anyone who has it can recover a device into the space until it is replaced (§8). Replace it, which also starts a new epoch. After a lost or stolen device is removed, the app suggests replacing it.
- **Someone else's recovery record:** the server keeps a person's `recovery` record only from a device of that person (`20261023000800_own_recovery_records.sql`). Without that, another member could put their own public key in it: rotations would seal to a key the server refuses, and that person's recovery would quietly stop covering new epochs. A device also compares the record with the hash the server seals to, and asks for a new key when they differ.
- **A hostile server holding back newer epochs from a recovering device:** a recovering device knows the current epoch only from the server. A hostile server could stop at an older epoch, hide the records after it (including a later removal), and so get the recovering device to write under a key a removed device still holds. This is the same limit as withholding a removal record (below); it ends as soon as any other device seals the current key to the new device. Closing it would mean holding back the recovering device's uploads until another device has confirmed the current key, which a person with no other device in the space could then never get.
- **Recovery with a hostile server and a removed device:** a recovering device trusts the newest key only if a device listed under the older keys, and not removed, signed it. Older keys are trusted because they open (the server never sees a recovery public key), so a removed device that read the public key could, with the server, slip a fake older key and fake older records into what the new device sees. That falls under faking the history the new device sees, which is out of scope; it can't read anything written after the removal.
- **Person rows on the server:** members can only read them now (§19). Before, they could change or delete them directly, and deleting one cascaded to that person's recovery key entry.
- **Hostile server colluding with a removed device:** a removal is written under the old key before the rotation, and devices read it before adopting a new key, so a key signed by the removed device is refused. Repair skips devices the server reports as removed. What remains is a server that withholds the removal record entirely while serving a key the removed device signed. That is out of scope: preventing it would need every rotation to be confirmed by a device the others already trust, without the server in between.

## 12. Obligations and costs
- **Domain and website:**
  - needed for invite links (App Links / Universal Links), the privacy policy and support;
  - also needed for publishing anyway.
- **Store and legal:**
  - In-app deletion of sync data: leave or dissolve deletes the server copy, whatever Apple's account rules turn out to be.
  - Privacy policy, Play Data safety and the App Store privacy label: check the current wording. Don't assume end-to-end encrypted data is exempt from disclosure, or that GDPR doesn't apply. EU hosting, a data processing agreement with Supabase, and a list of processors are required.
- **Cost:** a Supabase Pro project (fixed monthly fee) plus storage and egress for encrypted photos. Estimate it from the limit (2 GB per space) × the expected number of couples before launch; most couples will stay well below it.
- **Analytics:** possible opt-in events such as `sharing_enabled`, `device_added` and `space_left`, as booleans only. Add them to `usage-events.ts` when they're implemented.

## 13. Phased plan

| Phase | Scope | Done when |
|---|---|---|
| 0. Spike | libsodium WASM in both WebViews; secure storage attributes; Supabase EU project with RLS; a QR scanner plugin | Encrypt, seal and round-trip proven on an Android emulator and an iOS simulator |
| 1. Local model | Migration v2 (persons, HLC, tombstones, outbox, local/shared split, Recently deleted); still no network | All current tests pass; new merge and HLC tests; the UI shows "Matthieu & Sam" from persons |
| 2. Invite + core sync | Device registration, create space, QR invite, approval, safety code; sync the profile, persons and milestones | Two emulators see each other's dates; conflict tests |
| 3. Devices + leave | Add a device, remove a device (rotation), leave and dissolve | The removed device can't decrypt new records; both keep data after dissolving |
| 4. Recovery | Recovery key, confirmation, recovery flow, key replacement | Restored on a wiped emulator with the key only |
| 5. Memories + photos | Memory records, encrypted chunked blobs, quota | Photos appear on the other device; a resumable upload is verified |
| 6. Hardening | Security review, rate limits and attestation, privacy policy, store forms, link domain | Two-device test plan passes on real phones (iPhone + Android) |

## 14. Open decisions
The product questions (joining with existing data, edit rights and trash, partner reminders) were decided on 2026-10-21; see the list at the top. Still open:
1. **Server:** Supabase EU (recommended to start) or self-hosted.
2. **Domain** for invite links, the privacy policy and support. It blocks links, but not QR invites.
3. ~~App lock~~: decided 2026-10-24, phone unlock (`docs/APP_LOCK.md`).

## 15. Phase 0 spike results (2026-10-21)

**Crypto** (`src/app/core/sync/sync-crypto.ts`, self-test `sync-self-test.ts`):
- Every §3 construction is implemented with libsodium-wrappers 0.8.4.
- 26 round-trip and tamper checks run in Node (vitest). Tampering covers a record moved to another ID or epoch, replayed under a newer version or with a flipped deletion flag, the wrong key, the wrong invite secret, a recovery-key typo, and photo chunks truncated, reordered or altered.
- The safety code is order-independent and changes if either key of a device is swapped or the invite secret differs. A post-commit security review found that the first version covered only the signing keys and didn't authenticate the version or deletion flag. Both are fixed; the in-WebView run below predates this fix.
- **Bundle:** libsodium is a separate on-demand chunk of 434 kB (124 kB compressed). The startup bundle is unchanged (1.18 MB), so solo users never download it.
- libsodium 0.8 ships **WebAssembly only**, with no JavaScript fallback. A WebView without WASM fails to load it, loudly.

**Android WebView** (API 37.2 emulator, WebView 149, development build with DevTools hooks in `core/sync/dev-hooks.ts`):
- ✅ All 21 checks pass.
- Timings: load 25 ms, device keys 1.2 ms, a 1.5 MB photo encrypted in 8.3 ms and decrypted in 6.1 ms.

**Secure storage** (`core/platform/secure-key-store.ts`, `@aparajita/capacitor-secure-storage` 8.0.1):
- ✅ A device key survives the app being killed.
- ✅ On disk it is only ciphertext. It's AES-GCM under an Android Keystore key, in app-private preferences excluded from backups, and the public key appears nowhere in the file.
- ✅ Removal works. Android writes the preferences file lazily, so it's empty only after a moment.
- iOS is configured as `whenUnlockedThisDeviceOnly` with iCloud sync off. ✅ Checked on the iOS 26.3 simulator (2026-10-22): an item survives a relaunch, the keychain stores it with `pdmn=aku` (when unlocked, this device only) and `sync=0`, and removal leaves nothing. The check called the plugin directly with the wrapper's settings, because `storeDeviceKey` loads libsodium first (see below).
- **libsodium in WKWebView: not verified.** On the iOS 26.3 simulator on an Intel Mac, loading libsodium crashes the WebContent process inside JavaScriptCore's WebAssembly signal handler (`docs/IOS_SETUP.md` §4), so `selfTest()` can't run there. Plain WebAssembly works there, and the same libsodium runs in the Mac's own JavaScriptCore. It needs a real iPhone or an Apple-silicon Mac.
- Whether the Android key is hardware-backed can't be judged on an emulator. Check on a real phone.
- The plugin's own web fallback is `localStorage`, so our wrapper uses memory only on the web.
- The package also lists `@capacitor/keyboard` as a dependency. Capacitor registers only plugins the app itself declares, so no extra native code is built in.

**Server schema** (`supabase/migrations/20261021000000_sharing_init.sql`):
- The tables of §4 with row-level security on all of them. Cross-device operations go through `SECURITY DEFINER` functions: `create_space`, `create_invite`, `claim_invite`, `approve_invite`, `revoke_device`, `dissolve_space`.
- A trigger stops an older HLC version from overwriting a newer one.
- **Tests:** `supabase/tests/sharing-rls.test.ts` runs the real migration on PGlite 0.5.11 (Postgres in WASM) with a Supabase auth shim. ✅ 8 tests:
  - only members see a space and its records;
  - a stranger's insert is rejected by row-level security;
  - invites are single use and expire, and a claimed but unapproved device sees nothing;
  - a stranger can't approve an invite;
  - each device reads only its own key envelope;
  - an older version is ignored and a newer one advances the cursor;
  - a second device joins as the same person, and revoking it starts epoch 2 and cuts its access;
  - dissolving removes everything from the server.
- **Security review fix:** migration `20261021000100_records_server_cursor.sql`. The server now always assigns the change cursor `seq` on insert, so a member can't hide a record from incremental pulls with a low `seq`. A record's space, type and ID can't change on update. Tested on PGlite (9 tests) and re-applied to the live stack (`supabase db reset`, 4 live tests pass).
- A mutation check (opening up the read rule and disabling the version trigger) makes 5 of the 8 tests fail, so they test what they claim.
- **Live check (2026-10-21, later):** the migration applies on a local Supabase stack (Postgres 17, `bunx supabase start`, anonymous sign-in enabled in `supabase/config.toml`). `supabase/tests/sharing-live.test.ts` runs only when `SUPABASE_LIVE=1`. ✅ 4 tests through real GoTrue anonymous sessions and PostgREST:
  - devices register;
  - only members read records, and a stranger's insert is rejected by row-level security;
  - invite, claim and approve work, and invites are single use;
  - an older version is ignored;
  - dissolving removes everything;
  - the signed-out role sees nothing.
- **Not done:**
  - A hosted Supabase EU project.
  - The real GoTrue anonymous sign-in, Storage buckets and Edge Functions.
  - Abuse protection: rate limits, Play Integrity and App Attest.

**QR codes (chosen, not installed):**
- Scanning: `@capacitor/barcode-scanner` 3.1.3, the official Capacitor plugin. `@capacitor-mlkit/barcode-scanning` 8.2.1 is the alternative. Phase 2 must check the Google Play services dependency on Android.
- Display: `uqr` (no dependencies, SVG output).

**Next (phase 1):** the local data model migration (§5): persons, HLC, tombstones, the outbox, the trash, and the local/shared split. It needs no server.

**Before phase 2:**
- a Supabase EU project, or a working Docker for `supabase start`;
- a decision on the domain;
- the iOS check of libsodium in WKWebView on a real iPhone or an Apple-silicon Mac (the Keychain attributes are verified).

## 16. Phase 1 results: local data model (2026-10-21)

Implemented with no network. Everything still runs solo.

**Schema v2** (`core/persistence/migrations.ts`):
- New tables:
  - `persons`: the owner has `is_self` = 1; the typed partner name becomes `is_placeholder` = 1, which phase 2 replaces with the partner's own entry;
  - `hlc_state`;
  - `sync_state`, empty until sharing is turned on;
  - `outbox`, one row per record, keeping its latest version.
- New columns:
  - `version` (hybrid logical clock) and `author_person_id` on the profile, milestones and memories;
  - `deleted_at` on milestones, memories, photo rows and persons;
  - `trashed_with` on memories (deleted together with a date).
- Existing rows get `ZERO_HLC`. Person IDs are generated in SQL as valid UUIDv4. The old `relationship_profile.display_name` is moved to `persons` and then set to NULL.

**Code**
- `core/domain/hlc.ts`: format identical to the server's check; it never goes backwards, a full counter carries into the next millisecond, and state is persisted. Node IDs come from Web Crypto, so libsodium stays out of the startup bundle.
- `core/persistence/change-journal.ts`: every write stamps a version and its author, and queues the outbox only when `sync_state` exists.
- `core/domain/sync-schema.ts`: for every synced table, which columns are shared, local or metadata. `calendar_time_zone_id`, file paths and reminder rules never sync.
- **Trash** (`core/persistence/trash.repository.ts`, `TrashService`, Settings › Recently deleted):
  - Deleting is now a soft delete.
  - Restoring a date brings back the memories trashed with it and its reminders, with the same notification IDs.
  - "Delete forever" asks for confirmation.
  - Items older than 30 days are purged at startup, before the orphan-photo cleanup.
  - Trashed photos count as in use, so the cleanup never deletes them.
  - Photos removed while editing leave a tombstone, and their file is deleted at once.
- **Names:** the profile keeps `displayName` (the partner) and adds `selfName` (the "Your name" field in the profile editor). Both are stored in `persons`.
- **Export** includes only active items, not the trash. The profile now also carries `selfName`; the export format version is unchanged because the field is optional.

**Tests** (`persistence/sync-model.test.ts`, `domain/hlc.test.ts`, plus updated persistence tests): 14 + 7 new.
- Upgrade from a filled v1 database: every value is kept, the placeholder person is created, IDs match UUIDv4, and rules and notification IDs are intact.
- Upgrade from v1 before onboarding.
- The version advances on create, update, pin, trash and restore, also when the clock goes back and after a restart. Persons get a new version only when a name actually changes.
- Outbox: stays empty when solo; one coalesced entry per record when sharing.
- Trash: restore, photo-cleanup safety (mutation-checked), purge at 29 versus 30+ days, delete forever, and delete-all clearing the new tables.
- Every synced column is classified exactly once.

**On the emulator** (API 37.2):
- Installed **over** the v1 build with its data, without clearing anything. Migration 2 applied; persons were created ("Sam" as the placeholder); the profile and milestone versions are `ZERO_HLC`; the rule kept notification ID 1000; the 6 alarms are identical to before; the outbox is empty.
- Home still reads "You and Sam".
- Deleting the anniversary showed the trash wording and toast and cancelled its alarm. "Recently deleted" listed it. Restoring brought the alarm back with ID 1000 and a new HLC version.

**Left for phase 2:**
- When a space is purged, keep a content-free tombstone instead of removing the row.
- Merge the placeholder partner with the real partner person on join.
- Push and pull the outbox.

## 17. Phase 2 progress: sync engine core (2026-10-22)

Slice 1 of 4 (see the slices below). No network yet: the engine runs against an in-memory server that behaves like the Supabase `records` table and its triggers.

**Code** (`core/sync`, framework-free):
- `sync-crypto-port.ts`: the `SyncCrypto` interface. The engine and UI depend only on it, so the libsodium backend can be swapped (for example for a pure-JS one, if WebAssembly fails on real iPhones, §15) in one place.
- `sync-store.ts`: the local side.
  - Payloads hold the shared columns plus author and `deleted_at`, never local columns (zones, file paths, `is_self`, timestamps).
  - Applying a remote record writes it only if its version is newer, without entering the outbox (no echo), and advances the local clock past it (`ChangeJournal.observe`), so the next local edit orders after it even on a slow device clock.
  - Local-only columns get defaults on first arrival; the calendar zone is the device's own.
  - Received dates have **no reminder rules**.
  - The single profile row is `PROFILE_RECORD_ID` on the server.
  - An outbox entry is removed only if its version did not change while it was being pushed.
  - Joining a space and queueing everything already on the device for upload happen in one transaction.
  - A **placeholder partner** (a name typed on this device) is never uploaded; the partner's own person replaces it when they join. Until slice 3 links the two, the placeholder stays only on the device where it was typed.
  - A remote tombstone for this device's owner is refused (it would also break saving the profile).
- `sync-transport.ts`: the `SyncTransport` interface (push, versions, pull by cursor) and `InMemoryTransport`.
- `sync-engine.ts`: pull, push, pull.
  - Records are sealed with AAD v2 (§3). Anything that fails to decrypt, is not exactly the shared columns of its type, breaks the editors' own rules (`sync-payload-rules.ts`: categories, dates, times, zones, lengths, author ID; the start date may be "in the future" because the partner's today can be ahead), has a tombstone flag that contradicts its payload, or is refused by the local schema is **rejected and skipped**; sync never stalls on it.
  - The server skips stale writes silently, so after each push the engine reads back the stored versions. A change that lost to a newer one is counted as `superseded`, and the following pull applies the winner and clears the entry.
  - The report lists the record types that changed, so the app can reload and reconcile reminders and widgets afterwards (persist first, then side effects).
- **Updates that accept more** (migration 3, `sync_state.capability`): records a build refuses (an unknown type such as memories before phase 5, a new payload format, a new category, a longer limit) would otherwise stay behind the cursor for good. Each build declares `SYNC_CAPABILITY`; raise it whenever a build starts accepting something an older one refused. A device whose stored capability is lower pulls everything once more (unchanged records are no-ops).
- **Cursor gap:** Postgres numbers a write when it happens, but the write becomes visible when its transaction commits. A slow transaction can therefore appear behind a device's cursor. The engine re-reads the last 50 change numbers on every pull (no-op applies). Slice 2 fixed this on the server (see below); the overlap stays as a safety margin.

**Tests** (`sync/sync-engine.test.ts`, two sql.js devices, 11 tests):
- Profile, both names and dates arrive. The receiver keeps its own calendar zone, gets no photo path and no reminders, and nothing is echoed back. Decrypted server payloads contain no local column.
- Edits flow both ways; concurrent edits settle on the newer one on both devices.
- A push skipped as stale is detected, and the newer version is taken.
- Trash and restore travel to the other device.
- HLC ordering with a device clock an hour behind.
- Records with the wrong key, an extra column, a blank title, an unknown category, an impossible date, an unknown zone, a malformed author, a wrong value type, an unknown payload format, a contradictory tombstone or a foreign profile ID are rejected, and the valid record after them still arrives.
- A write that becomes visible behind the cursor is still pulled.
- After an update with a higher capability, a date an older build refused arrives, and the full re-pull happens only once.
- A tombstone for the device owner is refused, and the profile can still be saved.
- A placeholder partner is never uploaded.
- A record with an ID the server cannot store stays local while the rest is pushed.

### Slice 2: Supabase transport and device sessions (2026-10-22)

**Server** (`supabase/migrations/20261022000000_device_sessions.sql`):
- `register_device(sign_key, box_key, device_platform, credential)`: the only way to add a device (the direct-insert policy is gone). Retrying with the same keys returns the same device, so a lost reply is harmless.
- `device_credentials`: the SHA-256 of each device's re-attach secret. Row-level security with no policies: not even the device can read it.
- `rebind_device(device, secret, next_credential)`: moves a device row to the calling anonymous user if the secret matches, and installs the next credential. A revoked device cannot come back; a user cannot hold two devices.
- **Ordered change numbers:** the record triggers take a per-space advisory lock before drawing a number and hold it until commit, so one space's writes become visible in number order and a pull can never step over a slow transaction. (A transaction-ID filter, considered in slice 1, does not give this guarantee when one transaction writes several rows.) Different spaces never wait for each other.

**Client** (`core/sync`, `core/platform/sync-config.ts`):
- `SYNC_CONFIG` is `null`: until a server is configured, sharing does not exist in the app and makes no request.
- `SupabaseTransport`: push (upsert; the server keeps the newest), versions (in chunks of 50 IDs), and pull by change number, all under row-level security. Errors carry only the operation and the server's code. A malformed byte value from the server gets that record rejected, not the whole pull. In the other direction, the engine never sends a record the server's table would refuse (an ID that is not a UUID): one such row would fail the whole request on every sync, so it stays local and is counted as `unsendable`. All local IDs are UUIDs today; this guards a future import that keeps IDs from a file. The in-memory server refuses the same rows, so the two-device tests match production.
- `DeviceSession`: creates the device keys once, keeps the Supabase session in the secure store, then registers or re-attaches. It uses **one Supabase client per session**: several clients sharing one stored session would each refresh the same rotating refresh token and sign each other out. Every secret is stored locally *before* the server sees it: if the app stops after the server accepted a new secret, the next start promotes the pending one and retries. Only a session the server refuses (JWT errors) leads to a fresh sign-in; being offline keeps the session. New keys always start a fresh anonymous user. A revoked device reports `DeviceLostError`.

**Tests**
- PGlite (`supabase/tests/device-sessions.test.ts`, 6): retry-safe registration, no direct inserts, credentials unreadable, re-attach with a wrong, spent or rotated secret, revoked devices, numbering of upserts and stale writes.
- Live local Supabase in Docker (`supabase/tests/sync-live.test.ts`, 4, run with `SUPABASE_LIVE=1`):
  - two devices register (one client per session, reused across `connect()` calls), share through a space and invite, and sync dates both ways through PostgREST; the server holds no plaintext;
  - a restart resumes the same anonymous user; a lost session re-attaches the same device under a new user, and sync continues;
  - recovery when the server took a new secret that the device did not save;
  - a revoked device is reported lost;
  - a second writer in the same space waits for the first to commit, and gets the higher number.
- `core/sync/encoding.test.ts`: base64, bytea and SHA-256.

### Clock drift limit (2026-10-22, after a security review)

A version from another device more than **one day** ahead of the receiving clock is never adopted. Otherwise one broken clock (a phone set to 2099) or a hostile member could drag every later version into the future, so normal edits elsewhere could never win again.
- **Server** (`20261022000100_records_future_versions.sql`): writes more than a day ahead of the server clock are **skipped silently**, like stale ones, so one bad row never fails a whole upload. The skipped change stays in the sender's outbox and is accepted once real time catches up.
- **Device:** pulling stops just before a record more than a day ahead of this device's clock (`deferred` in the report) and resumes once the clocks agree, so nothing is skipped. This only happens when the receiving clock is behind by more than a day, because the server refuses anything further ahead of real time.
- `observeHlc` ignores such versions too, and the clock only advances on records that actually change something.
- Tests: `domain/hlc.test.ts`, `sync/sync-engine.test.ts` (a record from a clock three days ahead waits, then applies), `supabase/tests/records-versions.test.ts`.

**Found for slice 3 (invite screens), all resolved in slice 3a below:**
- `approve_invite` seals the space key to the joiner, but the inviter cannot read the joiner's device row before approval (row-level security). The invite needs to expose the claimed device's public keys to the inviter, which the safety code then covers.
- `claim_invite` returns the invite envelope before approval, so whoever holds the link gets the space key before the inviter approves; only row-level security keeps them out. Return the envelope only after approval, or drop it and rely on the sealed key.

- **Upgraded profiles share one version.** Every device upgraded from v1 has the profile at `ZERO_HLC`, and the profile has the same server ID everywhere. If neither person edited it since, the joiner's push is skipped as not newer, and then confirmed as pushed because the versions are equal. The two devices would silently keep different start dates. The join flow must not upload the joiner's profile as is: the space's profile wins unless the joiner chooses their own date (§6.2), which then needs a fresh version.

**Found for slice 4 (wiring):**
- `DeviceSession` reads "no stored keys" as "new device" and starts over. Check what the secure-storage plugin returns while the phone is locked (iOS `whenUnlockedThisDeviceOnly`, during a background sync): if it is `null` rather than an error, the device would discard its own identity. Sync must not start while protected data is unavailable.

### Slice 3a: invite server functions and the sharing flow (2026-10-23)

No screens yet; everything below is driven by tests.

**Server** (`supabase/migrations/20261023000000_invites_v2.sql`; old signatures dropped and re-granted):
- **Same person IDs everywhere:** `create_space(sealed_key, self_person)` and `claim_invite(invite, person)` take the device's own local person ID, so server membership, records and authors share identifiers (adding one of my devices in phase 3 needs no mapping).
- **The key reaches the joiner only after approval**, and never through a key the server supplied:
  - `claim_invite` returns the inviter device's signing and encryption keys, not the envelope;
  - `invite_claim` shows the claimed device's two keys to members, for the safety code;
  - `approve_invite(invite)` admits the device; it no longer seals anything;
  - `accept_invite` gives the approved joiner the invite envelope (the key wrapped with the secret from the code, which the server never sees);
  - `finish_join` files the joiner's own sealed copy and clears the invite envelope.

  So the server cannot obtain the key even if nobody compares the safety code; comparing it still protects against someone else using an intercepted code.
- `decline_invite` ends an invite before approval. Every function can be retried after a lost reply: creating the space again returns it, claiming again from the same device is accepted, approving twice is a no-op, finishing twice changes nothing.
- No names reach the server: the inviter's screen says only that a device wants to join.

**Client** (`core/sync`):
- `invite-code.ts`: the invite as text, `H1.` and 64 base64url characters (invite ID and secret), found even inside a pasted message. **QR codes come later:** no QR generator or scanner is installed yet, and emulators cannot scan. A copyable code works without a domain too.
- `space-api.ts`: the functions above, with error codes and no data in errors.
- `space-keys.ts`: space keys by epoch in the secure store. If a member device lost them, it reopens its own sealed copy from the server.
- `sharing.ts` (`Sharing`): start sharing, create, show, check, approve or decline an invite; claim, check and finish a join; sync; go back to solo on this device.
  - A self name is required before starting or claiming (otherwise the partner would see a nameless person).
  - Crash safety: the space key and the invite or join in progress are stored before the server learns about them. Starting again after a crash finds the space the server already created, and **always takes the key sealed to this device on the server**. So sharing again after going back to solo on this device rejoins the old space with the old key, instead of pairing a new key with it. The joiner's own start date is recorded before the space's profile replaces it, so a crash at that moment cannot lose the choice.
  - Syncing is refused while a join waits for the start-date answer, so nothing of the joiner's is uploaded before it.
  - **Joining with data of your own** (§6.2): the joiner's profile is not queued; the first pull adopts the space's profile whatever its version (this also settles the shared `ZERO_HLC` version of upgraded profiles). If the start dates differ, the joiner chooses; keeping their own writes it with a fresh version so it wins everywhere. Dates on both sides are merged.
  - **Names:** when the partner's own person arrives, the name typed for them on this device (a placeholder, never uploaded) is removed. Each person's own name wins.
  - `stopSharingHere`: back to solo on this device, keeping every record. It is the way out for a device without its key, and half of leaving (phase 3).

**Tests**
- PGlite: `supabase/tests/invites.test.ts` (4) and the updated RLS, session and version tests.
- sql.js: `sync/join.test.ts` (6): adopting the space's profile over a newer local one, keeping one's own start, merged dates, placeholders replaced on both sides, going back to solo, invite codes.
- Live local Supabase (`supabase/tests/sharing-flow-live.test.ts`, 5, `SUPABASE_LIVE=1`): the whole flow between two phones with both safety codes equal, the start-date choice surviving a restart and a crash at the moment it is recorded, syncing refused while the join waits for it, merged data and names, a lost space key reopened from the server, declining, finishing after a crash right after the server created the space, and sharing again after going solo on one device (same space, same key).

**Security review fixes (2026-10-23, `20261023000100_signed_envelopes.sql`):**
- **Signed key envelopes.** A device files the space key sealed to itself together with its own Ed25519 signature over the space, epoch, device and sealed key. It trusts an envelope from the server only with that signature. The server can write any row, so without this it could plant a key it knows for a device that lost its local copy (or that shares again after going solo) and read what that device writes next. A device now chooses its new space's ID itself, so it can sign before the server sees anything.
- Members may file envelopes only for their own device. Rotation (phase 3) and recovery envelopes (phase 4) will go through checked functions.
- **Person IDs are unique per space**, not across the server (`persons` key `(space_id, id)`), so knowing someone's ID does not let anyone block them from creating or joining a space. Joining a space under an ID it already has is still refused.
- Tests: PGlite (envelopes only for one's own device, IDs per space) and live (a planted envelope, unsigned or signed by another key, is refused and the device reports it has no key).

**Notes for 3b (both handled there):**
- `invite_claim` ignores expiry: an expired invite looked like "waiting" forever. The device now forgets an invite 24 hours after creating it.
- After going back to solo on one device, the server still counts that device as a member until phase 3 adds leaving, so claiming an invite returns `alreadyInSpace`. The screen says so in words.

**Before real users:** the recovery key (§8, phase 4) must exist, because §6.1 makes it a step that can't be skipped. `SYNC_CONFIG` stays null until then. *(Phase 4 built it; see below.)*

### Slice 3b: the sharing screens (2026-10-23)

**Settings › Share with your partner** (`features/settings/sharing.page.ts`, route `settings/sharing`). The entry exists only when a sharing server is configured. One screen, by state:
- **Off:** what sharing means (end-to-end encrypted; your partner sees and can edit your profile and dates; memories and photos later; each keeps a full copy on leaving), then *Invite your partner* or *Join with a code*.
- **Inviting:** your name (pre-filled, required), *Create an invite*, then the code with *Copy code* and *Send code* (share sheet), "Waiting for your partner…". When a device claims it: "A device wants to join", the **safety code** in large digits ("942 308", read out as one label), *The codes match, accept* or *Decline*.
- **Joining:** paste the code (found anywhere in the pasted text), your name, *Join*; then the same safety code and "Show this code to your partner"; when the start dates differ, two buttons with both dates; then "You're now sharing with …".
- **Shared:** "Shared with Sam", *Sync now* (with "Up to date", or a note when changes wait for the clock).
- **No key on this device:** an explanation and *Stop sharing on this device* (confirmed; every record stays).
- Errors are whole sentences per code (wrong code, invite used or expired, device still in an earlier space, offline, other).
- The server is asked about an invite or a join every 3 seconds, **only while the screen is open**.
- Text in EN, FR and NL (drafts for native review, like the rest).

**Angular side** (`core/services/sharing.service.ts`): `SYNC_SERVER` is `SYNC_CONFIG` on devices. In the browser preview it is the local development stack (`core/platform/sync-dev-config.ts`), only in development builds served from `localhost`, `127.0.0.1` or `*.localhost`. **Release builds contain neither the URL nor the key**: `ngDevMode` folds it to null, checked by searching the production bundle. libsodium and the Supabase client load only when the screen is used; neither is in the startup bundle. After anything that changed local data, state is reloaded and reminders and widgets refreshed. The device session is now established once and reused, instead of checked with the server on every call.

**Verified in the browser** (development build, local Supabase in Docker, two separate origins `localhost:4200` and `sam.localhost:4200` as two phones):
- Alex creates an invite; Sam pastes it inside a message, with "Alexandre" typed as the partner and a different start date (6 versus 14 October).
- Both screens show the same safety code (942 308); Alex accepts.
- Sam is asked which start date to keep and keeps their own: after *Sync now* on Alex's phone, both phones show "together since 6 October 2026", "You and Sam" and "You and Alex", and Alex's yearly anniversary is in Sam's dates.
- A device that lost its key (see below) shows the no-key state, stops sharing locally, and can share again.

**Tests:** `sharing.page.spec.ts` (6: states, safety code, start choice, error wording, error codes) and `sync/sharing.test.ts` (2: an expired invite is forgotten without the server, status from local state).

**Limits found:**
- **The browser preview keeps sharing secrets in memory**, by design (§15): reloading the page loses the device's keys, and the device then shows the no-key state. On a phone they are in the Keychain or Keystore.
- Ionic's view events don't fire when the sharing screen is the first page loaded, so it also loads from Angular's own lifecycle.
- If both people added "Our anniversary" during onboarding, they will have two such dates after joining (different IDs). Merging look-alike dates on join is left for later.
- Copy uses the web clipboard; check it in the Android WebView in slice 4.

### Slice 4: automatic sync and the Android route to the local stack (2026-10-23)

**When sync runs** (`SharingService.requestSync`): when the app starts, when it comes back to the foreground (or the browser tab becomes visible), and 2 seconds after a local change (quick successive edits share one sync). That is the whole list: there is no timer and no background sync (§9).
- A **solo device stops after one local database check**: no sharing code is loaded and no request is made.
- Syncs and the sharing steps (start, join, choose the start date, stop) run **one at a time**.
- Failures are silent (offline, a join still waiting for its answer, keys unavailable); the next trigger tries again.
- Changes that arrived from the partner are not sent back: the reload after a sync does not count as a local change.

**Device keys are created only when the user starts or joins sharing.** On iOS the secure-storage plugin returns nothing (no error) when the Keychain can't be read, for example while the phone is locked (checked in its source: `keychain.get` returns nil). Before this, "no keys" meant "new device" and the identity would have been replaced; now any other read without keys stops with `DeviceKeysUnavailableError`, and the registration is kept.

**Android debug builds reach the local stack:**
- `bun run android:build:dev` builds the web app in development mode, syncs and assembles the debug APK.
- `adb reverse tcp:54321 tcp:54321` makes `127.0.0.1:54321` on the emulator reach this machine.
- `android/app/src/debug` adds a network security config that allows plain HTTP **only to `127.0.0.1` and `localhost`, only in debug builds**. Release builds keep Android's default (no cleartext) and have no development server.

**Verified on the emulator** (API 37.2, Android Keystore) with the browser preview as the second phone, both on the local Supabase stack in Docker:
- The emulator, with its existing data (together since 14 June 2024), started sharing as Alex and created an invite. The browser phone (Sam) joined with it; both showed safety code **199 411**. The emulator accepted; Sam kept the partner's start date.
- Afterwards both phones had the same start date, each other's names ("Shared with Sam" and "Alex"), and both sets of dates. The emulator's own reminder was unchanged, and the received date had none.
- An edit of the relationship label on the emulator reached the server **without pressing Sync now** (server cursor 387 → 390 about 2 seconds after saving).
- Sending the app to the background and back ran exactly one sync (two pulls, nothing to push). With the app open and idle, there were no requests in 40 seconds.
- Membership survived reinstalling the APK over itself (keys in the Keystore).

**Also fixed:** the sharing screen updates first and shows toasts without waiting for them. A toast whose animation can't run (a hidden window) held the screen in its busy state after joining.

**Tests:** `sharing.service.spec.ts` (2: a solo device checks only the local database and loads nothing; no server, no checks at all); `sync/sharing.test.ts` adds a device whose keys can't be read keeping its registration.

**Not verified yet:**
- Two emulators, or an emulator and a real phone. The browser served as the second phone.
- iOS, which needs a real iPhone (see the implementation plan).
- Copying the code in the Android WebView: a member's screen has no invite to copy until adding a device (phase 3).

**Seen during the test:**
- Both phones had an "Our anniversary" date from onboarding, so after joining there are two (the merge-look-alike-dates note under slice 3b).
- While the browser pane was hidden, its tab synced about every 17 seconds. That is the resume trigger firing on each visibility change of the hidden pane, which does not happen on a phone.

### Phase 3, slice 1: leaving the space (2026-10-23)

**Leaving** (§6.5): in the shared state, *Leave the shared space*, with *Export my data first* (the existing export) and a confirmation that says what happens: sharing ends for both, now; the server copy is deleted; each keeps everything; it can't be undone. The device asks the server to dissolve the space first, and only then goes back to solo. Offline, nothing changes and the screen says so.

**The other phone notices** (`membership()`, `20261023000200_membership.sql`): after a dissolve, row-level security just returns nothing, so a sync would look "up to date" forever. Every sync now first asks the server where this device belongs, before loading keys, so a device without its key learns it too. It goes solo **only on a definite answer**: the space is gone or different, or this device was removed. Being offline, a refused session or no answer change nothing, because going solo drops the outbox and false positives would lose unsent edits. It then shows once: "Sharing with Sam has ended. Everything stays on this device."

**After sharing ends, the other people become placeholders** (a product choice): they still show on the device ("You and Sam"), but like a name typed there. Sharing later with someone new never uploads them, and the new partner's own name replaces them. Without this, the ex's name would have been uploaded into the new partner's space.

**Server fix:** dissolving left devices pointing to their deleted person, because the device's space reference was cleared before the person reference could match. `dissolve_space` now clears both. Sharing again after leaving creates a new space.

**Tests:**
- PGlite (`membership.test.ts`, 2): through sharing, dissolving and sharing again; a removed device; a user without a device.
- Unit (`sync/sharing.test.ts`): staying a member when leaving fails offline; going solo when the space is gone or the device removed, with the partner kept as a local name; no change without a definite answer.
- Live: Alex leaves; the server has no space and no records; both keep all dates; Sam's next sync notices; Sam shares again with Kim in a new space, and Kim never sees Alex's name.
- Page spec: the confirmation (refusing it does nothing), and switching to solo when a sync learns of the end.
- **On the emulator** (development build, local stack): leaving from the shared state removed the space and its 6 records from the server. The phone kept its partner's name, both dates and its reminder.

**Next in phase 3:** adding one of my devices and removing a device both need a **verified device list** first. Rotation seals the new key to each remaining device, and keys read from the server's `devices` table could be planted by the server (the same attack as unsigned envelopes). The plan: an end-to-end encrypted `device` record holding each device's public keys, written by the device that checked the safety code; rotation seals only to devices on that list. This is a design change for §7, to be written down before it is built.

### Phase 3, slice 2: the verified device list (2026-10-23)

The design is in §7 (revised the same day: each device writes only its own record; removal will be one all-or-nothing `rotate` call; repair of missing envelopes; old-epoch writes skipped). This slice builds §7.9 step 1.
- **Local:** migration 4 adds `space_devices` and rebuilds the `outbox` table so it accepts the new `device` record type (SQLite can't change a check). The new type is classified in `SYNC_SCHEMA`: the shared fields are `person_id`, the two public keys, `platform` and `revoked_at`.
- **Payload rules:** each key is 32 bytes in base64, the platform is `android` or `ios`, and the person is a UUID or null.
- **`SYNC_CAPABILITY` is 2**, so an updated older build pulls everything once more and picks up the device records it refused before.
- **Each device writes its own record** (`SyncStore.writeOwnDevice`) when it creates the space, when it finishes joining, and on any sync where its record is missing or out of date. It never writes over a removal.
- Going solo and *Delete all data* clear the list.
- **Server:** `20261023000300_device_records.sql` lets `records` hold `device`.

**Tests:**
- Upgrade from v3 keeps queued changes and accepts device records.
- Device records travel between two devices; a malformed one is refused; writing an unchanged record queues nothing; a removed device does not write itself back.
- Live: after a real join, both phones list exactly both devices, each with the keys that device holds.

**Next:**
- Adding one of my devices (§7.6): done in slice 3.
- Removing a device with rotation (§7.4); only my own devices on screen (§7.7, decided).

**Found:** *Delete all data* did not touch sharing (fixed below, "Delete all data while sharing").

### Phase 3, slice 3: adding one of my devices (2026-10-23)

Builds §7.6. In the shared state, *Add one of my devices* creates the same kind of invite, remembered locally as "for me"; approving it admits the device as this person (`approve_invite(invite, as_person)`). Its screens say "your other device" instead of "your partner".
- **On the new device:** *Join with a code* works for both cases (its hint now mentions both). After approval, `accept_invite` names the person it now belongs to. If that's not the person it claimed with, it **becomes that person** (`SyncStore.becomePerson`): its onboarding person is replaced by a local row for the space's person, kept as this device's owner and starting at the oldest version so the space's name wins. Everything it authored is re-attributed, and its old self is never uploaded. It then adopts the space's profile **without asking about the start date**, merges its dates, writes its own device record and says "This device now shares your space too."
- Retrying after a crash is safe: becoming the person a second time changes nothing.

**Security review of slice 2 (device list), fixed here:** a received device record can no longer change the keys of a device already listed, or undo a removal, whatever its version (`RefusedRecordError`). The suggestion to also sign each device record was not taken: only members can write records, and members are trusted by design (§11).

**Tests:**
- sql.js: a tablet becomes Alex; its date is re-attributed; nothing of its old self is queued; the phone still lists exactly Alex and Sam.
- Engine: refused key changes and refused un-removal.
- Live: Alex adds a tablet with a different start date. The safety codes match, there is no date question, both devices share one person, the tablet's date reaches the phone, and the device list has two devices of the same person.
- Page spec: the button creates a "for me" invite with its own wording.
- Not run on a device: the screens are the partner flow's, apart from the button and wording covered by the spec.

### Phase 3, slice 4: removing a device (2026-10-23)

Builds §7.3–7.5. In the shared state, *Your devices* lists this device and my other devices (never the partner's, §7.7) with *Remove* on the others, after a confirmation: the device stops receiving anything new, the space gets a new key, and what's already on it stays.
- **Removing** (`Sharing.removeDevice`):
  - a new key, stored locally first, is sealed and signed to every other listed device;
  - then one server call, `rotate(target, expected_epoch, envelopes)`, does it all or nothing;
  - the removed device's entry is marked removed;
  - if another device rotated first, it refuses and the user tries again;
  - a crash after the call is finished by the next sync.
- **The other devices** notice a newer epoch on their next sync. They take the key from their envelope only if it was signed by themselves or by a listed device **that hasn't been removed**.
  - If the signer's entry hasn't arrived yet, they first pull what the keys in hand can read. The engine now **stops at a record under an epoch whose key it doesn't have yet** (`awaitingKey`), instead of rejecting and skipping it. Then they try again.
  - An untrusted key is never adopted: "This device can't open the new sharing key yet".
- **The removed device** learns it was removed on its next sync, goes solo, keeps everything it had, and says "This device was removed from the shared space. Everything already on it stays."
- **Repair:** each sync seals the current key to listed, non-removed devices that have no envelope yet (`devices_missing_envelope`, `seal_missing`). An existing envelope is never replaced.
- **Old epochs:** writes under any epoch but the current one are skipped by the server. The invite envelope now carries **every epoch's key and, for my own devices, the person** (`invite-bundle.ts`), sealed with the invite secret.
  - A device added after a removal reads history, and files its own envelopes for the older epochs (`store_own_envelopes`).
  - The joining device accepts the server's person only if the sealed bundle agrees.
- **Server** (`20261023000400_rotation.sql`, `20261023000500_own_envelopes.sql`):
  - `rotate`, `devices_missing_envelope`, `seal_missing` and `store_own_envelopes`;
  - envelopes record their signer;
  - `revoke_device` is gone (it started an epoch with no envelopes);
  - `approve_invite` admits a device "as a person" only for the approver's own person.

**Security reviews of slice 3 and this slice, fixed:**
- **Device entries:** a received device entry can't move a known device to another person, change its keys or undo its removal.
- **The joining device's person:** it checks the person against the sealed bundle.
- **Removed signers:** a removed device no longer vouches for keys. Otherwise a hostile server could plant a key signed by a removed device and read what the others write next.
- **Interrupted removals:** one is completed only if the adopted key is the one this device created. Another device may have rotated first, and marking its target removed would have cut it off for good.

**Tests:**
- PGlite (`rotation.test.ts`, 5):
  - all or nothing when one envelope is refused;
  - removal and the new epoch in one step, then a second rotation on top of the old epoch refused;
  - old-epoch writes skipped;
  - repair that never replaces;
  - "as a person" only for oneself.
- sql.js:
  - a record under a missing epoch waits;
  - the invite bundle, including older 32-byte invites.
- Page spec: my devices listed, *Remove* never on this device, asked first.
- **Live, on the local stack** (Alex's phone and tablet, Sam's phone, later Alex's new phone and Sam's tablet):
  - Alex's phone removes the tablet; Sam adopts epoch 2 from the envelope Alex's phone signed; Sam's next record reaches Alex.
  - The tablet learns it was removed and keeps its data.
  - **Read as the database owner, the record written after the removal can't be decrypted with the tablet's key; the new key can.**
  - A phone added afterwards reads the records from before the removal.
  - A lost reply during a concurrent removal does not mark the wrong device removed.
  - A key planted by the server and signed by the removed tablet is refused.

**Not verified:**
- From the app side: retrying after `epochChanged`, a crash right after `rotate`, and repair for a device added just before a rotation (the server functions are tested).
- On a device: nothing in this slice ran on the emulator.
- Recovery envelopes weren't re-wrapped yet: done in phase 4 (§7.8).

**A third security review, fixed the same day:** before this, the record that marks a device removed was written under the *new* key. So a device catching up couldn't read it before deciding whether to trust that new key, and a key signed by the removed device would have been accepted. Now the removal is written under the old key first. Every device pulls with the keys it holds before adopting a new epoch, and repair runs after the pull. Live test: the server swaps Sam's envelope for a key the removed tablet chose and signed, and Sam refuses it; with the honest envelope back, Sam adopts the real key.

**A fourth security review, fixed the same day:** if the key change failed after the removal record was written (offline, say), the device was marked removed but kept the current key, and it vanished from the list so the user couldn't retry. Now the removal is recorded before anything else and resumed on every sync until the server has rotated. Meanwhile the device shows as "Removal pending". A removal interrupted by someone else's rotation is finished from the new epoch instead of being dropped. Live test: with the server's `rotate` unavailable, the removal stays pending and visible; the next sync completes it, and the tablet learns it was removed.

**A fifth security review, fixed the same day** (`20261023000600_rotate_messages.sql`):
- **"Already removed" was read too loosely.** One error message covered both "the target is gone" (clear the pending removal) and "a recipient is out of date" (retry). They now have distinct messages.
- **A second removal could overwrite a pending one.** It's now refused.
- **New content could go up under the old key while a removal was pending.** The removed device still holds that key. Now only device records go up before the rotation, and a sync with a removal pending only downloads.
- Live test (with `rotate` unavailable):
  - a date written meanwhile never reaches the server;
  - a second removal is refused;
  - once the rotation goes through, the date arrives under the new epoch.

**Phase 3's done-when** ("the removed device can't decrypt new records; both keep data after dissolving") is met in live tests against the local stack, not yet on devices.

### Phase 4: the recovery key (2026-10-23)

Built as revised in §8 (key pair, separate `recovery` record, hashed lookups, signed envelopes).
- **Server** (`20261023000700_recovery.sql`): `recovery_lookups` (lookup and public key hashes, no member access), recovery envelopes per person, `recover()` (admits the device as that person; asking again from the same device returns the same answer), `persons_missing_recovery_envelope()`, and `rotate()` taking recovery envelopes and an optional new lookup. Envelopes sealed to an outdated public key, or for a person without a key, are skipped.
- **Device:** local migration 5 (`space_recovery`), the `recovery` record type (capability 3), `deriveRecoveryKeys` (lookup and X25519 pair from the key), `Sharing.recoveryStatus / createRecoveryKey / confirmRecoveryKey / recover`, recovery envelopes in every rotation, and repair by rotation.
- **Screens:** after *Create an invite*, the key comes first and can't be skipped; a partner who joins makes theirs next. Until a partner has joined, the shared screen also offers *Invite your partner* (the first invite may have expired, or never been shown if the key screen was left). On the shared screen: a banner while my person has no key, then a *Recovery key* section with *Replace recovery key*, and a suggestion to replace it after removing a device. *Recover with your recovery key* on the off screen. EN, FR and NL.

**Tests:**
- PGlite (`recovery.test.ts`, 4): setup by rotation, hashes out of members' reach; only envelopes for the current public key are kept; repair; recover and asking again; Replace, after which the old key recovers nothing and a rotation sealed to the old public key leaves the person missing.
- sql.js (`sharing.test.ts`): nothing changes until the two groups match; groups typed loosely; a mistyped key refused before the server; an interrupted recovery counts as off and blocks syncing.
- **Live, local stack:** Alex sets up a key, Sam joins and sets up theirs; a new phone recovers as Alex with the key typed in lower case and gets every date; both directions sync; removing the lost phone seals the new key to both recovery keys; Replace makes the old key unknown; a newest envelope whose signer was changed on the server is refused and the device stays solo; with the honest signer back, recovery works; a deleted recovery envelope is repaired by a key change on Sam's next sync, which the others adopt.
- Page spec: the key's numbered groups, confirmation, mismatch message, invite after confirming, banner, Replace and cancel, suggestion after a removal, recovering.
- **Browser preview against the local stack:** turning sharing on showed the key, confirming it saved the hashes and both epochs' envelopes on the server, then showed the invite.

- **Live, interrupted setup:** with the server's key change unavailable, the confirmed key waits as "saving" and the next sync finishes it (a new phone then recovers with it); with the reply lost after the server made a Replace, the next sync still writes the new public key, a later key change from another device leaves nobody missing, the old key is unknown and the new one recovers.

**Security review of phase 4 (2026-10-23):**
- A `recovery` record is now kept by the server only from a device of the person it belongs to, and a mismatch with the key the server seals to shows the "create your recovery key" banner again (PGlite and sql.js tests).
- A hostile server holding back newer epochs from a recovering device is recorded as a limit in §11 (same family as withholding a removal record).

**Verified on the Android emulator** (API 37.2, development build against the local stack, the browser preview on a separate origin as Sam's phone):
- Alex turns sharing on; the key shows in 8 numbered groups; *Save or send* opens the Android share sheet with the key as one sentence (no file written by the app); two groups typed back in lower case confirm it, then the invite shows.
- Sam joins (same safety code on both), goes straight to their own key and confirms it. The server holds both persons' lookups, at epoch 3.
- **The app's data is wiped** (`pm clear`). After a fresh onboarding with a different start date, *Recover with your recovery key* with only the key (typed in lower case, spaces for hyphens) brings back "Shared with Sam", the shared start date (over the one just typed), every date, the key shown as set, and the lost phone listed under my devices.
- **Syncing both ways:** a date added on the recovered phone reaches Sam, and Sam's new date reaches the phone.
- Removing the lost phone from the recovered one moves the space to epoch 4 with recovery envelopes for both persons, shows the suggestion to replace the key, and Sam adopts the new key and keeps syncing.
- Found and fixed: the shared screen kept offering *Invite your partner* after a sync had brought the partner in; it now rechecks after each sync (page spec).

**Phase 4's done-when** ("restored on a wiped emulator with the key only") is met.

**Not verified:** iOS, a real Android phone, and two emulators (the second phone was the browser preview).

### Delete all data while sharing (2026-10-23)

**Decided by the product owner:** *Delete all data* takes **this device** out of the space, then wipes it. The partner and my other devices keep sharing.
- This device seals a new key to every other device and signs it, in the same all-or-nothing `rotate` call as any removal, with itself as the target. Unlike removing another device, it does **not** mark itself removed first: the others must still accept its signature on the new key. They mark it removed on their next sync, from the server's report (`removedDevices`). Trusting the server there can only remove trust, never add it.
- **If it was the only device in the space, the space is deleted.**
- Then every sharing secret is forgotten: device keys, the session, pending steps and every space key (`secret-names.ts`). The usual wipe follows.
- **Offline**, the wipe still goes ahead with the keys deleted, so the device can read nothing more, and the message says it couldn't be taken out of the space.
- Tests:
  - live: the tablet takes itself out; Alex's phone and Sam move to the new key, mark it removed and keep syncing; a device alone in its space deletes the space;
  - spec: every sharing secret is forgotten.

**Phase 2 status:** the invite and core sync are complete for the profile, persons and dates. They are verified between the Android emulator and the browser preview against a local server. Next is phase 3 (devices and leaving), then phase 4 (recovery key), which real users need before `SYNC_CONFIG` can be set.

**Still open from phase 1:**
- "Delete forever" and the 30-day purge remove the row locally but do not reach the other device yet. They need a content-free tombstone that syncs. *(Done in phase 5, slice 3: §18.)*

## 18. Phase 5: memories and photos (2026-10-23)

**Scope.** Memories (title, text, date, linked date) and the photos in them; since 2026-10-24 also the photo on a date and the profile photo (below).

**Photos** (decided by the product owner, 2026-10-23, see §9): only the 2048 px version is uploaded, encrypted with its own random key in 64 KiB chunks (§3). The photo's record (`memory_media`) carries the blob ID, the file key, the stream header and the size, inside its encryption. A photo record reaches the server **only after its file is uploaded**; until then, and when the space is at its 2 GB limit, it waits in the outbox. Each device makes its own thumbnail after downloading.

**Slices:**
1. **Memory records** (done, below): memories sync; photo records have their final format but wait on the phone.
2. **Encrypted photos:** first a live test of what local Supabase Storage enforces (object size, paths per chunk, a quota a member can't get around by calling Storage directly), then upload with resume, download with thumbnails through a `core/platform` interface, the 2 GB limit, and the screen's message at the limit.
3. **Deleting:** "delete forever" and the 30-day purge reach the other devices as a content-free record, and the server deletes the photo's file, freeing its space.

### Slice 1: memory records

- **Local schema 6:** `memories.milestone_id` and `memory_media.memory_id` are no longer foreign keys. A pull is ordered by each record's latest change, so after an edit a photo record can arrive before its memory, and a memory before its date. With foreign keys on, that insert failed and the record was skipped for good. The repositories now delete a memory's photo rows explicitly.
- `memory_media` gains `blob_id`, `blob_key`, `blob_header`, `blob_size` (shared) and `blob_state` (local: `local`, `uploaded` or `remote`); `file_path` may be empty for a photo not downloaded yet, and such photos aren't shown yet.
- **Deleted for good stays deleted:** a local `purged_records` table keeps the version of what "delete forever" and the purge removed, and a pull of the same or an older version is ignored. Without it, the full re-pull after an update (capability 4) would have brought such items back to the trash. *(Slice 3 replaced this with synced purge records, and made deleting for good final: a newer version no longer brings it back.)*
- **Memories made before sharing could sync** go up once: moving to capability 4 queues every memory and photo record (photos still wait for slice 2). Memory edits made while sharing were already queued and go up too, once.
- Payload rules: lengths as in the editor, a valid date, IDs as UUIDs, and the blob fields all present (valid sizes) or all empty.
- The sharing screen now says memories are shared and photos will follow.

**Tests:** sql.js (`memory-sync.test.ts`, 6): memories both ways with photos held back; a photo and a memory pulled before their memory and date end up linked; memories from before the update uploaded once; something deleted for good here stays gone after a full re-pull but comes back when restored elsewhere (checked to fail without the guard); records over the limits refused; schema 6 keeps data and drops the two foreign keys. Live, local stack: a memory made before sharing and one made after reach the other phone; the server holds two memory records and no photo record.

**On the emulator** (API 37.2, development build): the recovered phone from phase 4, on schema 5, was updated in place; it opened on schema 6 with its data, and a memory written there reached the server.

**Not verified:** receiving memories on a device (covered by sql.js and live tests); photos (slice 2).

### Slice 2: encrypted photos

**What local Supabase Storage enforces** (probed first, live, as a hostile member calling Storage directly with their own session: `supabase/tests/photos-live.test.ts`):
- The **bucket's per-object limit** is enforced by Storage itself ("The object exceeded the maximum allowed size").
- Storage first checks the insert policy with a row it rolls back, which has **no size yet**, then uploads, then inserts the row with the file's size (seen with a temporary trigger). So a policy can't check sizes, but a trigger on that final row can, and a refused part leaves no file behind (checked on the local file backend).
- Insert, select and delete policies on `storage.objects` see the path, and can call our own functions.
- With no update policy, a stored object can't be replaced, with or without upsert.
- **Resumable (TUS) uploads** follow the same rules (probed with a member's session).
- `storage.objects`, the reservations and the settings aren't reachable through the data API, and a member can't change the bucket.
- The **S3-compatible protocol** wasn't probed, and Harmonia doesn't use it: it is off in `supabase/config.toml` and **must be off on the hosted project** too.

**The design that follows** (`20261023000900_photo_blobs.sql`):
- A private bucket `photos` whose objects may be at most one part: 16 encrypted chunks of 64 KiB (1,048,848 bytes).
- A photo is stored as parts at `<space>/<blob>/<part>`. Before uploading, a device calls `reserve_blob(blob, size)`, which takes the space's lock, checks the total against the limit and records how many parts the photo may have. The same photo and size again changes nothing.
- The insert policy accepts a part only from the device that reserved the photo, in its own space, with a part number within its size. A trigger then requires **exactly** the encrypted size that part has (each 64 KiB chunk adds 17 bytes). So a member can store exactly what was reserved, whatever their app does.
- *Found in review, fixed before commit:* a first version checked only part numbers, so a 1-byte reservation could store a full 1 MiB part.
- Members read and delete only their own space's photos (partners are equal).
- The limit is the one row of `storage_settings` (2 GiB), out of members' reach; `space_storage()` gives the screen the bytes used and the limit.

**On the device** (`photo-sync.ts`, `photo-transport.ts`):
- A sync uploads this device's photos, then pushes the records, then pulls and downloads. A photo's record goes up only once its file is on the server.
- **Resuming:** libsodium's chunked encryption picks a fresh random header each time, so a half-uploaded photo can't be re-encrypted to match parts already stored. An interrupted photo starts again: its stale parts are deleted, and its reservation is reused (the blob ID is stored before uploading). An interrupted batch carries on with the remaining photos. A 2048 px photo is usually one or two parts.
- **Downloading:** every chunk is authenticated, a cut-short or altered photo is refused, and so is anything that isn't a JPEG of at most 4096 px a side, read from its header before the image decoder sees it (`jpeg.ts`: a small file declaring a huge image could otherwise exhaust memory on every sync). Both encoders in use (Android WebView, Chrome) were checked to produce headers it reads. Nothing is kept until all of it checks out, and it is retried on the next sync. The file is kept as sent (already a 2048 px JPEG without metadata), with this device's own thumbnail.
- **At the limit:** the photos that don't fit stay on this phone and are counted as waiting; everything else keeps syncing. The sharing screen shows "Shared photos use 12.5 MB of 2 GB", says how many photos are waiting, and says when there's no room. A background sync says so once.
- Photos of a memory from the space appear once downloaded.

**Tests:**
- PGlite (`photos.test.ts`): parts by reserved size; odd paths, other spaces and strangers refused; the limit; settings out of reach.
- Live probe (`photos-live.test.ts`, 3): the refusal reasons above, read back as stored, 5 reservations at once can't pass the limit.
- sql.js (`photo-sync.test.ts`, 4):
  - a 2.5 MiB photo goes up in three encrypted parts (no plaintext run on the server) and arrives byte for byte;
  - an interrupted photo starts again while the next one is shared, with one reservation;
  - at the limit photos wait and go once there's room;
  - altered or cut-short parts are never kept, and the honest ones then are.
- Live, through `Sharing` on the local stack: a 1.5 MiB photo goes through Storage as two parts and the partner's phone keeps the same bytes; `photoStorage()` reports the reservation.
- Page spec: usage line, photos waiting, no room.

**Verified on the Android emulator** (API 37.2, development build against the local stack, the browser preview on a separate origin as Sam's phone; 2026-10-24):
- Alex turns sharing on and sets up the recovery key; Sam joins (same safety code) and sets up theirs.
- **Browser to phone:** Sam adds a memory with a photo; the server holds one encrypted part (the 53,928-byte JPEG plus 17 bytes), a memory record and a photo record. The emulator downloads it, checks it, stores it through Android's file storage, makes its own 480 × 360 thumbnail, and shows it in Memories.
- **Phone to browser:** a photo picked on the emulator through Android's system photo picker goes up (the screen then says "Shared photos use 0.2 MB of 2 GB") and appears on Sam's side with its thumbnail.
- No console errors other than the expected "not approved yet" answers while Sam waited for approval.
- Seen there: Storage still holds the photos of spaces deleted by earlier test runs (slice 3, below).

**Phase 5's done-when** ("photos appear on the other device; a resumable upload is verified"): photos appear on the other device, on the emulator. Resuming is verified in sql.js tests (per photo, as above), not on a device.

**Left for slice 3 (done there, below):** freeing a photo's space when it is deleted for good, and deleting a space's photos when it is left. Still open: a received photo that fails its checks is retried on every sync; a cap on attempts would save the downloads.

### Date and profile photos, and a retry cap (2026-10-24)

- A date's photo and the profile photo travel like a memory's photos: encrypted, as parts, with the key in the record (local schema 8, capability 6). Unlike a memory's photo record, the date or profile itself syncs at once; its photo follows in a new version once the file is up.
- A replaced or removed photo frees its old space once the new version is on the server. Deleting a date for good frees its photo too.
- A device that receives another photo downloads it, and keeps the old file until the new one is in; a removed photo goes from the other device too. Records from an older app, without the photo fields, are still accepted.
- A received photo that keeps failing its checks is tried five times, not on every sync forever.
- Tests (sql.js): a date's photo shared, replaced and removed, with its space freed each time; the profile photo shared; a tampered photo downloaded five times, then left alone.

### Slice 3: deleting for good (2026-10-24)

**A content-free purge record** (`purge`, capability 5, local schema 7):
- "Delete forever" from Recently deleted, the 30-day purge, and **removing a photo from a memory** now each write a purge record: only the item's ID, with its type inside the encryption. Every device deletes the item (and what depends on it, the way "Delete forever" does), and drops anything of it still waiting to go up. A purge is final: no later version brings the item back, on any device or after a full re-pull.
- Removing a photo is a purge rather than a tombstone because its file is deleted at once: a tombstone could be undone by a concurrent edit elsewhere, leaving everyone a photo whose file is gone.
- On the server (`20261024000000_purges.sql`), a purge record deletes the item's records and later writes to that ID are skipped. **Only dates, memories and photos**: record IDs are shared across types (a person's recovery record has the person's ID, device records carry removals), and the server can't see which type a purge meant. The device also refuses a purge naming another type.
- Received purges reach reminders and widgets like any other change.

**Freeing photo space:**
- The server can't see which stored photo a record belongs to, so the device does it. Once the photo's purge is on the server, it deletes the parts through Storage and calls `release_blob()`. (Earlier, a crash could leave the partner a live photo whose file is gone.) The server refuses a release while any part remains, so the limit can't be gamed.
- Photos deleted before their upload finished release their reservation the same way. Any device that learns of the purge may do it; it is idempotent.

**Leaving:**
- Leave (and *Delete all data* on the last device) deletes every photo of the space through Storage **before** dissolving it: afterwards nobody is a member, and nobody may delete them. Storage lists 100 entries a page and one folder level at a time; every page and folder is taken.
- Leaving is recorded first, so an interrupted leave is finished by the next sync (nothing else syncs meanwhile), and the space is dissolved only once Storage is empty for it.
- What a crash still leaves behind (photos of a space that is gone or no longer reserved, and reservations that never got a part) is cleaned by **`scripts/cleanup-photo-storage.mjs`**. The operator runs it with the service role; `orphan_photo_parts()` and `release_stale_reservations()` are service role only. **On the hosted project it must run on a schedule**, for example hourly.

**Security review after commit** (`20261024000100_photo_locks.sql`): a part being stored and its reservation being released could interleave, leaving a part counted against nothing. Both now lock the reservation row (the part's size check for share, the release for update), so whichever comes second sees the other. Live test: a part insert held open makes the release wait, then refuse.

**Also fixed:** the received-photo check reads every kind of JPEG frame header the way a decoder does. It refuses a file whose first frame header is a kind we don't make, or that has two of them (found by the automated security review).

**Tests:**
- PGlite (`purges.test.ts`, 4): a purged date is removed and stays removed; a purge carrying a person's ID leaves the person and recovery records intact and writable; a release is refused while parts remain; the cleanup functions are the operator's only.
- sql.js:
  - a memory deleted for good on one device leaves only a purge record and goes from the other device, for good, even after a full re-pull (`memory-sync.test.ts`);
  - a removed photo's space is freed after its purge, and it goes from the other device; deleting a memory for good frees all its photos; a photo deleted mid-upload releases its reservation (`photo-sync.test.ts`);
  - an interrupted leave is resumed by the next sync, and nothing else is synced meanwhile (`sharing.test.ts`);
  - the JPEG check (`jpeg.test.ts`).
- Live, local stack:
  - a release only once parts are gone; 105 photos deleted across two pages of listing;
  - the cleanup script removes a crashed leave's photos and an unused reservation;
  - through `Sharing`, a removed photo leaves the other phone, the records (only a purge is left) and Storage; leaving with a photo shared empties Storage before the space goes.
- **On the emulator** (API 37.2, development build, alone in a space):
  - a photo picked through Android's picker went up as one part of exactly the photo's size plus 17 bytes per chunk;
  - removing it in the memory editor left a purge record, and emptied Storage and the reservations;
  - a photo shared again was deleted from Storage when leaving from the screen, and the space was gone;
  - WebView-encoded JPEGs pass the stricter check.

**Not verified:** a purge arriving on a device (covered by sql.js and live tests); the cleanup script on a hosted project.

**Noticed (not new), fixed the same day:** while an invite was waiting, the sharing screen showed only the invite, with no way to *Sync now* or *Leave* until it was answered or expired. A waiting invite is now a section at the top of the shared view (code, *Copy code*, *Send code*, *Cancel invite*), with *Sync now*, the devices, the recovery key and *Leave* below it; the safety-code step still takes the whole screen once a device claims the invite. Page spec, and checked on the emulator.

## 19. Hardening (2026-10-24)

Phase 6's server-side part, done before real users (`20261024000200_limits.sql`, `20261024000300_tighten.sql`).

**Rate limits**, per device and hour, on the calls that create something: spaces (10), invites (30), claims (30), key changes (60), photo reservations (3,000) and record writes (20,000).
- A call refused by its limit leaves its counter as it was, so the device stays refused until the hour turns.
- The originals are kept under other names, out of members' reach, behind functions with the same names and arguments.
- Calls that fail anyway aren't counted (a counter bumped by a failing call is rolled back with it): an unknown recovery key, an unknown invite. What protects those is that they can't be guessed (a 128-bit lookup, a random invite ID). Nothing here limits how often a signed-in device calls them: Supabase Auth's per-address limits (`config.toml`) cover sign-ins only. A hard bound on load belongs in the API gateway or in attestation (still open).

**Size caps:**
- An encrypted record is at most 64 KiB, with a 24-byte nonce.
- A space's records total at most 200 MiB (a setting next to the photo limit), kept as a running count: purges and smaller versions free room. Before this, records had no cap at all, so a member could have stored any amount outside the photo limit.
- A full space can always free itself: purges and moves to the trash (a tombstone grows by at most 1 KiB) skip the total check, and the device sends purges in a batch of their own first, since one refused row fails a whole batch. A push is an upsert, so the check counts the stored version of a record as replaced (found in review: the first version charged the full size, which would have refused almost every upload in a full space).
- A record over 64 KiB never leaves the device (it would fail every upload); the editors' limits stay far below that.
- An invite bundle is at most 16 KiB.
- The app says in words when a limit is hit ("too often in the last hour", "your shared space is full").

**Security review** (automated checks on the live database, then by hand):
- **Fixed, real:** `store_recovery_envelopes`, an internal helper that trusts its `space` and `caller` arguments, was callable by any signed-in device. Its migration revoked it only from PUBLIC, but Supabase also grants signed-in users every function directly. Anyone knowing a space's and a person's IDs (an ex-member, a removed device) could have filled that person's recovery envelope slots with junk, so the real envelopes for those epochs would be skipped and recovery would break. The PGlite shim now grants functions the way Supabase does, so a test catches this kind of mistake.
- **Fixed:** members could insert, change or delete person rows directly, and a delete cascaded to the person's recovery key entry. Members can only read them now; the functions that create persons don't need more.
- **Fixed, defense in depth:** the signed-out role held every table and function privilege (Supabase's defaults plus Postgres's grant to PUBLIC). Nothing was open (every function refuses a caller that isn't a registered device, and no policy lets it read a row), but it now has no privileges at all, for later objects too.
- **Checked, fine:** every function that bypasses row-level security sets its search path; every table has row-level security; signed-in callers can only run the functions the app calls, plus the read-only helpers the policies use.

**Tests:** PGlite (`limits.test.ts`): the 31st invite refused until the hour turns; an oversized bundle; counters and originals out of reach; record size, nonce and the space's total, including room freed by smaller versions and purges; person rows read-only; the helper not callable; the signed-out role refused. Live: the whole suite (76) on the local stack.

**Operator, on the hosted project:** before applying `20261024000300_tighten.sql`, check that no extension keeps functions in the `public` schema (they would lose the PUBLIC grant that defaults or policies may rely on).

**Still open for phase 6:** app attestation (Play Integrity / App Attest) to keep non-Harmonia clients out; the privacy policy, store forms and link domain (need the product owner).


## 20. QR invites (2026-10-24)

- **Showing:** while an invite waits, the sharing screen draws its code as a QR code (`shared/components/qr-code.component.ts`: `uqr` encodes it, error correction M, drawn as one SVG path, so it stays sharp and themable), with the text code below for sending it.
- **Scanning:** the join form has *Scan QR code* (native only, `core/platform/qr-scanner.ts`). It only fills the code field after checking it with `parseInviteCode`; the name and *Join* stay with the user. A code that isn't an invite says so; a cancel does nothing.
- **Android:** `@capacitor/barcode-scanner` with the **ZXing** engine. ML Kit is excluded from the build (`configurations.all { exclude group: 'com.google.mlkit' }` in `android/app/build.gradle`): its terms let it send usage metrics to Google, and Harmonia makes no such calls. The debug APK was checked: no ML Kit classes or init provider (the release build is checked in release prep). The plugin needs **minSdk 26** (Android 8.0), raised from 24.
- **iOS:** the plugin uses AVFoundation; the camera usage text now mentions scanning invites (EN/FR/NL).
- **Verified:** page spec with a fake scanner (fills the code, refuses a non-invite, ignores a cancel). On the API 37.2 emulator: the shown QR code, screenshotted and decoded with zxing-cpp, equals the invite code exactly; the ZXing scanner opened on the camera and Back returned to the app with a cancel, no crash. Not verified: a scan of a real code by a real camera, iOS.

## 21. Two phones (2026-10-24)

First run between **two Android emulators** (API 37.2, both on the local stack through `adb reverse tcp:54321 tcp:54321`, one per emulator; development build `bun run android:build:dev`, since the production bundle leaves the local server out):

- **Invite and join:** phone A creates the invite and its recovery key; phone B, with its own data and a different start date, joins with the code; both show the same safety code (329 548); A accepts; B is asked which start date to keep, keeps A's, then sets up its own recovery key. Both show *Together since June 14, 2024*.
- **Dates:** a date added on B appears on A after a sync. An edit made on A while the server was unreachable shows *Harmonia couldn't reach the sharing server*, stays on A, and reaches B once A is back online. The same date edited on both phones before either syncs ends with the later edit on both.
- **Photos:** a memory with a 3000 × 2000 photo, picked through Android's photo picker on A, arrives on B with its thumbnail and the 2048 × 1365 photo; A shows 0.1 MB used.
- **Delete forever:** deleting that memory and then *Delete forever* on B removes it from A (not in Memories or Recently deleted), the space's use goes back to 0 MB and its photo is gone from Storage.
- **Operator script:** an 18-byte part left by an earlier live test in a space that no longer exists was removed by `scripts/cleanup-photo-storage.mjs`.
- **Fixed:** the *Delete forever* dialog said "from this device" while sharing, though it removes the item from both people's devices and the server. While sharing it now says so (EN/FR/NL; page spec).
- **Not covered here:** airplane mode on the emulator doesn't cut `adb reverse` (it's a loopback connection), so being offline was simulated by removing the route and restarting the app. Two real phones on a real network, iOS, and scanning one phone's QR code with the other's camera are still to do.
