// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/edit-events.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
/**
 * The edit events a StorybookStudio session records (FILM-2002). The type
 * list is the `edit_events.type` CHECK; each type's `data` is validated by
 * its own schema, strictly, so a field the contract does not name is refused
 * rather than silently stored. FILM-2011's `events.js` sends these in
 * batches of at most {@link MAX_EDIT_EVENTS_PER_CALL}.
 */
export const EDIT_EVENT_TYPES = [
    'plan_proposed',
    'plan_approved',
    'plan_rejected',
    'version_created',
    'qa_run',
    'delivered',
];
export const EditEventTypeSchema = z.enum(EDIT_EVENT_TYPES);
export const MAX_EDIT_EVENTS_PER_CALL = 500;
const id = z.string().min(1).max(100);
const seconds = z.number().finite().nonnegative().max(86_400);
const count = z.number().int().nonnegative().max(1_000_000);
/** An action plan shown to the user (an intent compiled to steps). */
export const PlanProposedDataSchema = z
    .object({
    planId: id,
    by: z.enum(['ai', 'user']),
    intent: z.string().min(1).max(100).optional(),
    steps: count,
    scope: z.string().max(200).optional(),
})
    .strict();
export const PlanApprovedDataSchema = z
    .object({
    planId: id,
    versionId: id.optional(),
})
    .strict();
export const PlanRejectedDataSchema = z
    .object({
    planId: id,
    reason: z.string().max(500).optional(),
})
    .strict();
/**
 * A version boundary in the Studio's op log. `aiOps` and `userOps` count the
 * operations since the previous version, so the session's totals are sums.
 */
export const VersionCreatedDataSchema = z
    .object({
    versionId: id,
    name: z.string().max(200).optional(),
    durationSeconds: seconds,
    aiOps: count,
    userOps: count,
})
    .strict();
export const QaRunDataSchema = z
    .object({
    versionId: id.optional(),
    pass: z.boolean(),
    issues: count,
    tier: z.string().max(50).optional(),
})
    .strict();
export const DeliveredDataSchema = z
    .object({
    renderIds: z.array(z.string().uuid()).max(50),
    durationSeconds: seconds.optional(),
})
    .strict();
const eventBase = {
    /** The Studio's id for the event; a retried batch with the same ids inserts nothing twice. */
    clientEventId: z.string().min(1).max(128),
    /** When it happened in the Studio (ISO 8601 with offset). */
    ts: z.string().datetime({ offset: true }),
};
export const EditEventSchema = z.discriminatedUnion('type', [
    z.object({
        ...eventBase,
        type: z.literal('plan_proposed'),
        data: PlanProposedDataSchema,
    }),
    z.object({
        ...eventBase,
        type: z.literal('plan_approved'),
        data: PlanApprovedDataSchema,
    }),
    z.object({
        ...eventBase,
        type: z.literal('plan_rejected'),
        data: PlanRejectedDataSchema,
    }),
    z.object({
        ...eventBase,
        type: z.literal('version_created'),
        data: VersionCreatedDataSchema,
    }),
    z.object({ ...eventBase, type: z.literal('qa_run'), data: QaRunDataSchema }),
    z.object({
        ...eventBase,
        type: z.literal('delivered'),
        data: DeliveredDataSchema,
    }),
]);
export const EditEventBatchSchema = z
    .array(EditEventSchema)
    .min(1, 'Send at least one event')
    .max(MAX_EDIT_EVENTS_PER_CALL, `At most ${MAX_EDIT_EVENTS_PER_CALL} events per call`);
