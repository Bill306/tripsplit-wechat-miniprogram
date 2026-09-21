'use strict'

const { summarizeLedger } = require('../domain/ledger')
const { splitEqual, splitByUnits } = require('../domain/split')
const { buildSettlementTransfers } = require('../domain/settlement')

const STORAGE_KEY = 'tripsplit.demo.v1'
const CURRENT_USER_ID = 'demo-user'
const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const load = () => wx.getStorageSync(STORAGE_KEY) || { trips: [], members: [], expenses: [], settlements: [] }
const save = (state) => wx.setStorageSync(STORAGE_KEY, state)
const clone = (value) => JSON.parse(JSON.stringify(value))
const tripMembers = (state, tripId) => state.members.filter((member) => member.tripId === tripId && member.status === 'active')
const tripExpenses = (state, tripId) => state.expenses.filter((expense) => expense.tripId === tripId && !expense.deletedAt)
const getCurrentMember = (state, tripId) => state.members.find((member) => member.tripId === tripId && member.userId === CURRENT_USER_ID)

function buildDashboard(state, trip) {
  const members = tripMembers(state, trip.id)
  const expenses = tripExpenses(state, trip.id)
  const summary = summarizeLedger(members, expenses)
  const currentMember = getCurrentMember(state, trip.id)
  const mine = summary.find((item) => currentMember && item.memberId === currentMember.id)
  return {
    ...clone(trip),
    members: clone(members),
    expenses: clone(expenses).sort((a, b) => b.spentAt.localeCompare(a.spentAt)),
    summary,
    totalAmountFen: expenses.reduce((sum, expense) => sum + expense.amountFen, 0),
    currentMemberId: currentMember && currentMember.id,
    myPaidAmountFen: mine ? mine.paidAmount : 0,
    myNetAmountFen: mine ? mine.netAmount : 0,
  }
}

async function bootstrap() {
  save(load())
  return { mode: 'demo', userId: CURRENT_USER_ID }
}

async function listTrips() {
  const state = load()
  return state.trips.map((trip) => buildDashboard(state, trip))
}

async function getTrip(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  return buildDashboard(state, trip)
}

async function createTrip(input) {
  const state = load()
  const createdAt = now()
  const tripId = id('trip')
  const trip = { id: tripId, name: input.name.trim(), destination: (input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', ownerUserId: CURRENT_USER_ID, status: 'active', ledgerRevision: 0, createdAt, updatedAt: createdAt }
  state.trips.push(trip)
  state.members.push({ id: id('member'), tripId, userId: CURRENT_USER_ID, displayName: (input.ownerName || 'Bill').trim(), role: 'owner', status: 'active', createdAt })
  ;(input.companions || []).filter(Boolean).forEach((displayName, index) => {
    state.members.push({ id: id('member'), tripId, userId: null, displayName, role: 'member', status: 'active', createdAt: new Date(Date.now() + index + 1).toISOString() })
  })
  save(state)
  return clone(trip)
}

async function createExpense(input) {
  const state = load()
  const duplicate = state.expenses.find((expense) => expense.tripId === input.tripId && expense.createdByUserId === CURRENT_USER_ID && expense.clientRequestId === input.clientRequestId)
  if (duplicate) return clone(duplicate)
  const trip = state.trips.find((item) => item.id === input.tripId)
  if (!trip) throw new Error('行程不存在')
  const members = tripMembers(state, input.tripId)
  const selected = members.filter((member) => input.participantMemberIds.includes(member.id))
  if (selected.length !== input.participantMemberIds.length) throw new Error('参与人不合法')
  const shares = input.splitMode === 'units'
    ? splitByUnits(input.amountFen, selected.map((member) => ({ ...member, units: input.units[member.id] })))
    : splitEqual(input.amountFen, selected)
  const createdAt = now()
  const expense = { id: id('expense'), tripId: input.tripId, payerMemberId: input.payerMemberId, amountFen: input.amountFen, category: input.category, note: input.note || '', spentAt: input.spentAt || createdAt, splitMode: input.splitMode, shares, shareUnits: input.splitMode === 'units' ? { ...input.units } : {}, revision: 1, clientRequestId: input.clientRequestId, createdByUserId: CURRENT_USER_ID, createdAt, updatedAt: createdAt }
  state.expenses.push(expense)
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.updatedAt = createdAt
  save(state)
  return clone(expense)
}

async function getExpense(expenseId) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  const members = tripMembers(state, expense.tripId)
  return { ...clone(expense), members: clone(members) }
}

async function updateExpense(input) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === input.expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  if (expense.revision !== input.expectedRevision) {
    const error = new Error('账单已被修改，请刷新后重试')
    error.code = 'REVISION_CONFLICT'
    throw error
  }
  const trip = state.trips.find((item) => item.id === expense.tripId)
  if (!['active', 'needs_settlement'].includes(trip.status)) throw new Error('当前结算状态不允许改账')
  const members = tripMembers(state, expense.tripId)
  const selected = members.filter((member) => input.participantMemberIds.includes(member.id))
  const shares = input.splitMode === 'units'
    ? splitByUnits(input.amountFen, selected.map((member) => ({ ...member, units: input.units[member.id] })))
    : splitEqual(input.amountFen, selected)
  Object.assign(expense, { payerMemberId: input.payerMemberId, amountFen: input.amountFen, category: input.category, note: input.note || '', spentAt: input.spentAt, splitMode: input.splitMode, shares, shareUnits: input.splitMode === 'units' ? { ...input.units } : {}, revision: expense.revision + 1, updatedAt: now() })
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.activeSettlementId = null
  trip.updatedAt = now()
  save(state)
  return clone(expense)
}

