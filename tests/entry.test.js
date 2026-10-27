const test = require('node:test')
const assert = require('node:assert/strict')
const { parseInviteCode, profileDestination } = require('../domain/entry')

test('invitation codes accept plain and encoded scene values', () => {
  for (const value of ['123456', 'code=123456', 'code%3D123456']) assert.equal(parseInviteCode(value), '123456')
})

test('invalid invitation values cannot be truncated into another code', () => {
  for (const value of ['%', '%E0%A4%A', '1234567', 'a123456', '12345', '', '123 456']) assert.throws(() => parseInviteCode(value))
})

test('profile destination retains invitation context', () => {
  assert.equal(profileDestination('', '123456'), '/pages/join/join?code=123456')
  assert.equal(profileDestination('', 'code=123456'), '/pages/join/join?code=code%3D123456')
  assert.equal(profileDestination('', ''), '/pages/index/index')
  const target = '/pages/join/join?inviteId=example'
  assert.equal(profileDestination(encodeURIComponent(target), ''), target)
  assert.equal(profileDestination(encodeURIComponent('/pages/trip-form/trip-form'), ''), '/pages/trip-form/trip-form')
})

test('profile destination rejects malformed and unregistered pages', () => {
  for (const target of ['%', 'https://example.com', '//example.com', '/pages/missing/missing']) assert.throws(() => profileDestination(target, ''))
})
