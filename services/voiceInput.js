'use strict'
const config = require('../config/voice')

// One manager owns the microphone. Never start a second session while an old
// stop callback is pending; an old transcript must not become a new draft.
function createVoiceInput(loadPlugin, schedule = setTimeout, unschedule = clearTimeout) {
  let manager; let active = null; let timer; let quarantined = false
  function finish(error, text) {
    const session = active
    active = null; unschedule(timer)
    if (!session || session.cancelled) return
    if (error) session.onError(error)
    else session.onResult(String(text || '').trim())
  }
  return {
    start(handlers) {
      if (quarantined) throw new Error('录音服务未响应，请重新进入小程序或使用文字输入')
      if (active) throw new Error('上一段录音仍在结束，请稍后再试')
      if (!manager) {
        manager = loadPlugin().getRecordRecognitionManager()
        manager.onStop = (res) => finish(null, res.result)
        manager.onError = () => finish(new Error('录音或识别失败，请检查麦克风授权，也可使用文字输入'))
        manager.onRecognize = (res) => { if (active && !active.cancelled && active.onPartial) active.onPartial(String(res.result || '')) }
      }
      active = { ...handlers, cancelled: false, stopping: false }
      // On a missing final callback, block further sessions instead of risking
      // a late result being attributed to the next recording.
      timer = schedule(() => {
        quarantined = true
        try { manager.stop() } catch (_) {}
        finish(new Error('语音识别超时，请使用文字输入'))
      }, 45000)
      try { manager.start({ lang: 'zh_CN', duration: 30000 }) }
      catch (error) { finish(new Error('无法启动录音，请检查麦克风权限')) }
    },
    stop(cancelled = false) {
      if (!active) return
      active.cancelled = active.cancelled || cancelled
      if (active.stopping) return
      active.stopping = true
      try { manager.stop() } catch (_) { finish(new Error('录音结束失败，请重试')) }
    },
  }
}
const singleton = createVoiceInput(() => {
  if (!config.enabled) throw new Error('语音服务尚未启用，可先输入一句话生成草稿')
  return requirePlugin(config.pluginName)
})
module.exports = { createVoiceInput, start: (handlers) => singleton.start(handlers), stop: (cancelled) => singleton.stop(cancelled) }
