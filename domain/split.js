'use strict'

function compareMembers(left, right) {
  const leftCreatedAt = String(left.createdAt || '')
  const rightCreatedAt = String(right.createdAt || '')
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt.localeCompare(rightCreatedAt)
  }
  return String(left.id).localeCompare(String(right.id))
}

function assertAmount(amountFen) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new Error('分摊金额必须是正整数分')
  }
}

function assertMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('至少选择一名参与人')
  }
  const ids = new Set()
  members.forEach((member) => {
    if (!member || !member.id || ids.has(member.id)) {
      throw new Error('参与人不合法或重复')
    }
    ids.add(member.id)
  })
}

function distributeRemainder(shares, remainder, orderedMembers) {
  for (let index = 0; index < remainder; index += 1) {
    shares[orderedMembers[index].id] += 1
  }
  return shares
}

function splitEqual(amountFen, members) {
  assertAmount(amountFen)
  assertMembers(members)

  const ordered = [...members].sort(compareMembers)
  const base = Math.floor(amountFen / ordered.length)
  const shares = Object.fromEntries(ordered.map((member) => [member.id, base]))
  return distributeRemainder(shares, amountFen - base * ordered.length, ordered)
}

function splitByUnits(amountFen, membersWithUnits) {
  assertAmount(amountFen)
  assertMembers(membersWithUnits)

  membersWithUnits.forEach((member) => {
    if (!Number.isInteger(member.units) || member.units < 1 || member.units > 999) {
      throw new Error('每名成员的份数必须是 1 至 999 的整数')
    }
  })

  const ordered = [...membersWithUnits].sort(compareMembers)
  const totalUnits = ordered.reduce((sum, member) => sum + member.units, 0)
  const shares = {}
  let allocated = 0
  ordered.forEach((member) => {
    const share = Math.floor((amountFen * member.units) / totalUnits)
    shares[member.id] = share
    allocated += share
  })
  return distributeRemainder(shares, amountFen - allocated, ordered)
}

module.exports = {
  compareMembers,
  splitByUnits,
  splitEqual,
}
