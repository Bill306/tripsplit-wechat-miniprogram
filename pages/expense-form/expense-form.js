const repository = require('../../services/repository')
const { parseYuanToFen } = require('../../domain/money')
const { CATEGORY } = require('../../utils/view')

function requestId() { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` }

Page({
  data: {
    tripId: '', expenseId: '', revision: 0, trip: null, amount: '', payerIndex: 0, participantMemberIds: [], splitMode: 'equal', units: {},
    categories: Object.entries(CATEGORY).map(([value, meta]) => ({ value, ...meta })), category: 'other', note: '', spentAt: '', submitting: false,
  },
  onLoad(options) { this.setData({ tripId: options.tripId, expenseId: options.expenseId || '', spentAt: new Date().toISOString().slice(0, 10) }); this.loadTrip() },
  draftKey() { return `tripsplit.draft.${this.data.tripId}` },
  async loadTrip() {
    try {
      const trip = await repository.getTrip(this.data.tripId)
      const expense = this.data.expenseId ? await repository.getExpense(this.data.expenseId) : null
      const saved = this.data.expenseId ? null : wx.getStorageSync(this.draftKey())
      const participantMemberIds = expense ? Object.keys(expense.shares) : saved && saved.participantMemberIds ? saved.participantMemberIds : trip.members.map((member) => member.id)
      const units = Object.fromEntries(trip.members.map((member) => [member.id, expense && expense.shareUnits && expense.shareUnits[member.id] ? expense.shareUnits[member.id] : saved && saved.units && saved.units[member.id] ? saved.units[member.id] : 1]))
      trip.members = trip.members.map((member) => ({ ...member, selected: participantMemberIds.includes(member.id) }))
      const payerId = expense ? expense.payerMemberId : trip.currentMemberId
      const payerIndex = Math.max(0, trip.members.findIndex((member) => member.id === payerId))
      this.setData({
        trip, participantMemberIds, units, payerIndex, ...(saved || {}),
        ...(expense ? { amount: (expense.amountFen / 100).toFixed(2), splitMode: expense.splitMode, category: expense.category, note: expense.note, spentAt: expense.spentAt.slice(0, 10), revision: expense.revision } : {}),
      })
      if (expense) wx.setNavigationBarTitle({ title: '编辑账单' })
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  persistDraft(next = {}) {
    this.setData(next)
    if (this.data.expenseId) return
    const { amount, payerIndex, participantMemberIds, splitMode, units, category, note, spentAt } = this.data
    wx.setStorageSync(this.draftKey(), { amount, payerIndex, participantMemberIds, splitMode, units, category, note, spentAt })
  },
  updateField(event) { this.persistDraft({ [event.currentTarget.dataset.field]: event.detail.value }) },
  changePayer(event) { this.persistDraft({ payerIndex: Number(event.detail.value) }) },
  changeParticipants(event) {
    const participantMemberIds = event.detail.value
    this.persistDraft({ participantMemberIds, 'trip.members': this.data.trip.members.map((member) => ({ ...member, selected: participantMemberIds.includes(member.id) })) })
  },
  changeSplitMode(event) { this.persistDraft({ splitMode: event.detail.value }) },
  chooseCategory(event) { this.persistDraft({ category: event.currentTarget.dataset.value }) },
  changeUnits(event) { this.persistDraft({ [`units.${event.currentTarget.dataset.id}`]: Number(event.detail.value) }) },
  async submit() {
    let amountFen
    try { amountFen = parseYuanToFen(this.data.amount) } catch (error) { return wx.showToast({ title: error.message, icon: 'none' }) }
    if (!this.data.participantMemberIds.length) return wx.showToast({ title: '至少选择一名参与人', icon: 'none' })
    this.setData({ submitting: true })
    const persistentRequestId = wx.getStorageSync(`${this.draftKey()}.requestId`) || requestId()
    wx.setStorageSync(`${this.draftKey()}.requestId`, persistentRequestId)
    try {
      const payload = {
        tripId: this.data.tripId,
        payerMemberId: this.data.trip.members[this.data.payerIndex].id,
        amountFen,
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
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  },
})
