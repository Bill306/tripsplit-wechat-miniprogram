'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

let storage = {}
global.wx = {
  getStorageSync(key) { return storage[key] },
  setStorageSync(key, value) { storage[key] = JSON.parse(JSON.stringify(value)) },
  removeStorageSync(key) { delete storage[key] },
}

const repository = require('../services/demoRepository')

async function seedTrip() {
  storage = {}
  await repository.bootstrap()
  const trip = await repository.createTrip({ name: '云南七日', ownerName: 'Bill', companions: ['小明', '小红'] })
  return repository.getTrip(trip.id)
}

test('creates an idempotent expense and updates the dashboard', async () => {
  const trip = await seedTrip()
  const input = {
    tripId: trip.id,
    payerMemberId: trip.currentMemberId,
    amountFen: 100,
    participantMemberIds: trip.members.map((member) => member.id),
    splitMode: 'equal', units: {}, category: 'food', note: '米线', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'same-request',
  }
  const first = await repository.createExpense(input)
  const duplicate = await repository.createExpense(input)
  assert.equal(first.id, duplicate.id)
  const dashboard = await repository.getTrip(trip.id)
  assert.equal(dashboard.expenses.length, 1)
  assert.equal(dashboard.totalAmountFen, 100)
  assert.equal(dashboard.summary.reduce((sum, item) => sum + item.netAmount, 0), 0)
})

test('edits an expense with optimistic revision and rejects stale writes', async () => {
  const trip = await seedTrip()
  const expense = await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '晚饭', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'edit-request',
  })
  const updated = await repository.updateExpense({
    expenseId: expense.id, expectedRevision: 1, payerMemberId: trip.currentMemberId, amountFen: 600,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '晚饭+甜品', spentAt: '2026-09-21T12:00:00.000Z',
  })
  assert.equal(updated.revision, 2)
  assert.equal(updated.amountFen, 600)
  await assert.rejects(() => repository.updateExpense({
    expenseId: expense.id, expectedRevision: 1, payerMemberId: trip.currentMemberId, amountFen: 700,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '', spentAt: '2026-09-21T12:00:00.000Z',
  }), /\u5df2被修改/)
})

test('soft deletes an expense and excludes it from totals', async () => {
  const trip = await seedTrip()
  const expense = await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 450,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'transport', note: '打车', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'delete-request',
  })
  await repository.deleteExpense({ expenseId: expense.id, expectedRevision: 1 })
  const dashboard = await repository.getTrip(trip.id)
  assert.equal(dashboard.expenses.length, 0)
  assert.equal(dashboard.totalAmountFen, 0)
})

test('settlement advances pending to paid to received and completes the trip', async () => {
  const trip = await seedTrip()
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '住宿', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'settle-request',
  })
  let settlement = await repository.startSettlement(trip.id)
  for (const transfer of settlement.transfers) {
    settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
    settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'received' })
  }
  assert.equal(settlement.status, 'completed')
  assert.equal((await repository.getTrip(trip.id)).status, 'settled')
})

test('deactivated member remains in historical ledger but is excluded from new expenses', async () => {
  const trip = await seedTrip()
  const offline = trip.members.find((member) => member.userId === null)
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '旧账', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'historical-member',
  })
  await repository.deactivateMember(offline.id)
  const dashboard = await repository.getTrip(trip.id)
  assert.equal(dashboard.members.find((member) => member.id === offline.id).status, 'inactive')
  assert.ok(dashboard.summary.some((item) => item.memberId === offline.id && item.owedAmount === 100))
  const activeMemberIds = dashboard.members.filter((member) => member.status === 'active').map((member) => member.id)
  assert.ok(!activeMemberIds.includes(offline.id))
})

test('updates, archives, and restores a trip without changing its ledger', async () => {
  const trip = await seedTrip()
  await repository.updateTrip({ tripId: trip.id, name: '云南八日', destination: '大理与丽江', startDate: '2026-10-01', endDate: '2026-10-08' })
  let updated = await repository.getTrip(trip.id)
  assert.equal(updated.name, '云南八日')
  assert.equal(updated.ledgerRevision, 0)
  await repository.archiveTrip(trip.id)
  updated = await repository.getTrip(trip.id)
  assert.equal(updated.status, 'archived')
  await assert.rejects(() => repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 100,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'other', note: '', spentAt: '2026-10-01T12:00:00.000Z', clientRequestId: 'archived-write',
  }), /不允许改账/)
  await repository.restoreTrip(trip.id)
  assert.equal((await repository.getTrip(trip.id)).status, 'active')
})
