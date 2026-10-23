import type { ValidProfile } from '../domain/validation';
import { LIMITS } from '../domain/validation';
import { newId as newUuid } from '../persistence/ids';
import type { RelationshipRepository } from '../persistence/relationship.repository';
import type { SecureKeyStore } from '../platform/secure-key-store';
import type { ConnectedDevice, DeviceSession } from './device-session';
import { fromBase64, toBase64 } from './encoding';
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
  | 'joinInProgress';

/**
 * The server says this device no longer belongs to the space: the partner left (the space
 * was dissolved) or this device was removed. This device has already gone back to solo
 * and kept every record.
 */
export class SharingEndedError extends Error {
  readonly code = 'sharingEnded';
  constructor() {
    super('Sharing has ended.');
    this.name = 'SharingEndedError';
  }
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
  | { state: 'joined' }
  | { state: 'gone' };

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
} as const;

interface PendingInvite {
  inviteId: string;
  secret: string;
  /** When it was created here (ms); the server expires invites after 24 hours. */
  createdAt?: number;
}

const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface PendingJoin {
  inviteId: string;
  secret: string;
  inviter?: { sign: string; box: string };
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

  /** A new single-use invite (24 hours). Replaces an earlier unanswered one. */
  async createInvite(): Promise<string> {
    const state = await this.deps.store.state();
    if (!state) throw new SharingError('notSharing');
    const device = await this.deps.session.connect();
    const api = new SpaceApi(device.client);
    const previous = await this.read<PendingInvite>(NAMES.invite);
    if (previous) await api.declineInvite(previous.inviteId).catch(() => undefined);

    await this.loadKeys(api);
    const key = this.keys.key(state.epoch);
    if (!key) throw new MissingSpaceKeyError();
    const secret = this.deps.crypto.newInviteSecret();
    const inviteId = await api.createInvite(this.deps.crypto.wrapForInvite(key, secret));
    await this.write<PendingInvite>(NAMES.invite, {
      inviteId,
      secret: toBase64(secret),
      createdAt: this.deps.store.nowMs(),
    });
    return formatInviteCode({ inviteId, secret });
  }

  /** The code of the invite still waiting for an answer, to show it again. */
  async currentInviteCode(): Promise<string | null> {
    const pending = await this.pendingInvite();
    return pending
      ? formatInviteCode({ inviteId: pending.inviteId, secret: fromBase64(pending.secret) })
      : null;
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
    await new SpaceApi(device.client).approveInvite(pending.inviteId);
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
    const pending: PendingJoin = { inviteId: code.inviteId, secret: toBase64(code.secret) };
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
      const key = this.deps.crypto.unwrapInvite(accepted.envelope, fromBase64(pending.secret));
      await this.keys.save(accepted.spaceId, accepted.epoch, key);
      pending.space = { spaceId: accepted.spaceId, epoch: accepted.epoch };
      await this.write(NAMES.join, pending);
    }

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
    await this.loadKeys(api);
    await this.writeOwnDevice(device, membership?.personId ?? null);
    return this.engine(device.client).sync();
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
      throw new SharingEndedError();
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

  private async finishJoin(): Promise<JoinProgress> {
    const device = await this.deps.session.connect();
    await this.loadKeys(new SpaceApi(device.client));
    await this.writeOwnDevice(device, null);
    await this.engine(device.client).sync();
    await this.deps.secrets.remove(NAMES.join);
    return { state: 'joined' };
  }

  /**
   * The space key this device sealed to itself and signed, as stored on the server. An
   * envelope without this device's valid signature is ignored: the server can write any
   * row, and must not be able to hand a device a key it knows.
   */
  private async ownKey(api: SpaceApi, spaceId: string, epoch: number): Promise<Uint8Array | null> {
    const device = await this.deps.session.connect();
    for (const envelope of await api.ownEnvelopes()) {
      if (envelope.spaceId !== spaceId || envelope.epoch !== epoch) continue;
      if (envelope.deviceId !== device.deviceId || !envelope.signature) continue;
      const message = envelopeMessage(spaceId, epoch, device.deviceId, envelope.sealed);
      if (!this.deps.crypto.verify(message, envelope.signature, device.keys.signPublicKey))
        continue;
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
