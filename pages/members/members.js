const repository = require('../../services/repository')

Page({
  data: { tripId: '', trip: null, newName: '', editingId: '', editingName: '', busy: false },
  onLoad(options) { this.setData({ tripId: options.tripId }) },
  onShow() { if (this.data.tripId) this.load() },
  async load() {
    try {
      const trip = await repository.getTrip(this.data.tripId)
      trip.members = trip.members.map((member) => ({ ...member, initial: member.displayName.slice(0, 1) }))
      this.setData({ trip })
    }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  updateNewName(event) { this.setData({ newName: event.detail.value }) },
  async add() {
    if (!this.data.newName.trim()) return
    this.setData({ busy: true })
    try { await repository.createOfflineMember(this.data.tripId, { displayName: this.data.newName.trim() }); this.setData({ newName: '', busy: false }); await this.load() }
    catch (error) { this.setData({ busy: false }); wx.showToast({ title: error.message, icon: 'none' }) }
  },
  startRename(event) { this.setData({ editingId: event.currentTarget.dataset.id, editingName: event.currentTarget.dataset.name }) },
  updateEditingName(event) { this.setData({ editingName: event.detail.value }) },
  cancelRename() { this.setData({ editingId: '', editingName: '' }) },
  async saveRename() {
    try { await repository.updateOfflineMember({ memberId: this.data.editingId, displayName: this.data.editingName.trim() }); this.cancelRename(); await this.load() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  async deactivate(event) {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '停用该成员？', content: '历史账单会保留，但之后不再默认参与新账单。', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    try { await repository.deactivateMember(event.currentTarget.dataset.id); await this.load() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
