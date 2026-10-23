import type { SupabaseClient } from '@supabase/supabase-js';

import { fromBytea, toBytea } from './encoding';
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

export interface SealedEnvelope {
  spaceId: string;
  epoch: number;
  deviceId: string | null;
  sealed: Uint8Array;
  /** The sealing device's signature over `envelopeMessage(…)`; null if unsigned. */
  signature: Uint8Array | null;
}

interface EnvelopeRow {
  space_id: string;
  epoch: number;
  device_id: string | null;
  sealed: string;
  signature: string | null;
}

const MESSAGES: [RegExp, SpaceErrorCode][] = [
  [/invite unavailable|invite not ready/, 'inviteUnavailable'],
  [/not approved yet/, 'notApprovedYet'],
  [/already in a space|already approved/, 'alreadyInSpace'],
  [/person exists/, 'personExists'],
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

  async approveInvite(inviteId: string): Promise<string> {
    return this.call<string>('approveInvite', 'approve_invite', { invite: inviteId });
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

  /** The space keys sealed to this device (row-level security returns only its own). */
  async ownEnvelopes(): Promise<SealedEnvelope[]> {
    const { data, error } = await this.client
      .from('key_envelopes')
      .select('space_id,epoch,device_id,sealed,signature');
    if (error) throw new SpaceApiError(error.code ? 'server' : 'network', 'ownEnvelopes');
    return ((data ?? []) as EnvelopeRow[]).map((row) => ({
      spaceId: row.space_id,
      epoch: row.epoch,
      deviceId: row.device_id,
      sealed: fromBytea(row.sealed),
      signature: row.signature ? fromBytea(row.signature) : null,
    }));
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
