'use strict'

function decodeEntry(value, message) {
  try { return decodeURIComponent(value) }
  catch (error) {
    if (error instanceof URIError) throw new Error(message)
    throw error
  }
}

function parseInviteCode(value) {
  const code = decodeEntry(String(value), '邀请参数格式不正确，请重新打开邀请').replace(/^code=/, '')
  if (!/^\d{6}$/.test(code)) throw new Error('匹配码需为 6 位数字')
  return code
}

function profileDestination(redirect, inviteCode) {
  if (redirect) {
    const target = decodeEntry(redirect, '登录返回地址格式不正确，请返回首页')
    const page = target.split('?')[0]
    if (!['/pages/index/index', '/pages/join/join', '/pages/trip-form/trip-form'].includes(page)) throw new Error('登录返回地址无效，请返回首页')
    return target
  }
  return inviteCode ? `/pages/join/join?code=${encodeURIComponent(inviteCode)}` : '/pages/index/index'
}

module.exports = { parseInviteCode, profileDestination }
