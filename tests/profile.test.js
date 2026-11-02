const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeProfile } = require('../cloudfunctions/api/profile')

test('nickname is sufficient to create a usable profile', () => {
  assert.deepEqual(normalizeProfile({ displayName: '  同行旅伴  ' }), { displayName: '同行旅伴', avatarUrl: '' })
  assert.deepEqual(normalizeProfile({ displayName: '同行旅伴', avatarUrl: '' }), { displayName: '同行旅伴', avatarUrl: '' })
})

test('an existing cloud avatar is preserved', () => {
  const profile = { displayName: '同行旅伴', avatarUrl: 'cloud://environment/avatars/member.jpg' }
  assert.deepEqual(normalizeProfile(profile), profile)
})

test('missing and oversized nicknames are rejected', () => {
  for (const displayName of ['', '   ', '旅'.repeat(31)]) assert.throws(() => normalizeProfile({ displayName }), { code: 'VALIDATION_ERROR' })
})

test('optional avatars still require a valid storage reference', () => {
  for (const avatarUrl of ['https://example.com/avatar.jpg', 'wxfile://avatar.jpg', 'cloud://' + 'a'.repeat(501)]) assert.throws(() => normalizeProfile({ displayName: '同行旅伴', avatarUrl }), { code: 'VALIDATION_ERROR' })
})
