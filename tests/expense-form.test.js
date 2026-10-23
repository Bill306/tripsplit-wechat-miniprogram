'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const money = require('../domain/currency')

function makePage(repository, saved = null) {
  let definition
  const context = {
    require(name) {
      if (name.includes('repository')) return repository
      if (name.includes('currency')) return money
      if (name.includes('voiceExpense')) return require('../domain/voiceExpense')
      if (name.includes('voiceInput')) return { start() {}, stop() {} }
      if (name.includes('config/voice')) return { enabled: false }
      return { CATEGORY: { other: { label: '其他' }, food: { label: '餐饮' } } }
    },
    Page(value) { definition = value },
    wx: { getStorageSync: () => saved, setStorageSync() {}, setNavigationBarTitle() {}, showToast() {} },
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../pages/expense-form/expense-form.js'), 'utf8'), context)
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}
const trip = () => ({ id: 't', baseCurrency: 'CNY', currentMemberId: 'a', members: [{ id: 'a', status: 'active' }] })
const quote = { id: 'a'.repeat(32), base: 'USD', quote: 'CNY', provider: 'ECB', rate: '7.1', requestedDate: '2026-09-22', rateDate: '2026-09-22' }

test('editing a bill restores its frozen quote without fetching new rates', async () => {
  const page = makePage({
    getTrip: async () => trip(),
    getFxQuote: async () => { throw new Error('must not refresh existing quote') },
    getExpense: async () => ({ payerMemberId: 'a', shares: { a: 710 }, originalCurrency: 'USD', originalAmountMinor: 100, amountFen: 710, spentAt: '2026-09-22T12:00:00Z', revision: 2, fx: { mode: 'auto', quoteId: quote.id, ...quote } }),
  })
  page.setData({ tripId: 't', expenseId: 'e' })
  await page.loadTrip()
  assert.equal(page.data.amount, '1.00')
  assert.equal(page.data.convertedText, 'CNY 7.10')
  page.persistDraft({ note: 'only a note edit' })
  assert.equal(page.moneyInput().fx.quoteId, quote.id)
  assert.equal(page.moneyInput().amountFen, 710)
})

test('a late quote cannot overwrite a newly selected manual rate', async () => {
  let resolve
  const page = makePage({ getFxQuote: () => new Promise((r) => { resolve = r }) })
  page.setData({ tripId: 't', originalCurrency: 'USD', spentAt: '2026-09-22', amount: '1.00' })
  const pending = page.refreshQuote()
  assert.equal(page.data.fxLoading, true)
  page.persistDraft({ fxMode: 'manual', fxRate: '7.3' })
  await page.refreshQuote()
  resolve(quote)
  await pending
  assert.equal(page.data.fxLoading, false)
  assert.equal(page.data.fxQuote, null)
  assert.equal(page.data.fxRate, '7.3')
  assert.equal(page.moneyInput().amountFen, 730)
})

test('restoring an obsolete payer index falls back to a current member', async () => {
  const page = makePage({ getTrip: async () => trip() }, { payerIndex: 99, amount: '2.00' })
  page.setData({ tripId: 't' })
  await page.loadTrip()
  assert.equal(page.data.payerIndex, 0)
  assert.equal(page.data.convertedText, 'CNY 2.00')
})

test('voice parsing previews a draft and never writes a ledger by itself', () => {
  const page = makePage({ createExpense: () => assert.fail('preview must not save') })
  page.setData({ voiceText: '今天中午吃饭花了三千日元', amount: '9.00' })
  page.previewVoice()
  assert.equal(page.data.voiceDraft.ready, true)
  assert.equal(page.data.voiceDraft.amount, '3000')
  assert.equal(page.data.voiceDraft.categoryLabel, '餐饮')
  assert.equal(page.data.amount, '9.00', 'existing form is untouched until apply')
})

test('voice draft cannot be applied while saving or recording', async () => {
  const page = makePage({})
  page.setData({ submitting: true, voiceDraft: { ready: true, amount: '100' }, amount: '9.00' })
  await page.applyVoice()
  assert.equal(page.data.amount, '9.00')
  page.setData({ submitting: false, voiceState: 'recording' })
  await page.applyVoice()
  assert.equal(page.data.amount, '9.00')
})
