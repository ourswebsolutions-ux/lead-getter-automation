/* Help Center: search filter + highlight, and the contents list follows the section you are reading. */
;(function () {
  var docs = Array.prototype.slice.call(document.querySelectorAll('.doc'))
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc-in a'))
  var q = document.getElementById('q')
  var qn = document.getElementById('qn')
  var none = document.getElementById('none')
  var toc = document.querySelector('.toc details')

  // Mobile: contents collapsed by default; close it after choosing a section
  if (matchMedia('(max-width: 900px)').matches && toc) toc.open = false
  tocLinks.forEach(function (a) {
    a.addEventListener('click', function () {
      if (matchMedia('(max-width: 900px)').matches && toc) toc.open = false
    })
  })

  // Search
  var original = new Map()
  docs.forEach(function (d) {
    original.set(d, d.innerHTML)
  })
  function esc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  function highlight(el, words) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    var nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    var re = new RegExp('(' + words.map(esc).join('|') + ')', 'gi')
    nodes.forEach(function (n) {
      if (!re.test(n.nodeValue)) return
      re.lastIndex = 0
      var span = document.createElement('span')
      span.innerHTML = n.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(re, '<mark>$1</mark>')
      n.parentNode.replaceChild(span, n)
    })
  }
  var timer
  function run() {
    var text = q.value.trim().toLowerCase()
    var words = text.split(/\s+/).filter(function (w) {
      return w.length > 1
    })
    // The whole phrase first ("app password"); only if no section has it, every word anywhere.
    var phrase = words.length > 1 ? words.join(' ') : null
    var texts = docs.map(function (d) {
      return original.get(d).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').toLowerCase()
    })
    var usePhrase = phrase && texts.some(function (t) {
      return t.indexOf(phrase) !== -1
    })
    if (usePhrase) words = [phrase]
    var shown = 0
    docs.forEach(function (d, i) {
      d.innerHTML = original.get(d)
      var hay = texts[i]
      var hit = !words.length || words.every(function (w) {
        return hay.indexOf(w) !== -1
      })
      d.classList.toggle('hide', !hit)
      var link = document.querySelector('.toc-in a[href="#' + d.id + '"]')
      if (link) link.classList.toggle('hide', !hit)
      if (hit) {
        shown++
        if (words.length) {
          highlight(d, words)
          d.querySelectorAll('details').forEach(function (x) {
            if (x.textContent.toLowerCase().indexOf(words[0]) !== -1) x.open = true
          })
        }
      }
    })
    // hide group titles in the contents when none of their links are shown
    document.querySelectorAll('.toc-in p').forEach(function (p) {
      var n = p.nextElementSibling, any = false
      while (n && n.tagName === 'A') {
        if (!n.classList.contains('hide')) any = true
        n = n.nextElementSibling
      }
      p.classList.toggle('hide', !any)
    })
    none.classList.toggle('on', shown === 0)
    qn.textContent = words.length ? shown + (shown === 1 ? ' section' : ' sections') : ''
    // keep WhatsApp links working after the HTML was restored
    document.querySelectorAll('.content [data-wa]').forEach(function (a) {
      a.href = 'https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent('Hello, I have a question about Lead Generation.')
      a.target = '_blank'
      a.rel = 'noopener'
    })
  }
  q.addEventListener('input', function () {
    clearTimeout(timer)
    timer = setTimeout(run, 150)
  })
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = docs.find(function (d) {
        return !d.classList.contains('hide')
      })
      if (first) first.scrollIntoView({ behavior: 'smooth' })
    }
  })
  var params = new URLSearchParams(location.search)
  if (params.get('q')) {
    q.value = params.get('q')
    run()
  }

  // Contents follows the reader
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return
          tocLinks.forEach(function (a) {
            a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id)
          })
        })
      },
      { rootMargin: '-90px 0px -65% 0px' }
    )
    docs.forEach(function (d) {
      io.observe(d)
    })
  }
})()
