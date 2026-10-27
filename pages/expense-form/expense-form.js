const repository = require('../../services/repository')
const money = require('../../domain/currency')
const { parseVoiceExpense } = require('../../domain/voiceExpense')
const { restoreDraftMembers } = require('../../domain/draft')
const voiceInput = require('../../services/voiceInput')
const voiceConfig = require('../../config/voice')
const { CATEGORY } = require('../../utils/view')

function requestId() { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` }
function localDate() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }

Page({
  data: {
    tripId: '', expenseId: '', revision: 0, trip: null, loading: true, error: '', draftNotice: '', amount: '', payerIndex: 0, participantMemberIds: [], splitMode: 'equal', units: {},
    categories: Object.entries(CATEGORY).map(([value, meta]) => ({ value, ...meta })), category: 'other', note: '', spentAt: '', submitting: false,
    currencies: money.CURRENCIES, currencyIndex: 0, originalCurrency: 'CNY', baseCurrency: 'CNY',
    fxMode: 'auto', fxRate: '', actualAmount: '', fxQuote: null, fxLoading: false, fxError: '', convertedText: '',
    voiceEnabled: voiceConfig.enabled, voiceExpanded: false, voiceState: 'idle', voiceText: '', voiceError: '', voiceDraft: null, voiceCancel: false, voiceApplying: false,
  },
  onLoad(options = {}) { this.setData({ tripId: options.tripId || '', expenseId: options.expenseId || '', spentAt: localDate() }); this.loadTrip() },
  draftKey() { return `tripsplit.draft.${this.data.tripId}` },
  toggleVoice() { if (this.data.voiceState === 'idle' && !this.data.voiceApplying) this.setData({ voiceExpanded: !this.data.voiceExpanded }) },
  async loadTrip() {
    if (!this.data.tripId) return this.setData({ loading: false, error: '行程链接不完整，请返回首页重新打开' })
    this.setData({ loading: true, error: '', trip: null })
    try {
      const trip = await repository.getTrip(this.data.tripId)
      if (trip.status === 'archived') throw new Error('行程已归档，请恢复行程后记账')
      if (trip.currentMemberStatus !== 'active') throw new Error('你当前只能查看这个行程的账单')
      const expense = this.data.expenseId ? await repository.getExpense(this.data.expenseId) : null
      if (expense && !expense.canEdit) throw new Error('这笔账单当前只允许查看')
      const historicalMemberIds = new Set(expense ? [expense.payerMemberId, ...Object.keys(expense.shares)] : [])
      trip.members = trip.members.filter((member) => member.status === 'active' || historicalMemberIds.has(member.id)).map((member) => ({ ...member, displayLabel: member.status === 'inactive' ? `${member.displayName}（已停用）` : member.displayName }))
      const saved = this.data.expenseId ? null : wx.getStorageSync(this.draftKey())
      const draftMembers = restoreDraftMembers(trip.members, trip.currentMemberId, saved || {})
      const participantMemberIds = expense ? Object.keys(expense.shares) : draftMembers.participantMemberIds
      const units = expense ? Object.fromEntries(trip.members.map((member) => [member.id, expense.shareUnits && expense.shareUnits[member.id] ? expense.shareUnits[member.id] : 1])) : draftMembers.units
      trip.members = trip.members.map((member) => ({ ...member, selected: participantMemberIds.includes(member.id) }))
      const payerId = expense ? expense.payerMemberId : trip.currentMemberId
      const payerIndex = expense ? Math.max(0, trip.members.findIndex((member) => member.id === payerId)) : draftMembers.payerIndex
      this.setData({
        ...(saved || {}), trip, participantMemberIds, units, payerIndex, draftNotice: expense ? '' : draftMembers.draftNotice,
        ...(expense ? { amount: money.amountText(expense.originalAmountMinor || expense.amountFen, expense.originalCurrency || 'CNY', false), splitMode: expense.splitMode, category: expense.category, note: expense.note, spentAt: expense.spentAt.slice(0, 10), revision: expense.revision } : {}),
      })
      const baseCurrency = trip.baseCurrency || 'CNY'
      const originalCurrency = expense ? expense.originalCurrency || 'CNY' : saved && saved.originalCurrency || baseCurrency
      const fx = expense && expense.fx
      const fxQuote = fx && fx.mode === 'auto' ? { id: fx.quoteId, base: originalCurrency, quote: baseCurrency, rate: fx.rate, rateDate: fx.rateDate, requestedDate: fx.requestedDate, fetchedAt: fx.fetchedAt, provider: 'ECB' } : saved && saved.fxQuote || null
      this.setData({ baseCurrency, originalCurrency, currencyIndex: Math.max(0, money.CURRENCIES.findIndex((item) => item.code === originalCurrency)),
        fxMode: fx && fx.mode !== 'same' ? fx.mode : saved && saved.fxMode || 'auto', fxRate: fx && fx.rate || saved && saved.fxRate || '',
        actualAmount: fx && fx.mode === 'actual' ? money.amountText(expense.amountFen, baseCurrency, false) : saved && saved.actualAmount || '',
        fxQuote, fxError: '', fxLoading: false,
      })
      this.updateConversion()
      if (originalCurrency !== baseCurrency && this.data.fxMode === 'auto' && !this.quoteMatches()) this.refreshQuote()
      if (expense) wx.setNavigationBarTitle({ title: '编辑账单' })
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ loading: false }) }
  },
  persistDraft(next = {}) {
    if (this.data.submitting) return
    this.setData(next)
    this.updateConversion()
    if (this.data.expenseId) return
    const { amount, payerIndex, participantMemberIds, splitMode, units, category, note, spentAt, originalCurrency, fxMode, fxRate, actualAmount, fxQuote } = this.data
    const payerMemberId = this.data.trip && this.data.trip.members[payerIndex] && this.data.trip.members[payerIndex].id
    wx.setStorageSync(this.draftKey(), { amount, payerIndex, payerMemberId, participantMemberIds, splitMode, units, category, note, spentAt, originalCurrency, fxMode, fxRate, actualAmount, fxQuote })
  },
  updateField(event) {
    const field = event.currentTarget.dataset.field
    this.persistDraft({ [field]: event.detail.value, ...(field === 'spentAt' ? { fxQuote: null } : {}) })
    if (field === 'spentAt') this.refreshQuote()
  },
  changeCurrency(event) {
    if (this.data.submitting) return
    const currencyIndex = Number(event.detail.value)
    this.persistDraft({ currencyIndex, originalCurrency: money.CURRENCIES[currencyIndex].code, fxQuote: null, fxRate: '', actualAmount: '', fxError: '' })
    this.refreshQuote()
  },
  changeFxMode(event) {
    if (this.data.submitting) return
    this.persistDraft({ fxMode: event.detail.value, fxError: '' })
    this.refreshQuote()
  },
  quoteMatches() {
    const q = this.data.fxQuote
    return q && q.base === this.data.originalCurrency && q.quote === this.data.baseCurrency && q.requestedDate === this.data.spentAt
  },
  async refreshQuote() {
    const requestNo = this.fxRequestNo = (this.fxRequestNo || 0) + 1
    this.setData({ fxLoading: false })
    if (this.data.originalCurrency === this.data.baseCurrency || this.data.fxMode !== 'auto') return
    this.setData({ fxLoading: true, fxError: '', fxQuote: null })
    this.updateConversion()
    try {
      const quote = await repository.getFxQuote({ tripId: this.data.tripId, currency: this.data.originalCurrency, date: this.data.spentAt })
      if (requestNo !== this.fxRequestNo) return
      this.setData({ fxLoading: false })
      this.persistDraft({ fxQuote: quote, fxRate: quote.rate })
    } catch (error) {
      if (requestNo !== this.fxRequestNo) return
      this.setData({ fxLoading: false, fxError: error.message || '汇率获取失败，请重试或手动填写' })
    }
  },
  moneyInput() {
    const { originalCurrency, baseCurrency, amount, fxMode, fxRate, actualAmount, spentAt } = this.data
    const originalAmountMinor = money.parseAmount(amount, originalCurrency)
    const fx = originalCurrency === baseCurrency ? { mode: 'same' }
      : fxMode === 'actual' ? { mode: 'actual', actualAmountMinor: money.parseAmount(actualAmount, baseCurrency) }
        : fxMode === 'manual' ? { mode: 'manual', rate: fxRate }
          : { mode: 'auto', quoteId: this.quoteMatches() ? this.data.fxQuote.id : '' }
    const input = { originalCurrency, originalAmountMinor, fx, spentAt: `${spentAt}T12:00:00.000Z` }
    return { ...input, amountFen: money.normalizeFx(input, baseCurrency, this.data.fxQuote).amountFen }
  },
  updateConversion() {
    try { this.setData({ convertedText: money.amountText(this.moneyInput().amountFen, this.data.baseCurrency) }) }
    catch (_) { this.setData({ convertedText: '' }) }
  },
  onHide() { this.cancelVoice() },
  onUnload() { this.fxRequestNo = (this.fxRequestNo || 0) + 1; this.voiceDisposed = true; this.cancelVoice() },
  startVoice(event) {
    if (this.data.submitting || this.data.voiceApplying || this.data.voiceState !== 'idle') return
    if (!this.data.voiceEnabled) return this.setData({ voiceError: '语音服务尚未启用，可先输入一句话生成草稿' })
    this.voiceStartY = event.touches && event.touches[0] && event.touches[0].clientY
    this.setData({ voiceState: 'recording', voiceCancel: false, voiceError: '' })
    try {
      voiceInput.start({
        onPartial: (text) => { if (!this.voiceDisposed) this.setData({ voiceText: text, voiceDraft: null }) },
        onResult: (text) => {
          if (this.voiceDisposed) return
          this.setData({ voiceState: 'idle', voiceText: text, voiceDraft: null, voiceError: text ? '' : '没有听清，请重试或输入一句话' })
          if (text) this.previewVoice()
        },
        onError: (error) => { if (!this.voiceDisposed) this.setData({ voiceState: 'idle', voiceError: error.message }) },
      })
    } catch (error) { this.setData({ voiceState: 'idle', voiceError: error.message }) }
  },
  moveVoice(event) {
    if (this.data.voiceState !== 'recording') return
    const y = event.touches && event.touches[0] && event.touches[0].clientY
    this.setData({ voiceCancel: Number.isFinite(y) && y < this.voiceStartY - 60 })
  },
  endVoice() {
    if (this.data.voiceState !== 'recording') return
    if (this.data.voiceCancel) return this.cancelVoice()
    this.setData({ voiceState: 'recognizing' }); voiceInput.stop()
  },
  cancelVoice() {
    if (this.data.voiceState === 'idle') return
    voiceInput.stop(true)
    if (!this.voiceDisposed) this.setData({ voiceState: 'idle', voiceCancel: false, voiceDraft: null })
  },
  editVoiceText(event) { if (this.data.voiceState === 'idle' && !this.data.submitting) this.setData({ voiceText: event.detail.value, voiceDraft: null, voiceError: '' }) },
  previewVoice() {
    if (this.data.submitting || this.data.voiceState !== 'idle') return
    const draft = parseVoiceExpense(this.data.voiceText, localDate())
    this.setData({ voiceDraft: { ...draft, categoryLabel: CATEGORY[draft.category].label }, voiceError: '' })
  },
  async applyVoice() {
    if (this.data.submitting || this.data.voiceApplying || this.data.voiceState !== 'idle' || !this.data.voiceDraft || !this.data.voiceDraft.ready) return
    const draft = this.data.voiceDraft
    this.setData({ voiceApplying: true })
    try {
      if (this.data.amount || this.data.note) {
        const answer = await new Promise((resolve) => wx.showModal({ title: '替换当前草稿？', content: '将替换金额、币种、分类和备注；付款人、分摊成员保持不变。尚未保存账单。', success: resolve, fail: () => resolve({ confirm: false }) }))
        if (!answer.confirm || this.voiceDisposed) return
      }
      this.persistDraft({ amount: draft.amount, originalCurrency: draft.originalCurrency, currencyIndex: money.CURRENCIES.findIndex((c) => c.code === draft.originalCurrency), category: draft.category, note: draft.note, spentAt: draft.spentAt || this.data.spentAt, fxMode: 'auto', fxQuote: null, fxRate: '', actualAmount: '', fxError: '', voiceDraft: null })
      this.refreshQuote()
      wx.showToast({ title: '已填入，请核对后确认记账', icon: 'none' })
    } finally { if (!this.voiceDisposed) this.setData({ voiceApplying: false }) }
  },
  changePayer(event) { this.persistDraft({ payerIndex: Number(event.detail.value) }) },
  changeParticipants(event) {
    const participantMemberIds = event.detail.value
    this.persistDraft({ participantMemberIds, 'trip.members': this.data.trip.members.map((member) => ({ ...member, selected: participantMemberIds.includes(member.id) })) })
  },
  changeSplitMode(event) { this.persistDraft({ splitMode: event.detail.value }) },
  chooseCategory(event) { this.persistDraft({ category: event.currentTarget.dataset.value }) },
  changeUnits(event) { this.persistDraft({ [`units.${event.currentTarget.dataset.id}`]: Number(event.detail.value) }) },
  async submit() {
    if (this.data.submitting || this.data.fxLoading || this.data.voiceApplying || this.data.voiceState !== 'idle' || !this.data.trip) return
    let monetary
    try { monetary = this.moneyInput() } catch (error) { return wx.showToast({ title: error.message, icon: 'none' }) }
    if (!this.data.participantMemberIds.length) return wx.showToast({ title: '至少选择一名参与人', icon: 'none' })
    this.setData({ submitting: true })
    const persistentRequestId = wx.getStorageSync(`${this.draftKey()}.requestId`) || requestId()
    wx.setStorageSync(`${this.draftKey()}.requestId`, persistentRequestId)
    try {
      const payload = {
        tripId: this.data.tripId,
        payerMemberId: this.data.trip.members[this.data.payerIndex].id,
        ...monetary,
        participantMemberIds: this.data.participantMemberIds,
        splitMode: this.data.splitMode,
        units: this.data.units,
        category: this.data.category,
        note: this.data.note.trim(),
        spentAt: `${this.data.spentAt}T12:00:00.000Z`,
        clientRequestId: persistentRequestId,
      }
      if (this.data.expenseId) await repository.updateExpense({ ...payload, expenseId: this.data.expenseId, expectedRevision: this.data.revision })
      else await repository.createExpense(payload)
      if (!this.data.expenseId) {
        wx.removeStorageSync(this.draftKey())
        wx.removeStorageSync(`${this.draftKey()}.requestId`)
      }
      wx.navigateBack()
    } catch (error) {
      if (error.code === 'REVISION_CONFLICT') {
        const result = await new Promise((resolve) => wx.showModal({ title: '账单已被别人修改', content: '重新载入最新版本后再编辑，当前未提交内容不会覆盖云端账单。', confirmText: '重新载入', cancelText: '先保留', success: resolve }))
        if (result.confirm) await this.loadTrip()
      } else wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  },
})
