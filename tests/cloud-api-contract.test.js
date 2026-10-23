'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

function createFakeCloud() {
  let currentOpenid = ''
  let throwOnNotFound = true
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
    async get() {
      const data = clone(storeFor(this.name).get(this.id))
      // wx-server-sdk 4.0.2 throws a string for absent docs by default,
      // both inside and outside transactions. Do not hide this in tests.
      if (!data && throwOnNotFound) throw `document with _id ${this.id} does not exist`
      return { data: data || null }
    }
    async update({ data }) {
      const target = storeFor(this.name).get(this.id)
      if (!target) throw new Error(`missing ${this.name}/${this.id}`)
      applyPatch(target, data)
      return { stats: { updated: 1 } }
    }
    async set({ data }) {
      storeFor(this.name).set(this.id, { ...clone(data), _id: this.id })
      return { _id: this.id }
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
    async createCollection(name) { storeFor(name); return {} },
    async startTransaction() {
      const before = clone(Object.fromEntries([...stores].map(([name, rows]) => [name, [...rows.values()]])))
      return {
        collection: (name) => {
          const collection = new Collection(name)
          collection.where = () => { throw new Error('CloudBase transactions do not support where()') }
          return collection
        },
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
    database: (config = {}) => {
      throwOnNotFound = config.throwOnNotFound !== false
      return database
    },
    getWXContext: () => ({ OPENID: currentOpenid }),
    openapi: { wxacode: { getUnlimited: async (input) => ({ buffer: Buffer.from(JSON.stringify(input)) }) } },
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://demo/${cloudPath}` }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, tempFileURL: `https://example.test/${encodeURIComponent(fileID)}` })) }),
  }
  return { cloud, setOpenid: (openid) => { currentOpenid = openid } }
}

test('first CNY expense creates its missing idempotency document and retries only once', async () => {
  const fake = createFakeCloud()
  const originalLoad = Module._load
  const apiPath = require.resolve('../cloudfunctions/api/index.js')
  let api
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'wx-server-sdk' ? fake.cloud : originalLoad.call(this, request, parent, isMain)
    }
    delete require.cache[apiPath]
    api = require(apiPath)
  } finally { Module._load = originalLoad }
  fake.setOpenid('missing-doc-owner')
  async function call(action, payload) {
    const result = await api.main({ action, payload })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.data
  }
  const created = await call('trip.create', { name: 'Missing document regression', companions: ['B', 'C'] })
  const trip = await call('trip.get', { tripId: created.id })
  const input = { tripId: trip.id, clientRequestId: 'first-cny-90', amountFen: 9000,
    payerMemberId: trip.currentMemberId, participantMemberIds: trip.members.map((m) => m.id),
    splitMode: 'equal', category: 'food', spentAt: '2026-10-04T12:00:00Z' }
  const expense = await call('expense.create', input)
  assert.equal((await call('expense.create', input)).id, expense.id)
  const result = await call('trip.get', { tripId: trip.id })
  assert.equal(result.expenses.length, 1)
  assert.equal(result.totalAmountFen, 9000)
  assert.equal(result.myNetAmountFen, 6000)
  assert.equal(result.ledgerRevision, 1)
})

