'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { formatFen, parseYuanToFen } = require('../domain/money')
const { splitByUnits, splitEqual } = require('../domain/split')
const { summarizeLedger } = require('../domain/ledger')
const { buildSettlementTransfers } = require('../domain/settlement')

const members = [
  { id: 'b', displayName: '小明', createdAt: '2026-01-02' },
  { id: 'a', displayName: 'Bill', createdAt: '2026-01-01' },
  { id: 'c', displayName: '小红', createdAt: '2026-01-03' },
]

test('parses and formats integer fen without floating-point arithmetic', () => {
  assert.equal(parseYuanToFen('0.01'), 1)
  assert.equal(parseYuanToFen('1234.5'), 123450)
  assert.equal(formatFen(123450), '¥1,234.50')
  assert.equal(formatFen(-105), '¥-1.05')
})

test('rejects invalid amounts', () => {
  for (const value of ['', '0', '-1', '1.234', '1000000']) {
    assert.throws(() => parseYuanToFen(value))
  }
})

test('equal split assigns remainder in stable member order', () => {
  assert.deepEqual(splitEqual(100, members), { a: 34, b: 33, c: 33 })
  assert.equal(Object.values(splitEqual(100, members)).reduce((a, b) => a + b, 0), 100)
})

test('unit split assigns amounts and remainder deterministically', () => {
  const weighted = members.map((member, index) => ({ ...member, units: index + 1 }))
  assert.deepEqual(splitByUnits(101, weighted), { a: 34, b: 17, c: 50 })
  assert.equal(Object.values(splitByUnits(101, weighted)).reduce((a, b) => a + b, 0), 101)
})

test('split rejects empty members and invalid units', () => {
  assert.throws(() => splitEqual(100, []))
  assert.throws(() => splitByUnits(100, [{ id: 'a', units: 0 }]))
})

test('ledger summarizes payments and obligations and ignores deleted expenses', () => {
  const expenses = [
    { payerMemberId: 'a', amountFen: 100, shares: splitEqual(100, members) },
    { payerMemberId: 'b', amountFen: 60, shares: { a: 0, b: 30, c: 30 } },
    { payerMemberId: 'c', amountFen: 999, shares: { c: 999 }, deletedAt: '2026-01-05' },
  ]
  assert.deepEqual(summarizeLedger(members, expenses), [
    { memberId: 'b', displayName: '小明', paidAmount: 60, owedAmount: 63, netAmount: -3 },
    { memberId: 'a', displayName: 'Bill', paidAmount: 100, owedAmount: 34, netAmount: 66 },
    { memberId: 'c', displayName: '小红', paidAmount: 0, owedAmount: 63, netAmount: -63 },
  ])
})

test('settlement transfers make every member balance zero', () => {
  const summary = [
    { memberId: 'a', netAmount: 700 },
    { memberId: 'b', netAmount: 300 },
    { memberId: 'c', netAmount: -600 },
    { memberId: 'd', netAmount: -400 },
  ]
  const transfers = buildSettlementTransfers(summary)
  assert.deepEqual(transfers, [
    { fromMemberId: 'c', toMemberId: 'a', amountFen: 600, status: 'pending' },
    { fromMemberId: 'd', toMemberId: 'a', amountFen: 100, status: 'pending' },
    { fromMemberId: 'd', toMemberId: 'b', amountFen: 300, status: 'pending' },
  ])

  const balances = Object.fromEntries(summary.map((item) => [item.memberId, item.netAmount]))
  transfers.forEach((transfer) => {
    balances[transfer.fromMemberId] += transfer.amountFen
    balances[transfer.toMemberId] -= transfer.amountFen
  })
  assert.deepEqual(Object.values(balances), [0, 0, 0, 0])
})

test('already balanced ledger produces no transfers', () => {
  assert.deepEqual(buildSettlementTransfers([{ memberId: 'a', netAmount: 0 }]), [])
})

test('unbalanced ledger cannot produce settlement', () => {
  assert.throws(() => buildSettlementTransfers([
    { memberId: 'a', netAmount: 10 },
    { memberId: 'b', netAmount: -9 },
  ]))
})
