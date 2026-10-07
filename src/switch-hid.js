/* ---------- Manette Switch Pro en WebHID ---------- */
// Chrome réserve les manettes Nintendo (057e) à son propre pilote, qui
// échoue avec certains clones : l'API Gamepad ne les voit alors jamais. On
// lit donc la manette directement en HID, et on la présente au reste du jeu
// comme une manette au mapping standard. Chrome et Edge seulement ; il faut
// un clic pour l'autoriser la première fois, Chrome la retrouve ensuite seul.

const NINTENDO = 0x057e
const PRO_CONTROLLER = 0x2009

// Rapport de sortie 0x01 : compteur, vibrations neutres, puis sous-commande
const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]
const SUBCOMMAND_REPORT_MODE = 0x03 // argument 0x30 : rapport complet
const SUBCOMMAND_PLAYER_LIGHTS = 0x30 // argument 0x01 : voyant du joueur 1
const SUBCOMMAND_VIBRATION = 0x48 // argument 0x01 : active les moteurs
const RUMBLE_REPORT = 0x10 // rapport de sortie sans sous-commande

// Vibration « HD Rumble » : chaque moteur joue une bande basse et une bande
// haute, chacune avec sa fréquence et son amplitude. On garde les fréquences
// des valeurs neutres (160 Hz et 320 Hz) et on fait varier les amplitudes :
// la bande basse rend le gros moteur des autres manettes, la haute le petit.
// Encodage repris de la rétro-ingénierie de dekuNukem (Nintendo_Switch_Reverse_Engineering).
function amplitudeIndex(amp) {
  if (amp <= 0) return 0
  const log = Math.log2(Math.min(1, amp) * 1000) * 32 - 0x60
  let encoded
  if (amp < 0.117) encoded = log / (5 - amp ** 2) - 1
  else if (amp < 0.23) encoded = log - 0x5c
  else encoded = log * 2 - 0xf6
  return Math.max(0, Math.min(100, Math.round(encoded / 2)))
}

function rumbleBytes(strong, weak) {
  const high = amplitudeIndex(weak)
  const low = amplitudeIndex(strong)
  // Octets 0-1 : fréquence haute (320 Hz) et son amplitude ; octets 2-3 :
  // fréquence basse (160 Hz) et son amplitude, dont le bit de parité passe
  // dans l'octet 2
  const side = [0x00, 0x01 + high * 2, 0x40 + (low & 1 ? 0x80 : 0), 0x40 + (low >> 1)]
  return [...side, ...side] // même effet à gauche et à droite
}

// Bits des trois octets de boutons du rapport 0x30, rangés dans l'ordre du
// mapping standard (position du bouton, pas son nom : B est en bas)
const BUTTON_BITS = [
  [0, 0x04], // B
  [0, 0x08], // A
  [0, 0x01], // Y
  [0, 0x02], // X
  [2, 0x40], // L
  [0, 0x40], // R
  [2, 0x80], // ZL
  [0, 0x80], // ZR
  [1, 0x01], // −
  [1, 0x02], // +
  [1, 0x08], // clic du stick gauche
  [1, 0x04], // clic du stick droit
  [2, 0x02], // croix : haut
  [2, 0x01], // bas
  [2, 0x08], // gauche
  [2, 0x04], // droite
  [1, 0x10], // Home
]

const RAW_CENTER = 2048 // sticks sur 12 bits
const INITIAL_RANGE = 1400 // course minimale supposée, élargie à l'usage

// Un axe s'étalonne tout seul : centre lu au repos à la connexion, course
// élargie à chaque fois que le stick va plus loin que ce qu'on a déjà vu
function createAxis() {
  let center = null
  let range = INITIAL_RANGE
  return (raw) => {
    if (center === null) {
      // Un stick tenu pendant la connexion ne doit pas fausser le centre
      center = Math.abs(raw - RAW_CENTER) < 400 ? raw : RAW_CENTER
    }
    const offset = raw - center
    range = Math.max(range, Math.abs(offset))
    return offset / range
  }
}

