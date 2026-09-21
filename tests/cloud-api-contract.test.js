'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

function createFakeCloud() {
  let currentOpenid = ''
  let sequence = 0
  const stores = new Map()
  const op = (type, value) => ({ __command: type, value })
  const command = { eq: (value) => op('eq', value), neq: (value) => op('neq', value), in: (value) => op('in', value), inc: (value) => op('inc', value), remove: () => op('remove') }
  const storeFor = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name) }
  const matches = (doc, where) => Object.entries(where || {}).every(([key, expected]) => {
    if (expected && expected.__command === 'eq') return doc[key] === expected.value
    if (expected && expected.__command === 'neq') return doc[key] !== expected.value
    if (expected && expected.__command === 'in') return expected.value.includes(doc[key])
    return doc[key] === expected
  })
  const applyPatch = (target, patch) => {
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined) return
      if (value && value.__command === 'inc') target[key] = (target[key] || 0) + value.value
      else if (value && value.__command === 'remove') delete target[key]
      else target[key] = clone(value)
    })
  }

  class Query {
    constructor(name, where) { this.name = name; this.criteria = where; this.offset = 0; this.maximum = 100 }
    skip(value) { this.offset = value; return this }
    limit(value) { this.maximum = value; return this }
    async get() {
      const data = [...storeFor(this.name).values()].filter((doc) => matches(doc, this.criteria)).slice(this.offset, this.offset + this.maximum)
      return { data: clone(data) }
    }
    async count() { return { total: [...storeFor(this.name).values()].filter((doc) => matches(doc, this.criteria)).length } }
  }

  class Doc {
    constructor(name, id) { this.name = name; this.id = id }
    async get() { return { data: clone(storeFor(this.name).get(this.id)) } }
    async update({ data }) {
      const target = storeFor(this.name).get(this.id)
      if (!target) throw new Error(`missing ${this.name}/${this.id}`)
      applyPatch(target, data)
      return { stats: { updated: 1 } }
    }
    async remove() { return { stats: { removed: storeFor(this.name).delete(this.id) ? 1 : 0 } } }
  }

  class Collection {
    constructor(name) { this.name = name }
    where(criteria) { return new Query(this.name, criteria) }
    doc(id) { return new Doc(this.name, id) }
    async add({ data }) {
      const _id = `${this.name}_${++sequence}`
      storeFor(this.name).set(_id, { ...clone(data), _id })
      return { _id }
    }
  }

  const database = {
    command,
    collection: (name) => new Collection(name),
    async startTransaction() {
      const before = clone(Object.fromEntries([...stores].map(([name, rows]) => [name, [...rows.values()]])))
      return {
        collection: (name) => new Collection(name),
        async commit() {},
        async rollback() {
          stores.clear()
          Object.entries(before).forEach(([name, rows]) => stores.set(name, new Map(rows.map((row) => [row._id, row]))))
        },
      }
    },
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: currentOpenid }),
  }
  return { cloud, setOpenid: (openid) => { currentOpenid = openid } }
}

