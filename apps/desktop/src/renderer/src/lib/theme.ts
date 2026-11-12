export type ThemePref = 'system' | 'light' | 'dark'

const mq = window.matchMedia('(prefers-color-scheme: dark)')
let pref: ThemePref = (() => {
  try {
    return (localStorage.getItem('lge.theme') as ThemePref) || 'system'
  } catch {
    return 'system'
  }
})()

export function resolved(p: ThemePref = pref): 'light' | 'dark' {
  return p === 'system' ? (mq.matches ? 'dark' : 'light') : p
}

export function applyTheme(p: ThemePref, animate = false): void {
  pref = p
  try {
    localStorage.setItem('lge.theme', p)
  } catch {
    /* storage unavailable */
  }
  const root = document.documentElement
  if (animate) {
    root.classList.add('theme-transition')
    setTimeout(() => root.classList.remove('theme-transition'), 320)
  }
  root.dataset.theme = resolved(p)
}

export function currentTheme(): ThemePref {
  return pref
}

mq.addEventListener('change', () => pref === 'system' && applyTheme('system', true))
applyTheme(pref)
