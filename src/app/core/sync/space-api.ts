import type { SupabaseClient } from '@supabase/supabase-js';

import { fromBytea, toBase64, toBytea } from './encoding';
import type { DevicePublicKeys } from './sync-crypto-port';

/**
 * Space membership on the server (supabase/migrations, docs/PARTNER_SYNC.md §6, §17).
 * Every call can be retried after a lost reply. Errors carry a code and never data.
 */
export type SpaceErrorCode =
  | 'inviteUnavailable'
  | 'notApprovedYet'
  | 'alreadyInSpace'
  | 'personExists'
  | 'notAllowed'
  | 'epochChanged'
  | 'network'
  | 'server';

export class SpaceApiError extends Error {
  constructor(
    readonly code: SpaceErrorCode,
    readonly operation: string,
  ) {
    super(`Sharing ${operation} failed (${code})`);
    this.name = 'SpaceApiError';
  }
}

export interface SpaceMembership {
  spaceId: string;
  personId: string;
  epoch: number;
}

export interface InviteClaim {
  joiner: DevicePublicKeys;
  approved: boolean;
}

export interface AcceptedInvite extends SpaceMembership {
  envelope: Uint8Array;
}

/** Where the server says this device belongs (`membership()`). */
export interface Membership {
  deviceId: string;
  revoked: boolean;
  spaceId: string | null;
  personId: string | null;
  epoch: number | null;
}

export interface SealedEnvelope {
  spaceId: string;
  epoch: number;
  deviceId: string | null;
  sealed: Uint8Array;
  /** The sealing device's signature over `envelopeMessage(…)`; null if unsigned. */
  signature: Uint8Array | null;
  /** The device that sealed and signed it; null means the recipient itself. */
  signerDeviceId: string | null;
}

/** A new envelope for another device: the space key sealed to it and signed by this one. */
export interface EnvelopeForDevice {
  deviceId: string;
  sealed: Uint8Array;
  signature: Uint8Array;
}

interface EnvelopeRow {
  space_id: string;
  epoch: number;
  device_id: string | null;
  sealed: string;
  signature: string | null;
  signer_device_id: string | null;
}

const envelopesJson = (envelopes: readonly EnvelopeForDevice[]) =>
  envelopes.map((e) => ({
    device_id: e.deviceId,
    sealed: toBase64(e.sealed),
    signature: toBase64(e.signature),
  }));

const MESSAGES: [RegExp, SpaceErrorCode][] = [
  [/invite unavailable|invite not ready/, 'inviteUnavailable'],
  [/not approved yet/, 'notApprovedYet'],
  [/already in a space|already approved/, 'alreadyInSpace'],
  [/person exists/, 'personExists'],
  [/epoch changed/, 'epochChanged'],
  [/not allowed|not a member|unknown device/, 'notAllowed'],
];

export class SpaceApi {
  constructor(private readonly client: SupabaseClient) {}

  async createSpace(
    space: string,
    sealedKey: Uint8Array,
    signature: Uint8Array,
    selfPerson: string,
  ): Promise<SpaceMembership> {
    const [row] = await this.call<{ space_id: string; person_id: string; epoch: number }[]>(
      'createSpace',
      'create_space',
      {
        space,
        sealed_key: toBytea(sealedKey),
        signature: toBytea(signature),
        self_person: selfPerson,
      },
    );
    return { spaceId: row.space_id, personId: row.person_id, epoch: row.epoch };
  }

  async createInvite(wrappedKey: Uint8Array): Promise<string> {
    return this.call<string>('createInvite', 'create_invite', { wrapped_key: toBytea(wrappedKey) });
  }

  async claimInvite(inviteId: string, person: string): Promise<DevicePublicKeys> {
    const [row] = await this.call<
      { inviter_sign_public_key: string; inviter_box_public_key: string }[]
    >('claimInvite', 'claim_invite', { invite: inviteId, person });
    if (!row) throw new SpaceApiError('inviteUnavailable', 'claimInvite');
    return {
      signPublicKey: fromBytea(row.inviter_sign_public_key),
      boxPublicKey: fromBytea(row.inviter_box_public_key),
    };
  }

  /** Null while nobody has claimed the invite. */
  async inviteClaim(inviteId: string): Promise<InviteClaim | null> {
    const rows = await this.call<
      { joiner_sign_public_key: string; joiner_box_public_key: string; approved: boolean }[]
    >('inviteClaim', 'invite_claim', { invite: inviteId });
    const row = rows[0];
    if (!row) return null;
    return {
      joiner: {
        signPublicKey: fromBytea(row.joiner_sign_public_key),
        boxPublicKey: fromBytea(row.joiner_box_public_key),
      },
      approved: row.approved,
    };
  }

