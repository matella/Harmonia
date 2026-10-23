import type { ValidProfile } from '../domain/validation';
import { LIMITS } from '../domain/validation';
import { newId as newUuid } from '../persistence/ids';
import type { RelationshipRepository } from '../persistence/relationship.repository';
import type { SecureKeyStore } from '../platform/secure-key-store';
import type { ConnectedDevice, DeviceSession } from './device-session';
import { fromBase64, toBase64 } from './encoding';
import { decodeInviteBundle, encodeInviteBundle } from './invite-bundle';
import { formatInviteCode, parseInviteCode } from './invite-code';
import { SpaceApi, SpaceApiError, type Membership } from './space-api';
import { envelopeMessage, MissingSpaceKeyError, SpaceKeys } from './space-keys';
import { SupabaseTransport } from './supabase-transport';
import type { DevicePublicKeys, SyncCrypto } from './sync-crypto-port';
import { SyncEngine, type SyncReport } from './sync-engine';
import type { LocalDefaults, StartOfRelationship, SyncStore } from './sync-store';

/**
 * Turning sharing on, inviting and joining (docs/PARTNER_SYNC.md §6.1–6.2, §17).
 * Framework-free; the screens drive it and poll the `check…` methods while they are open.
 *
 * Crash safety: every secret (space key, invite secret) is stored locally before the
 * server learns about it, and every step can run again after an interruption.
 */
export type SharingErrorCode =
  | 'nameRequired'
  | 'noProfile'
  | 'invalidCode'
  | 'alreadySharing'
  | 'notSharing'
  | 'noInvite'
  | 'joinInProgress'
  | 'inviteMismatch'
  | 'newKeyNotTrusted'
  | 'unknownDevice'
  | 'removalPending';

/**
 * The server says this device no longer belongs to the space: the partner left (the space
 * was dissolved) or this device was removed. This device has already gone back to solo
 * and kept every record.
 */
export class SharingEndedError extends Error {
  readonly code = 'sharingEnded';
  /** 'dissolved': the space was left; 'removed': this device was removed from it. */
  constructor(readonly reason: 'dissolved' | 'removed' = 'dissolved') {
    super('Sharing has ended.');
    this.name = 'SharingEndedError';
  }
}

/** One of my devices in the space (from the end-to-end device list). */
export interface MyDevice {
  id: string;
  platform: string;
  thisDevice: boolean;
  /** Marked removed here; the key change is still to happen (retried on each sync). */
  pendingRemoval: boolean;
}

export class SharingError extends Error {
  constructor(readonly code: SharingErrorCode) {
    super(`Sharing: ${code}`);
    this.name = 'SharingError';
  }
}

export type SharingStatus = 'off' | 'member' | 'memberWithoutKey' | 'joining';

export type InviteProgress =
  { state: 'waiting' } | { state: 'claimed'; safetyCode: string } | { state: 'gone' };

export type JoinProgress =
  | { state: 'waiting'; safetyCode: string }
  | { state: 'chooseStart'; space: StartOfRelationship; mine: StartOfRelationship }
  /** `ownDevice`: this device joined as another device of an existing person (§7.6). */
  | { state: 'joined'; ownDevice?: boolean }
  | { state: 'gone' };

/** The invite waiting for an answer, and whether it is for one of my own devices. */
export interface CurrentInvite {
  code: string;
  forMe: boolean;
}

export interface SharingDeps {
  store: SyncStore;
  profiles: RelationshipRepository;
  session: DeviceSession;
  crypto: SyncCrypto;
  secrets: SecureKeyStore;
  defaults: () => LocalDefaults;
}

const NAMES = {
  pendingKey: 'sharing.pendingKey',
  invite: 'sharing.invite',
  join: 'sharing.join',
  rotation: 'sharing.rotation',
} as const;

/** A removal in progress: the new key is stored here before the server sees it. */
interface PendingRotation {
  from: number;
  target: string;
  key: string;
}

interface PendingInvite {
  inviteId: string;
  secret: string;
  /** Set for "add one of my devices": approve the device as this person. */
  forPerson?: string;
  /** When it was created here (ms); the server expires invites after 24 hours. */
  createdAt?: number;
}

