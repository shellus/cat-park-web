import { z } from 'zod';
const id = z.string().min(1).max(128);
const report = z.strictObject({
  status: z.enum(['unchecked', 'checking', 'denied', 'missing', 'silent', 'connecting', 'disconnected', 'muted', 'ok', 'error']),
  message: z.string().max(160).optional(), hasSignal: z.boolean(), voiceConnected: z.boolean(), published: z.boolean(),
});
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), input: z.strictObject({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1), jump: z.boolean(), sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER) }) }),
  z.strictObject({ type: z.literal('chat'), text: z.string().trim().min(1).max(200) }),
  z.strictObject({ type: z.literal('party.create') }),
  z.strictObject({ type: z.literal('party.invite'), userId: id }),
  z.strictObject({ type: z.literal('party.accept'), invitationId: id.optional(), inviteCode: id.optional() }).refine(value => Boolean(value.invitationId) !== Boolean(value.inviteCode)),
  z.strictObject({ type: z.literal('party.decline'), invitationId: id }),
  z.strictObject({ type: z.literal('party.leave') }),
  z.strictObject({ type: z.literal('party.disband') }),
  z.strictObject({ type: z.literal('party.ready'), ready: z.boolean(), withoutMic: z.boolean().optional() }),
  z.strictObject({ type: z.literal('party.start') }),
  z.strictObject({ type: z.literal('party.return') }),
  z.strictObject({ type: z.literal('party.restart') }),
  z.strictObject({ type: z.literal('mic'), report }),
  z.strictObject({ type: z.literal('voice.join') }),
]);
export const profileSchema = z.strictObject({ nickname: z.string().max(48).optional(), characterId: id.optional(), color: z.string().max(16).optional() }).refine(value => Object.keys(value).length > 0);
export const loginSchema = z.strictObject({ userId: id, password: z.string().max(72) });
export const usernameSchema = z.strictObject({ username: z.string().max(40) });
export const passwordSchema = z.strictObject({ currentPassword: z.string().max(72), newPassword: z.string().max(72) });