test('cloud API validates FX quotes and computes foreign expenses on the server', async () => {
  const fake = createFakeCloud()
  const provider = require('../cloudfunctions/api/fxProvider')
  let fetches = 0
  let fail = false
  const originalLoad = Module._load
  const apiPath = require.resolve('../cloudfunctions/api/index.js')
  let api
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'wx-server-sdk') return fake.cloud
      if (request === './fxProvider' && parent.filename === apiPath) return {
        ...provider,
        async fetchRate(base, quote, date) {
          fetches += 1
          if (fail) throw new Error('测试服务超时')
          return provider.validateResponse({ base, quote, date, rate: quote === 'JPY' ? 150.5 : 7.12345678 }, base, quote, date)
        },
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    delete require.cache[apiPath]
    api = require(apiPath)
  } finally { Module._load = originalLoad }
  async function raw(action, payload, openid = 'fx-owner') {
    fake.setOpenid(openid)
    return api.main({ action, payload })
  }
  async function call(action, payload) {
    const result = await raw(action, payload)
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.data
  }
  const created = await call('trip.create', { name: 'FX test', companions: ['B'], baseCurrency: 'CNY' })
  const trip = await call('trip.get', { tripId: created.id })
  const quoteInput = { tripId: trip.id, currency: 'USD', date: '2026-09-22' }
  assert.equal((await raw('fx.quote', quoteInput, 'outsider')).error.code, 'FORBIDDEN')
  assert.equal(fetches, 0)
  const quote = await call('fx.quote', quoteInput)
  assert.match(quote.id, /^[a-f0-9]{32}$/)
  assert.deepEqual(await call('fx.quote', quoteInput), quote)
  assert.equal(fetches, 1, 'cached request must not call provider again')
  const input = {
    tripId: trip.id, payerMemberId: trip.currentMemberId,
    participantMemberIds: trip.members.map((m) => m.id), splitMode: 'equal', units: {}, category: 'food',
    spentAt: '2026-09-22T12:00:00.000Z', clientRequestId: 'fx-create-1',
    originalCurrency: 'USD', originalAmountMinor: 100, amountFen: 1,
    fx: { mode: 'auto', quoteId: quote.id, rate: '99999', source: 'forged' },
  }
  const expense = await call('expense.get', { expenseId: (await call('expense.create', input)).id })
  assert.equal(expense.amountFen, 712, 'ignore client supplied converted amount')
  assert.equal(expense.originalAmountMinor, 100)
  assert.equal(expense.fx.rate, '7.12345678', 'ignore client supplied automatic rate')
  assert.equal(expense.fx.source, 'Frankfurter / ECB')
  const detail = await call('expense.get', { expenseId: expense.id })
  assert.equal(Object.values(detail.shares).reduce((a, b) => a + b, 0), 712)
  const edit = await call('expense.update', { ...input, expenseId: expense.id, expectedRevision: 1, note: 'changed note' })
  assert.deepEqual(edit.fx, expense.fx, 'editing keeps frozen quote')
  assert.equal(fetches, 1)
  for (const patch of [
    { fx: { mode: 'auto', quoteId: 'bad' } },
    { fx: { mode: 'auto', quoteId: '0'.repeat(32) } },
    { spentAt: '2026-09-21T12:00:00.000Z' },
    { originalCurrency: 'EUR' },
  ]) {
    const result = await raw('expense.create', { ...input, ...patch, clientRequestId: `bad-${JSON.stringify(patch)}` })
    assert.equal(result.error.code, 'VALIDATION_ERROR')
  }
  assert.equal((await call('trip.get', { tripId: trip.id })).expenses.length, 1)
  assert.equal((await raw('trip.update', { tripId: trip.id, name: trip.name, baseCurrency: 'JPY' })).error.code, 'VALIDATION_ERROR')
  assert.equal((await raw('trip.create', { name: 'invalid', baseCurrency: 'XXX' })).error.code, 'VALIDATION_ERROR')
  fail = true
  assert.equal((await raw('fx.quote', { ...quoteInput, currency: 'EUR' })).error.code, 'FX_UNAVAILABLE')
  const manual = await call('expense.get', { expenseId: (await call('expense.create', { ...input, clientRequestId: 'fx-manual', fx: { mode: 'manual', rate: '7.1' } })).id })
  assert.equal(manual.amountFen, 710)
  const actual = await call('expense.get', { expenseId: (await call('expense.create', { ...input, clientRequestId: 'fx-actual', fx: { mode: 'actual', actualAmountMinor: 735 } })).id })
  assert.equal(actual.amountFen, 735)
  assert.equal(actual.fx.rate, '')
  const japaneseTrip = await call('trip.create', { name: 'Japan', baseCurrency: 'JPY', companions: ['B'] })
  const jp = await call('trip.get', { tripId: japaneseTrip.id })
  const jpExpense = await call('expense.get', { expenseId: (await call('expense.create', { ...input, tripId: jp.id, payerMemberId: jp.currentMemberId, participantMemberIds: jp.members.map((m) => m.id), fx: { mode: 'manual', rate: '150.5' } })).id })
  assert.equal(jpExpense.amountFen, 151)
  assert.equal(jpExpense.baseCurrency, 'JPY')
  const settlement = await call('settlement.start', { tripId: jp.id })
  assert.equal(settlement.baseCurrency, 'JPY')
  assert.equal(settlement.transfers.length, 1)
  assert.ok([75, 76].includes(settlement.transfers[0].amountFen))
})

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

  const emptyProfile = await call('openid-a', 'bootstrap')
  assert.equal(emptyProfile.profileComplete, false)
  const savedProfile = await call('openid-a', 'user.updateProfile', { displayName: 'A', avatarUrl: 'cloud://demo/profile-a.jpg' })
  assert.equal(savedProfile.profileComplete, true)
  await call('openid-b', 'bootstrap')
  const created = await call('openid-a', 'trip.create', { name: '云南七日', ownerName: 'A', companions: [] })
  const invite = await call('openid-a', 'invite.create', { tripId: created.id })
  assert.match(invite.inviteCode, /^\d{6}$/)
  const resolved = await call('openid-b', 'invite.resolveCode', { inviteCode: invite.inviteCode })
  assert.equal(resolved.inviteId, invite.inviteId)
  const qr = await call('openid-a', 'invite.getQr', { inviteId: invite.inviteId, envVersion: 'develop' })
  assert.equal(qr.inviteCode, invite.inviteCode)
  assert.match(qr.tempFileURL, /^https:\/\/example\.test\//)
  const preview = await call('openid-b', 'invite.preview', { inviteId: invite.inviteId })
  assert.equal(preview.tripName, '云南七日')
  await call('openid-b', 'invite.join', { inviteId: invite.inviteId, displayName: 'B' })
  await call('openid-b', 'invite.join', { inviteId: invite.inviteId, displayName: 'B' })
  const activeInvite = await call('openid-a', 'invite.getActive', { tripId: created.id })
  assert.equal(activeInvite.useCount, 1)

  const trip = await call('openid-a', 'trip.get', { tripId: created.id })
  const memberA = trip.members.find((member) => member.userId === 'openid-a')
  const memberB = trip.members.find((member) => member.userId === 'openid-b')
  assert.ok(memberA && memberB)
  await call('openid-a', 'member.updateMyAvatar', { tripId: created.id, avatarUrl: 'cloud://demo/avatar-a.jpg' })
  const avatarTrip = await call('openid-a', 'trip.get', { tripId: created.id })
  assert.equal(avatarTrip.members.find((member) => member.id === memberA.id).avatarUrl, 'cloud://demo/avatar-a.jpg')
  assert.equal(avatarTrip.summary.find((member) => member.memberId === memberA.id).avatarUrl, 'cloud://demo/avatar-a.jpg')

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
  assert.equal(refreshed.transfers.length, 1)
  assert.equal(refreshed.transfers[0].amountFen, 20, 'completed transfers must not be charged again')
  const historicalEdit = await raw('openid-a', 'expense.update', {
    expenseId: expenseA.id, expectedRevision: 1, payerMemberId: memberA.id, amountFen: 400,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'stay', spentAt: '2026-09-22T12:00:00.000Z',
  })
  assert.equal(historicalEdit.error.code, 'SETTLEMENT_LOCKED')
  const historicalDelete = await raw('openid-a', 'expense.delete', { expenseId: expenseA.id, expectedRevision: 1 })
  assert.equal(historicalDelete.error.code, 'SETTLEMENT_LOCKED')
  assert.equal((await call('openid-a', 'expense.get', { expenseId: expenseA.id })).canEdit, false)

  const second = await call('openid-a', 'settlement.start', { tripId: created.id })
  assert.equal(second.transfers[0].amountFen, 20)
  await call('openid-b', 'settlement.transfer.update', { settlementId: second.id, transferId: second.transfers[0].id, status: 'paid' })
  await call('openid-a', 'settlement.transfer.update', { settlementId: second.id, transferId: second.transfers[0].id, status: 'received' })
  assert.ok((await call('openid-a', 'trip.get', { tripId: created.id })).summary.every((item) => item.netAmount === 0))

  const thirdInput = {
    tripId: created.id, payerMemberId: memberA.id, amountFen: 60,
    participantMemberIds: [memberA.id, memberB.id], splitMode: 'equal', units: {},
    category: 'other', spentAt: '2026-09-22T15:00:00.000Z', clientRequestId: 'third-round-request',
  }
  const thirdExpense = await call('openid-a', 'expense.create', thirdInput)
  const unpaid = await call('openid-a', 'settlement.start', { tripId: created.id })
  assert.equal(unpaid.transfers[0].amountFen, 30)
  const edited = await call('openid-a', 'expense.update', { ...thirdInput, expenseId: thirdExpense.id, expectedRevision: 1, amountFen: 80 })
  assert.equal(edited.revision, 2)
  assert.equal((await call('openid-a', 'settlement.get', { tripId: created.id })).status, 'preview')
  const obsolete = await raw('openid-b', 'settlement.transfer.update', { settlementId: unpaid.id, transferId: unpaid.transfers[0].id, status: 'paid' })
  assert.equal(obsolete.error.code, 'SETTLEMENT_LOCKED')
  const third = await call('openid-a', 'settlement.start', { tripId: created.id })
  assert.equal(third.transfers[0].amountFen, 40)
  await call('openid-b', 'settlement.transfer.update', { settlementId: third.id, transferId: third.transfers[0].id, status: 'paid' })
  const lockedWrite = await raw('openid-a', 'expense.create', { ...thirdInput, clientRequestId: 'locked-create-request' })
  assert.equal(lockedWrite.error.code, 'SETTLEMENT_LOCKED')
  const lockedDelete = await raw('openid-a', 'expense.delete', { expenseId: thirdExpense.id, expectedRevision: 2 })
  assert.equal(lockedDelete.error.code, 'SETTLEMENT_LOCKED')
  await call('openid-b', 'settlement.transfer.update', { settlementId: third.id, transferId: third.transfers[0].id, status: 'pending' })
  await call('openid-a', 'expense.delete', { expenseId: thirdExpense.id, expectedRevision: 2 })
  assert.equal((await call('openid-a', 'settlement.get', { tripId: created.id })).transfers.length, 0)

  await call('openid-a', 'invite.revoke', { inviteId: invite.inviteId })
  const revoked = await raw('openid-b', 'invite.preview', { inviteId: invite.inviteId })
  assert.equal(revoked.error.code, 'INVITE_INVALID')

  await call('openid-a', 'member.transferOwner', { tripId: created.id, memberId: memberB.id })
  const oldOwnerInvite = await raw('openid-a', 'invite.create', { tripId: created.id })
  assert.equal(oldOwnerInvite.error.code, 'FORBIDDEN')
  const newOwnerInvite = await call('openid-b', 'invite.create', { tripId: created.id })
  assert.ok(newOwnerInvite.inviteId)
})
