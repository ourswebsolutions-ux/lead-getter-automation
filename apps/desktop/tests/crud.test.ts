import { describe, it, expect, beforeEach } from 'vitest'
import { freshDb } from './helpers'
import { db } from '../src/main/db'
import * as convs from '../src/main/services/conversations'
import * as manage from '../src/main/services/maps/manage'
import { listResults } from '../src/main/services/maps/session'
import { createCategory, renameCategory, deleteCategory, listCategories, getLead } from '../src/main/services/leads'
import { clearFinishedJobs, deleteJobs } from '../src/main/core/jobs'
import { renameCampaign } from '../src/main/services/campaigns'
import { patchSmtpAccount } from '../src/main/services/email'

const n = (sql: string, ...p: any[]) => db().get<{ n: number }>(sql, ...p)!.n

describe('Conversations: delete chats and messages', () => {
  beforeEach(() => freshDb())

  function chat(address: string, bodies: string[]) {
    const conv = convs.getOrCreateConversation({ channel: 'whatsapp', address, accountId: 1 } as any)
    for (const b of bodies) convs.recordMessage(conv.id, { direction: 'in', author: 'contact', body: b } as any)
    return conv.id
  }

  it('deletes whole conversations with their messages and scheduled AI replies', () => {
    const a = chat('923001111111', ['hi', 'price?'])
    const b = chat('923002222222', ['hello'])
    db().run("INSERT INTO agent_queue (conversation_id, kind, due_at, status) VALUES (?, 'reply', datetime('now','+1 hour'), 'waiting')", a)
    expect(convs.deleteConversations([a])).toBe(1)
    expect(n('SELECT COUNT(*) n FROM conversations WHERE id = ?', a)).toBe(0)
    expect(n('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', a)).toBe(0)
    expect(n('SELECT COUNT(*) n FROM agent_queue WHERE conversation_id = ?', a)).toBe(0)
    expect(n('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', b)).toBe(1)
  })

  it('deletes one message and updates the chat preview', () => {
    const a = chat('923003333333', ['first', 'second'])
    const last = db().get<{ id: number }>('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC', a)!.id
    expect(convs.deleteMessages(a, [last])).toBe(1)
    expect(db().get<any>('SELECT last_message_preview p FROM conversations WHERE id = ?', a).p).toBe('first')
    // a message id from another chat is not touched
    const b = chat('923004444444', ['other'])
    const otherMsg = db().get<{ id: number }>('SELECT id FROM messages WHERE conversation_id = ?', b)!.id
    expect(convs.deleteMessages(a, [otherMsg])).toBe(0)
  })

  it('clears a chat but keeps the contact', () => {
    const a = chat('923005555555', ['one', 'two', 'three'])
    expect(convs.clearConversation(a)).toBe(3)
    const c = db().get<any>('SELECT * FROM conversations WHERE id = ?', a)
    expect(c).toBeTruthy()
    expect(c.last_message_preview).toBeNull()
    expect(c.unread).toBe(0)
  })
})