const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface PendingJoin {
  inviteId: string;
  secret: string;
  inviter?: { sign: string; box: string };
  /** The local person ID this device claimed with. */
  claimedAs?: string;
  /** Set once approved: the person this device now belongs to. */
  person?: string;
  /** Set once approved: this device joined as one of an existing person's devices. */
  ownDevice?: boolean;
  /** Set once the space key is stored here. */
  space?: { spaceId: string; epoch: number };
  /** The joiner's own start, captured before the space's profile replaces it. */
  mine?: StartOfRelationship;
  /** Set while the joiner chooses between two start dates. */
  choose?: { space: StartOfRelationship; mine: StartOfRelationship };
}

export class Sharing {
  private readonly keys: SpaceKeys;

  constructor(private readonly deps: SharingDeps) {
    this.keys = new SpaceKeys(deps.secrets);
  }

  async status(): Promise<SharingStatus> {
    // A joiner choosing a start date is already in the space here, but not done.
    if (await this.read<PendingJoin>(NAMES.join)) return 'joining';
    const state = await this.deps.store.state();
    if (!state) return 'off';
    return (await this.keys.has(state.spaceId, state.epoch)) ? 'member' : 'memberWithoutKey';
  }

  // -------------------------------------------------------------------------------
  // Inviter

  /** Creates the space with this device's data and uploads it (§6.1 steps 1–2). */
  async startSharing(selfName: string): Promise<void> {
    if (await this.deps.store.state()) throw new SharingError('alreadySharing');
    const selfId = await this.ensureSelfName(selfName);
    const device = await this.deps.session.connect({ createKeys: true });
    const api = new SpaceApi(device.client);

    // The new space's ID and key are chosen and stored here first, so the envelope can be
    // signed before the server sees it and a retry after a crash reuses both.
    let pending = await this.read<{ spaceId: string; key: string }>(NAMES.pendingKey);
    if (!pending) {
      pending = { spaceId: newUuid(), key: toBase64(this.deps.crypto.newSpaceKey()) };
      await this.write(NAMES.pendingKey, pending);
    }
    const key = fromBase64(pending.key);
    const sealedKey = this.deps.crypto.sealSpaceKey(key, device.keys.boxPublicKey);
    const signature = this.deps.crypto.sign(
      envelopeMessage(pending.spaceId, 1, device.deviceId, sealedKey),
      device.keys,
    );
    const space = await api.createSpace(pending.spaceId, sealedKey, signature, selfId);
    // If the server already had this device in a space (sharing again after going back to
    // solo here), the key that counts is the one this device sealed and signed for it.
    const own = await this.ownKey(api, space.spaceId, space.epoch);
    if (!own && space.spaceId !== pending.spaceId) throw new MissingSpaceKeyError();
    await this.keys.save(space.spaceId, space.epoch, own ?? key);
    await this.deps.store.joinSpace(space.spaceId, space.epoch);
    await this.writeOwnDevice(device, space.personId);
    await this.deps.secrets.remove(NAMES.pendingKey);
    await this.sync();
  }

  /**
   * A new single-use invite (24 hours). Replaces an earlier unanswered one. `forMe` makes
   * it an invite for one of my own devices (§7.6).
   */
  async createInvite(options: { forMe?: boolean } = {}): Promise<string> {
    const state = await this.deps.store.state();
    if (!state) throw new SharingError('notSharing');
    const device = await this.deps.session.connect();
    const api = new SpaceApi(device.client);
    const previous = await this.read<PendingInvite>(NAMES.invite);
    if (previous) await api.declineInvite(previous.inviteId).catch(() => undefined);

    await this.loadKeys(api);
    if (!this.keys.key(state.epoch)) throw new MissingSpaceKeyError();
    const forPerson = options.forMe
      ? (await this.deps.profiles.persons()).find((p) => p.isSelf)?.id
      : undefined;
    // Every epoch's key, so a device joining after a rotation can read history (§7.5),
    // and the person a device of mine is to become, both out of the server's reach.
    const keys = new Map<number, Uint8Array>();
    for (let epoch = 1; epoch <= state.epoch; epoch++) {
      const key = this.keys.key(epoch);
      if (key) keys.set(epoch, key);
    }
    const secret = this.deps.crypto.newInviteSecret();
    const inviteId = await api.createInvite(
      this.deps.crypto.wrapForInvite(
        encodeInviteBundle({ keys, forPerson: forPerson ?? null }),
        secret,
      ),
    );
    await this.write<PendingInvite>(NAMES.invite, {
      inviteId,
      secret: toBase64(secret),
      createdAt: this.deps.store.nowMs(),
      forPerson,
    });
    return formatInviteCode({ inviteId, secret });
  }

