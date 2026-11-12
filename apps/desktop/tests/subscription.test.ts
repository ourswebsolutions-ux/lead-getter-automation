import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb } from './helpers'
import * as sub from '../src/main/services/subscription'
import { db } from '../src/main/db'

const mails: any[] = []
const lastCode = () => /OTP (\d{4})/.exec(mails.at(-1).subject)![1]
const wrongOf = (c: string) => String((Number(c) + 1) % 10000).padStart(4, '0')
const wait30s = () => (Date.now = ((n) => () => n)(Date.now() + 31_000))
const realNow = Date.now

describe('local subscription (no server)', () => {
  beforeEach(() => {
    Date.now = realNow
    freshDb()
    mails.length = 0
    sub.setMarkerPath(join(mkdtempSync(join(tmpdir(), 'lge-sub-')), 'marker'))
    sub.setMailer({ sendMail: async (m) => void mails.push(m) })
    process.env.SUBSCRIPTION_OTP_EMAIL = 'owner@test.io'
  })

  it('starts a 2-day trial on first launch and survives a reinstall', () => {
    const s = sub.initSubscription()
    expect(s.state).toBe('trial')
    expect(sub.isLicensed()).toBe(true)
    const days = (Date.parse(s.expiresAt!) - Date.now()) / 86400_000
    expect(days).toBeGreaterThan(1.99)
    // Reinstall = fresh DB, same home-folder marker → same trial end, not a new trial.
    freshDb()
    expect(sub.initSubscription().expiresAt).toBe(s.expiresAt)
  })

  it('locks after the trial ends', () => {
    sub.initSubscription()
    db().run("UPDATE subscription SET trial_ends_at = '2020-01-01T00:00:00.000Z'")
    expect(sub.subscriptionStatus().state).toBe('invalid') // edited without a valid signature
    expect(sub.isLicensed()).toBe(false)
  })

  it('emails an OTP to the owner, limits wrong codes, activates, and renewals extend', async () => {
    sub.initSubscription()
    await sub.requestOtp({ planCode: 'basic_monthly', name: 'Team PC', phone: '+92300' })
    expect(mails[0].to).toBe('owner@test.io')
    expect(mails[0].text).toMatch(/Customer: Team PC/)
    const code = lastCode()
    await expect(sub.verifyOtp(wrongOf(code))).rejects.toThrow(/Wrong code. 4 attempts left/)
    const s = await sub.verifyOtp(code)
    expect(s.state).toBe('active')
    expect(s.plan).toBe('basic_monthly')
    await expect(sub.verifyOtp(code)).rejects.toThrow(/No activation request/) // single use
    const firstExpiry = Date.parse(s.expiresAt!)
    wait30s()
    await sub.requestOtp({ planCode: 'six_month' })
    const s2 = await sub.verifyOtp(lastCode())
    const added = (Date.parse(s2.expiresAt!) - firstExpiry) / 86400_000
    expect(added).toBeGreaterThan(179)
    // Paid plan also survives a reinstall.
    freshDb()
    expect(sub.initSubscription().plan).toBe('six_month')
  })

  it('locks a code after 5 wrong attempts and a new request replaces the old code', async () => {
    sub.initSubscription()
    await sub.requestOtp({ planCode: 'lifetime' })
    const code = lastCode()
    for (let i = 0; i < 4; i++) await expect(sub.verifyOtp(wrongOf(code))).rejects.toThrow(/Wrong code/)
    await expect(sub.verifyOtp(wrongOf(code))).rejects.toThrow(/Too many wrong codes/)
    await expect(sub.verifyOtp(code)).rejects.toThrow(/No activation request/)
    wait30s()
    await sub.requestOtp({ planCode: 'lifetime' })
    const s = await sub.verifyOtp(lastCode())
    expect(s.state).toBe('active')
    expect(s.expiresAt).toBeNull() // lifetime
  })

  it('reports a clear error when the email cannot be sent', async () => {
    sub.initSubscription()
    sub.setMailer({ sendMail: async () => { throw new Error('ECONNREFUSED') } })
    await expect(sub.requestOtp({ planCode: 'basic_monthly' })).rejects.toThrow(/Could not send/)
    await expect(sub.verifyOtp('1234')).rejects.toThrow(/No activation request/)
  })
})
