import { describe, it, expect, afterAll } from 'vitest'
import { parseRobots, isAllowed, extractEmails, decodeCfEmail, crawlSite, classifyEmail } from '../src/main/services/sources/website'
import { serve } from './helpers'

describe('robots.txt', () => {
  const rules = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/contact\nCrawl-delay: 1\n\nUser-agent: badbot\nDisallow: /`)
  it('applies longest-match rules', () => {
    expect(isAllowed(rules, '/about')).toBe(true)
    expect(isAllowed(rules, '/private/team')).toBe(false)
    expect(isAllowed(rules, '/private/contact')).toBe(true)
    expect(rules.crawlDelay).toBe(1)
  })
})

describe('email extraction', () => {
  it('finds mailto, plain text, cloudflare-protected and obfuscated emails, ignoring junk', () => {
    const cf = '6a' + Buffer.from(Buffer.from('admin@acme.com').map((b) => b ^ 0x6a)).toString('hex')
    expect(decodeCfEmail(cf)).toBe('admin@acme.com')
    const html = `<a href="mailto:Sales@Acme.com?subject=hi">mail</a> <p>Support: support@acme.com</p>
      <span data-cfemail="${cf}"></span> <p>ceo [at] acme [dot] com</p> <img src="logo@2x.png"> user@example.com`
    const emails = extractEmails(html)
    expect(emails).toEqual(expect.arrayContaining(['sales@acme.com', 'support@acme.com', 'admin@acme.com', 'ceo@acme.com']))
    expect(emails).not.toContain('logo@2x.png')
    expect(emails).not.toContain('user@example.com')
    expect(classifyEmail('sales@acme.com')).toBe('sales')
    // Real-world regressions: separate elements must not be glued, junk addresses are dropped, JSON-LD is read.
    expect(extractEmails('<p>Email</p><p>customercare@servis.com</p><p>Call</p>')).toEqual(['customercare@servis.com'])
    expect(extractEmails('<script>x</script><p>calculated@checkout.check noreply@shop.pk</p>')).toEqual([])
    expect(extractEmails('<script type="application/ld+json">{"email":"mailto:info@shop.pk"}</script>')).toEqual(['info@shop.pk'])
    expect(classifyEmail('info@acme.com')).toBe('contact')
  })
})

describe('crawlSite', async () => {
  const site = await serve((req, res) => {
    const pages: Record<string, string> = {
      '/robots.txt': 'User-agent: *\nDisallow: /secret',
      '/': '<html><title>Acme Home</title><body><a href="/contact">Contact us</a> <a href="/secret">s</a> <a href="https://facebook.com/acme">fb</a></body></html>',
      '/contact': '<html><body>Write to <a href="mailto:hello@acme-shop.io">us</a> or call <a href="tel:+15550001234">call</a></body></html>',
      '/secret': '<html><body>hidden@acme-shop.io</body></html>'
    }
    const body = pages[req.url]
    if (!body) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html' }).end(body)
  })
  afterAll(() => site.close())

  it('follows contact pages, respects robots.txt, collects socials', async () => {
    const r = await crawlSite(site.url, { maxPages: 5, delayMs: 0 })
    expect(r.emails.map((e) => e.email)).toEqual(['hello@acme-shop.io'])
    expect(r.emails[0].sourceUrl).toContain('/contact')
    expect(r.phones[0].phone).toBe('+15550001234')
    expect(r.blockedByRobots.some((u) => u.includes('/secret'))).toBe(true)
    expect(r.socials).toContain('https://facebook.com/acme')
  })
})
