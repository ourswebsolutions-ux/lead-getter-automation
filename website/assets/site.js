/* Lead Generation — website behaviour. Edit SITE to change the repo or the WhatsApp number. */
var SITE = {
  repo: 'ourswebsolutions-ux/lead-getter-automation',
  whatsapp: '923245237429'
}

;(function () {
  var waLink = function (text) {
    return 'https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent(text)
  }

  // WhatsApp links (contact + buy a plan)
  document.querySelectorAll('[data-wa]').forEach(function (a) {
    a.href = waLink('Hello, I have a question about Lead Generation.')
    a.target = '_blank'
    a.rel = 'noopener'
  })
  document.querySelectorAll('[data-buy]').forEach(function (a) {
    a.href = waLink('Hello, I would like to buy the Lead Generation ' + a.dataset.buy + ' plan. My Activation ID is: ')
    a.target = '_blank'
    a.rel = 'noopener'
  })
  document.getElementById('year').textContent = new Date().getFullYear()

  // Mobile menu
  var links = document.getElementById('links')
  document.getElementById('menuBtn').onclick = function () {
    links.classList.toggle('open')
  }
  links.querySelectorAll('a').forEach(function (a) {
    a.onclick = function () {
      links.classList.remove('open')
    }
  })

  // Guide tabs
  var tabs = document.querySelectorAll('.tabs button')
  tabs.forEach(function (b) {
    b.onclick = function () {
      tabs.forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab)
      })
    }
  })

  // The visitor's computer decides the big Download button
  var ua = navigator.userAgent
  var os = /Windows/i.test(ua) ? 'win' : /Android|iPhone|iPad/i.test(ua) ? 'mobile' : /Linux|X11/i.test(ua) ? 'linux' : /Mac/i.test(ua) ? 'mac' : 'other'
  var heroOs = document.getElementById('heroOs')
  var heroDl = document.getElementById('heroDl')
  if (os === 'win') {
    var guideWin = document.querySelector('[data-tab="win"]')
    if (guideWin) guideWin.click()
  } else if (os === 'linux') {
    var guideLinux = document.querySelector('[data-tab="linux"]')
    if (guideLinux) guideLinux.click()
  }
  function pointHero() {
    var sel = os === 'win' ? '[data-asset="portable.exe"]' : os === 'linux' ? '[data-asset=".AppImage"]' : null
    var a = sel && document.querySelector(sel)
    if (a) {
      heroDl.href = a.href
      heroOs.textContent = os === 'win' ? 'for Windows' : 'for Linux'
    } else heroOs.textContent = os === 'mobile' ? '— for your computer' : os === 'mac' ? '— Windows & Linux' : 'for your computer'
    document.getElementById(os === 'linux' ? 'dl-linux' : 'dl-win').classList.add('main')
  }
  pointHero()

  // Latest release from GitHub: links, sizes and version stay current without editing this page
  fetch('https://api.github.com/repos/' + SITE.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (rel) {
      if (!rel || !rel.assets) return
      var v = String(rel.tag_name || '').replace(/^v/, '')
      if (v)
        document.querySelectorAll('[data-version]').forEach(function (e) {
          e.textContent = v
        })
      document.querySelectorAll('[data-asset]').forEach(function (a) {
        var key = a.dataset.asset
        var asset = rel.assets.find(function (x) {
          return x.name.slice(-key.length) === key
        })
        if (!asset) return
        a.href = asset.browser_download_url
        var s = a.querySelector('[data-size]')
        if (s) s.textContent = Math.round(asset.size / 1048576) + ' MB'
      })
      pointHero()
    })
    .catch(function () {
      /* offline or rate-limited: the built-in v1.0.1 links stay */
    })

  // Reveal on scroll + top progress bar
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.12 }
    )
    document.querySelectorAll('.reveal').forEach(function (el) {
      io.observe(el)
    })
  } else
    document.querySelectorAll('.reveal').forEach(function (el) {
      el.classList.add('in')
    })
  var bar = document.getElementById('progress')
  addEventListener(
    'scroll',
    function () {
      var h = document.documentElement
      bar.style.width = (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100 + '%'
    },
    { passive: true }
  )

  // 3D background: turning chrome icosphere, perspective grid, twinkling stars (same scene as the app)
  var c = document.getElementById('fx')
  var ctx = c.getContext('2d', { alpha: false })
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  var t0 = performance.now(), last = 0, w = 0, h = 0, mx = 0, my = 0, tx = 0, ty = 0
  var phi = (1 + Math.sqrt(5)) / 2
  var P = [[-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0], [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi], [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]]
  var F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  function nrm(p) {
    var l = Math.hypot(p[0], p[1], p[2])
    return [p[0] / l, p[1] / l, p[2] / l]
  }
  P = P.map(nrm)
  var cache = {}
  function mid(a, b) {
    var k = a < b ? a + '-' + b : b + '-' + a
    if (cache[k] == null) {
      P.push(nrm([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2]))
      cache[k] = P.length - 1
    }
    return cache[k]
  }
  var F2 = []
  F.forEach(function (f) {
    var ab = mid(f[0], f[1]), bc = mid(f[1], f[2]), ca = mid(f[2], f[0])
    F2.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca])
  })
  var E = [], seen = {}
  F2.forEach(function (f) {
    ;[[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]].forEach(function (e) {
      var k = Math.min(e[0], e[1]) + '-' + Math.max(e[0], e[1])
      if (!seen[k]) {
        seen[k] = 1
        E.push(e)
      }
    })
  })
  var stars = Array.from({ length: 150 }, function () {
    return { x: Math.random(), y: Math.random(), r: Math.random() * 1.1 + 0.3, p: Math.random() * 6.28, s: 0.4 + Math.random() * 1.2 }
  })
  function size() {
    var d = Math.min(1.5, devicePixelRatio || 1)
    w = innerWidth
    h = innerHeight
    c.width = w * d
    c.height = h * d
    ctx.setTransform(d, 0, 0, d, 0, 0)
  }
  function acc(t) {
    var s = [[77, 166, 255], [0, 209, 255], [123, 97, 255]]
    var x = Math.min(0.999, Math.max(0, t)) * 2, i = Math.floor(x), f = x - i
    return [0, 1, 2].map(function (k) {
      return Math.round(s[i][k] + (s[i + 1][k] - s[i][k]) * f)
    })
  }
  function draw(now) {
    var t = (now - t0) / 1000, sy = scrollY || 0
    mx += (tx - mx) * 0.04
    my += (ty - my) * 0.04
    ctx.fillStyle = '#020204'
    ctx.fillRect(0, 0, w, h)
    var g1 = ctx.createRadialGradient(w * 0.85, h * 0.08, 0, w * 0.85, h * 0.08, Math.max(w, h) * 0.6)
    g1.addColorStop(0, 'rgba(77,166,255,0.07)')
    g1.addColorStop(1, 'rgba(77,166,255,0)')
    ctx.fillStyle = g1
    ctx.fillRect(0, 0, w, h)
    var g2 = ctx.createRadialGradient(w * 0.12, h * 0.95, 0, w * 0.12, h * 0.95, Math.max(w, h) * 0.55)
    g2.addColorStop(0, 'rgba(123,97,255,0.06)')
    g2.addColorStop(1, 'rgba(123,97,255,0)')
    ctx.fillStyle = g2
    ctx.fillRect(0, 0, w, h)
    stars.forEach(function (s) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.03 + 0.17 * (0.5 + 0.5 * Math.sin(t * s.s + s.p))).toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(s.x * w, (((s.y * h - sy * 0.15) % h) + h) % h, s.r, 0, 6.28)
      ctx.fill()
    })
    var hz = h * 0.7, fov = 260, camY = 70, zs = (t * 26) % 40
    for (var z = 40; z < 1400; z += 40) {
      var zz = z - zs
      if (zz <= 1) continue
      var y = hz + (camY * fov) / zz
      if (y > h) continue
      ctx.strokeStyle = 'rgba(77,166,255,' + Math.max(0, 0.12 * (1 - zz / 1400)).toFixed(3) + ')'
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    for (var x = -1600; x <= 1600; x += 80) {
      var xo = x + mx * 40
      var x1 = w / 2 + (xo * fov) / 40, y1 = hz + (camY * fov) / 40, x2 = w / 2 + (xo * fov) / 1400, y2 = hz + (camY * fov) / 1400
      var gr = ctx.createLinearGradient(0, y2, 0, y1)
      gr.addColorStop(0, 'rgba(123,97,255,0)')
      gr.addColorStop(1, 'rgba(0,209,255,0.1)')
      ctx.strokeStyle = gr
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
    var R = Math.min(w, h) * 0.26
    var cx = w * (w < 900 ? 0.5 : 0.78) + mx * 18, cy = h * 0.4 + my * 12 - sy * 0.08
    var ay = t * 0.18 + mx * 0.35 + sy * 0.0015, ax = 0.42 + Math.sin(t * 0.13) * 0.15 + my * 0.2
    var ca = Math.cos(ay), sa = Math.sin(ay), cb = Math.cos(ax), sb = Math.sin(ax), br = 1 + Math.sin(t * 0.6) * 0.025
    var pr = P.map(function (p) {
      var x1 = p[0] * ca + p[2] * sa, z1 = -p[0] * sa + p[2] * ca, y2 = p[1] * cb - z1 * sb, z2 = p[1] * sb + z1 * cb, d = 3.2 / (3.2 + z2)
      return { x: cx + x1 * R * br * d, y: cy + y2 * R * br * d, z: z2, d: d }
    })
    E.forEach(function (e) {
      var p = pr[e[0]], q = pr[e[1]], dp = (2 - (p.z + q.z) / 2) / 3, col = acc(((p.y + q.y) / 2 - (cy - R)) / (2 * R))
      ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (0.04 + dp * 0.2).toFixed(3) + ')'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(q.x, q.y)
      ctx.stroke()
    })
    pr.forEach(function (p) {
      var dp = (1 - p.z) / 2
      ctx.fillStyle = 'rgba(201,201,203,' + (0.12 + dp * 0.6).toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 0.8 + dp * 1.8 * p.d, 0, 6.28)
      ctx.fill()
    })
  }
  function loop(now) {
    requestAnimationFrame(loop)
    if (document.hidden || now - last < 33) return
    last = now
    draw(now)
  }
  size()
  addEventListener('resize', size)
  addEventListener('pointermove', function (e) {
    tx = (e.clientX / w - 0.5) * 2
    ty = (e.clientY / h - 0.5) * 2
  }, { passive: true })
  if (reduce) draw(performance.now())
  else requestAnimationFrame(loop)
})()
