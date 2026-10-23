'use strict'
const https = require('https')
const { currency, parseRate, rateText } = require('./currency')

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function validateRequest(base, quote, date) {
  currency(base); currency(quote)
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  if (!validDate(date) || date < '1999-01-04' || date > today) throw new Error('自动汇率日期需在 1999-01-04 至今天之间')
  if (base === quote) throw new Error('相同币种无需查询汇率')
}

function readJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/json' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 16384) request.destroy(new Error('汇率响应过大'))
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`汇率服务暂不可用 (${response.statusCode})`))
        try { resolve(JSON.parse(body)) } catch (_) { reject(new Error('汇率服务响应不合法')) }
      })
    })
    const timeout = setTimeout(() => request.destroy(new Error('获取汇率超时，请重试或选择手动汇率')), 8000)
    request.on('error', reject)
    request.on('close', () => clearTimeout(timeout))
  })
}

function validateResponse(data, base, quote, requestedDate) {
  if (!data || data.base !== base || data.quote !== quote || !validDate(data.date) || data.date > requestedDate || !Number.isFinite(data.rate) || data.rate <= 0 || data.rate > 100000) throw new Error('汇率数据与请求不匹配')
  // Never silently use a very old quote when the provider has no recent data.
  if (Date.parse(`${requestedDate}T00:00:00Z`) - Date.parse(`${data.date}T00:00:00Z`) > 7 * 86400000) throw new Error('没有近期参考汇率，请填写手动汇率或实际扣款')
  return { base, quote, requestedDate, rateDate: data.date, rate: rateText(parseRate(data.rate.toFixed(8))), provider: 'ECB', source: 'Frankfurter / ECB', fetchedAt: new Date().toISOString() }
}

async function fetchRate(base, quote, date) {
  validateRequest(base, quote, date)
  const url = `https://api.frankfurter.dev/v2/providers/ecb/rate/${base.toLowerCase()}/${quote.toLowerCase()}?date=${date}`
  return validateResponse(await readJson(url), base, quote, date)
}

module.exports = { fetchRate, validateRequest, validateResponse }
