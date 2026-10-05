// FILM-2004: the Studio reads allowDialogueCuts, maxSilenceSeconds and the
// brand's emphasisWords through the shared contract, with its defaults.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditPolicySchema } from '../../src/studio/contracts/edit-policy.schema.mjs'
import { BrandSchema } from '../../src/studio/contracts/brand.schema.mjs'
import { dialogueCutModeOf, maxSilenceSecondsOf, emphasisWordsOf } from '../../src/studio/policyFields.js'
import { maxSilenceFor, QA_DEFAULTS } from '../../src/studio/review/qaChecks.js'
import { dialogueCutMode } from '../../src/studio/intents/dialogueDrops.js'
import { emphasisWordsFrom } from '../../src/studio/captions/style.js'

test('the parsed policy exposes the dialogue-cut and silence defaults, and an old payload still parses', () => {
  const old = EditPolicySchema.safeParse({ targetDurationSeconds: 90 })
  assert.equal(old.success, true)
  assert.equal(old.data.allowDialogueCuts, 'ask')
  assert.equal(old.data.maxSilenceSeconds, 1.5)
  assert.equal(EditPolicySchema.safeParse({ allowDialogueCuts: 'sometimes' }).success, false)
  assert.equal(EditPolicySchema.safeParse({ maxSilenceSeconds: 11 }).success, false)
})

test('the parsed brand carries emphasisWords, empty for an old payload', () => {
  assert.deepEqual(BrandSchema.parse({}).captionStyle.emphasisWords, [])
  assert.deepEqual(BrandSchema.parse({ captionStyle: { emphasisWords: ['now'] } }).captionStyle.emphasisWords, ['now'])
})

test('the Studio defaults are the schema defaults, not local constants', () => {
  const policy = EditPolicySchema.parse({})
  assert.equal(dialogueCutModeOf({}), policy.allowDialogueCuts)
  assert.equal(dialogueCutMode({ policy: {} }), policy.allowDialogueCuts)
  assert.equal(maxSilenceSecondsOf({}), policy.maxSilenceSeconds)
  assert.equal(QA_DEFAULTS.maxSilenceSeconds, policy.maxSilenceSeconds)
  assert.equal(maxSilenceFor(policy), policy.maxSilenceSeconds)
  assert.equal(maxSilenceFor({ maxSilenceSeconds: 4 }), 4)
  assert.deepEqual(emphasisWordsOf({}), BrandSchema.parse({}).captionStyle.emphasisWords)
})

test('emphasis words come from the typed brand', () => {
  const brand = BrandSchema.parse({ captionStyle: { emphasisWords: ['Doors'] } })
  assert.deepEqual(emphasisWordsFrom({ brand }), ['Doors'])
})
