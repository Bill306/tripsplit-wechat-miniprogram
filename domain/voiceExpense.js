'use strict'
const money = require('./currency')

const ALIASES = {
  CNY: ['人民币', '元人民币', '块钱', '元', '块', 'CNY', 'RMB'],
  HKD: ['港币', '港元', 'HKD'], USD: ['美元', '美金', 'USD'], EUR: ['欧元', 'EUR'],
  JPY: ['日元', '日币', '日圆', 'JPY'], GBP: ['英镑', 'GBP'], AUD: ['澳元', '澳币', 'AUD'],
  CAD: ['加元', '加币', 'CAD'], SGD: ['新加坡元', '新币', 'SGD'], THB: ['泰铢', 'THB'],
  KRW: ['韩元', '韩币', 'KRW'], CHF: ['瑞士法郎', '瑞郎', 'CHF'],
}
const aliasCode = Object.fromEntries(Object.entries(ALIASES).flatMap(([code, names]) => names.map((name) => [name, code])))
const currencyPattern = Object.keys(aliasCode).sort((a, b) => b.length - a.length).join('|')
const numberPattern = '(?:[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二两三四五六七八九]+)?)'
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function numberText(raw) {
  if (/^[\d,.]+$/.test(raw)) {
    if (raw.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) throw new Error('金额千位分隔不明确')
    return raw.replace(/,/g, '')
  }
  const parts = raw.split('点')
  const integer = parts[0]
  if (!/[十百千万]/.test(integer)) return integer.split('').map((c) => digits[c]).join('') + (parts[1] ? `.${parts[1].split('').map((c) => digits[c]).join('')}` : '')
  // Reject colloquial trailing digits such as 三千五 (3500 or 3005).
  if (/[百千万][一二两三四五六七八九]$/.test(integer)) throw new Error('请把金额说完整，例如三千五百')
  let total = 0; let section = 0; let pending = null; let lastUnit = 10000; let usedWan = false
  for (const char of integer) {
    if (Object.prototype.hasOwnProperty.call(digits, char)) {
      if (pending !== null && pending !== 0) throw new Error('金额数词不明确')
      pending = digits[char]
    } else if (char === '万') {
      if (usedWan || section + (pending || 0) === 0) throw new Error('金额数词不明确')
      total = (section + (pending || 0)) * 10000; section = 0; pending = null; lastUnit = 10000; usedWan = true
    } else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[char]
      if (!unit || unit >= lastUnit || pending === 0 || (pending === null && (unit !== 10 || section !== 0))) throw new Error('金额数词不明确')
      section += (pending === null ? 1 : pending) * unit; pending = null; lastUnit = unit
    }
  }
  return String(total + section + (pending || 0)) + (parts[1] ? `.${parts[1].split('').map((c) => digits[c]).join('')}` : '')
}

function parseVoiceExpense(value, today) {
  const text = String(value || '').trim().replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296)).replace(/．/g, '.')
  const issues = []; const warnings = []
  const result = { text, amount: '', originalCurrency: '', category: 'other', note: text.slice(0, 100), spentAt: '', issues, warnings, ready: false }
  if (!text || text.length > 300) { issues.push('请描述一笔花销，最多 300 字'); return result }
  if (/退款|退了|退回|退货|收入|返现|负|减去|找零|找回|[-−]\s*\d/.test(text)) issues.push('暂时只能识别支出金额，请填写扣除退款或找零后的实际花费')
  if (/大约|大概|左右|多[元块]|几|几十|几百|上千|不到|差不多|至少|最多|至|到\s*\d|[~～]/.test(text)) issues.push('请说出准确金额，例如“花了 200 元”')
  const monetary = new RegExp(`(${numberPattern})\\s*(${currencyPattern})|(${currencyPattern})\\s*(${numberPattern})`, 'gi')
  const found = [...text.matchAll(monetary)]
  const mentionedCodes = [...text.matchAll(new RegExp(currencyPattern, 'gi'))].map((m) => aliasCode[m[0].toUpperCase()] || aliasCode[m[0]])
  if (!mentionedCodes.length) issues.push('请明确币种，例如“3000 日元”或“200 人民币”')
  if (new Set(mentionedCodes).size > 1) issues.push('一次只能识别一种货币，请分开记录')
  if (found.length !== 1) issues.push(found.length > 1 ? '出现多个金额，请一次只说一笔消费' : '未识别到明确的金额与币种')
  if (found.length === 1) {
    const match = found[0]
    const raw = match[1] || match[4]; const name = match[2] || match[3]
    result.originalCurrency = aliasCode[name.toUpperCase()] || aliasCode[name]
    // Do not silently ignore more numbers (e.g. 300、200 日元 or 3 人每人 100 元).
    const rest = text.slice(0, match.index) + text.slice(match.index + match[0].length)
    if (/\d|[零〇一二两三四五六七八九十百千万]/.test(rest.replace(/一共|一起|前天|昨天|今天/g, ''))) issues.push('这句话里还有其他数字，请直接填写这笔消费的总金额')
    try { result.amount = money.amountText(money.parseAmount(numberText(raw), result.originalCurrency), result.originalCurrency, false) }
    catch (error) { issues.push(error.message) }
  }
  const categories = [
    ['food', /吃饭|午饭|午餐|晚饭|晚餐|早饭|早餐|餐饮|餐厅|咖啡|奶茶|火锅|拉面/],
    ['transport', /打车|出租车|地铁|火车|飞机|机票|车票|租车|汽油|加油|公交/],
    ['stay', /住宿|酒店|民宿|房费/], ['ticket', /门票|景点|博物馆/], ['shopping', /购物|买衣服|纪念品|超市/],
  ].filter(([, pattern]) => pattern.test(text))
  if (categories.length === 1) result.category = categories[0][0]
  else warnings.push(categories.length ? '无法确定分类，已选“其他”，可以修改' : '没有识别出分类，已选“其他”，可以修改')
  const dateWords = ['今天', '昨天', '前天'].filter((word) => text.includes(word))
  if (dateWords.length > 1 || /明天|后天|上周|上个|上月|\d+[年月日号]|[一二三四五六七八九十]+[年月日号]/.test(text)) {
    warnings.push('请在下方核对消费日期')
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(today || '')) {
    const offset = dateWords[0] === '昨天' ? 1 : dateWords[0] === '前天' ? 2 : 0
    const date = new Date(`${today}T12:00:00Z`)
    if (Number.isFinite(date.getTime())) { date.setUTCDate(date.getUTCDate() - offset); result.spentAt = date.toISOString().slice(0, 10) }
    if (!dateWords.length) warnings.push('未说日期，暂按今天填写')
  }
  warnings.push('请核对下方的付款人和分摊成员')
  result.ready = issues.length === 0
  return result
}

module.exports = { parseVoiceExpense, numberText }
