# Partner sharing and multi-device sync (design)

**Status:** design only, not implemented. **Decided by the product owner on 2026-10-21:**
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
| Record encryption | `crypto_aead_xchacha20poly1305_ietf` with key `K[epoch]`, a random 24-byte nonce, and AAD = `spaceId ‖ recordType ‖ recordId ‖ epoch` |
| Key delivery to a device | `crypto_box_seal(K[epoch], devicePublicKey)` |
| Photos | Per-file random key; `crypto_secretstream_xchacha20poly1305` in 64 KiB chunks (resumable, constant memory); the file key is stored inside the encrypted media record |
| Invite secret | 32 random bytes, sent only in a URL fragment or QR code; `crypto_kdf` derives the invite key |
| Recovery key | 160 random bits plus a checksum, shown as grouped base32 (§8); `crypto_kdf` derives the lookup ID and the wrapping key. No password stretching is needed, which matters because the standard build has no `crypto_pwhash`. |
| Safety code | `crypto_generichash` over both device public keys and the invite ID, shown as 6 digits on both screens |

**Key storage:** `@aparajita/capacitor-secure-storage` 8.x (iOS Keychain, Android Keystore). To verify in the spike:
- the Keychain item is *ThisDeviceOnly* and excluded from iCloud backup;
- the Android key is hardware-backed where available.

Keys are decrypted into WebView memory while the app runs. That's acceptable for this threat model; see §11.

## 4. Server

**Recommended:** Supabase, EU region (Frankfurt), used as a store for encrypted data plus a few Edge Functions. Self-hosting (Postgres + S3-compatible storage + a small Bun service) is the fallback. The API is kept small so it can move.

**Device authentication**
- Supabase anonymous sign-in gives each device a JWT. The **device's Ed25519 key is the real identity**: the server binds the JWT to a registered device public key, and membership changes require a signed request. An anonymous session is lost on reinstall; the device identity in secure storage is not.
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

## 5. Local data model changes (migration v2)

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
- **Clock:** a hybrid logical clock (wall time, counter, device ID). Last write wins **per field** for the profile and milestones, and per record otherwise. A delete is a tombstone; when a delete and an edit happen at the same time, the delete wins. Deleted items stay recoverable for 30 days (§6.6). Media in a memory are separate records, so adding and removing photos never conflict.

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
On an existing device, choose **Add a device** to show a QR code. The new device scans it, registers, shows the safety code, and is approved on the existing device. It becomes a device of the **same person**. A recovery key also works (§8).

### 6.4 Remove a device (lost or replaced)
From any device in the space:
1. The server revokes the device, so its JWT and signature no longer work.
2. A new epoch `K[n+1]` is sealed to the remaining devices and to every recovery envelope.
3. Future writes use the new epoch.

**The removed device keeps what it already downloaded.** This is unavoidable, and it's why an app lock (PIN or biometrics) is planned.

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

## 7. Key rotation
- A new epoch is created when a device is removed, when a person's recovery key is replaced, and when a person leaves (the dissolve deletes everything anyway).
- Old records keep their epoch. Members keep the old keys locally so they can read history, and the server stores envelopes for each epoch.
- **Every rotation also re-wraps each person's recovery envelope.** Without that, recovery breaks.

## 8. Recovery key
- 160 random bits plus a 16-bit checksum, shown as **8 groups of 5 base32 characters**, for example `K7QX2-…`. It's language-neutral (no English word list) and typo-safe thanks to the checksum.
- It's shown once, when sharing is turned on. The user must confirm it by typing back two groups. They can copy it or save it as a file, and print it as an option. It can be shown again on a device that's already a member.
- The server stores, per person, `lookupId = KDF(recoveryKey, "lookup")` and `K[epoch]` sealed with `KDF(recoveryKey, "wrap")`. It never stores the key itself.
- **To recover:** on a new device, enter the key. The device fetches the envelope by lookup ID, registers as a device of that person, and is admitted.
- **Also possible:** the partner re-invites you from their device. In a couple, data isn't lost while either person has a device.
- **Replacing the key** (if it may have been exposed): this creates a new key and a new epoch, and deletes the old envelope.

## 9. Sync behaviour and limits
- Sync runs on launch, on resume, after local changes (debounced), on pull-to-refresh, and when the network comes back. iOS doesn't allow background sync without push, so **the partner's widget updates only after the partner opens the app**. This is documented as a limit.
- Photos: a decrypted 2048 px image plus a thumbnail on each device; only encrypted originals are uploaded. A storage quota applies per space (to decide, for example 2 GB).
- Offline edits wait in the outbox and are merged by HLC when the device reconnects.

## 10. What the server can and cannot see

| Cannot see | Can see (metadata) |
|---|---|
| Names, start date, titles, notes, dates, photos, which reminder settings you use | That a space exists and how many persons and devices it has; device platform; when each device syncs; record counts, types and sizes; blob sizes; IP addresses of requests; invite timing |

The privacy policy must describe the right-hand column. It is not accurate to say "the server knows nothing".

## 11. Threat model (summary)
- **Server breach or an honest-but-curious operator:** gets only metadata and ciphertext. ✔
- **Intercepted invite link:** single-use, 24-hour expiry, requires the inviter's approval and the safety code. ✔
- **Lost or stolen phone:** remove it from another device, which also changes the key. Data already on it stays readable without an app lock, so the PIN or biometric lock is planned.
- **Malicious member:** they can read and edit everything by design. Recently deleted limits the damage from destructive edits.
- **Compromised device (malware):** out of scope, since keys live in the app's memory while it runs.
- **Recovery key leaked:** replace it (§8).

## 12. Obligations and costs
- **Domain and website:**
  - needed for invite links (App Links / Universal Links), the privacy policy and support;
  - also needed for publishing anyway.
- **Store and legal:**
  - In-app deletion of sync data: leave or dissolve deletes the server copy, whatever Apple's account rules turn out to be.
  - Privacy policy, Play Data safety and the App Store privacy label: check the current wording. Don't assume end-to-end encrypted data is exempt from disclosure, or that GDPR doesn't apply. EU hosting, a data processing agreement with Supabase, and a list of processors are required.
- **Cost:** a Supabase Pro project (fixed monthly fee) plus storage and egress for encrypted photos. Estimate it from the quota per space × the expected number of couples before launch.
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
3. **Photo storage quota** per space and the pricing impact.
4. **App lock** (PIN or biometrics): recommended in the same release as sharing.
