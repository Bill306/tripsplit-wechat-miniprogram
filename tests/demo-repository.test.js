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

test('multi-currency demo stores original amounts, settles base units and locks base currency', async () => {
  storage = {}
  const created = await repository.createTrip({ name: '日本旅行', baseCurrency: 'JPY', companions: ['同行'] })
  const trip = await repository.getTrip(created.id)
  const input = { tripId: trip.id, payerMemberId: trip.currentMemberId, participantMemberIds: trip.members.map((m) => m.id), splitMode: 'equal', category: 'food', spentAt: '2026-10-02T12:00:00Z', originalCurrency: 'USD', originalAmountMinor: 100, fx: { mode: 'manual', rate: '150.5' }, clientRequestId: 'fx-demo-first' }
  const expense = await repository.createExpense(input)
  assert.equal(expense.amountFen, 151)
  assert.equal(Object.values(expense.shares).reduce((sum, value) => sum + value, 0), 151)
  assert.equal((await repository.getTrip(trip.id)).baseCurrency, 'JPY')
  const updated = await repository.updateExpense({ ...input, expenseId: expense.id, expectedRevision: 1, fx: { mode: 'actual', actualAmountMinor: 149 } })
  assert.equal(updated.amountFen, 149)
  assert.equal((await repository.startSettlement(trip.id)).baseCurrency, 'JPY')
  await assert.rejects(() => repository.updateTrip({ tripId: trip.id, name: '日本旅行', baseCurrency: 'USD' }), /不可修改/)
})

test('saves the confirmed WeChat profile and reuses it for new trips', async () => {
  storage = {}
  const initial = await repository.bootstrap()
  assert.equal(initial.profileComplete, false)
  const profile = await repository.updateProfile({ displayName: 'Bill', avatarUrl: 'wxfile://profile.jpg' })
  assert.equal(profile.profileComplete, true)
  const trip = await repository.createTrip({ name: '猫咪旅行', companions: [] })
  const dashboard = await repository.getTrip(trip.id)
  const current = dashboard.members.find((member) => member.id === dashboard.currentMemberId)
  assert.equal(current.displayName, 'Bill')
  assert.equal(current.avatarUrl, 'wxfile://profile.jpg')
})

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

test('lets the current member update their avatar and exposes it in summaries', async () => {
  const trip = await seedTrip()
  await repository.updateMyAvatar(trip.id, 'wxfile://avatar.jpg')
  const dashboard = await repository.getTrip(trip.id)
  assert.equal(dashboard.members.find((member) => member.id === trip.currentMemberId).avatarUrl, 'wxfile://avatar.jpg')
  assert.equal(dashboard.summary.find((member) => member.memberId === trip.currentMemberId).avatarUrl, 'wxfile://avatar.jpg')
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
  for (let index = 0; index < settlement.transfers.length; index += 1) {
    const transfer = settlement.transfers[index]
    settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
    if (index === 0) {
      settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'pending' })
      settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
    }
    settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'received' })
  }
  assert.equal(settlement.status, 'completed')
  assert.equal((await repository.getTrip(trip.id)).status, 'settled')
})

test('adjustments settle only the new balance and cannot unlock completed expenses', async () => {
  const trip = await seedTrip()
  const input = {
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {},
    category: 'food', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'completed-original',
  }
  const original = await repository.createExpense(input)
  for (let round = 0; round < 2; round += 1) {
    let settlement = await repository.startSettlement(trip.id)
    assert.equal(settlement.transfers.reduce((sum, item) => sum + item.amountFen, 0), round === 0 ? 200 : 20)
    for (const transfer of settlement.transfers) {
      await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
      await repository.updateTransferStatus({ settlementId: settlement.id, transferId: transfer.id, status: 'received' })
    }
    assert.ok((await repository.getTrip(trip.id)).summary.every((item) => item.netAmount === 0))
    await repository.createExpense({ ...input, amountFen: 30, clientRequestId: `adjustment-round-${round}` })
    await assert.rejects(() => repository.updateExpense({ ...input, expenseId: original.id, expectedRevision: 1 }), /已结算账单/)
    await assert.rejects(() => repository.deleteExpense({ expenseId: original.id, expectedRevision: 1 }), /已结算账单/)
    assert.equal((await repository.getExpense(original.id)).canEdit, false)
  }
  assert.equal((await repository.previewSettlement(trip.id)).transfers.reduce((sum, item) => sum + item.amountFen, 0), 20)
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

test('editing a historical expense can preserve a deactivated participant', async () => {
  const trip = await seedTrip()
  const offline = trip.members.find((member) => member.userId === null)
  const expense = await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '旧账', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'inactive-edit-request',
  })
  await repository.deactivateMember(offline.id)
  const updated = await repository.updateExpense({
    expenseId: expense.id, expectedRevision: 1, payerMemberId: trip.currentMemberId, amountFen: 360,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '旧账修正', spentAt: '2026-09-21T12:00:00.000Z',
  })
  assert.equal(updated.shares[offline.id], 120)
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

test('shows expense audit history after create and edit', async () => {
  const trip = await seedTrip()
  const expense = await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '午饭', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'audit-request',
  })
  await repository.updateExpense({
    expenseId: expense.id, expectedRevision: 1, payerMemberId: trip.currentMemberId, amountFen: 360,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '午饭加饮料', spentAt: '2026-09-21T12:00:00.000Z',
  })
  const detail = await repository.getExpense(expense.id)
  assert.equal(detail.auditEvents.length, 2)
  assert.deepEqual(new Set(detail.auditEvents.map((event) => event.action)), new Set(['created', 'updated']))
  assert.equal(detail.canEdit, true)
})

test('invalidates an unpaid settlement when the ledger changes', async () => {
  const trip = await seedTrip()
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '住宿', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'invalidate-request',
  })
  const settlement = await repository.startSettlement(trip.id)
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 90,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '加餐', spentAt: '2026-09-22T12:00:00.000Z', clientRequestId: 'adjust-request',
  })
  const current = await repository.getSettlement(trip.id)
  assert.equal(current.status, 'preview')
  assert.ok(current.ledgerRevision > settlement.ledgerRevision)
})

test('locks ledger changes after a settlement transfer is marked paid', async () => {
  const trip = await seedTrip()
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '住宿', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'paid-lock-request',
  })
  let settlement = await repository.startSettlement(trip.id)
  settlement = await repository.updateTransferStatus({ settlementId: settlement.id, transferId: settlement.transfers[0].id, status: 'paid' })
  await assert.rejects(() => repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 90,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'food', note: '加餐', spentAt: '2026-09-22T12:00:00.000Z', clientRequestId: 'locked-request',
  }), /已有转账/)
})

test('removes a member only before they are linked to expenses', async () => {
  const trip = await seedTrip()
  const removable = await repository.createOfflineMember(trip.id, { displayName: '临时同行者' })
  await repository.removeMember(removable.id)
  assert.ok(!(await repository.getTrip(trip.id)).members.some((member) => member.id === removable.id))
  const linked = trip.members.find((member) => member.userId === null)
  await repository.createExpense({
    tripId: trip.id, payerMemberId: trip.currentMemberId, amountFen: 300,
    participantMemberIds: trip.members.map((member) => member.id), splitMode: 'equal', units: {}, category: 'stay', note: '住宿', spentAt: '2026-09-21T12:00:00.000Z', clientRequestId: 'linked-member-request',
  })
  await assert.rejects(() => repository.removeMember(linked.id), /已有账单/)
})
