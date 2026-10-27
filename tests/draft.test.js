const test = require('node:test')
const assert = require('node:assert/strict')
const { restoreDraftMembers } = require('../domain/draft')

const members = [{ id: 'owner' }, { id: 'member' }]

test('new drafts select available members and current payer', () => {
  const result = restoreDraftMembers(members, 'owner')
  assert.deepEqual(result.participantMemberIds, ['owner', 'member'])
  assert.equal(result.payerIndex, 0)
  assert.deepEqual(result.units, { owner: 1, member: 1 })
})

test('restored drafts exclude unavailable members and their units', () => {
  const result = restoreDraftMembers(members, 'owner', { participantMemberIds: ['member', 'removed'], units: { member: 3, removed: 2 }, payerMemberId: 'removed' })
  assert.deepEqual(result.participantMemberIds, ['member'])
  assert.deepEqual(result.units, { owner: 1, member: 3 })
  assert.equal(result.payerIndex, 0)
  assert.ok(result.draftNotice)
})

test('empty participant selections remain empty for explicit confirmation', () => {
  assert.deepEqual(restoreDraftMembers(members, 'owner', { participantMemberIds: [] }).participantMemberIds, [])
  assert.deepEqual(restoreDraftMembers(members, 'owner', { participantMemberIds: ['removed'] }).participantMemberIds, [])
})

test('payer identity survives member reordering', () => {
  assert.equal(restoreDraftMembers([...members].reverse(), 'owner', { payerMemberId: 'member', payerIndex: 1 }).payerIndex, 0)
})

test('legacy payer indexes must reference an available member', () => {
  assert.equal(restoreDraftMembers(members, 'owner', { payerIndex: 1 }).payerIndex, 1)
  assert.equal(restoreDraftMembers(members, 'owner', { payerIndex: 4 }).payerIndex, 0)
})

test('draft unit values remain available for validation', () => {
  assert.equal(restoreDraftMembers(members, 'owner', { units: { member: 0 } }).units.member, 0)
})
