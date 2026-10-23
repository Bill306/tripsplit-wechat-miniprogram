const repository = require('../../services/repository')

Page({
  data: { tripId: '', trip: null, newName: '', editingId: '', editingName: '', busy: false, loading: true, error: '' },
  onLoad(options) { this.setData({ tripId: options.tripId }) },
  onShow() { if (this.data.tripId) this.load() },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const trip = await repository.getTrip(this.data.tripId)
      trip.members = trip.members.map((member) => ({ ...member, initial: member.displayName.slice(0, 1), isCurrent: member.id === trip.currentMemberId }))
      trip.canManage = trip.currentMemberRole === 'owner' && trip.currentMemberStatus === 'active'
      this.setData({ trip })
    }
    catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ loading: false }) }
  },
  updateNewName(event) { this.setData({ newName: event.detail.value }) },
  openInvite() { wx.navigateTo({ url: `/pages/invite/invite?tripId=${this.data.tripId}` }) },
  async chooseAvatar(event) {
    this.setData({ busy: true })
    try { await repository.updateMyAvatar(this.data.tripId, event.detail.avatarUrl); await this.load(); wx.showToast({ title: '头像已更新' }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    finally { this.setData({ busy: false }) }
  },
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
  async remove(event) {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '移除该成员？', content: '仅未关联任何账单的成员可以移除。', confirmColor: '#C24B3A', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    try { await repository.removeMember(event.currentTarget.dataset.id); await this.load() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  async transferOwner(event) {
    const { id, name } = event.currentTarget.dataset
    const confirmed = await new Promise((resolve) => wx.showModal({ title: `转让给 ${name}？`, content: '转让后你将变为普通成员。', confirmColor: '#C24B3A', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    try { await repository.transferOwner({ tripId: this.data.tripId, memberId: id }); wx.showToast({ title: '已转让' }); await this.load() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
