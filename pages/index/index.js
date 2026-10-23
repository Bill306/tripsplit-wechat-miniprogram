const repository = require('../../services/repository')
const { decorateDashboard } = require('../../utils/view')

Page({
  data: { loading: true, trips: [], groups: [], profile: null, error: '', mode: repository.mode, joinCodeOpen: false, inviteCode: '', joining: false },
  onShow() {
    const inviteCode = getApp().globalData.launchInviteCode
    if (inviteCode) return wx.navigateTo({ url: `/pages/join/join?code=${inviteCode}` })
    this.loadTrips()
  },
  async loadTrips() {
    this.setData({ loading: true, error: '' })
    try {
      const profile = await repository.bootstrap()
      if (!profile.profileComplete) return wx.reLaunch({ url: '/pages/profile/profile' })
      const trips = (await repository.listTrips()).map(decorateDashboard)
      const definitions = [
        { key: 'active', title: '进行中', statuses: ['active'] },
        { key: 'pending', title: '待结算', statuses: ['needs_settlement', 'settling'] },
        { key: 'settled', title: '已结算', statuses: ['settled'] },
        { key: 'archived', title: '已归档', statuses: ['archived'] },
      ]
      const groups = definitions.map((group) => ({ ...group, trips: trips.filter((trip) => group.statuses.includes(trip.status)) })).filter((group) => group.trips.length)
      this.setData({ profile, trips, groups, loading: false })
    } catch (error) {
      this.setData({ loading: false, error: error.message })
    }
  },
  createTrip() { wx.navigateTo({ url: '/pages/trip-form/trip-form' }) },
  openJoinCode() { this.setData({ joinCodeOpen: true, error: '' }) },
  closeJoinCode() { this.setData({ joinCodeOpen: false, inviteCode: '' }) },
  updateInviteCode(event) { this.setData({ inviteCode: String(event.detail.value || '').replace(/\D/g, '').slice(0, 6) }) },
  async joinWithCode() {
    if (!/^\d{6}$/.test(this.data.inviteCode)) return wx.showToast({ title: '请输入 6 位匹配码', icon: 'none' })
    this.setData({ joining: true })
    try {
      const invite = await repository.resolveInviteCode(this.data.inviteCode)
      wx.navigateTo({ url: `/pages/join/join?inviteId=${invite.inviteId}` })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.setData({ joining: false })
    }
  },
  openProfile() { wx.navigateTo({ url: '/pages/profile/profile?edit=1' }) },
  openTrip(event) { wx.navigateTo({ url: `/pages/trip/trip?id=${event.currentTarget.dataset.id}` }) },
})