test('cloud API supports a two-account shared ledger and enforces settlement permissions', async () => {
  const fake = createFakeCloud()
  const originalLoad = Module._load
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fake.cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  const apiPath = require.resolve('../cloudfunctions/api/index.js')
  delete require.cache[apiPath]
  const api = require(apiPath)
  Module._load = originalLoad

  async function raw(openid, action, payload = {}) {
    fake.setOpenid(openid)
    return api.main({ action, payload })
  }
  async function call(openid, action, payload = {}) {
    const result = await raw(openid, action, payload)
    assert.equal(result.ok, true, `${action}: ${result.error && result.error.message}`)
    return result.data
  }

  await call('openid-a', 'bootstrap')
  await call('openid-b', 'bootstrap')
  const created = await call('openid-a', 'trip.create', { name: '云南七日', ownerName: 'A', companions: [] })
  const invite = await call('openid-a', 'invite.create', { tripId: created.id })
  const preview = await call('openid-b', 'invite.preview', { inviteId: invite.inviteId })
  assert.equal(preview.tripName, '云南七日')
  await call('openid-b', 'invite.join', { inviteId: invite.inviteId, displayName: 'B' })

  const trip = await call('openid-a', 'trip.get', { tripId: created.id })
  const memberA = trip.members.find((member) => member.userId === 'openid-a')
  const memberB = trip.members.find((member) => member.userId === 'openid-b')
  assert.ok(memberA && memberB)

  const expenseA = await call('openid-a', 'expense.create', {
    tripId: created.id, payerMemberId: memberA.id, amountFen: 300,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'stay', note: '住宿', spentAt: '2026-09-22T12:00:00.000Z', clientRequestId: 'cloud-a-request',
  })
  const duplicate = await call('openid-a', 'expense.create', {
    tripId: created.id, payerMemberId: memberA.id, amountFen: 300,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'stay', note: '住宿', spentAt: '2026-09-22T12:00:00.000Z', clientRequestId: 'cloud-a-request',
  })
  assert.equal(duplicate.id, expenseA.id)
  await call('openid-b', 'expense.create', {
    tripId: created.id, payerMemberId: memberB.id, amountFen: 100,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'food', note: '午饭', spentAt: '2026-09-22T13:00:00.000Z', clientRequestId: 'cloud-b-request',
  })

  const forbiddenEdit = await raw('openid-b', 'expense.update', {
    expenseId: expenseA.id, expectedRevision: 1, payerMemberId: memberA.id, amountFen: 400,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'stay', note: '越权', spentAt: '2026-09-22T12:00:00.000Z',
  })
  assert.equal(forbiddenEdit.error.code, 'FORBIDDEN')

  const settlement = await call('openid-a', 'settlement.start', { tripId: created.id })
  assert.equal(settlement.summary.length, 2)
  assert.equal(settlement.transfers.length, 1)
  const transfer = settlement.transfers[0]
  assert.equal(transfer.fromMemberId, memberB.id)
  assert.equal(transfer.toMemberId, memberA.id)
  assert.equal(transfer.amountFen, 100)

  const wrongPayer = await raw('openid-a', 'settlement.transfer.update', { settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
  assert.equal(wrongPayer.error.code, 'FORBIDDEN')
  await call('openid-b', 'settlement.transfer.update', { settlementId: settlement.id, transferId: transfer.id, status: 'paid' })
  const wrongReceiver = await raw('openid-b', 'settlement.transfer.update', { settlementId: settlement.id, transferId: transfer.id, status: 'received' })
  assert.equal(wrongReceiver.error.code, 'FORBIDDEN')
  const completed = await call('openid-a', 'settlement.transfer.update', { settlementId: settlement.id, transferId: transfer.id, status: 'received' })
  assert.equal(completed.status, 'completed')

  await call('openid-a', 'expense.create', {
    tripId: created.id, payerMemberId: memberA.id, amountFen: 40,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'other', note: '调整', spentAt: '2026-09-22T14:00:00.000Z', clientRequestId: 'cloud-adjustment',
  })
  const refreshed = await call('openid-b', 'settlement.get', { tripId: created.id })
  assert.equal(refreshed.status, 'preview')
  assert.ok(refreshed.ledgerRevision > settlement.ledgerRevision)

  await call('openid-a', 'invite.revoke', { inviteId: invite.inviteId })
  const revoked = await raw('openid-b', 'invite.preview', { inviteId: invite.inviteId })
  assert.equal(revoked.error.code, 'INVITE_INVALID')

  await call('openid-a', 'member.transferOwner', { tripId: created.id, memberId: memberB.id })
  const oldOwnerInvite = await raw('openid-a', 'invite.create', { tripId: created.id })
  assert.equal(oldOwnerInvite.error.code, 'FORBIDDEN')
  const newOwnerInvite = await call('openid-b', 'invite.create', { tripId: created.id })
  assert.ok(newOwnerInvite.inviteId)
})