export function createSwitchHid({ onConnect, onDisconnect } = {}) {
  const supported = 'hid' in navigator
  let device = null
  let attaching = false // getDevices et l'événement connect peuvent se croiser
  let counter = 0
  let axes = null
  let snapshot = null // dernier état reçu, au format de l'API Gamepad
  let sending = Promise.resolve() // un rapport de sortie à la fois
  let rumbleTimer = null

  function send(reportId, payload) {
    const target = device
    sending = sending
      .then(() => {
        if (device !== target) return // manette débranchée entre-temps
        const data = [counter, ...payload]
        counter = (counter + 1) & 0x0f
        return target.sendReport(reportId, new Uint8Array(data))
      })
      .catch(() => {}) // rapport refusé : la manette suivante repartira à zéro
    return sending
  }

  const subcommand = (id, arg) => send(0x01, [...NEUTRAL_RUMBLE, id, arg])

  function onInputReport(event) {
    // 0x30 : rapport complet ; 0x21 : réponse à une sous-commande, qui porte
    // aussi l'état des boutons et des sticks
    if (event.reportId !== 0x30 && event.reportId !== 0x21) return
    const d = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
    const bytes = [d[2], d[3], d[4]]
    const stick = (o) => [d[o] | ((d[o + 1] & 0x0f) << 8), (d[o + 1] >> 4) | (d[o + 2] << 4)]
    const [lx, ly] = stick(5)
    const [rx, ry] = stick(8)
    snapshot = {
      // L'axe Y de la manette monte, celui de l'API Gamepad descend
      axes: [axes.lx(lx), -axes.ly(ly), axes.rx(rx), -axes.ry(ry)].map((v) =>
        Math.max(-1, Math.min(1, v)),
      ),
      buttons: BUTTON_BITS.map(([byte, bit]) => {
        const pressed = Boolean(bytes[byte] & bit)
        return { pressed, value: pressed ? 1 : 0 }
      }),
    }
  }

  async function attach(next) {
    if (device || attaching) return
    attaching = true
    try {
      if (!next.opened) await next.open()
    } catch {
      return // déjà ouverte ailleurs ou refusée : on reste sur l'API Gamepad
    } finally {
      attaching = false
    }
    device = next
    axes = { lx: createAxis(), ly: createAxis(), rx: createAxis(), ry: createAxis() }
    snapshot = null
    device.addEventListener('inputreport', onInputReport)
    // Une sous-commande refusée n'empêche pas de lire la manette : elle
    // envoie peut-être déjà ses rapports
    subcommand(SUBCOMMAND_REPORT_MODE, 0x30)
    subcommand(SUBCOMMAND_PLAYER_LIGHTS, 0x01)
    subcommand(SUBCOMMAND_VIBRATION, 0x01)
    onConnect?.()
  }

  function detach() {
    if (!device) return
    device.removeEventListener('inputreport', onInputReport)
    clearTimeout(rumbleTimer)
    device = null
    snapshot = null
    onDisconnect?.()
  }

  const isProController = (d) => d.vendorId === NINTENDO && d.productId === PRO_CONTROLLER

  if (supported) {
    // Manette déjà autorisée lors d'une visite précédente : reprise sans clic
    navigator.hid.getDevices().then((devices) => {
      const known = devices.find(isProController)
      if (known) attach(known)
    })
    navigator.hid.addEventListener('connect', (event) => {
      if (isProController(event.device)) attach(event.device)
    })
    navigator.hid.addEventListener('disconnect', (event) => {
      if (event.device === device) detach()
    })
  }

  // À appeler depuis un clic : ouvre le sélecteur de périphériques de Chrome
  async function request() {
    if (!supported) return
    const [chosen] = await navigator.hid.requestDevice({
      filters: [{ vendorId: NINTENDO, productId: PRO_CONTROLLER }],
    })
    if (chosen) await attach(chosen)
  }

  // Même contrat que `playEffect('dual-rumble')` : intensités de 0 à 1, puis
  // retour au neutre une fois la durée écoulée
  function rumble(strong, weak, duration) {
    if (!device) return
    clearTimeout(rumbleTimer)
    send(RUMBLE_REPORT, rumbleBytes(strong, weak))
    rumbleTimer = setTimeout(() => device && send(RUMBLE_REPORT, NEUTRAL_RUMBLE), duration)
  }

  return {
    supported,
    request,
    rumble,
    get connected() {
      return device !== null
    },
    read: () => snapshot,
  }
}