  /** The invite still waiting for an answer, to show it again. */
  async currentInvite(): Promise<CurrentInvite | null> {
    const pending = await this.pendingInvite();
    if (!pending) return null;
    return {
      code: formatInviteCode({ inviteId: pending.inviteId, secret: fromBase64(pending.secret) }),
      forMe: pending.forPerson !== undefined,
    };
  }

  async checkInvite(): Promise<InviteProgress> {
    const pending = await this.pendingInvite();
    if (!pending) return { state: 'gone' };
    const device = await this.deps.session.connect();
    try {
      const claim = await new SpaceApi(device.client).inviteClaim(pending.inviteId);
      if (!claim) return { state: 'waiting' };
      const safetyCode = this.deps.crypto.safetyCode(
        fromBase64(pending.secret),
        pending.inviteId,
        publicKeys(device.keys),
        claim.joiner,
      );
      return { state: 'claimed', safetyCode };
    } catch (error) {
      if (error instanceof SpaceApiError && error.code === 'notAllowed') {
        await this.deps.secrets.remove(NAMES.invite);
        return { state: 'gone' };
      }
      throw error;
    }
  }

  /** The invite waiting for an answer; an expired one is forgotten (the server refuses it anyway). */
  private async pendingInvite(): Promise<PendingInvite | null> {
    const pending = await this.read<PendingInvite>(NAMES.invite);
    if (pending?.createdAt && this.deps.store.nowMs() - pending.createdAt >= INVITE_LIFETIME_MS) {
      await this.deps.secrets.remove(NAMES.invite);
      return null;
    }
    return pending;
  }

  /** Admits the device that claimed the invite, after the safety codes matched. */
  async approveInvite(): Promise<void> {
    const pending = await this.read<PendingInvite>(NAMES.invite);
    if (!pending) throw new SharingError('noInvite');
    const device = await this.deps.session.connect();
    await new SpaceApi(device.client).approveInvite(pending.inviteId, pending.forPerson);
    await this.deps.secrets.remove(NAMES.invite);
  }

  async declineInvite(): Promise<void> {
    const pending = await this.read<PendingInvite>(NAMES.invite);
    if (!pending) return;
    const device = await this.deps.session.connect();
    await new SpaceApi(device.client).declineInvite(pending.inviteId);
    await this.deps.secrets.remove(NAMES.invite);
  }

  // -------------------------------------------------------------------------------
  // Joiner

  /** Claims the invite in `text` for this device; returns the safety code to compare. */
  async claim(text: string, selfName: string): Promise<string> {
    if (await this.deps.store.state()) throw new SharingError('alreadySharing');
    const code = parseInviteCode(text);
    if (!code) throw new SharingError('invalidCode');
    const selfId = await this.ensureSelfName(selfName);
    const device = await this.deps.session.connect({ createKeys: true });
    const pending: PendingJoin = {
      inviteId: code.inviteId,
      secret: toBase64(code.secret),
      claimedAs: selfId,
    };
    await this.write(NAMES.join, pending);
    try {
      const inviter = await new SpaceApi(device.client).claimInvite(code.inviteId, selfId);
      pending.inviter = {
        sign: toBase64(inviter.signPublicKey),
        box: toBase64(inviter.boxPublicKey),
      };
      await this.write(NAMES.join, pending);
      return this.joinSafetyCode(pending, device.keys);
    } catch (error) {
      await this.deps.secrets.remove(NAMES.join);
      throw error;
    }
  }

