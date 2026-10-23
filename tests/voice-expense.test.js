const test = require('node:test')
const assert = require('node:assert/strict')
const { parseVoiceExpense, numberText } = require('../domain/voiceExpense')
const parse = (text) => parseVoiceExpense(text, '2026-10-04')
test('spoken lunch in yen becomes a reviewable original-currency draft', () => {
  const result = parse('今天中午吃饭花了三千日元')
  assert.equal(result.ready, true)
  assert.equal(result.amount, '3000')
  assert.equal(result.originalCurrency, 'JPY')
  assert.equal(result.category, 'food')
  assert.equal(result.spentAt, '2026-10-04')
})
test('Chinese decimals, currency aliases and zero-decimal currencies', () => {
  assert.equal(parse('昨天打车花了二十三点五美元').amount, '23.50')
  assert.equal(parse('昨天打车花了二十三点五美元').spentAt, '2026-10-03')
  assert.equal(parse('午饭 JPY 3,000').amount, '3000')
  assert.equal(parse('咖啡人民币１２.５０').amount, '12.50')
  assert.equal(parse('午饭三千点五日元').ready, false)
  assert.equal(parse('购物两万三千五百韩元').amount, '23500')
  assert.equal(numberText('一百零五'), '105')
  assert.equal(numberText('十五'), '15')
  assert.equal(numberText('十万零五十'), '100050')
})
test('ambiguous, multiple, negative and incomplete amounts are not applied', () => {
  for (const text of ['午饭3000', '午饭三千五日元', '退款100元', '午饭-100元', '午饭大约100元', '午饭100到200元', '午饭300、200日元', '三个人每人100元', '午饭100元晚饭200元', '3000日元扣了150人民币', '100元找零20元', '午饭0美元', '午饭1.234美元']) {
    assert.equal(parse(text).ready, false, text)
  }
})
test('relative dates cross month/year boundaries without UTC shift', () => {
  assert.equal(parseVoiceExpense('昨天午饭100元', '2026-01-01').spentAt, '2025-12-31')
  assert.equal(parseVoiceExpense('前天住宿100美元', '2026-03-01').spentAt, '2026-02-27')
  assert.equal(parse('上周午饭100元').spentAt, '')
})
