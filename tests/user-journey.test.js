'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const money = require('../domain/currency')

function pageAt(name, repository, wxOverrides = {}) {
  let definition
  const calls = []
  const app = { globalData: {} }
  const wx = { showToast: (v) => calls.push(['toast', v]), showLoading() {}, hideLoading() {}, showShareMenu() {}, hideShareMenu() {}, setNavigationBarTitle() {},
    reLaunch: (v) => calls.push(['reLaunch', v]), redirectTo: (v) => calls.push(['redirectTo', v]),
    showModal: (v) => { calls.push(['modal', v]); v.success({ confirm: false }) }, ...wxOverrides }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.js`), 'utf8'), {
    require: (id) => id.includes('repository') ? repository : money,
    Page: (v) => { definition = v }, wx, getApp: () => app, getCurrentPages: () => [],
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), calls, app }
  page.setData = (v) => Object.assign(page.data, v)
  return page
}
function settlement(status = 'pending', currentMemberId = 'a') {
  return { id: 's', status: 'active', baseCurrency: 'CNY', currentMemberId, currentMemberRole: 'member', currentMemberStatus: 'active', ledgerRevision: 1,
    summary: [{ memberId: 'a', displayName: '旅伴A', netAmount: -8000 }, { memberId: 'b', displayName: '旅伴B', netAmount: 8000 }],
    transfers: [{ id: 'x', fromMemberId: 'a', toMemberId: 'b', fromName: '旅伴A', toName: '旅伴B', amountFen: 8000, status }] }
}
const action = (status) => ({ currentTarget: { dataset: { id: 'x', status } } })

test('settlement highlights only the current user and separates pending payment from receipt', async () => {
  const page = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement() })
  await page.load()
  assert.equal(page.data.settlement.myPayText, 'CNY 80.00')
  assert.equal(page.data.settlement.myReceiveText, 'CNY 0.00')
  assert.equal(page.data.settlement.transfers[0].canMarkPaid, true)
  assert.equal(page.data.settlement.transfers[0].canConfirmReceived, false)
  assert.match(page.data.settlement.nextAction, /先到微信/)
})
test('canceling payment confirmation never changes cloud status', async () => {
  const page = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement(), updateTransferStatus: () => assert.fail('no write on cancel') })
  await page.load()
  await page.updateStatus(action('paid'))
  assert.equal(page.calls.filter(([name]) => name === 'modal').length, 1)
  assert.equal(page.data.busyId, '')
  assert.equal(page.data.settlement.transfers[0].status, 'pending')
})
test('confirmed payment updates once and shows waiting for the recipient', async () => {
  let count = 0
  const page = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement(), updateTransferStatus: async () => { count++; return settlement('paid') } }, { showModal: (v) => v.success({ confirm: true }) })
  await page.load()
  await page.updateStatus(action('paid'))
  await page.updateStatus(action('paid'))
  assert.equal(count, 1)
  assert.match(page.data.settlement.nextAction, /等待对方/)
  assert.equal(page.data.settlement.myPayText, 'CNY 0.00')
})
test('recipient must verify receipt and unrelated user cannot confirm', async () => {
  let count = 0
  const page = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement('paid', 'b'), updateTransferStatus: async () => { count++; return { ...settlement('received', 'b'), status: 'completed' } } }, { showModal: (v) => v.success({ confirm: true }) })
  await page.load()
  assert.match(page.data.settlement.nextAction, /检查微信或银行是否到账/)
  await page.updateStatus(action('received'))
  assert.equal(count, 1)
  assert.equal(page.data.settlement.receivedCount, 1)
  assert.equal(page.data.settlement.myReceiveText, 'CNY 0.00')
  const outsider = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement('paid', 'c'), updateTransferStatus: () => assert.fail('not recipient') })
  await outsider.load()
  await outsider.updateStatus(action('received'))
  assert.equal(outsider.calls.length, 0)
})
test('settlement errors remain visible and failed updates release the busy state', async () => {
  const page = pageAt('settlement', { mode: 'cloud', getSettlement: async () => { throw new Error('连接失败') } })
  await page.load()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.error, '连接失败')
  const update = pageAt('settlement', { mode: 'cloud', getSettlement: async () => settlement(), updateTransferStatus: async () => { throw new Error('保存失败') } }, { showModal: (v) => v.success({ confirm: true }) })
  await update.load()
  await update.updateStatus(action('paid'))
  assert.equal(update.data.busyId, '')
  assert.equal(update.data.settlement.transfers[0].status, 'pending')
})
test('opening invitations is read-only and preserves the complete share path', async () => {
  const page = pageAt('invite', { getTrip: async () => ({ name: '京都', currentMemberRole: 'owner', currentMemberStatus: 'active', status: 'active' }), getActiveInvite: async () => ({ inviteId: 'i', inviteCode: '123456', path: '/pages/join/join?code=123456' }), createInvite: () => assert.fail('must require button click') })
  await page.load()
  assert.equal(page.data.canInvite, true)
  assert.equal(page.onShareAppMessage().path, '/pages/join/join?code=123456')
})
test('ordinary members cannot create invitations through the new screen', async () => {
  const page = pageAt('invite', { getTrip: async () => ({ currentMemberRole: 'member', currentMemberStatus: 'active', status: 'active' }), getActiveInvite: () => assert.fail('owner only'), createInvite: () => assert.fail('owner only') })
  await page.load()
  await page.create()
  assert.equal(page.data.canInvite, false)
  assert.equal(page.onShareAppMessage().path, '/pages/index/index')
})
test('QR uses the current WeChat build channel and reports missing QR data', async () => {
  const page = pageAt('invite', { getInviteQr: async (id, env) => { assert.equal(id, 'i'); assert.equal(env, 'trial'); return { tempFileURL: 'https://example.test/qr.png' } } }, { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) })
  page.setData({ invite: { inviteId: 'i' } })
  await page.showQr()
  assert.equal(page.data.qrUrl, 'https://example.test/qr.png')
  assert.equal(page.data.qrLoading, false)
  const bad = pageAt('invite', { getInviteQr: async () => ({}) })
  bad.setData({ invite: { inviteId: 'i' } })
  await bad.showQr()
  assert.match(bad.data.error, /二维码暂未生成/)
  assert.equal(bad.data.qrLoading, false)
})
test('canceling invitation revocation preserves the existing code', async () => {
  const page = pageAt('invite', { revokeInvite: () => assert.fail('do not revoke on cancel') })
  page.setData({ canInvite: true, invite: { inviteId: 'i', inviteCode: '123456' } })
  await page.revoke()
  assert.equal(page.data.invite.inviteCode, '123456')
  assert.equal(page.data.busy, false)
})
test('login keeps existing sessions and restores the invitation destination', async () => {
  const page = pageAt('profile', { bootstrap: async () => ({ profileComplete: true }) })
  page.app.globalData.launchInviteCode = '123456'
  await page.onLoad({})
  assert.equal(page.calls[0][1].url, '/pages/join/join?code=123456')
})
test('first-time login shows the profile form; failed identity connection can retry', async () => {
  let attempt = 0
  const page = pageAt('profile', { bootstrap: async () => { if (!attempt++) throw new Error('离线'); return { profileComplete: false, displayName: '' } } })
  await page.onLoad({})
  assert.equal(page.data.ready, false)
  assert.equal(page.data.loading, false)
  await page.retry()
  assert.equal(page.data.ready, true)
  assert.equal(page.data.error, '')
  assert.equal(page.calls.length, 0)
})
test('all registered user screens exist and all detail screens have a home exit', () => {
  const config = require('../app.json')
  assert.equal(config.pages.length, 10)
  for (const route of config.pages) {
    for (const suffix of ['.js', '.wxml', '.wxss', '.json']) assert.ok(fs.existsSync(path.join(__dirname, '..', route + suffix)), route + suffix)
    if (route !== 'pages/index/index') assert.match(fs.readFileSync(path.join(__dirname, '..', route + '.wxml'), 'utf8'), /<journey-nav /)
  }
})
