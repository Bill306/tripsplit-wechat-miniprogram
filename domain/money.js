'use strict'

const MAX_AMOUNT_FEN = 99999999

function parseYuanToFen(value) {
  const normalized = String(value == null ? '' : value).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('金额必须是最多两位小数的正数')
  }

  const [yuan, decimal = ''] = normalized.split('.')
  const fen = Number(yuan) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(fen) || fen <= 0 || fen > MAX_AMOUNT_FEN) {
    throw new Error('金额需在 ¥0.01 至 ¥999,999.99 之间')
  }
  return fen
}

function formatFen(value, options = {}) {
  const fen = Number(value)
  if (!Number.isSafeInteger(fen)) {
    throw new Error('金额必须是整数分')
  }

  const sign = fen < 0 ? '-' : ''
  const absolute = Math.abs(fen)
  const yuan = Math.floor(absolute / 100)
  const decimal = String(absolute % 100).padStart(2, '0')
  const integer = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${options.symbol === false ? '' : '¥'}${sign}${integer}.${decimal}`
}

module.exports = {
  MAX_AMOUNT_FEN,
  formatFen,
  parseYuanToFen,
}
