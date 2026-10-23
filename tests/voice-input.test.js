const test = require('node:test')
const assert = require('node:assert/strict')
const { createVoiceInput } = require('../services/voiceInput')
function harness() {
  const events = []; let timeout; let startArgs
  const manager = { start: (args) => { startArgs = args }, stop() {} }
  const service = createVoiceInput(() => ({ getRecordRecognitionManager: () => manager }), (fn) => { timeout = fn; return 1 }, () => {})
  const handlers = { onResult: (text) => events.push(text), onError: (err) => events.push(err.message), onPartial: (text) => events.push(`partial:${text}`) }
  return { service, manager, events, handlers, timeout: () => timeout(), args: () => startArgs }
}
test('voice input only emits text and uses a bounded recording session', () => {
  const h = harness(); h.service.start(h.handlers)
  assert.deepEqual(h.args(), { lang: 'zh_CN', duration: 30000 })
  h.manager.onRecognize({ result: '午饭' }); h.service.stop()
  h.manager.onStop({ result: '午饭三千日元', tempFilePath: '/private/audio.mp3' })
  assert.deepEqual(h.events, ['partial:午饭', '午饭三千日元'])
})
test('cancelled recordings never populate drafts and cannot overlap', () => {
  const h = harness(); h.service.start(h.handlers); h.service.stop(true)
  assert.throws(() => h.service.start(h.handlers), /上一段/)
  h.manager.onRecognize({ result: 'late' }); h.manager.onStop({ result: 'late' })
  assert.deepEqual(h.events, [])
  h.service.start(h.handlers); h.manager.onStop({ result: 'new' })
  assert.deepEqual(h.events, ['new'])
})
test('timeout quarantines the manager to prevent late transcript attribution', () => {
  const h = harness(); h.service.start(h.handlers); h.timeout()
  h.manager.onStop({ result: 'late' })
  assert.equal(h.events.length, 1)
  assert.match(h.events[0], /超时/)
  assert.throws(() => h.service.start(h.handlers), /未响应/)
})
test('provider errors release recording state without preserving audio paths', () => {
  const h = harness(); h.service.start(h.handlers); h.manager.onError({ retcode: -1 })
  assert.match(h.events[0], /授权/)
  h.service.start(h.handlers); h.manager.onStop({ result: 'ok' })
  assert.equal(h.events[1], 'ok')
})
