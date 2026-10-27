const test = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { splitEqual, splitByUnits } = require('../domain/split')
const { summarizeLedger } = require('../domain/ledger')
const { buildSettlementTransfers } = require('../domain/settlement')

test('ten members and five hundred expenses conserve every minor unit', () => {
  const startedAt = performance.now()
  const members = Array.from({ length: 10 }, (_, index) => ({ id: `member-${index}`, displayName: `Member ${index}`, units: index + 1 }))
  const expenses = Array.from({ length: 500 }, (_, index) => {
    const amountFen = index * 137 + 1
    const shares = index % 2 ? splitEqual(amountFen, members) : splitByUnits(amountFen, members)
    assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), amountFen)
    return { amountFen, shares, payerMemberId: members[index % 7].id }
  })
  const summary = summarizeLedger(members, expenses)
  const transfers = buildSettlementTransfers(summary)
  const balances = Object.fromEntries(summary.map((item) => [item.memberId, item.netAmount]))
  for (const transfer of transfers) {
    assert.ok(Number.isSafeInteger(transfer.amountFen) && transfer.amountFen > 0)
    balances[transfer.fromMemberId] += transfer.amountFen
    balances[transfer.toMemberId] -= transfer.amountFen
  }
  assert.ok(Object.values(balances).every((value) => value === 0))
  assert.ok(transfers.length <= members.length - 1)
  assert.ok(performance.now() - startedAt < 2000)
})

test('completed settlements leave only newly added expenses outstanding', () => {
  const members = [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }]
  const previous = { amountFen: 10001, payerMemberId: 'a', shares: splitEqual(10001, members) }
  const completed = { summary: summarizeLedger(members, [previous]) }
  const adjustment = { amountFen: 3000, payerMemberId: 'b', shares: splitEqual(3000, members) }
  const summary = summarizeLedger(members, [previous, adjustment], [completed])
  assert.equal(summary.find((item) => item.memberId === 'a').netAmount, -1500)
  assert.equal(summary.find((item) => item.memberId === 'b').netAmount, 1500)
  assert.deepEqual(buildSettlementTransfers(summary), [{ fromMemberId: 'a', toMemberId: 'b', amountFen: 1500, status: 'pending' }])
})