  /**
   * Polled while waiting for approval. Once approved, takes the space key, adopts the
   * space's profile (§6.2) and syncs; asks first if the two start dates differ.
   */
  async checkJoin(): Promise<JoinProgress> {
    const pending = await this.read<PendingJoin>(NAMES.join);
    if (!pending) return (await this.deps.store.state()) ? { state: 'joined' } : { state: 'gone' };
    if (pending.choose) return { state: 'chooseStart', ...pending.choose };
    const device = await this.deps.session.connect();
    const api = new SpaceApi(device.client);

    if (!pending.space) {
      let accepted;
      try {
        accepted = await api.acceptInvite(pending.inviteId);
      } catch (error) {
        if (error instanceof SpaceApiError && error.code === 'notApprovedYet') {
          return { state: 'waiting', safetyCode: this.joinSafetyCode(pending, device.keys) };
        }
        if (error instanceof SpaceApiError && error.code === 'inviteUnavailable') {
          await this.deps.secrets.remove(NAMES.join);
          return { state: 'gone' };
        }
        throw error;
      }
      const bundle = decodeInviteBundle(
        this.deps.crypto.unwrapInvite(accepted.envelope, fromBase64(pending.secret)),
        accepted.epoch,
      );
      // The person comes from the server; accept it only if the sealed bundle agrees.
      const expected = bundle.forPerson ?? pending.claimedAs;
      if (expected && accepted.personId !== expected) {
        await this.deps.secrets.remove(NAMES.join);
        throw new SharingError('inviteMismatch');
      }
      for (const [epoch, key] of bundle.keys) await this.keys.save(accepted.spaceId, epoch, key);
      pending.space = { spaceId: accepted.spaceId, epoch: accepted.epoch };
      pending.person = accepted.personId;
      pending.ownDevice = bundle.forPerson !== null;
      await this.write(NAMES.join, pending);
    }
    const ownDevice = pending.ownDevice === true;

    const { spaceId, epoch } = pending.space;
    await this.keys.load(spaceId, epoch);
    const key = this.keys.key(epoch);
    if (!key) throw new MissingSpaceKeyError();
    const sealedKey = this.deps.crypto.sealSpaceKey(key, device.keys.boxPublicKey);
    await api.finishJoin(
      pending.inviteId,
      sealedKey,
      this.deps.crypto.sign(
        envelopeMessage(spaceId, epoch, device.deviceId, sealedKey),
        device.keys,
      ),
    );
    await this.storeOlderEnvelopes(api, device, spaceId, epoch);

    if (ownDevice) {
      // One of my devices (§7.6): become that person, adopt the space's profile without
      // asking about the start date (it is the same couple), and merge this device's dates.
      await this.deps.store.becomePerson(pending.person!);
      if (!(await this.deps.store.state())) {
        await this.deps.store.joinSpace(spaceId, epoch, { queueProfile: false });
      }
      await this.engine(device.client).sync({ pullOnly: true, adoptProfile: true });
      return this.finishJoin(true);
    }

    // Captured before adopting the space's profile, so a retry after a crash still knows it.
    if (!pending.mine) {
      const own = await this.deps.store.startOfRelationship();
      if (!own) throw new SharingError('noProfile');
      pending.mine = own;
      await this.write(NAMES.join, pending);
    }
    const mine = pending.mine;
    if (!(await this.deps.store.state())) {
      await this.deps.store.joinSpace(spaceId, epoch, { queueProfile: false });
    }
    await this.engine(device.client).sync({ pullOnly: true, adoptProfile: true });
    const space = await this.deps.store.startOfRelationship();
    if (space && !sameStart(space, mine)) {
      pending.choose = { space, mine };
      await this.write(NAMES.join, pending);
      return { state: 'chooseStart', space, mine };
    }
    return this.finishJoin();
  }

  /** The joiner's answer when the two start dates differ. */
  async chooseStart(choice: 'space' | 'mine'): Promise<JoinProgress> {
    const pending = await this.read<PendingJoin>(NAMES.join);
    if (!pending?.choose) throw new SharingError('noInvite');
    if (choice === 'mine') await this.deps.store.restampStart(pending.choose.mine);
    return this.finishJoin();
  }

