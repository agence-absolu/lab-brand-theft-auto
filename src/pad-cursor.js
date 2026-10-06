/* ---------- Curseur manette des menus ---------- */
// Repris de la démo game-controller : dans les écrans qui attendent un clic
// (accueil, confirmation, capture), le stick gauche déplace un curseur, le
// stick droit l'ajuste finement, et A / ✕ clique sur le bouton survolé.

const SPEED = 900 // px/s, stick gauche à fond
const FINE_SPEED = 200 // px/s, stick droit à fond (précision)
const CLICKABLE = 'button, a[href]'

export function createPadCursor(sticks) {
  const element = document.createElement('div')
  element.className = 'pad-cursor'
  element.innerHTML = '<i></i>'
  document.body.append(element)

  const pos = { x: innerWidth / 2, y: innerHeight / 2 }
  let active = false
  let hovered = null

  function render() {
    element.style.transform = `translate(${pos.x}px, ${pos.y}px)`
  }

  function clamp() {
    pos.x = Math.min(Math.max(pos.x, 0), innerWidth)
    pos.y = Math.min(Math.max(pos.y, 0), innerHeight)
  }

  // Le curseur n'intercepte rien (pointer-events: none) : le point visé est
  // donc bien l'élément de la page en dessous
  function updateHover() {
    const target = document.elementFromPoint(pos.x, pos.y)?.closest(CLICKABLE) ?? null
    if (target === hovered) return
    hovered?.classList.remove('is-hover')
    hovered = target
    hovered?.classList.add('is-hover')
    element.classList.toggle('is-over', Boolean(hovered))
  }

  // `home` : élément sur lequel poser le curseur à l'apparition, pour que
  // l'action principale soit à un appui de A
  function show(home) {
    if (!active && home) {
      const rect = home.getBoundingClientRect()
      pos.x = rect.left + rect.width / 2
      pos.y = rect.top + rect.height / 2
      clamp()
    }
    active = true
    element.classList.add('is-visible')
  }

  function hide() {
    if (!active) return
    active = false
    element.classList.remove('is-visible')
    hovered?.classList.remove('is-hover')
    hovered = null
  }

  function update(delta) {
    if (!active) return
    const dx = sticks.lx * SPEED + sticks.rx * FINE_SPEED
    const dy = sticks.ly * SPEED + sticks.ry * FINE_SPEED
    if (dx || dy) {
      pos.x += dx * delta
      pos.y += dy * delta
      clamp()
    }
    render()
    updateHover() // à chaque frame : l'écran peut changer sous le curseur
  }

  // Renvoie true si un bouton a reçu le clic
  function click() {
    if (!active || !hovered) return false
    element.classList.add('is-pressed')
    setTimeout(() => element.classList.remove('is-pressed'), 120)
    hovered.click()
    return true
  }

  addEventListener('resize', () => {
    clamp()
    render()
  })

  return {
    show,
    hide,
    update,
    click,
    get active() {
      return active
    },
  }
}
