'use strict'

function restoreDraftMembers(members, currentMemberId, saved = {}) {
  const available = new Set(members.map((member) => member.id))
  const selected = Array.isArray(saved.participantMemberIds) ? saved.participantMemberIds : members.map((member) => member.id)
  const participantMemberIds = selected.filter((id) => available.has(id))
  const currentIndex = Math.max(0, members.findIndex((member) => member.id === currentMemberId))
  const savedIndex = saved.payerMemberId ? members.findIndex((member) => member.id === saved.payerMemberId) : saved.payerIndex
  const payerIndex = Number.isInteger(savedIndex) && members[savedIndex] ? savedIndex : currentIndex
  const units = Object.fromEntries(members.map((member) => [member.id, saved.units && Object.prototype.hasOwnProperty.call(saved.units, member.id) ? saved.units[member.id] : 1]))
  const changed = participantMemberIds.length !== selected.length || Boolean(saved.payerMemberId && !available.has(saved.payerMemberId))
  return { participantMemberIds, payerIndex, units, draftNotice: changed ? '同行成员已更新，请核对付款人和分摊成员。' : '' }
}

module.exports = { restoreDraftMembers }