  /** Forgets a join in progress on this device (the inviter can still decline it). */
  async cancelJoin(): Promise<void> {
    await this.deps.secrets.remove(NAMES.join);
  }

  // -------------------------------------------------------------------------------

  async sync(): Promise<SyncReport> {
    if (!(await this.deps.store.state())) throw new SharingError('notSharing');
    // Until the joiner has answered (start date), nothing of theirs may be uploaded.
    if (await this.read<PendingJoin>(NAMES.join)) throw new SharingError('joinInProgress');
    const device = await this.deps.session.connect();
    const api = new SpaceApi(device.client);
    // Before anything else (a member without its key must still learn this): after a
    // dissolve, pulls just return nothing, so the end must be asked for explicitly.
    const membership = await this.checkStillMember(api);
    await this.catchUp(api, device, membership);
    await this.loadKeys(api);
    await this.writeOwnDevice(device, membership?.personId ?? null);
    if (await this.read<PendingRotation>(NAMES.rotation)) {
      await this.resumeRemoval(api, device);
      await this.loadKeys(api);
    }
    const report = await this.engine(device.client).sync();
    // After the pull, so the device list it seals to is as fresh as this device can know.
    await this.repairEnvelopes(api, device);
    return report;
  }

  /**
   * Before trusting a newer epoch's key: read everything the keys in hand can (the pull
   * stops at the new epoch's records). A removal is written under the old key before the
   * rotation (§7.4), so this device already knows who was removed, and refuses a key
   * signed by them, before it adopts anything.
   */
  private async catchUp(
    api: SpaceApi,
    device: ConnectedDevice,
    membership: Membership | null,
  ): Promise<void> {
    const state = await this.deps.store.state();
    if (state && membership?.epoch && membership.epoch > state.epoch) {
      await this.loadKeys(api);
      await this.engine(device.client).sync({ pullOnly: true });
    }
    await this.adoptNewEpochs(api, membership);
  }

