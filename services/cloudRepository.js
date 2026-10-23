'use strict'

function call(action, payload = {}) {
  return wx.cloud.callFunction({ name: 'api', data: { action, payload } }).then(({ result }) => {
    if (!result || result.ok !== true) {
      const error = new Error((result && result.error && result.error.message) || '云端请求失败')
      error.code = result && result.error && result.error.code
      error.details = result && result.error && result.error.details
      throw error
    }
    return result.data
  })
}

function uploadAvatar(tempFilePath) {
  const suffix = String(tempFilePath || '').match(/\.(png|jpe?g|webp)$/i)
  const extension = suffix ? suffix[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
  const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`
  return wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath }).then(({ fileID }) => fileID)
}

module.exports = {
  getFxQuote: (input) => call('fx.quote', input),
  bootstrap: () => call('bootstrap'),
  updateProfile: (input) => call('user.updateProfile', input),
  listTrips: () => call('trip.list'),
  getTrip: (tripId) => call('trip.get', { tripId }),
  createTrip: (input) => call('trip.create', input),
  updateTrip: (input) => call('trip.update', input),
  archiveTrip: (tripId) => call('trip.archive', { tripId }),
  restoreTrip: (tripId) => call('trip.restore', { tripId }),
  createOfflineMember: (tripId, input) => call('member.addOffline', { tripId, ...input }),
  updateOfflineMember: (input) => call('member.updateOffline', input),
  deactivateMember: (memberId) => call('member.deactivate', { memberId }),
  removeMember: (memberId) => call('member.remove', { memberId }),
  transferOwner: (input) => call('member.transferOwner', input),
  uploadAvatar,
  updateMyAvatar: async (tripId, tempFilePath) => call('member.updateMyAvatar', { tripId, avatarUrl: await uploadAvatar(tempFilePath) }),
  createExpense: (input) => call('expense.create', input),
  getExpense: (expenseId) => call('expense.get', { expenseId }),
  updateExpense: (input) => call('expense.update', input),
  deleteExpense: (input) => call('expense.delete', input),
  previewSettlement: (tripId) => call('settlement.preview', { tripId }),
  getSettlement: (tripId) => call('settlement.get', { tripId }),
  startSettlement: (tripId) => call('settlement.start', { tripId }),
  updateTransferStatus: (input) => call('settlement.transfer.update', input),
  createInvite: (tripId) => call('invite.create', { tripId }),
  getActiveInvite: (tripId) => call('invite.getActive', { tripId }),
  revokeInvite: (inviteId) => call('invite.revoke', { inviteId }),
  resolveInviteCode: (inviteCode) => call('invite.resolveCode', { inviteCode }),
  getInviteQr: (inviteId, envVersion) => call('invite.getQr', { inviteId, envVersion }),
  previewInvite: (inviteId) => call('invite.preview', { inviteId }),
  joinTrip: (input) => call('invite.join', input),
}
