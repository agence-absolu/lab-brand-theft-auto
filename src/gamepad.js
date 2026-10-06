/* ---------- Manette de jeu ---------- */
// Même principe que la démo game-controller : l'API Gamepad ne pousse aucun
// événement pour les axes ni les boutons, on interroge donc la manette à
// chaque frame. Le mapping « standard » donne le même ordre d'index pour
// toutes les manettes, seuls les libellés changent selon la marque.

const DEADZONE = 0.12 // zone morte des sticks
const TRIGGER_DEADZONE = 0.05 // les gâchettes ne reviennent pas toujours à 0

// Index des boutons au mapping standard
export const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  LS: 10, // clic du stick gauche
  RS: 11, // clic du stick droit
  UP: 12, // croix directionnelle, haut
}

// Pictogramme du bouton Menu des manettes Xbox : trois barres
const MENU_ICON =
  '<svg class="pad-icon" viewBox="0 0 16 14" aria-hidden="true">' +
  '<path d="M2 2.5h12M2 7h12M2 11.5h12" stroke-linecap="round" />' +
  '</svg>'

const PROFILES = {
  xbox: {
    name: 'Xbox',
    labels: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑'],
    // Boutons qui s'affichent avec leur pictogramme plutôt qu'avec leur nom
    icons: { 9: MENU_ICON },
  },
  playstation: {
    name: 'PlayStation',
    labels: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '↑'],
  },
}

// Identifiant fabricant USB (Microsoft 045e, Sony 054c) ou nom du modèle selon
// le navigateur. Xbox est testé en premier : son id contient souvent aussi
// « Wireless Controller », comme celui des manettes Sony.
const XBOX_ID = /045e|xbox|xinput/i
const PLAYSTATION_ID = /054c|dualsense|dualshock|playstation|wireless controller/i

function detectProfile(id) {
  if (XBOX_ID.test(id)) return PROFILES.xbox
  if (PLAYSTATION_ID.test(id)) return PROFILES.playstation
  return PROFILES.xbox
}

// Applique la zone morte en conservant une réponse progressive au-delà : fin
// au centre pour corriger un cap, franc en bout de course.
function stick(value) {
  const abs = Math.abs(value)
  if (abs < DEADZONE) return 0
  return Math.sign(value) * ((abs - DEADZONE) / (1 - DEADZONE)) ** 2
}

function trigger(button) {
  const value = button?.value ?? 0
  return value < TRIGGER_DEADZONE ? 0 : value
}

// `onPress(index)` est appelé une fois par appui, au front montant ;
// `onActivity()` à chaque frame où un stick ou un bouton est sollicité
export function createGamepad({ onPress, onActivity, onConnect, onDisconnect } = {}) {
  // Valeurs analogiques normalisées : sticks dans [-1, 1] (haut = positif,
  // comme les sticks tactiles), gâchettes dans [0, 1]
  const state = {
    connected: false,
    profile: PROFILES.xbox,
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    lookBack: false,
    lookX: 0,
    lookY: 0,
    // Sticks après zone morte, dans le repère de l'écran (y vers le bas) :
    // c'est ce que lit le curseur des menus
    sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
  }
  let padIndex = null
  let previousButtons = []

  function reset() {
    state.steer = state.throttle = state.brake = state.lookX = state.lookY = 0
    state.handbrake = state.lookBack = false
    Object.assign(state.sticks, { lx: 0, ly: 0, rx: 0, ry: 0 })
  }

  addEventListener('gamepadconnected', (event) => {
    // On garde la première manette : une seconde branchée ne vole pas la main
    if (padIndex !== null) return
    padIndex = event.gamepad.index
    state.connected = true
    state.profile = detectProfile(event.gamepad.id)
    onConnect?.(state.profile)
  })

  addEventListener('gamepaddisconnected', (event) => {
    if (event.gamepad.index !== padIndex) return
    padIndex = null
    previousButtons = []
    state.connected = false
    reset()
    onDisconnect?.()
  })

  function poll() {
    if (padIndex === null) return
    const pad = navigator.getGamepads()[padIndex]
    if (!pad) return

    const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes.map(stick)
    Object.assign(state.sticks, { lx, ly, rx, ry })
    state.steer = lx
    state.lookX = rx
    state.lookY = -ry // l'axe Y de l'API pointe vers le bas
    state.throttle = trigger(pad.buttons[BUTTON.RT])
    state.brake = trigger(pad.buttons[BUTTON.LT])
    state.handbrake = Boolean(pad.buttons[BUTTON.RB]?.pressed)
    state.lookBack = Boolean(pad.buttons[BUTTON.RS]?.pressed)

    const buttons = pad.buttons.map((b) => b.pressed)
    if (lx || ly || rx || ry || buttons.some(Boolean)) onActivity?.()
    buttons.forEach((on, i) => {
      if (on && !previousButtons[i]) onPress?.(i)
    })
    previousButtons = buttons
  }

  // Vibration, si le navigateur l'expose : intensités de 0 à 1 pour le gros
  // moteur (basses fréquences) et le petit (hautes fréquences)
  function rumble(strong, weak, duration = 150) {
    if (padIndex === null) return
    const actuator = navigator.getGamepads()[padIndex]?.vibrationActuator
    if (!actuator?.playEffect) return
    actuator
      .playEffect('dual-rumble', {
        duration,
        strongMagnitude: Math.min(1, strong),
        weakMagnitude: Math.min(1, weak),
      })
      .catch(() => {}) // effet refusé ou interrompu : sans conséquence
  }

  return { state, poll, rumble }
}
