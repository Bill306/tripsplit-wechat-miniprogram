'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const money = require('../domain/currency')
const provider = require('../cloudfunctions/api/fxProvider')

test('client and deployed cloud currency logic are identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../domain/currency.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../cloudfunctions/api/currency.js'), 'utf8'))
})

test('currency decimals and explicit labels distinguish yuan from yen', () => {
  assert.equal(money.CURRENCIES.length, 12)
  assert.equal(money.parseAmount('12.34', 'CNY'), 1234)
  assert.equal(money.parseAmount('1200', 'JPY'), 1200)
  assert.equal(money.parseAmount('1200', 'KRW'), 1200)
  assert.throws(() => money.parseAmount('12.34', 'JPY'), /整数/)
  assert.equal(money.amountText(1200, 'JPY'), 'JPY 1,200')
  assert.equal(money.amountText(1200, 'CNY'), 'CNY 12.00')
  assert.equal(money.amountText(-1234, 'USD', false), '-12.34')
  for (const value of ['0', '-1', '1e3', 'Infinity', '1.234', '99999999999999999999']) assert.throws(() => money.parseAmount(value, 'USD'))
  assert.throws(() => money.currency('BAD'))
})

test('empty amounts ask for an amount instead of reporting decimal precision', () => {
  for (const code of ['CNY', 'JPY']) {
    for (const value of ['', '  ', null, undefined]) assert.throws(() => money.parseAmount(value, code), /请输入消费金额/)
  }
})

test('exact half-up conversion handles currency exponents and eight decimals', () => {
  assert.equal(money.convertMinor(10000, 'JPY', 'CNY', '0.04812345'), 48123)
  assert.equal(money.convertMinor(100, 'USD', 'CNY', '7.125'), 713)
  assert.equal(money.convertMinor(100, 'USD', 'JPY', '150.5'), 151)
  assert.equal(money.convertMinor(99999999, 'CNY', 'USD', '0.12345678'), 12345678)
  assert.equal(money.rateText(money.parseRate('10.00000000')), '10')
  assert.throws(() => money.convertMinor(1, 'JPY', 'CNY', '0.00000001'), /过小/)
  assert.throws(() => money.convertMinor(99999999, 'USD', 'CNY', '100000'), /超限/)
  for (const rate of ['0', '-1', '1e2', 'NaN', '0.123456789', '100001']) assert.throws(() => money.parseRate(rate))
})

test('conversion matches a BigInt oracle without requiring BigInt in the app', () => {
  let seed = 731
  const random = (max) => { seed = (seed * 16807) % 2147483647; return seed % max + 1 }
  for (let i = 0; i < 1000; i += 1) {
    const amount = random(99999999)
    const scaled = random(2000000000)
    const from = i % 2 ? 'JPY' : 'USD'
    const to = i % 3 ? 'CNY' : 'KRW'
    const numerator = BigInt(amount) * BigInt(scaled) * BigInt(10 ** money.currency(to).decimals)
    const denominator = BigInt(money.RATE_SCALE) * BigInt(10 ** money.currency(from).decimals)
    const expected = Number((numerator + denominator / 2n) / denominator)
    if (expected < 1 || expected > money.MAX_MINOR) assert.throws(() => money.convertMinor(amount, from, to, money.rateText(scaled)))
    else assert.equal(money.convertMinor(amount, from, to, money.rateText(scaled)), expected)
  }
})

test('legacy amounts remain CNY; actual deductions override reference rates', () => {
  assert.equal(money.normalizeFx({ amountFen: 1234 }).amountFen, 1234)
  assert.throws(() => money.normalizeFx({ amountFen: 1234 }, 'JPY'), /更新小程序/)
  const result = money.normalizeFx({ originalCurrency: 'USD', originalAmountMinor: 10000, amountFen: 1, fx: { mode: 'actual', actualAmountMinor: 71234, rate: '9' } }, 'CNY')
  assert.equal(result.amountFen, 71234)
  assert.equal(result.fx.rate, '')
  assert.equal(result.originalAmountMinor, 10000)
})

test('automatic conversion requires a matching server quote', () => {
  const input = { originalCurrency: 'USD', originalAmountMinor: 100, spentAt: '2026-10-03T12:00:00Z', fx: { mode: 'auto', quoteId: 'q' } }
  const quote = { id: 'q', base: 'USD', quote: 'CNY', rate: '7', provider: 'ECB', requestedDate: '2026-10-03', rateDate: '2026-10-02' }
  assert.equal(money.normalizeFx(input, 'CNY', quote).amountFen, 700)
  assert.throws(() => money.normalizeFx(input, 'CNY'), /不匹配/)
  assert.throws(() => money.normalizeFx({ ...input, spentAt: '2026-10-02T12:00:00Z' }, 'CNY', quote), /不匹配/)
  assert.throws(() => money.normalizeFx(input, 'HKD', quote), /不匹配/)
})

test('provider rejects malformed, future, mismatched and stale data', () => {
  assert.throws(() => provider.validateRequest('USD', 'CNY', '2026-02-30'))
  assert.throws(() => provider.validateRequest('USD', 'CNY', '2999-01-01'))
  assert.throws(() => provider.validateRequest('USD', 'USD', '2026-01-02'))
  const data = { base: 'USD', quote: 'CNY', date: '2026-10-02', rate: 7.1 }
  assert.equal(provider.validateResponse(data, 'USD', 'CNY', '2026-10-03').rateDate, '2026-10-02')
  assert.throws(() => provider.validateResponse(data, 'JPY', 'CNY', '2026-10-03'))
  assert.throws(() => provider.validateResponse(data, 'USD', 'CNY', '2026-10-01'))
  assert.throws(() => provider.validateResponse(data, 'USD', 'CNY', '2026-10-20'))
  assert.throws(() => provider.validateResponse({ ...data, rate: Infinity }, 'USD', 'CNY', '2026-10-03'))
})
