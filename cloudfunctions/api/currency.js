'use strict'

const CURRENCIES = [
  ['CNY', '人民币', 2], ['HKD', '港币', 2], ['USD', '美元', 2], ['EUR', '欧元', 2],
  ['JPY', '日元', 0], ['GBP', '英镑', 2], ['AUD', '澳元', 2], ['CAD', '加元', 2],
  ['SGD', '新加坡元', 2], ['THB', '泰铢', 2], ['KRW', '韩元', 0], ['CHF', '瑞士法郎', 2],
].map(([code, name, decimals]) => ({ code, name, decimals, label: `${code} · ${name}` }))
const MAX_MINOR = 99999999
const RATE_SCALE = 100000000

function currency(code = 'CNY') {
  const result = CURRENCIES.find((item) => item.code === code)
  if (!result) throw new Error('暂不支持该币种')
  return result
}

function assertMinor(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MINOR) throw new Error('金额过小、超限或不是整数最小货币单位')
  return value
}

function parseAmount(value, code = 'CNY') {
  const { decimals } = currency(code)
  const text = String(value == null ? '' : value).trim()
  if (!text) throw new Error('请输入消费金额')
  const pattern = decimals ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/
  if (!pattern.test(text)) throw new Error(decimals ? '金额最多两位小数' : `${code} 金额只能填写整数`)
  const [whole, fraction = ''] = text.split('.')
  return assertMinor(Number(whole) * 10 ** decimals + Number(fraction.padEnd(decimals, '0')))
}

function amountText(minor, code = 'CNY', withCode = true) {
  const { decimals } = currency(code)
  if (!Number.isSafeInteger(minor)) throw new Error('金额必须是整数最小货币单位')
  const digits = String(Math.abs(minor)).padStart(decimals + 1, '0')
  const whole = decimals ? digits.slice(0, -decimals) : digits
  const fraction = decimals ? `.${digits.slice(-decimals)}` : ''
  return `${withCode ? `${code} ` : ''}${minor < 0 ? '-' : ''}${withCode ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}${fraction}`
}

function parseRate(value) {
  const text = String(value == null ? '' : value).trim()
  if (!/^\d{1,6}(?:\.\d{1,8})?$/.test(text)) throw new Error('汇率需为正数，最多八位小数')
  const [whole, fraction = ''] = text.split('.')
  const scaled = Number(whole) * RATE_SCALE + Number(fraction.padEnd(8, '0'))
  if (!Number.isSafeInteger(scaled) || scaled < 1 || scaled > 100000 * RATE_SCALE) throw new Error('汇率超出支持范围')
  return scaled
}

function rateText(scaled) {
  if (!Number.isSafeInteger(scaled) || scaled < 1) throw new Error('汇率不合法')
  const text = String(scaled).padStart(9, '0')
  return `${text.slice(0, -8)}.${text.slice(-8)}`.replace(/\.?0+$/, '')
}

// Decimal long multiplication/division avoids unsafe IEEE-754 intermediates and
// does not require BigInt support in older WeChat JavaScript runtimes.
function multiply(left, right) {
  const out = Array(left.length + right.length).fill(0)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) out[i + j + 1] += Number(left[i]) * Number(right[j])
  }
  for (let i = out.length - 1; i > 0; i -= 1) { out[i - 1] += Math.floor(out[i] / 10); out[i] %= 10 }
  return out.join('').replace(/^0+(?=\d)/, '')
}

function divideRound(numerator, denominator) {
  let remainder = 0
  let quotient = ''
  for (const digit of numerator) {
    remainder = remainder * 10 + Number(digit)
    quotient += String(Math.floor(remainder / denominator))
    remainder %= denominator
  }
  return assertMinor(Number(quotient) + (remainder * 2 >= denominator ? 1 : 0))
}

function convertMinor(originalMinor, originalCurrency, baseCurrency, rate) {
  assertMinor(originalMinor)
  const from = currency(originalCurrency)
  const to = currency(baseCurrency)
  const scaled = parseRate(rate)
  const numerator = multiply(String(originalMinor), String(scaled)) + '0'.repeat(to.decimals)
  return divideRound(numerator, RATE_SCALE * 10 ** from.decimals)
}

function normalizeFx(input, baseCurrency = 'CNY', automaticQuote = null) {
  currency(baseCurrency)
  if (!input.fx) {
    if (baseCurrency !== 'CNY') throw new Error('请更新小程序后按行程币种记账')
    return { amountFen: assertMinor(input.amountFen), baseCurrency, originalCurrency: 'CNY', originalAmountMinor: input.amountFen, fx: { mode: 'same', rate: '1', source: '同币种', rateDate: '', quoteId: '' } }
  }
  const originalCurrency = input.originalCurrency
  currency(originalCurrency)
  const originalAmountMinor = assertMinor(input.originalAmountMinor)
  const mode = input.fx.mode
  let amountFen
  let snapshot
  if (originalCurrency === baseCurrency) {
    amountFen = originalAmountMinor
    snapshot = { mode: 'same', rate: '1', source: '同币种', rateDate: '', quoteId: '' }
  } else if (mode === 'actual') {
    amountFen = assertMinor(input.fx.actualAmountMinor)
    snapshot = { mode, rate: '', source: '手动填写实际扣款', rateDate: '', quoteId: '', actualAmountMinor: amountFen }
  } else if (mode === 'manual') {
    const rate = rateText(parseRate(input.fx.rate))
    amountFen = convertMinor(originalAmountMinor, originalCurrency, baseCurrency, rate)
    snapshot = { mode, rate, source: '手动汇率', rateDate: '', quoteId: '' }
  } else if (mode === 'auto') {
    const q = automaticQuote
    const spentDate = String(input.spentAt || '').slice(0, 10)
    if (!q || q.id !== input.fx.quoteId || q.base !== originalCurrency || q.quote !== baseCurrency || q.requestedDate !== spentDate || q.provider !== 'ECB') throw new Error('汇率报价与币种或消费日期不匹配，请重新获取')
    amountFen = convertMinor(originalAmountMinor, originalCurrency, baseCurrency, q.rate)
    snapshot = { mode, rate: q.rate, source: 'Frankfurter / ECB', rateDate: q.rateDate, requestedDate: q.requestedDate, fetchedAt: q.fetchedAt, quoteId: q.id }
  } else throw new Error('请选择汇率换算方式')
  return { amountFen, baseCurrency, originalCurrency, originalAmountMinor, fx: snapshot }
}

module.exports = { CURRENCIES, MAX_MINOR, RATE_SCALE, currency, assertMinor, parseAmount, amountText, parseRate, rateText, convertMinor, normalizeFx }