  /** My devices in the space, from the end-to-end device list (§7.7: only mine on screen). */
  async myDevices(): Promise<MyDevice[]> {
    const self = (await this.deps.profiles.persons()).find((p) => p.isSelf)?.id;
    const thisDevice = await this.deps.session.storedDeviceId();
    const pending = (await this.read<PendingRotation>(NAMES.rotation))?.target;
    return (await this.deps.store.devices())
      .filter(
        (d) => (!d.revokedAt || d.id === pending) && d.personId !== null && d.personId === self,
      )
      .map((d) => ({
        id: d.id,
        platform: d.platform,
        thisDevice: d.id === thisDevice,
        pendingRemoval: d.id === pending,
      }))
      .sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice));
  }

  /**
   * Removes one of my other devices (§7.4): a new space key, stored here first, sealed and
   * signed to every other listed device, then one all-or-nothing server call. A crash
   * after that call is finished by the next sync.
   */
  async removeDevice(targetId: string): Promise<void> {
    if (!(await this.deps.store.state())) throw new SharingError('notSharing');
    const device = await this.deps.session.connect();
    const api = new SpaceApi(device.client);
    await this.catchUp(api, device, await this.checkStillMember(api));
    await this.loadKeys(api);
    const state = (await this.deps.store.state())!;
    const known = await this.deps.store.devices();
    if (targetId === device.deviceId || !known.some((d) => d.id === targetId)) {
      throw new SharingError('unknownDevice');
    }
    // Recorded first: from here on the removal is resumed on every sync until the server
    // has rotated, so a device marked removed is never left holding the current key.
    await this.write<PendingRotation>(NAMES.rotation, {
      from: state.epoch,
      target: targetId,
      key: toBase64(this.deps.crypto.newSpaceKey()),
    });
    // Tell every device first, under the key they already hold, so none of them trusts a
    // new key signed by the removed device before it learns of the removal (§7.4).
    await this.deps.store.markDeviceRemoved(targetId);
    await this.engine(device.client).sync();
    if (!(await this.resumeRemoval(api, device))) throw new SharingError('removalPending');
    await this.loadKeys(api);
    await this.engine(device.client).sync();
  }

  /**
   * Finishes a removal recorded on this device: one all-or-nothing `rotate` call from the
   * current epoch (§7.4). Returns true when no removal is left pending. If someone else
   * rotated first, a fresh key is made for the new epoch next time; if the server already
   * removed the device, there is nothing left to do.
   */
  private async resumeRemoval(api: SpaceApi, device: ConnectedDevice): Promise<boolean> {
    let pending = await this.read<PendingRotation>(NAMES.rotation);
    const state = await this.deps.store.state();
    if (!pending || !state) return true;
    if (pending.from !== state.epoch) {
      pending = { ...pending, from: state.epoch, key: toBase64(this.deps.crypto.newSpaceKey()) };
      await this.write(NAMES.rotation, pending);
    }
    const key = fromBase64(pending.key);
    const next = state.epoch + 1;
    const recipients = (await this.deps.store.devices())
      .filter((d) => !d.revokedAt && d.id !== pending!.target)
      .map((d) => ({ id: d.id, box: fromBase64(d.boxPublicKey) }));
    if (!recipients.some((r) => r.id === device.deviceId)) {
      recipients.push({ id: device.deviceId, box: device.keys.boxPublicKey });
    }
    const envelopes = recipients.map((r) => {
      const sealed = this.deps.crypto.sealSpaceKey(key, r.box);
      const signature = this.deps.crypto.sign(
        envelopeMessage(state.spaceId, next, r.id, sealed),
        device.keys,
      );
      return { deviceId: r.id, sealed, signature };
    });
    try {
      await api.rotate(pending.target, state.epoch, envelopes);
    } catch (error) {
      if (error instanceof SpaceApiError && error.code === 'notAllowed') {
        // The server no longer has that device in the space: removed already.
        await this.deps.secrets.remove(NAMES.rotation);
        return true;
      }
      return false; // offline, or someone rotated first: tried again on the next sync
    }
    await this.finishRotation(state.spaceId, next, key, pending.target);
    return true;
  }

  private async finishRotation(
    spaceId: string,
    epoch: number,
    key: Uint8Array,
    removed: string,
  ): Promise<void> {
    await this.keys.save(spaceId, epoch, key);
    await this.deps.store.setEpoch(epoch);
    await this.deps.store.markDeviceRemoved(removed);
    await this.deps.secrets.remove(NAMES.rotation);
  }

  /**
   * After a rotation elsewhere (or here, interrupted): take every newer epoch's key from
   * this device's envelope, trusted as in §7.3. Without a trusted key, nothing is written.
   */
  private async adoptNewEpochs(api: SpaceApi, membership: Membership | null): Promise<void> {
    const state = await this.deps.store.state();
    if (!state) return;
    const pending = await this.read<PendingRotation>(NAMES.rotation);
    if (!membership?.epoch || membership.epoch <= state.epoch) return;
    const adopted = new Map<number, Uint8Array>();
    for (let epoch = state.epoch + 1; epoch <= membership.epoch; epoch++) {
      const key = await this.ownKey(api, state.spaceId, epoch);
      if (!key) throw new SharingError('newKeyNotTrusted');
      await this.keys.save(state.spaceId, epoch, key);
      adopted.set(epoch, key);
    }
    await this.deps.store.setEpoch(membership.epoch);
    if (pending && pending.from === state.epoch) {
      // This device's own removal went through before it could finish locally, but only
      // if the next epoch's key is the one it created: another device may have rotated
      // first, and then the target was never removed.
      // Otherwise the removal stays pending and is retried from the new epoch.
      const next = adopted.get(pending.from + 1);
      if (next && toBase64(next) === pending.key) await this.deps.secrets.remove(NAMES.rotation);
    }
  }

  /**
   * Repair (§7.4): seal the current key to listed devices that have no envelope for this
   * epoch. Best effort: a failure here never stops the sync.
   */
  private async repairEnvelopes(api: SpaceApi, device: ConnectedDevice): Promise<void> {
    try {
      const state = await this.deps.store.state();
      const key = state ? this.keys.key(state.epoch) : null;
      if (!state || !key) return;
      const missing = new Set(await api.devicesMissingEnvelope());
      if (missing.size === 0) return;
      const envelopes = (await this.deps.store.devices())
        .filter((d) => !d.revokedAt && missing.has(d.id))
        .map((d) => {
          const sealed = this.deps.crypto.sealSpaceKey(key, fromBase64(d.boxPublicKey));
          const signature = this.deps.crypto.sign(
            envelopeMessage(state.spaceId, state.epoch, d.id, sealed),
            device.keys,
          );
          return { deviceId: d.id, sealed, signature };
        });
      if (envelopes.length > 0) await api.sealMissing(state.epoch, envelopes);
    } catch {
      // Retried on the next sync.
    }
  }

  /** After joining: this device's own envelopes for the epochs before the current one. */
  private async storeOlderEnvelopes(
    api: SpaceApi,
    device: ConnectedDevice,
    spaceId: string,
    current: number,
  ): Promise<void> {
    const older: { epoch: number; sealed: Uint8Array; signature: Uint8Array }[] = [];
    for (let epoch = 1; epoch < current; epoch++) {
      const key = this.keys.key(epoch);
      if (!key) continue;
      const sealed = this.deps.crypto.sealSpaceKey(key, device.keys.boxPublicKey);
      const signature = this.deps.crypto.sign(
        envelopeMessage(spaceId, epoch, device.deviceId, sealed),
        device.keys,
      );
      older.push({ epoch, sealed, signature });
    }
    await api.storeOwnEnvelopes(older);
  }

  /**
   * This device's own record in the end-to-end device list (§7.2), written by this device
   * only, from its own keys. A no-op when the record is already up to date.
   */
  private async writeOwnDevice(device: ConnectedDevice, personId: string | null): Promise<void> {
    const person =
      personId ?? (await this.deps.profiles.persons()).find((p) => p.isSelf)?.id ?? null;
    await this.deps.store.writeOwnDevice({
      id: device.deviceId,
      personId: person,
      signPublicKey: toBase64(device.keys.signPublicKey),
      boxPublicKey: toBase64(device.keys.boxPublicKey),
      platform: this.deps.session.platform,
    });
  }

  /**
   * Leaves the space for both people (§6.5): the server deletes it, then this device goes
   * back to solo. Offline, nothing changes and the error is thrown. If the app stops in
   * between, the next sync notices that the space is gone and finishes the job.
   */
  async leave(): Promise<void> {
    if (!(await this.deps.store.state())) throw new SharingError('notSharing');
    const device = await this.deps.session.connect();
    await new SpaceApi(device.client).dissolveSpace();
    await this.stopSharingHere();
  }

  /** Goes solo only on a definite answer from the server; anything else changes nothing. */
  private async checkStillMember(api: SpaceApi): Promise<Membership | null> {
    const state = await this.deps.store.state();
    if (!state) return null;
    const membership = await api.membership();
    if (!membership) return null;
    if (membership.revoked || membership.spaceId !== state.spaceId) {
      await this.stopSharingHere();
      throw new SharingEndedError(membership.revoked ? 'removed' : 'dissolved');
    }
    return membership;
  }

  /**
   * Back to solo on this device only: every record stays, sharing state goes. For a
   * device that lost its space key, and the local half of leaving.
   */
  async stopSharingHere(): Promise<void> {
    const state = await this.deps.store.state();
    await this.deps.store.leaveLocally();
    if (state) await this.keys.forget(state.spaceId, state.epoch);
    for (const name of Object.values(NAMES)) await this.deps.secrets.remove(name);
  }

  private async finishJoin(ownDevice = false): Promise<JoinProgress> {
    const device = await this.deps.session.connect();
    await this.loadKeys(new SpaceApi(device.client));
    await this.writeOwnDevice(device, null);
    await this.engine(device.client).sync();
    await this.deps.secrets.remove(NAMES.join);
    return ownDevice ? { state: 'joined', ownDevice: true } : { state: 'joined' };
  }

  /**
   * The space key this device sealed to itself and signed, as stored on the server. An
   * envelope without this device's valid signature is ignored: the server can write any
   * row, and must not be able to hand a device a key it knows.
   */
  private async ownKey(api: SpaceApi, spaceId: string, epoch: number): Promise<Uint8Array | null> {
    const device = await this.deps.session.connect();
    const listed = await this.deps.store.devices();
    for (const envelope of await api.ownEnvelopes()) {
      if (envelope.spaceId !== spaceId || envelope.epoch !== epoch) continue;
      if (envelope.deviceId !== device.deviceId || !envelope.signature) continue;
      // Signed by this device, or by a device on the end-to-end list (§7.3).
      const signer =
        envelope.signerDeviceId === null || envelope.signerDeviceId === device.deviceId
          ? device.keys.signPublicKey
          : (() => {
              // A removed device no longer vouches for keys (§7.3).
              const known = listed.find((d) => d.id === envelope.signerDeviceId && !d.revokedAt);
              return known ? fromBase64(known.signPublicKey) : null;
            })();
      if (!signer) continue;
      const message = envelopeMessage(spaceId, epoch, device.deviceId, envelope.sealed);
      if (!this.deps.crypto.verify(message, envelope.signature, signer)) continue;
      try {
        return this.deps.crypto.openSealedSpaceKey(envelope.sealed, device.keys);
      } catch {
        // Signed by this device but not openable with its keys: ignore.
      }
    }
    return null;
  }

  /** Loads the space keys; if this device lost them, reopens its own envelopes. */
  private async loadKeys(api: SpaceApi): Promise<void> {
    const state = await this.deps.store.state();
    if (!state) throw new SharingError('notSharing');
    try {
      await this.keys.load(state.spaceId, state.epoch);
      return;
    } catch (error) {
      if (!(error instanceof MissingSpaceKeyError)) throw error;
    }
    for (let epoch = 1; epoch <= state.epoch; epoch++) {
      const key = await this.ownKey(api, state.spaceId, epoch);
      if (key) await this.keys.save(state.spaceId, epoch, key);
    }
    await this.keys.load(state.spaceId, state.epoch);
  }

  private engine(client: ConstructorParameters<typeof SupabaseTransport>[0]): SyncEngine {
    return new SyncEngine(
      this.deps.store,
      new SupabaseTransport(client),
      this.deps.crypto,
      this.keys,
      this.deps.defaults,
    );
  }

  /** Sets this device owner's name (required before sharing) and returns their person ID. */
  private async ensureSelfName(name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > LIMITS.displayName) throw new SharingError('nameRequired');
    const profile = await this.deps.profiles.get();
    if (!profile) throw new SharingError('noProfile');
    if (profile.selfName !== trimmed) {
      const valid: ValidProfile = {
        displayName: profile.displayName,
        selfName: trimmed,
        relationshipLabel: profile.relationshipLabel,
        startDate: profile.startDate,
        startTime: profile.startTime,
        startTimeZoneId: profile.startTimeZoneId,
        calendarTimeZoneId: profile.calendarTimeZoneId,
      };
      await this.deps.profiles.save(valid);
    }
    const self = (await this.deps.profiles.persons()).find((p) => p.isSelf);
    if (!self) throw new SharingError('noProfile');
    return self.id;
  }

  private joinSafetyCode(pending: PendingJoin, keys: DevicePublicKeys): string {
    if (!pending.inviter) throw new SharingError('noInvite');
    return this.deps.crypto.safetyCode(
      fromBase64(pending.secret),
      pending.inviteId,
      {
        signPublicKey: fromBase64(pending.inviter.sign),
        boxPublicKey: fromBase64(pending.inviter.box),
      },
      publicKeys(keys),
    );
  }

  private async read<T>(name: string): Promise<T | null> {
    const stored = await this.deps.secrets.get(name);
    return stored ? (JSON.parse(stored) as T) : null;
  }

  private async write<T>(name: string, value: T): Promise<void> {
    await this.deps.secrets.set(name, JSON.stringify(value));
  }
}

function publicKeys(keys: DevicePublicKeys): DevicePublicKeys {
  return { signPublicKey: keys.signPublicKey, boxPublicKey: keys.boxPublicKey };
}

function sameStart(a: StartOfRelationship, b: StartOfRelationship): boolean {
  return a.startDate === b.startDate;
}