async function deleteExpense(input) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === input.expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  if (expense.revision !== input.expectedRevision) throw new Error('账单已被修改，请刷新后重试')
  const trip = state.trips.find((item) => item.id === expense.tripId)
  if (!['active', 'needs_settlement'].includes(trip.status)) throw new Error('当前结算状态不允许删除账单')
  expense.deletedAt = now()
  expense.revision += 1
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.activeSettlementId = null
  trip.updatedAt = now()
  save(state)
  return { deleted: true }
}

async function previewSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  const members = tripMembers(state, tripId)
  const summary = summarizeLedger(members, tripExpenses(state, tripId))
  const names = Object.fromEntries(members.map((member) => [member.id, member.displayName]))
  return { status: 'preview', ledgerRevision: trip.ledgerRevision, summary, transfers: buildSettlementTransfers(summary).map((transfer, index) => ({ ...transfer, id: `preview_${index}`, fromName: names[transfer.fromMemberId], toName: names[transfer.toMemberId] })) }
}

async function startSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  const existing = state.settlements.find((item) => item.tripId === tripId && item.ledgerRevision === trip.ledgerRevision && item.status === 'active')
  if (existing) return clone(existing)
  const preview = await previewSettlement(tripId)
  const settlement = { ...preview, id: id('settlement'), tripId, status: preview.transfers.length ? 'active' : 'completed', transfers: preview.transfers.map((transfer) => ({ ...transfer, id: id('transfer') })), createdAt: now() }
  state.settlements.push(settlement)
  trip.activeSettlementId = settlement.status === 'active' ? settlement.id : null
  trip.latestSettlementId = settlement.id
  trip.status = settlement.status === 'completed' ? 'settled' : 'settling'
  save(state)
  return clone(settlement)
}

async function getSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip || !trip.latestSettlementId) return previewSettlement(tripId)
  return clone(state.settlements.find((item) => item.id === trip.latestSettlementId))
}

async function updateTransferStatus(input) {
  const state = load()
  const settlement = state.settlements.find((item) => item.id === input.settlementId)
  if (!settlement || settlement.status !== 'active') throw new Error('结算方案已不可操作')
  const transfer = settlement.transfers.find((item) => item.id === input.transferId)
  if (!transfer) throw new Error('转账项不存在')
  const transitions = { pending: ['paid'], paid: ['pending', 'received'], received: [] }
  if (!transitions[transfer.status].includes(input.status)) throw new Error('转账状态转换不合法')
  transfer.status = input.status
  if (settlement.transfers.every((item) => item.status === 'received')) {
    settlement.status = 'completed'
    const trip = state.trips.find((item) => item.id === settlement.tripId)
    trip.status = 'settled'
    trip.activeSettlementId = null
  }
  save(state)
  return clone(settlement)
}

async function createInvite() { throw new Error('多人邀请需先配置微信云开发') }
async function joinTrip() { throw new Error('多人邀请需先配置微信云开发') }

module.exports = { bootstrap, createExpense, createInvite, createTrip, deleteExpense, getExpense, getSettlement, getTrip, joinTrip, listTrips, previewSettlement, startSettlement, updateExpense, updateTransferStatus }