describe('Google Maps businesses: add, edit, move, delete', () => {
  beforeEach(() => freshDb())

  it('adds a business by hand and shows it in the Maps table', () => {
    const r = manage.addBusiness({ business_name: 'Hamza Shoes', phone: '+92 300 1234567', website: 'hamzashoes.pk', city: 'Lahore', email: 'info@hamzashoes.pk', business_category: 'Shoe store' })
    const rows = listResults({}).rows as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: r.id, business_name: 'Hamza Shoes', category: 'Shoe store', website_status: 'has_website', email: 'info@hamzashoes.pk' })
    expect(() => manage.addBusiness({ business_name: '  ' })).toThrow(/name is required/)
    // a second business with the same phone is not silently merged
    expect(() => manage.addBusiness({ business_name: 'Other name', phone: '+92 300 1234567' })).toThrow(/already saved as “Hamza Shoes”/)
  })

  it('edits a business, including its website status', () => {
    const r = manage.addBusiness({ business_name: 'Cafe One', website: 'cafeone.pk' })
    manage.updateBusiness(r.id, { business_name: 'Cafe One Gulberg', website: '', business_category: 'Cafe', notes: 'call after 5' })
    const b = manage.getBusiness(r.id)
    expect(b).toMatchObject({ business_name: 'Cafe One Gulberg', website: null, maps_category: 'Cafe', website_status: 'no_website', notes: 'call after 5' })
    expect(() => manage.updateBusiness(r.id, { business_name: '' })).toThrow(/required/)
  })

  it('moves businesses to a campaign category', () => {
    const a = manage.addBusiness({ business_name: 'A shop', phone: '+923001110000' })
    const b = manage.addBusiness({ business_name: 'B shop', phone: '+923001110001' })
    const cat = createCategory('Shoes')
    expect(manage.moveToCategory([a.id, b.id], cat)).toBe(2)
    expect(listCategories().find((c: any) => c.id === cat)!.lead_count).toBe(2)
  })

  it('deletes businesses completely so a new search can find them again', () => {
    const a = manage.addBusiness({ business_name: 'Gone Ltd', email: 'hi@gone.test' })
    expect(manage.deleteBusinesses([a.id])).toBe(1)
    expect(listResults({}).total).toBe(0)
    expect(getLead(a.leadId)).toBeNull()
    expect(n('SELECT COUNT(*) n FROM leads WHERE id = ?', a.leadId)).toBe(0)
    // the same business can be added again
    expect(manage.addBusiness({ business_name: 'Gone Ltd', email: 'hi@gone.test' }).id).toBeGreaterThan(0)
    expect(listResults({}).total).toBe(1)
  })
})

describe('Categories, tasks, campaigns, email accounts', () => {
  beforeEach(() => freshDb())

  it('blocks duplicate or empty category names and keeps businesses when a category is deleted', () => {
    const id = createCategory('Bakeries')
    expect(() => createCategory('bakeries')).toThrow(/already exists/)
    expect(() => renameCategory(id, ' ')).toThrow(/required/)
    renameCategory(id, 'Bakery shops')
    const biz = manage.addBusiness({ business_name: 'Bread Co', category_id: id })
    deleteCategory(id)
    expect(getLead(biz.leadId)).toBeTruthy()
    expect(listCategories().some((c: any) => c.name === 'Bakery shops')).toBe(false)
  })

  it('clears finished tasks but never running ones', () => {
    db().run("INSERT INTO jobs (id, type, title, params, status) VALUES ('j1','x','done','{}','completed'), ('j2','x','run','{}','running'), ('j3','x','bad','{}','failed')")
    expect(deleteJobs(['j2'])).toBe(0)
    expect(clearFinishedJobs()).toBe(2)
    expect(n('SELECT COUNT(*) n FROM jobs')).toBe(1)
  })

  it('renames a campaign and edits an email account', () => {
    db().run("INSERT INTO campaigns (id, channel, name, config) VALUES (7, 'email', 'Old', '{}')")
    renameCampaign(7, '  Dubai cafes  ')
    expect(db().get<any>('SELECT name FROM campaigns WHERE id = 7').name).toBe('Dubai cafes')
    expect(() => renameCampaign(7, '')).toThrow()

    db().run("INSERT INTO smtp_accounts (id, name, host, port, secure, username, from_name, from_email, daily_limit) VALUES (3, 'a', 'smtp.x.test', 465, 'ssl', 'u', 'Old', 'u@x.test', 100)")
    patchSmtpAccount(3, { from_name: 'Sara from Automas', daily_limit: 40, enabled: false, reply_to: 'sales@x.test' })
    expect(db().get<any>('SELECT from_name, daily_limit, enabled, reply_to FROM smtp_accounts WHERE id = 3')).toEqual({ from_name: 'Sara from Automas', daily_limit: 40, enabled: 0, reply_to: 'sales@x.test' })
    expect(() => patchSmtpAccount(3, { daily_limit: 0 })).toThrow(/between/)
    expect(() => patchSmtpAccount(3, { reply_to: 'nope' })).toThrow(/email/)
  })
})
