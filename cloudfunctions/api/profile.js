'use strict'

function normalizeProfile(input) {
  const displayName = String(input.displayName || '').trim()
  const avatarUrl = String(input.avatarUrl || '')
  const message = !displayName || displayName.length > 30 ? '昵称需为 1 至 30 字'
    : avatarUrl && (!avatarUrl.startsWith('cloud://') || avatarUrl.length > 500) ? '请选择有效的微信头像' : ''
  if (message) {
    const error = new Error(message)
    error.code = 'VALIDATION_ERROR'
    throw error
  }
  return { displayName, avatarUrl }
}

module.exports = { normalizeProfile }