  /** `asPerson`: admit the device as one of this existing person's devices (§7.6). */
  async approveInvite(inviteId: string, asPerson?: string): Promise<string> {
    return this.call<string>('approveInvite', 'approve_invite', {
      invite: inviteId,
      as_person: asPerson ?? null,
    });
  }

  async declineInvite(inviteId: string): Promise<void> {
    await this.call('declineInvite', 'decline_invite', { invite: inviteId });
  }

  async acceptInvite(inviteId: string): Promise<AcceptedInvite> {
    const [row] = await this.call<
      { envelope: string; space_id: string; person_id: string; epoch: number }[]
    >('acceptInvite', 'accept_invite', { invite: inviteId });
    if (!row) throw new SpaceApiError('inviteUnavailable', 'acceptInvite');
    return {
      envelope: fromBytea(row.envelope),
      spaceId: row.space_id,
      personId: row.person_id,
      epoch: row.epoch,
    };
  }

  async finishJoin(inviteId: string, sealedKey: Uint8Array, signature: Uint8Array): Promise<void> {
    await this.call('finishJoin', 'finish_join', {
      invite: inviteId,
      sealed_key: toBytea(sealedKey),
      signature: toBytea(signature),
    });
  }

  /** Null when the calling user has no device row at all (nothing can be concluded). */
  async membership(): Promise<Membership | null> {
    const rows = await this.call<
      {
        device_id: string;
        revoked: boolean;
        space_id: string | null;
        person_id: string | null;
        epoch: number | null;
      }[]
    >('membership', 'membership', {});
    const row = rows?.[0];
    if (!row) return null;
    return {
      deviceId: row.device_id,
      revoked: row.revoked,
      spaceId: row.space_id,
      personId: row.person_id,
      epoch: row.epoch,
    };
  }

  /** Ends the space for everyone: the server deletes it with all its records (§6.5). */
  async dissolveSpace(): Promise<void> {
    await this.call('dissolveSpace', 'dissolve_space', {});
  }

  /** The space keys sealed to this device (row-level security returns only its own). */
  async ownEnvelopes(): Promise<SealedEnvelope[]> {
    const { data, error } = await this.client
      .from('key_envelopes')
      .select('space_id,epoch,device_id,sealed,signature,signer_device_id');
    if (error) throw new SpaceApiError(error.code ? 'server' : 'network', 'ownEnvelopes');
    return ((data ?? []) as EnvelopeRow[]).map((row) => ({
      spaceId: row.space_id,
      epoch: row.epoch,
      deviceId: row.device_id,
      sealed: fromBytea(row.sealed),
      signature: row.signature ? fromBytea(row.signature) : null,
      signerDeviceId: row.signer_device_id,
    }));
  }

  /**
   * Removes `target` and starts the next epoch with these envelopes, all or nothing (§7.4).
   * Fails with 'epochChanged' when the space is no longer at `expectedEpoch`.
   */
  async rotate(
    target: string,
    expectedEpoch: number,
    envelopes: readonly EnvelopeForDevice[],
  ): Promise<number> {
    return this.call<number>('rotate', 'rotate', {
      target,
      expected_epoch: expectedEpoch,
      envelopes: envelopesJson(envelopes),
    });
  }

  /** Devices of the space (not removed) with no envelope for the current epoch. */
  async devicesMissingEnvelope(): Promise<string[]> {
    const rows = await this.call<{ device_id: string }[]>(
      'devicesMissingEnvelope',
      'devices_missing_envelope',
      {},
    );
    return (rows ?? []).map((r) => r.device_id);
  }

  /** Repair: envelopes of the current epoch for devices that have none yet. */
  async sealMissing(epoch: number, envelopes: readonly EnvelopeForDevice[]): Promise<void> {
    await this.call('sealMissing', 'seal_missing', {
      target_epoch: epoch,
      envelopes: envelopesJson(envelopes),
    });
  }

  /** Files this device's own envelopes (older epochs after joining); existing ones stay. */
  async storeOwnEnvelopes(
    envelopes: readonly { epoch: number; sealed: Uint8Array; signature: Uint8Array }[],
  ): Promise<void> {
    if (envelopes.length === 0) return;
    await this.call('storeOwnEnvelopes', 'store_own_envelopes', {
      envelopes: envelopes.map((e) => ({
        epoch: e.epoch,
        sealed: toBase64(e.sealed),
        signature: toBase64(e.signature),
      })),
    });
  }

  private async call<T>(operation: string, fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) {
      const known = MESSAGES.find(([pattern]) => pattern.test(error.message ?? ''));
      throw new SpaceApiError(known?.[1] ?? (error.code ? 'server' : 'network'), operation);
    }
    return data as T;
  }
}
