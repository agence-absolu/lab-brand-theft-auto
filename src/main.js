import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import GUI from 'lil-gui'
import { PROJECTS } from './projects.js'
import { BUTTON, createGamepad } from './gamepad.js'
import { createPadCursor } from './pad-cursor.js'
import { PROJECT_MEDIA, PROJECT_STREAMS } from './project-media.js'
import './style.css'

// Tous les médias sont servis depuis public/. En production le site vit sous
// un sous-chemin (/brand-theft-auto/), il faut donc préfixer les URL absolues
// stockées dans les données. Les URL distantes (flux Mux) passent telles quelles.
const asset = (path) =>
  /^https?:/.test(path) ? path : `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

// Le ciel peint et la lumière qu'il dégage sont deux réglages séparés : on
// choisit ainsi la teinte du dôme sans toucher à l'accord des couleurs au
// sol. SKY ne sert qu'au dôme et au brouillard ; SKY_LIGHT est ce que la
// lumière d'ambiance emprunte au ciel, et il tire bien plus franchement
// vers le bleu que le gris qu'on voit au-dessus des toits.
const SKY = new THREE.Color('#CFD0D2')
const SKY_LIGHT = new THREE.Color('#0550FF')
const SUN = new THREE.Color('#85A9FF')
const GROUND = new THREE.Color('#3E78FF')
const BUILDING = new THREE.Color('#CFD0D2') // teinte de base des façades
const ROAD_COLOR = SKY.clone().lerp(new THREE.Color('#000000'), 0.45)
const SIDEWALK_COLOR = new THREE.Color('#bfc6d4')
// Couleur d'horizon : le ciel éclairci. Partagée par le dégradé et le
// brouillard, pour que la ville se fonde exactement dans le fond.
const HORIZON = new THREE.Color()

// Valeurs pilotées par l'interface
const settings = {
  fov: 57,                // champ de vision de la caméra perspective
  cameraHeight: 0.6,      // hauteur du point visé, au-dessus du toit de la voiture
  // Recul de la caméra. Sur un écran de téléphone elle est ramenée plus près
  // encore, voir TOUCH_CAMERA_DISTANCE.
  cameraDistance: 7.5,
  carScale: 0.75,         // échelle du véhicule
  cameraPitch: -11,       // inclinaison en degrés : négatif = regard vers le bas
  sunColor: '#85a9ff',
  buildingColor: '#cfd0d2',
  roadColor: '#1e1e1e',
  sidewalkColor: '#cfd0d2',
  skyColor: '#cfd0d2',
  skyLightColor: '#0550ff',
  lampColor: '#cfd0d2',      // gris clair de la charte, pour les mâts
  lampLightColor: '#f2ff28', // jaune de la charte, pour la lampe allumée
  sunHeight: 0.349,       // élévation du soleil, de l'horizon (0) au zénith (1)
  // Le disque solaire n'est qu'un dessin du shader de ciel : l'éclairage de
  // la scène vient d'une lumière directionnelle à part, que ce réglage ne
  // touche pas. L'éteindre ne change donc rien à la lumière reçue au sol.
  showSun: false,
  pixelRatio: 1.5,        // plafond de densité de pixels : le poste le plus lourd
  shadows: true,          // passe d'ombre : toute la géométrie dessinée deux fois
  shadowSize: 4096,       // définition de la carte d'ombre : la finesse du bord
  whiteCameraGaze: 12.5,  // relèvement du regard dans l'espace blanc, en degrés
  titleHeight: 0.21,      // part de la hauteur d'écran occupée par le titre
  titleOffset: 0.29,      // remontée du bloc, en part d'écran
  titleWidth: 0.62,       // plafond de largeur, en part d'écran

  /* Leviers de qualité. Ils sont pilotés par le palier (voir applyQuality) et
     non réglés à la main : chacun est lourd à sa manière, et les descendre
     ensemble est le seul moyen de gagner vraiment sur un appareil modeste. */
  viewRadius: 4,          // chunks chargés autour de la caméra
  // La fin du brouillard doit rester EN DEÇÀ du bord de la zone chargée,
  // sinon on voit la ville s'arrêter net. Bord = viewRadius × 104 − 52.
  fogFar: 300,
  lampRadius: 2,          // chunks où les lampadaires restent allumés
  maxVideos: 5,           // vidéos de panneaux lues simultanément
  quality: 0,             // palier courant, posé au démarrage par applyQuality
  qualityAuto: true,      // descend d'un cran tant que le framerate ne suit pas
}
BUILDING.set(settings.buildingColor)
SUN.set(settings.sunColor)
ROAD_COLOR.set(settings.roadColor)
SIDEWALK_COLOR.set(settings.sidewalkColor)
SKY_LIGHT.set(settings.skyLightColor)

// Éclaircissement de l'horizon : la ville se fond dans un ciel un peu plus
// clair que son zénith, et le brouillard suit la même teinte.
const HORIZON_LIFT = 0.35

function applySkyColor() {
  SKY.set(settings.skyColor)
  HORIZON.copy(SKY).lerp(new THREE.Color('#ffffff'), HORIZON_LIFT)
}
applySkyColor()

// Réglages de génération : toute modification régénère la ville
const city = {
  density: 0.85,           // probabilité qu'une parcelle soit bâtie
  thickness: 0.79,         // part de la parcelle occupée au sol
  thicknessVariation: 0.26,// écart d'épaisseur entre voisins
  minHeight: 1,            // hauteur des petits immeubles
  maxHeight: 42,           // hauteur des gratte-ciel
  verticality: 4.1,        // >1 : rares tours très hautes sur fond de bâti bas
  towerRatio: 0.14,        // proportion d'immeubles à étage en retrait
  sidewalkHeight: 0.1,     // épaisseur de la dalle sur laquelle repose le bâti
  billboardFrequency: 0.2, // proportion d'immeubles portant un panneau
}

// Type de pointeur, relevé une fois : il ne change pas en cours de partie et
// plusieurs décisions d'interface en dépendent.
const COARSE = matchMedia('(pointer: coarse)').matches

/* ---------- Paliers de qualité ---------- */
// Le jeu est dimensionné pour un GPU de bureau : 4096² d'ombre, 81 chunks de
// ville, seize cents lampadaires. Un téléphone d'entrée de gamme n'a aucune
// chance, et il n'existe pas de liste fiable d'appareils pour le deviner.
// On mesure donc, et on descend d'un cran tant que ça ne suit pas.
//
// Chaque palier baisse PLUSIEURS leviers à la fois : sur une image trop
// lourde, diviser un seul poste par deux ne se voit pas — c'est le cumul qui
// ramène dans le budget.
// `maxVideos` plafonne le nombre de vidéos lues EN MÊME TEMPS. C'est un coût
// de processeur, pas de GPU : un décodeur matériel d'entrée de gamme ne tient
// qu'un ou deux flux, au-delà il bascule en logiciel et s'effondre. Baisser
// la résolution n'y change rien — d'où sa présence au barème.
const QUALITY_LEVELS = [
  { pixelRatio: 1.5, shadows: true, shadowSize: 4096, viewRadius: 4, fogFar: 300, lampRadius: 2, maxVideos: 5 },
  { pixelRatio: 1.25, shadows: true, shadowSize: 2048, viewRadius: 4, fogFar: 300, lampRadius: 2, maxVideos: 4 },
  { pixelRatio: 1.0, shadows: true, shadowSize: 1024, viewRadius: 3, fogFar: 250, lampRadius: 1, maxVideos: 3 },
  { pixelRatio: 0.85, shadows: false, shadowSize: 1024, viewRadius: 3, fogFar: 250, lampRadius: 1, maxVideos: 2 },
  { pixelRatio: 0.7, shadows: false, shadowSize: 1024, viewRadius: 2, fogFar: 150, lampRadius: -1, maxVideos: 1 },
]

// Tout le monde démarre en haut. Rétrograder les tactiles en bloc punissait
// les téléphones qui tenaient très bien le palier maximum — c'est précisément
// ce que la mesure est là pour éviter : on ne présume pas, on constate.
const QUALITY_START = 0
const QUALITY_MIN_FPS = 26      // en deçà, on considère que ça ne suit pas
const QUALITY_DIRE_FPS = 15     // en deçà, il y a urgence : on saute des crans
const QUALITY_GOOD_FPS = 48     // au-dessus, il reste du budget à reprendre
const QUALITY_PATIENCE = 2      // secondes sous le seuil avant de descendre
const QUALITY_CLIMB_PATIENCE = 6 // secondes de confort avant de remonter
const QUALITY_GRACE = 3         // secondes de répit après un changement
// Gain minimum attendu d'une baisse. En deçà, c'est que le goulot n'était pas
// la qualité : continuer à dégrader ne ferait qu'abîmer l'image pour rien.
const QUALITY_PAYOFF = 1.15

let qualityHold = 0      // temps passé sous le seuil, ou répit si négatif
let qualityComfort = 0   // temps passé au-dessus du seuil de confort
let qualityLimit = 0     // meilleur palier encore autorisé
let qualityStuck = false // une baisse n'a rien rapporté : on cesse de descendre
let qualityProbe = null  // { level, fps } de la dernière baisse, à valider

// Seuil au-delà duquel on prévient le joueur : à ce stade, l'appareil a déjà
// renoncé aux ombres et à la moitié de la ville. Ce n'est plus un réglage,
// c'est un constat.
const WEAK_QUALITY = 2
// Le message n'est pas posé au moment où le palier tombe, mais seulement
// s'il s'y maintient. Le gouverneur révoque une baisse qui n'a rien rapporté :
// annoncer un appareil trop faible pour le démentir trois secondes plus tard
// serait pire que de ne rien dire.
const WEAK_SETTLE = 5 // secondes passées sous le seuil avant d'avertir
const weakElement = document.querySelector('#weak')
let weakTime = 0
let weakDismissed = false

function updateWeakNotice(elapsed) {
  if (settings.quality <= WEAK_QUALITY) {
    // Remonté au-dessus du seuil : le constat n'a plus lieu d'être.
    weakTime = 0
    weakElement.classList.remove('is-visible')
    return
  }
  if (weakDismissed) return
  weakTime += elapsed
  if (weakTime >= WEAK_SETTLE) weakElement.classList.add('is-visible')
}

document.querySelector('#weak-close').addEventListener('click', () => {
  weakDismissed = true
  weakElement.classList.remove('is-visible')
})

function applyQuality(level) {
  const clamped = THREE.MathUtils.clamp(Math.round(level), 0, QUALITY_LEVELS.length - 1)
  settings.quality = clamped
  Object.assign(settings, QUALITY_LEVELS[clamped])

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio))
  renderer.shadowMap.enabled = settings.shadows
  sunLight.shadow.mapSize.set(settings.shadowSize, settings.shadowSize)
  // La carte est déjà allouée : il faut la jeter pour que three la recrée.
  sunLight.shadow.map?.dispose()
  sunLight.shadow.map = null
  cityFog.far = settings.fogFar
  // Couper les ombres change le programme compilé : sans invalidation, la
  // scène garde l'ancien rendu jusqu'au prochain matériau touché.
  scene.traverse((o) => {
    if (o.material) o.material.needsUpdate = true
  })
  qualityController?.updateDisplay()
}

// Appelé une fois par fenêtre de mesure du compteur, avec sa moyenne.
function governQuality(fps, elapsed) {
  updateWeakNotice(elapsed)
  if (!settings.qualityAuto) return

  // Répit après un changement : la mesure n'a pas encore de sens.
  if (qualityHold < 0) {
    qualityHold += elapsed
    return
  }

  // Rendement de la dernière baisse. C'est le garde-fou qui manquait : une
  // image bridée par le système, un pilote lent ou un décodeur saturé ne
  // s'améliorent pas d'un pixel en moins. Sans cette vérification, le jeu
  // dégringolait jusqu'au palier le plus laid pour exactement zéro gain.
  if (qualityProbe) {
    const probe = qualityProbe
    qualityProbe = null
    if (fps < probe.fps * QUALITY_PAYOFF) {
      applyQuality(probe.level)
      qualityStuck = true
      showNotice('Qualité rétablie')
      qualityHold = -QUALITY_GRACE
      return
    }
    // La baisse a payé : le palier qu'on vient de quitter est hors de portée
    // de cet appareil, on ne cherchera plus à y revenir.
    qualityLimit = probe.level + 1
  }

  if (fps < QUALITY_MIN_FPS) {
    qualityComfort = 0
    if (qualityStuck || settings.quality >= QUALITY_LEVELS.length - 1) return
    qualityHold += elapsed
    // À dix images par seconde, un cran toutes les deux secondes demanderait
    // une demi-minute pour toucher le fond. On saute d'autant que le retard
    // est grand, et sans attendre.
    const dire = fps < QUALITY_DIRE_FPS
    if (!dire && qualityHold < QUALITY_PATIENCE) return

    qualityProbe = { level: settings.quality, fps }
    applyQuality(settings.quality + (dire ? 2 : 1))
    showNotice(`Qualité réduite (${settings.quality}/${QUALITY_LEVELS.length - 1})`)
    qualityHold = -QUALITY_GRACE
    return
  }

  qualityHold = 0
  // Le jeu respire de nouveau : si une baisse avait été jugée inutile, c'est
  // que les conditions ont changé depuis — batterie rebranchée, appareil
  // refroidi. On lui rend le droit de redescendre le jour où il faudra.
  if (fps >= QUALITY_GOOD_FPS) qualityStuck = false

  // Remontée. Elle n'est tentée que bien au-dessus du seuil de chute, et
  // jamais au-delà d'un palier déjà jugé hors de portée : c'est ce qui
  // empêche l'oscillation entre deux crans.
  if (fps < QUALITY_GOOD_FPS || settings.quality <= qualityLimit) {
    qualityComfort = 0
    return
  }
  qualityComfort += elapsed
  if (qualityComfort < QUALITY_CLIMB_PATIENCE) return
  qualityComfort = 0
  applyQuality(settings.quality - 1)
  showNotice(`Qualité rétablie (${settings.quality}/${QUALITY_LEVELS.length - 1})`)
  qualityHold = -QUALITY_GRACE
}


const canvas = document.querySelector('#scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
// Plafond de densité de pixels. Sur un écran retina, 2 contre 1,5 c'est
// presque deux fois plus de pixels à remplir à chaque image — c'est le poste
// le plus lourd d'un rendu plein écran, et l'antialiasing masque l'essentiel
// de la différence.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio))
renderer.shadowMap.enabled = true
// Le filtrage ne rend pas l'ombre floue, il lisse l'escalier de texels sur
// son bord. Sans lui, le contour épouse la grille de la carte de profondeur
// et se découpe en marches — c'est le crénelage, pas de la netteté. La
// finesse réelle du bord ne tient qu'à la densité de texels, réglée plus bas
// par la définition de la carte et le cadrage de sa caméra.
// PCFSoftShadowMap est retiré depuis three r186 et retombe silencieusement
// sur celui-ci : autant le nommer, plutôt que de lire un avertissement en
// console à chaque démarrage.
renderer.shadowMap.type = THREE.PCFShadowMap

const scene = new THREE.Scene()

// Tout ce qui constitue la ville vit dans ce groupe : il permet de la faire
// descendre d'un bloc pendant la transition de portail, sans toucher au ciel,
// aux lumières ni à la caméra.
const world = new THREE.Group()
scene.add(world)
// Le brouillard fond la ville dans le ciel : la limite de chargement des
// chunks n'est jamais visible, contrairement à une coupure nette.
const cityFog = new THREE.Fog(HORIZON, 45, 300)
scene.fog = cityFog

/* ---------- Caméra immersive ---------- */
// Perspective à hauteur d'homme, orientée par un couple lacet / tangage.
// L'ordre YXZ évite le roulis parasite quand on cumule les deux rotations.
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200)
camera.rotation.order = 'YXZ'
scene.add(camera)

// Position affichée de la voiture (interpolée entre deux pas de simulation)
const carPosition = new THREE.Vector3(0, 0, 0) // démarrage sur un croisement

let yaw = -Math.PI / 4 // orientation dans le plan horizontal
const _pivot = new THREE.Vector3() // point visé : au-dessus de la voiture
const _back = new THREE.Vector3()

// Caméra de poursuite : l'orientation vient de la souris, la position en
// découle (on recule le long de l'axe de visée). La voiture reste donc
// toujours au centre de l'image, quel que soit l'angle.
function applyCameraOrientation() {
  camera.rotation.y = yaw
  // Le regard porte l'inclinaison de poursuite ET le relèvement de l'espace
  // blanc ; la position, elle, ne connaît que la première — voir placeCamera.
  camera.rotation.x = THREE.MathUtils.degToRad(settings.cameraPitch + whiteGaze)
  placeCamera()
}

// Écart résiduel entre la pose réelle et la pose de poursuite, résorbé après
// une transition pour que la caméra ne se téléporte jamais.
const cameraOffset = new THREE.Vector3()

function placeCamera() {
  if (portal) return // la caméra est pilotée par la transition
  _pivot.set(carPosition.x, city.sidewalkHeight + settings.cameraHeight, carPosition.z)

  // Le bras est mesuré sur la seule inclinaison de poursuite : relever le
  // regard dans l'espace blanc ne doit pas faire reculer ni descendre la
  // caméra. On neutralise donc le relèvement le temps de lire la direction,
  // plutôt que de recalculer un vecteur à la main — l'ordre d'Euler de la
  // caméra est ainsi respecté quoi qu'il arrive.
  const gaze = camera.rotation.x
  camera.rotation.x = THREE.MathUtils.degToRad(settings.cameraPitch)
  camera.getWorldDirection(_back).multiplyScalar(-1)
  camera.rotation.x = gaze

  // Spring arm : le bras se rétracte si un immeuble s'intercale entre la
  // voiture et la caméra, au lieu de laisser la caméra passer au travers.
  const reach = springArm(_pivot, _back, settings.cameraDistance)
  camera.position.copy(_pivot).addScaledVector(_back, reach).add(cameraOffset)
  clampAboveGround(camera.position)
}

// Le bras de caméra évite les immeubles ; le sol est un plan infini qu'aucun
// raycast ne couvre, il faut donc le traiter à part.
const CAMERA_FLOOR = 0.8
function clampAboveGround(p) {
  const floor = city.sidewalkHeight + CAMERA_FLOOR
  if (p.y < floor) p.y = floor
}

// Regard au clavier : les flèches orientent la caméra. Dès qu'on les relâche,
// elle revient d'elle-même derrière la voiture — elle la suit par défaut, on
// ne la « pilote » que ponctuellement pour jeter un œil autour.
const YAW_RATE = 1.9       // rad/s
const PITCH_RATE = 70      // degrés/s
const MAX_PITCH = 80       // pour ne pas basculer par-dessus la verticale
const LOOK_SMOOTH = 6      // inertie de la caméra au départ et à l'arrêt
const LOOK_IDLE = 0.45     // secondes sans entrée avant le retour automatique
const FOLLOW_SMOOTH = 3.2  // vitesse de réalignement derrière la voiture
const DEFAULT_PITCH = settings.cameraPitch

// Les flèches ne pilotent pas l'angle directement mais une vitesse de
// rotation, elle-même lissée : la caméra démarre et s'arrête en douceur au
// lieu de claquer d'un cran à chaque appui.
let yawVelocity = 0
let pitchVelocity = 0
let lookIdle = LOOK_IDLE // temps écoulé depuis la dernière entrée clavier

function updateLook(delta) {
  if (portal || gameOver || falling || paused) return // séquences qui gardent la caméra

  const turn =
    (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0) -
    (axis(lookStick.x) || pad.lookX)
  const tilt =
    (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0) -
    (axis(lookStick.y) || pad.lookY)
  if (turn || tilt) {
    lookIdle = 0
    framingBlend = null // une entrée de l'utilisateur annule tout recadrage
  } else {
    lookIdle += delta
  }

  const k = 1 - Math.exp(-LOOK_SMOOTH * delta)
  yawVelocity += (turn * YAW_RATE - yawVelocity) * k
  pitchVelocity += (tilt * PITCH_RATE - pitchVelocity) * k

  // Seuil d'arrêt : sans lui, la rotation traîne indéfiniment vers zéro
  if (Math.abs(yawVelocity) < 1e-3 && Math.abs(pitchVelocity) < 1e-2) return

  yaw += yawVelocity * delta
  settings.cameraPitch = THREE.MathUtils.clamp(
    settings.cameraPitch + pitchVelocity * delta,
    -MAX_PITCH,
    MAX_PITCH
  )
  pitchController?.updateDisplay()
  applyCameraOrientation()
}

// Suivi automatique : la caméra se replace dans l'axe de la voiture, vue de
// l'arrière. Le lacet cible suit le cap en continu, donc elle accompagne les
// virages au lieu d'attendre l'arrêt du véhicule.
// Seuil en deçà duquel on considère que le joueur lit l'écran plutôt qu'il
// ne conduit. La caméra de poursuite existe pour suivre un mouvement : sans
// mouvement, elle n'a rien à suivre.
const WHITE_PARKED_SPEED = 1.2

// Regard arrière, comme dans GTA : tant que C ou le clic du stick droit est
// maintenu, la caméra passe d'un coup devant la voiture et regarde derrière
// elle, puis revient d'un coup en poursuite au relâchement.
let lookingBack = false

function updateFollowCamera(delta) {
  if (portal || gameOver || falling || paused || framingBlend) return // recadrages prioritaires

  // Dans l'espace blanc, à l'arrêt, le recentrage derrière la voiture n'a
  // aucun sens : il ramenait la caméra au cadrage neutre à chaque fois que
  // l'aimant lâchait un CTA, et c'est ce détour par le centre qu'on voyait
  // en passant d'un bouton à l'autre. Dès qu'on roule, il reprend la main.
  if (whiteSpace && Math.abs(speed) < WHITE_PARKED_SPEED) return

  const back = keys.has('KeyC') || pad.lookBack
  if (back || lookingBack) {
    lookingBack = back
    // Caméra orientée selon -Z : lacet égal au cap = elle fait face à la
    // voiture depuis l'avant ; cap + PI = poursuite par l'arrière
    yaw = carHeading + (back ? 0 : Math.PI)
    settings.cameraPitch = DEFAULT_PITCH
    lookIdle = LOOK_IDLE // le retour en poursuite ne doit pas attendre
    yawVelocity = pitchVelocity = 0
    pitchController?.updateDisplay()
    applyCameraOrientation()
    return
  }

  if (lookIdle < LOOK_IDLE) return // une flèche vient d'être pressée : on la laisse faire

  const k = 1 - Math.exp(-FOLLOW_SMOOTH * delta)

  // La caméra regarde selon -Z : être derrière la voiture, donc alignée sur
  // son cap, correspond à un lacet décalé de PI.
  let diff = ((carHeading + Math.PI - yaw + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2

  const pitchGap = DEFAULT_PITCH - settings.cameraPitch
  if (Math.abs(diff) < 1e-4 && Math.abs(pitchGap) < 1e-3) return

  yaw += diff * k
  settings.cameraPitch += pitchGap * k
  pitchController?.updateDisplay()
  applyCameraOrientation()
}

// Retour progressif au cadrage mémorisé, après la sortie d'un portail
const FRAMING_RETURN = 1.1  // secondes
const WHITE_EXIT_PITCH = -18 // plongée du cadrage d'arrivée, en degrés
// Dans l'espace blanc, la caméra relève le regard sans bouger d'un pouce :
// la scène descend à l'écran et dégage le haut, où vivent le titre et les
// boutons, mais le cadrage reste celui de la poursuite, derrière la voiture.
const WHITE_GAZE_SMOOTH = 2.4 // résorption de l'écart, par seconde
let whiteGaze = 0
const FRAMING_DECAY = 2.6  // résorption de l'écart de position
let framingBlend = null

function updateFraming(delta) {
  // Le relèvement s'installe et se retire en fondu : posé d'un coup, il
  // ferait sauter le cadrage à l'entrée comme à la sortie.
  const gazeTarget = whiteSpace ? settings.whiteCameraGaze : 0
  whiteGaze += (gazeTarget - whiteGaze) * (1 - Math.exp(-WHITE_GAZE_SMOOTH * delta))
  if (Math.abs(gazeTarget - whiteGaze) > 1e-3) applyCameraOrientation()

  // L'écart de position se résorbe même après la fin du recadrage angulaire
  if (cameraOffset.lengthSq() > 1e-4) {
    cameraOffset.multiplyScalar(Math.exp(-FRAMING_DECAY * delta))
  } else {
    cameraOffset.set(0, 0, 0)
  }

  if (!framingBlend) return
  framingBlend.elapsed += delta
  const t = ease.outExpo(Math.min(1, framingBlend.elapsed / FRAMING_RETURN))

  // La caméra regarde selon -Z : être derrière la voiture, donc alignée sur
  // son cap, correspond à un lacet décalé de PI.
  const targetYaw = framingBlend.chase ? carHeading + Math.PI : framingBlend.yaw

  // Plus court chemin angulaire, sinon un demi-tour parasite est possible
  let diff = ((targetYaw - yaw + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  yaw += diff * t
  settings.cameraPitch += (framingBlend.pitch - settings.cameraPitch) * t

  if (framingBlend.elapsed >= FRAMING_RETURN) framingBlend = null
  pitchController?.updateDisplay()
  applyCameraOrientation()
}

// Tout ce qui doit "suivre" la caméra pour donner l'illusion de l'infini
function follow() {
  if (whiteSpace) {
    // Sol infini : on le recentre sous la voiture, comme le sol de la ville
    whiteGround.position.set(carPosition.x, 0, carPosition.z)
    sunLight.target.position.set(carPosition.x, 0, carPosition.z)
    sunLight.position.copy(sunLight.target.position).add(sunOffset)
    return
  }

  sky.position.copy(camera.position)
  cameraTarget(_target)
  ground.position.set(_target.x, 0, _target.z)
  sunLight.target.position.set(_target.x, 0, _target.z)
  sunLight.position.copy(_target).add(sunOffset)
}

/* ---------- Ciel : dégradé + soleil ---------- */
const skyMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uSkyTop: { value: SKY },
    uSkyBottom: { value: HORIZON },
    uSunColor: { value: SUN },
    uSunDirection: { value: new THREE.Vector3() },
    uSunGlow: { value: settings.showSun ? 1 : 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldDirection;
    void main() {
      vWorldDirection = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSkyTop;
    uniform vec3 uSkyBottom;
    uniform vec3 uSunColor;
    uniform vec3 uSunDirection;
    uniform float uSunGlow;
    varying vec3 vWorldDirection;

    void main() {
      vec3 dir = normalize(vWorldDirection);

      // Dégradé vertical
      float h = smoothstep(-0.15, 0.75, dir.y);
      vec3 color = mix(uSkyBottom, uSkyTop, h);

      // Halo + disque solaire. Les deux s'éteignent ensemble : un halo sans
      // disque ne serait qu'une tache lumineuse creuse au milieu du ciel.
      float d = dot(dir, normalize(uSunDirection));
      float halo = pow(max(d, 0.0), 48.0);
      float disc = smoothstep(0.9965, 0.9985, d);
      color = mix(color, uSunColor, halo * 0.75 * uSunGlow);
      color = mix(color, uSunColor, disc * uSunGlow);

      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `,
})
// Le ciel est accroché à la caméra : il ne peut donc jamais être "atteint"
const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 32), skyMaterial)
sky.frustumCulled = false
scene.add(sky)

/* ---------- Espace blanc ---------- */
// Décor d'arrivée, une fois le masque entièrement ouvert : un sol infini et
// un fond unis. La matière ne renvoie que la moitié de la lumière reçue,
// pour que le blanc reste lisible au lieu de saturer.
const WHITE_SPACE_COLOR = new THREE.Color(0xffffff)
const whiteGround = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.5, // diffusion atténuée de moitié
    roughness: 1,
    metalness: 0,
  })
)
whiteGround.rotation.x = -Math.PI * 0.5
whiteGround.receiveShadow = true
whiteGround.visible = false
scene.add(whiteGround)

// Le sol est un plan plein qui suit la voiture : impossible d'y découper un
// trou en géométrie, puisqu'il glisse en permanence. On perce donc au
// fragment, sur une position monde passée en uniform — le puits est alors
// réellement évidé et on voit dedans.
const whiteGroundHole = { value: new THREE.Vector4(0, 0, 0, 0) } // x, z, rayon, actif
whiteGround.material.onBeforeCompile = (shader) => {
  shader.uniforms.uHole = whiteGroundHole
  shader.vertexShader = shader.vertexShader
    .replace('void main() {', 'varying vec2 vGroundXZ;\nvoid main() {')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;'
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', 'uniform vec4 uHole;\nvarying vec2 vGroundXZ;\nvoid main() {')
    .replace(
      '#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\nif (uHole.w > 0.5 && distance(vGroundXZ, uHole.xy) < uHole.z) discard;'
    )
}


let whiteSpace = false
let whiteProject = 0 // index du projet dont on a franchi le panneau

/* ---------- Sol ---------- */
// Un seul plan géant recentré sur la caméra à chaque frame : sol infini, couleur unie
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  new THREE.MeshStandardMaterial({ color: GROUND, roughness: 0.9, metalness: 0 })
)
ground.rotation.x = -Math.PI * 0.5
ground.receiveShadow = true
world.add(ground)

/* ---------- Paramètres de la ville ---------- */
const BLOCK = 12                      // côté d'un bloc bâti
const ROAD = 14                       // largeur de rue
const CELL = BLOCK + ROAD             // pas de la grille
const BLOCKS_PER_CHUNK = 4            // blocs par côté de chunk
const CHUNK = BLOCKS_PER_CHUNK * CELL // côté d'un chunk en unités monde
const PLOTS = 2                       // parcelles par côté de bloc
const BILLBOARD_THICKNESS = 0.14      // épaisseur des panneaux
const BILLBOARD_RATIO = 9 / 16        // les panneaux sont toujours en 16:9
const PORTAL_MIN_WIDTH = 3.4          // largeur mini pour laisser entrer la voiture
const PORTAL_DEPTH = 2.2              // profondeur de la zone de déclenchement, DEVANT le panneau


/* ---------- Bruit déterministe ---------- */
// Hash 2D entier -> [0,1). Même coordonnée = même valeur, pour toujours :
// c'est ce qui rend la génération seamless entre chunks et stable dans le temps.
function hash(x, y, salt) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + salt * 2147483647
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/* ---------- Ressources partagées ---------- */
const boxGeometry = new THREE.BoxGeometry(1, 1, 1)
boxGeometry.translate(0, 0.5, 0) // pivot au pied de l'immeuble

// color blanc : les couleurs d'instance (setColorAt) sont multipliées par-dessus.
// Surtout PAS vertexColors ici — la BoxGeometry n'a pas d'attribut `color`.
const buildingMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.75,
  metalness: 0,
})

const roadMaterial = new THREE.MeshStandardMaterial({ color: ROAD_COLOR, roughness: 1 })
const sidewalkMaterial = new THREE.MeshStandardMaterial({ color: SIDEWALK_COLOR, roughness: 0.95 })

// Panneaux publicitaires : chaque panneau porte le média d'en-tête d'un projet.
// Caisson lumineux : la face est émissive, donc lisible quelle que soit
// l'heure ou l'orientation — elle ne dépend plus de l'éclairage de la scène.
const billboardGeometry = new THREE.BoxGeometry(1, 1, 1) // pivot au centre

// Tranche du caisson : commune à tous les panneaux, projets comme marque.
// Tranches des panneaux. Deux teintes, et non une seule : le noir de charte
// cerne les médias des projets sans leur disputer l'attention, tandis que le
// bleu foncé des panneaux de marque prolonge leurs propres fonds.
function edgeMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.35,
    roughness: 0.4,
  })
}

const billboardEdgeMaterial = edgeMaterial('#1E1E1E')
const brandEdgeMaterial = edgeMaterial('#364B9E')

// Recadrage `object-fit: cover` : le média garde ses proportions et déborde
// sur l'axe le plus long, qui est rogné symétriquement. Sans ça une vidéo
// verticale serait écrasée dans le 16:9 du panneau.
const PANEL_ASPECT = 1 / BILLBOARD_RATIO // 16/9
function coverTexture(texture, width, height) {
  if (!width || !height) return
  const aspect = width / height
  if (aspect > PANEL_ASPECT) {
    texture.repeat.set(PANEL_ASPECT / aspect, 1)
    texture.offset.set((1 - texture.repeat.x) / 2, 0)
  } else {
    texture.repeat.set(1, aspect / PANEL_ASPECT)
    texture.offset.set(0, (1 - texture.repeat.y) / 2)
  }
  texture.needsUpdate = true
}

function panelTexture(map) {
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = THREE.ClampToEdgeWrapping
  map.wrapT = THREE.ClampToEdgeWrapping
  // Le recadrage cover déplace les UV : sans mipmaps ni répétition, un simple
  // filtrage linéaire suffit et évite de régénérer la pyramide à chaque frame.
  map.minFilter = THREE.LinearFilter
  map.generateMipmaps = false
  return map
}

// Gestionnaire commun à tous les chargeurs : il compte les requêtes en cours
// et permet d'afficher une vraie progression, plutôt qu'une barre décorative.
const loadingManager = new THREE.LoadingManager()
const textureLoader = new THREE.TextureLoader(loadingManager)

// Un matériau par projet. La face avant du caisson (groupe 4 de la BoxGeometry,
// soit +Z) porte le média ; les cinq autres gardent la tranche blanche.
// Chaque projet n'a qu'UNE vidéo, partagée par toutes les instances de son
// panneau dans la ville. Le poster s'affiche immédiatement ; la vidéo n'est
// téléchargée que lorsqu'un de ces panneaux s'approche du véhicule, et elle
// est mise en pause dès qu'ils s'en éloignent tous. Voir updatePanelVideos.
const panelVideos = PROJECTS.map((project) => ({
  project,
  material: null,
  poster: null,
  video: null,     // l'élément <video>, créé à la demande
  texture: null,   // la VideoTexture, tant que la vidéo est chargée
  playing: false,
  distance: Infinity,
}))

const projectMaterials = PROJECTS.map((project, index) => {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    roughness: 0.4,
    side: THREE.DoubleSide,
  })

  // Le poster s'affiche tout de suite, la vidéo prend le relais quand elle
  // a de quoi jouer : jamais de panneau noir en attendant le réseau. Il est
  // conservé, et non libéré : c'est lui qu'on réaffiche quand la vidéo est
  // relâchée, et le retélécharger à chaque aller-retour serait absurde.
  const poster = panelTexture(textureLoader.load(asset(project.poster), (t) => {
    // Recadré sans condition : il reprend du service à chaque libération de
    // la vidéo, bien après ce chargement. Le conditionner à son affichage du
    // moment le laissait en UV plein cadre, donc déformé, au retour.
    coverTexture(t, t.image.width, t.image.height)
  }))
  material.map = poster
  material.emissiveMap = poster

  const entry = panelVideos[index]
  entry.material = material
  entry.poster = poster

  return [
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    material, // +Z : la face visible depuis la rue
    billboardEdgeMaterial,
  ]
})

/* ---------- Panneaux de marque ---------- */
// Les panneaux en hauteur sont hors d'atteinte : annoncer un projet qu'on ne
// pourra jamais franchir n'aurait pas de sens. Ils portent donc la marque,
// tirée au sort entre deux formats de logo et trois fonds de charte.
//
// Les appariements ne sont pas libres : le jaune et le gris clair ne
// supportent que l'encre noire, le bleu foncé que le logo blanc.
const BRAND_SURFACES = [
  { bg: '#364B9E', ink: '#F6F6F6' }, // bleu foncé, logo blanc
  { bg: '#F2FF28', ink: '#1E1E1E' }, // jaune, logo noir
  { bg: '#CFD0D2', ink: '#1E1E1E' }, // gris clair, logo noir
]
const BRAND_LOGOS = ['logo-absolu.svg', 'logo-absolu-compact.svg']
const BRAND_VARIANTS = BRAND_SURFACES.length * BRAND_LOGOS.length
const BRAND_CANVAS_W = 1024 // 16:9, les proportions du panneau
const BRAND_FILL = 0.62     // part du panneau occupée par le logo

const brandMaterials = []

function brandMaterial(variant) {
  if (brandMaterials[variant]) return brandMaterials[variant]

  const surface = BRAND_SURFACES[variant % BRAND_SURFACES.length]
  const logoUrl = BRAND_LOGOS[Math.floor(variant / BRAND_SURFACES.length)]

  const canvas = document.createElement('canvas')
  canvas.width = BRAND_CANVAS_W
  canvas.height = Math.round(BRAND_CANVAS_W / PANEL_ASPECT)
  const ctx = canvas.getContext('2d')
  // Le fond est peint tout de suite : le panneau a sa couleur avant même que
  // le logo n'arrive, au lieu de rester noir le temps du réseau.
  ctx.fillStyle = surface.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const texture = panelTexture(new THREE.CanvasTexture(canvas))
  const face = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    roughness: 0.4,
    side: THREE.DoubleSide,
    map: texture,
    emissiveMap: texture,
  })

  // Vu de dos, le panneau n'est qu'un aplat de sa propre couleur : le même
  // fond, sans le logo.
  const back = new THREE.MeshStandardMaterial({
    color: surface.bg,
    emissive: surface.bg,
    emissiveIntensity: 0.6,
    roughness: 0.4,
  })

  // Un matériau par face, comme les panneaux de projet. Appliquer la texture
  // au volume entier — ce qu'on faisait — la comprimait sur les tranches, où
  // le logo se retrouvait écrasé, et la répétait à l'envers au dos.
  const materials = [
    brandEdgeMaterial,
    brandEdgeMaterial,
    brandEdgeMaterial,
    brandEdgeMaterial,
    face, // +Z : la face visible depuis la rue
    back,
  ]
  brandMaterials[variant] = materials

  const image = new Image()
  image.onload = () => {
    // Le fichier est fourni en blanc : pour l'encrer en noir il faut repeindre
    // sa seule silhouette, dans un canvas à part. Le faire sur le panneau
    // lui-même recouvrirait aussi le fond.
    const stamp = document.createElement('canvas')
    stamp.width = image.width
    stamp.height = image.height
    const sctx = stamp.getContext('2d')
    sctx.drawImage(image, 0, 0)
    sctx.globalCompositeOperation = 'source-in'
    sctx.fillStyle = surface.ink
    sctx.fillRect(0, 0, stamp.width, stamp.height)

    const scale = Math.min(
      (canvas.width * BRAND_FILL) / stamp.width,
      (canvas.height * BRAND_FILL) / stamp.height
    )
    const w = stamp.width * scale
    const h = stamp.height * scale
    ctx.drawImage(stamp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    texture.needsUpdate = true
  }
  image.src = asset(logoUrl)

  return materials
}

/* ---------- Diffusion des vidéos de panneaux ---------- */
// Trois cercles concentriques autour du véhicule, et non un seul seuil : si
// charger et jouer se décidaient au même rayon, la vidéo commencerait toujours
// par un à-coup, le temps que le réseau réponde. Elle est donc téléchargée
// bien avant d'être vue, et n'est relâchée que loin derrière, pour qu'un
// demi-tour ne provoque pas un nouveau téléchargement.
const VIDEO_PLAY_RADIUS = 95     // en deçà, la vidéo joue
const VIDEO_PRELOAD_RADIUS = 150 // en deçà, elle est téléchargée
const VIDEO_RELEASE_RADIUS = 260 // au-delà, la mémoire est rendue
const VIDEO_SCAN_EVERY = 0.35    // secondes entre deux relevés de distance
// Au-delà, inutile de chercher : c'est déjà plus loin que le rayon de rejet
const VIDEO_SCAN_REACH = Math.ceil(VIDEO_RELEASE_RADIUS / CELL)

let videoScan = 0
let videosUnlocked = false // la lecture exige un geste préalable du visiteur

function createPanelVideo(entry) {
  const video = document.createElement('video')
  video.src = asset(entry.project.video)
  video.loop = true
  video.muted = true // sans quoi l'autoplay est refusé par le navigateur
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  entry.video = video

  video.addEventListener('loadeddata', () => {
    if (entry.video !== video) return // relâchée entre-temps
    const map = panelTexture(new THREE.VideoTexture(video))
    coverTexture(map, video.videoWidth, video.videoHeight)
    // Par défaut, une VideoTexture se téléverse à CHAQUE image, même sur une
    // vidéo en pause : ce serait autant de transferts par image pour des
    // trames identiques. On ne la renouvelle donc que pendant la lecture —
    // mais il faut bien en téléverser UNE, sinon le panneau reste vide entre
    // le chargement et l'entrée dans la zone de lecture, et l'on n'y voit ni
    // la vidéo ni le poster qu'elle vient de remplacer.
    let painted = false
    map.update = function () {
      if (video.readyState < video.HAVE_CURRENT_DATA) return
      if (video.paused && painted) return
      painted = true
      this.needsUpdate = true
    }
    entry.texture = map
    entry.material.map = map
    entry.material.emissiveMap = map
    entry.material.needsUpdate = true
  })
  video.load()
}

// Rend la mémoire : l'élément est détaché de sa source, la texture détruite,
// et le panneau revient à son poster.
function releasePanelVideo(entry) {
  if (!entry.video) return
  entry.video.pause()
  entry.video.removeAttribute('src')
  entry.video.load() // sans cela, Chrome garde le tampon de décodage
  entry.video = null
  entry.playing = false
  if (entry.texture) {
    entry.texture.dispose()
    entry.texture = null
  }
  entry.material.map = entry.poster
  entry.material.emissiveMap = entry.poster
  entry.material.needsUpdate = true
}

// Distance au panneau le plus proche, projet par projet. `eachBuilding` est
// une fonction pure : les panneaux se recalculent sans qu'il faille parcourir
// les chunks, et donc sans dépendre de ce qui est chargé à l'écran.
function scanPanelDistances() {
  panelVideos.forEach((entry) => (entry.distance = Infinity))

  const blockX = Math.floor(body.x / CELL)
  const blockZ = Math.floor(body.z / CELL)
  for (let bx = blockX - VIDEO_SCAN_REACH; bx <= blockX + VIDEO_SCAN_REACH; bx++) {
    for (let bz = blockZ - VIDEO_SCAN_REACH; bz <= blockZ + VIDEO_SCAN_REACH; bz++) {
      eachBuilding(bx, bz, (b) => {
        const p = b.billboard
        if (!p) return
        const entry = panelVideos[p.project]
        if (!entry) return
        const dx = p.x - body.x
        const dz = p.z - body.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < entry.distance) entry.distance = d
      })
    }
  }
}

function updatePanelVideos(delta) {
  // Dans l'espace blanc et pendant la traversée du portail, plus aucun
  // panneau n'est visible : tout se met en pause. L'espace blanc a ses
  // propres vidéos, il ne dépend plus de celles des panneaux.
  if (whiteSpace || portal) {
    panelVideos.forEach((entry) => {
      if (entry.video && !entry.video.paused) {
        entry.video.pause()
        entry.playing = false
      }
    })
    return
  }

  videoScan -= delta
  if (videoScan > 0) return
  videoScan = VIDEO_SCAN_EVERY
  scanPanelDistances()

  // Les plus proches d'abord : quand le plafond de lectures simultanées mord,
  // ce sont les panneaux que le joueur a sous les yeux qui gardent la vidéo,
  // les autres se figent sur leur dernière image sans qu'on le remarque.
  const playable = panelVideos
    .filter((entry) => entry.project.video && entry.distance <= VIDEO_PLAY_RADIUS)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, settings.maxVideos)

  panelVideos.forEach((entry) => {
    if (!entry.project.video) return // projet sans vidéo : le poster suffit
    const d = entry.distance

    if (d > VIDEO_RELEASE_RADIUS) return releasePanelVideo(entry)
    if (d <= VIDEO_PRELOAD_RADIUS && !entry.video) createPanelVideo(entry)
    if (!entry.video) return

    const shouldPlay = videosUnlocked && playable.includes(entry)
    if (shouldPlay && entry.video.paused) {
      entry.video.play().then(() => (entry.playing = true)).catch(() => {})
    } else if (!shouldPlay && !entry.video.paused) {
      entry.video.pause()
      entry.playing = false
    }
  })
}

// Nom du projet, peint en blanc sur le média du panneau. Les projets Absolu
// n'ont pas de logo détouré exploitable : c'est donc le nom qui identifie le
// panneau. Tout le mécanisme d'instanciation est inchangé — seule la source
// de la texture diffère, un canvas de texte au lieu d'un fichier.
const logoGeometry = new THREE.PlaneGeometry(1, 1)
const projectLabels = [] // { material, aspect, ready } par projet

const LABEL_FACE = "700 96px 'Instrument Serif'"
const LABEL_PAD = 36 // marge autour du texte, dans le canvas

function projectLabel(index) {
  if (projectLabels[index]) return projectLabels[index]

  const entry = {
    material: new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.95,
    }),
    aspect: 4,
    ready: false,
  }
  projectLabels[index] = entry

  const name = PROJECTS[index].name
  if (!name) return entry

  const paint = () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = LABEL_FACE
    const width = Math.ceil(ctx.measureText(name).width)
    canvas.width = width + LABEL_PAD * 2
    canvas.height = 96 + LABEL_PAD * 2
    // Redimensionner le canvas a réinitialisé le contexte : la police doit
    // être reposée, sinon le texte sort dans la fonte par défaut.
    ctx.font = LABEL_FACE
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Ombre portée franche : le nom se détache du média, quel qu'il soit
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
    ctx.shadowBlur = 12
    ctx.fillText(name, canvas.width / 2, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    entry.material.map?.dispose()
    entry.material.map = texture
    entry.material.needsUpdate = true
    entry.aspect = canvas.width / canvas.height
    entry.ready = true
    // Les chunks déjà construits ont été dimensionnés sur l'aspect par
    // défaut : on les recale maintenant que le texte est mesuré.
    refreshLabelInstances(index)
  }

  paint()
  // La mesure faite avant l'arrivée d'Instrument Serif porte sur la fonte de
  // repli : on repeint une fois la vraie police disponible.
  document.fonts?.load(LABEL_FACE).then(paint).catch(() => {})
  return entry
}

// Position et taille du libellé sur un panneau, partagées par la
// construction des chunks et le recalage après mesure du texte.
const LOGO_WIDTH = 0.62  // part de la largeur du panneau
const LOGO_MARGIN = 0.07 // marge basse, en part de la hauteur

function logoMatrix(billboard, aspect, out) {
  const w = billboard.w * LOGO_WIDTH
  const h = w / aspect
  const lift = -billboard.h / 2 + h / 2 + billboard.h * LOGO_MARGIN
  const front = billboard.thick / 2 + 0.02 // décollé de la face, pas de z-fighting
  return out.compose(
    _position.set(
      billboard.x + billboard.nx * front,
      city.sidewalkHeight + billboard.y + lift,
      billboard.z + billboard.nz * front
    ),
    _quat.setFromEuler(_euler.set(0, billboard.angle, 0)),
    _scale.set(w, h, 1)
  )
}

function refreshLabelInstances(projectIndex) {
  for (const chunk of chunks.values()) {
    chunk.userData.logos?.forEach((entry) => {
      if (entry.project !== projectIndex) return
      const aspect = projectLabels[projectIndex].aspect
      entry.items.forEach((b, i) => {
        entry.mesh.setMatrixAt(i, logoMatrix(b.billboard, aspect, _matrix))
      })
      entry.mesh.instanceMatrix.needsUpdate = true
    })
  }
}

// Trois raisons de devoir relancer la lecture : l'autoplay muet est refusé par
// certains navigateurs, un onglet en arrière-plan diffère le chargement des
// médias, et revenir sur l'onglet laisse les vidéos en pause.
// Le navigateur refuse toute lecture avant un geste du visiteur. On ne lance
// donc rien ici : on lève le verrou, et updatePanelVideos démarre les seules
// vidéos qui sont effectivement dans la zone de lecture.
function startPanelVideos() {
  videosUnlocked = true
}
window.addEventListener('pointerdown', startPanelVideos)
window.addEventListener('keydown', startPanelVideos)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) startPanelVideos()
})

// Longueur = CHUNK + ROAD : les bandes débordent légèrement pour que les
// croisements entre chunks voisins soient parfaitement bouchés.
const roadGeometry = new THREE.PlaneGeometry(ROAD, CHUNK + ROAD)

const FLAT_Z = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
const FLAT_X = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2))
const ONE = new THREE.Vector3(1, 1, 1)

const _matrix = new THREE.Matrix4()
const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _color = new THREE.Color()
const _quat = new THREE.Quaternion()
const WHITE = new THREE.Color('#ffffff')
const _euler = new THREE.Euler()


/* ---------- Génération du bâti d'un bloc ---------- */
// Fonction pure : mêmes coordonnées de bloc = mêmes immeubles. Elle sert à la
// fois au rendu (buildChunk) et aux collisions, qui partagent donc exactement
// la même géométrie sans qu'il faille la stocker.
function eachBuilding(blockX, blockZ, emit) {
  // Centre du bloc : la rue occupe la frontière, le bâti l'intérieur
  const centerX = blockX * CELL + CELL / 2
  const centerZ = blockZ * CELL + CELL / 2

  // "Densité urbaine" douce : des quartiers hauts et des quartiers bas
  const district = hash(Math.floor(blockX / 6), Math.floor(blockZ / 6), 7)

  const plotSize = BLOCK / PLOTS
  for (let px = 0; px < PLOTS; px++) {
    for (let pz = 0; pz < PLOTS; pz++) {
      const salt = px * 2 + pz
      if (hash(blockX, blockZ, 11 + salt) > city.density) continue // parcelle vide

      const x = centerX - BLOCK / 2 + plotSize * (px + 0.5)
      const z = centerZ - BLOCK / 2 + plotSize * (pz + 0.5)

      // Emprise au sol : épaisseur de base + variation par parcelle
      const vary = (hash(blockX, blockZ, 21 + salt) - 0.5) * city.thicknessVariation
      const ratio = THREE.MathUtils.clamp(city.thickness + vary, 0.25, 0.98)
      // Footprint non carré : des barres et des tours fines, pas que des cubes.
      // L'étirement est borné à la parcelle : sans ce clamp, ratio * stretch
      // peut dépasser 1 et l'immeuble déborde sur le trottoir puis sur la rue.
      const stretch = 0.7 + hash(blockX, blockZ, 51 + salt) * 0.6
      const MAX_FILL = 0.96 // laisse toujours un filet de trottoir
      const w = plotSize * Math.min(ratio * stretch, MAX_FILL)
      const d = plotSize * Math.min(ratio / stretch, MAX_FILL)

      // Courbe de puissance : la plupart des immeubles restent bas,
      // quelques-uns partent vraiment en gratte-ciel
      const t = Math.pow(hash(blockX, blockZ, 31 + salt), city.verticality)
      // Les quartiers denses tirent les hauteurs vers le haut
      const height = THREE.MathUtils.lerp(
        city.minHeight,
        city.maxHeight,
        t * (0.35 + district * 0.9)
      )

      const shade = 0.55 + hash(blockX, blockZ, 41 + salt) * 0.45

      // Panneau publicitaire, en volume, plaqué sur une façade, toujours en
      // 16:9. La majorité est posée à hauteur de rue et sert de portail :
      // la voiture doit pouvoir y entrer, ce qui impose une taille minimale.
      let billboard = null
      if (hash(blockX, blockZ, 91 + salt) < city.billboardFrequency) {
        // On ne garde que les façades tournées vers l'extérieur du bloc :
        // sur une face intérieure le panneau serait noyé dans le voisin.
        // 0 = +Z, 1 = +X, 2 = -Z, 3 = -X
        const face =
          hash(blockX, blockZ, 101 + salt) < 0.5 ? (px === 0 ? 3 : 1) : pz === 0 ? 2 : 0
        const alongX = face % 2 === 0 // façades ±Z : le panneau s'étend sur X
        const along = alongX ? w : d

        // Le ratio fixe le couple largeur/hauteur : une seule dimension à choisir
        const bw = along * 0.85
        const bh = bw * BILLBOARD_RATIO

        // Portail au sol : il faut une façade assez large ET un immeuble assez
        // haut pour abriter le panneau. Sinon on le renvoie sur le toit ; s'il
        // n'y tient pas non plus, l'immeuble n'en porte pas.
        const fitsAsPortal = bw >= PORTAL_MIN_WIDTH && height >= bh + 0.6
        const fitsOnTop = height >= bh * 1.6
        const atGround = fitsAsPortal && hash(blockX, blockZ, 111 + salt) < 0.75

        if (atGround || fitsOnTop) {
          const thick = BILLBOARD_THICKNESS
          const angle = (face * Math.PI) / 2
          const nx = Math.sin(angle)
          const nz = Math.cos(angle)
          const out = (alongX ? d : w) / 2 + thick / 2

          billboard = {
            face,
            angle,
            w: bw,
            h: bh,
            thick,
            x: x + nx * out,
            z: z + nz * out,
            // Au sol : posé sur le trottoir. En hauteur : ancré sous le toit.
            y: atGround ? bh / 2 + 0.05 : height - bh / 2 - Math.min(1.5, height * 0.08),
            ground: atGround,
            nx,
            nz,
            // Zone de déclenchement, plaquée DEVANT le panneau : le portail
            // s'amorce juste avant le contact, la voiture ne le touche jamais.
            tx: x + nx * (out + PORTAL_DEPTH / 2),
            tz: z + nz * (out + PORTAL_DEPTH / 2),
            thx: alongX ? bw / 2 : PORTAL_DEPTH / 2,
            thz: alongX ? PORTAL_DEPTH / 2 : bw / 2,
            // Projet affiché sur ce panneau, tiré lui aussi du hash. Il ne
            // sert qu'aux panneaux au sol : ceux en hauteur portent la marque.
            project: Math.floor(hash(blockX * 3 + 1, blockZ * 7 + 5, 121 + salt) * PROJECTS.length),
            // Déclinaison de marque des panneaux hors d'atteinte : format de
            // logo et fond, tirés du même hash déterministe que le reste.
            brand: atGround
              ? -1
              : Math.floor(hash(blockX * 5 + 3, blockZ * 11 + 7, 131 + salt) * BRAND_VARIANTS),
          }
        }
      }

      emit({ x, z, w, d, h: height, shade, billboard })

      // Étage en retrait : silhouette à gradins, typique des tours
      // Seuil relatif à maxHeight : seules les vraies tours reçoivent un gradin
      if (hash(blockX, blockZ, 61 + salt) < city.towerRatio && height > city.maxHeight * 0.4) {
        const shrink = 0.5 + hash(blockX, blockZ, 71 + salt) * 0.3
        const extra = height * (0.2 + hash(blockX, blockZ, 81 + salt) * 0.45)
        emit({
          x,
          z,
          w: w * shrink,
          d: d * shrink,
          h: extra,
          shade: Math.min(shade + 0.15, 1),
          base: height, // posé sur le toit du volume principal
        })
      }
    }
  }
}

// Index des panneaux instanciés : permet de masquer celui qui est repris par
// portalMesh pendant la transition, pour qu'on n'en voie pas deux.
const panelLookup = new Map()
const panelKey = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

// Le panneau repris par portalMesh doit disparaître de son InstancedMesh,
// sinon on en voit deux au même endroit.
function setPanelInstanceVisible(key, visible) {
  const entry = panelLookup.get(key)
  if (!entry) return
  entry.mesh.setMatrixAt(entry.index, visible ? entry.matrix : ZERO_MATRIX)
  entry.mesh.instanceMatrix.needsUpdate = true
}

/* ---------- Génération d'un chunk ---------- */
// Tout est calculé à partir des coordonnées de bloc GLOBALES, jamais locales :
// deux chunks voisins produisent donc des blocs cohérents, sans couture ni doublon.
function buildChunk(cx, cz) {
  const group = new THREE.Group()
  const originX = cx * CHUNK
  const originZ = cz * CHUNK

  /* Immeubles */
  const instances = []
  const billboards = []
  for (let bx = 0; bx < BLOCKS_PER_CHUNK; bx++) {
    for (let bz = 0; bz < BLOCKS_PER_CHUNK; bz++) {
      eachBuilding(cx * BLOCKS_PER_CHUNK + bx, cz * BLOCKS_PER_CHUNK + bz, (b) => {
        instances.push(b)
        if (b.billboard) billboards.push(b)
      })
    }
  }

  const mesh = new THREE.InstancedMesh(boxGeometry, buildingMaterial, instances.length)
  mesh.castShadow = true
  mesh.receiveShadow = true
  instances.forEach((b, i) => {
    _position.set(b.x, city.sidewalkHeight + (b.base || 0), b.z)
    _scale.set(b.w, b.h, b.d)
    _matrix.compose(_position, _quat.identity(), _scale)
    mesh.setMatrixAt(i, _matrix)
    _color.copy(BUILDING).lerp(WHITE, b.shade * 0.8)
    mesh.setColorAt(i, _color)
  })
  mesh.userData.shades = instances.map((b) => b.shade)
  group.add(mesh)

  /* Panneaux : un plan plaqué sur une façade, orienté vers l'extérieur.
     Un InstancedMesh ne portant qu'un matériau, on groupe les panneaux par
     projet : autant de lots que de projets réellement présents dans le chunk. */
  if (billboards.length) {
    // Un lot par projet : le réticule doit pouvoir tous les viser
    group.userData.panels = []
    group.userData.logos = []
    const byProject = new Map()
    const byBrand = new Map()
    billboards.forEach((b) => {
      // Au sol, un projet à franchir ; en hauteur, la marque.
      const map = b.billboard.ground ? byProject : byBrand
      const k = b.billboard.ground ? b.billboard.project : b.billboard.brand
      const list = map.get(k)
      if (list) list.push(b)
      else map.set(k, [b])
    })

    // Panneaux de marque : ni libellé ni inscription dans panelLookup, ils ne
    // sont jamais visés ni franchis.
    byBrand.forEach((group_, variant) => {
      const panels = new THREE.InstancedMesh(
        billboardGeometry,
        brandMaterial(variant),
        group_.length
      )
      panels.castShadow = true
      panels.receiveShadow = true
      group_.forEach((b, i) => {
        const p = b.billboard
        _matrix.compose(
          _position.set(p.x, city.sidewalkHeight + p.y, p.z),
          _quat.setFromEuler(_euler.set(0, p.angle, 0)),
          _scale.set(p.w, p.h, p.thick)
        )
        panels.setMatrixAt(i, _matrix)
      })
      group.add(panels)
    })

    byProject.forEach((group_, projectIndex) => {
      const panels = new THREE.InstancedMesh(
        billboardGeometry,
        projectMaterials[projectIndex],
        group_.length
      )
      panels.castShadow = true
      panels.receiveShadow = true
      group_.forEach((b, i) => {
        const p = b.billboard
        _matrix.compose(
          _position.set(p.x, city.sidewalkHeight + p.y, p.z),
          _quat.setFromEuler(_euler.set(0, p.angle, 0)),
          _scale.set(p.w, p.h, p.thick)
        )
        panels.setMatrixAt(i, _matrix)
        panelLookup.set(panelKey(p), { mesh: panels, index: i, matrix: _matrix.clone() })
      })
      group.add(panels)
      group.userData.panels.push(panels)

      // Nom du projet, en blanc, plaqué sur la face du panneau
      const label = projectLabel(projectIndex)
      const labels = new THREE.InstancedMesh(logoGeometry, label.material, group_.length)
      group_.forEach((b, i) => labels.setMatrixAt(i, logoMatrix(b.billboard, label.aspect, _matrix)))
      group.add(labels)
      group.userData.logos.push({ mesh: labels, project: projectIndex, items: group_ })
    })
    // Seuls les panneaux au sol ont été inscrits dans panelLookup : lister
    // les autres ici ferait supprimer des clés qui ne sont pas les leurs.
    group.userData.panelKeys = billboards
      .filter((b) => b.billboard.ground)
      .map((b) => panelKey(b.billboard))
  }

  /* Trottoirs : une dalle par bloc, le bâti repose dessus */
  const sidewalks = new THREE.InstancedMesh(
    boxGeometry,
    sidewalkMaterial,
    BLOCKS_PER_CHUNK * BLOCKS_PER_CHUNK
  )
  sidewalks.castShadow = true
  sidewalks.receiveShadow = true
  let sw = 0
  for (let bx = 0; bx < BLOCKS_PER_CHUNK; bx++) {
    for (let bz = 0; bz < BLOCKS_PER_CHUNK; bz++) {
      const blockX = cx * BLOCKS_PER_CHUNK + bx
      const blockZ = cz * BLOCKS_PER_CHUNK + bz
      _matrix.compose(
        _position.set(blockX * CELL + CELL / 2, 0, blockZ * CELL + CELL / 2),
        _quat.identity(),
        _scale.set(BLOCK, city.sidewalkHeight, BLOCK)
      )
      sidewalks.setMatrixAt(sw++, _matrix)
    }
  }
  group.add(sidewalks)

  /* Rues : une bande par ligne / colonne du chunk, croisements automatiques */
  const roads = new THREE.InstancedMesh(roadGeometry, roadMaterial, BLOCKS_PER_CHUNK * 2)
  roads.receiveShadow = true
  let r = 0
  for (let i = 0; i < BLOCKS_PER_CHUNK; i++) {
    const offset = i * CELL // frontière de bloc, en local
    _matrix.compose(_position.set(originX + offset, 0.01, originZ + CHUNK / 2), FLAT_Z, ONE)
    roads.setMatrixAt(r++, _matrix)
    _matrix.compose(_position.set(originX + CHUNK / 2, 0.01, originZ + offset), FLAT_X, ONE)
    roads.setMatrixAt(r++, _matrix)
  }
  group.add(roads)

  /* Lampadaires : seulement si le modèle est déjà arrivé. Sinon ils sont
     ajoutés après coup, au chargement. */
  addLamps(group, cx, cz)

  return group
}

/* ---------- Lampadaires ---------- */
// Quatre par bloc, au milieu de chaque bord de trottoir : le long d'une rue,
// l'écart entre deux lampadaires vaut donc exactement un pas de grille.
const LAMP_HEIGHT = 7        // hauteur du mât, en unités monde
const LAMP_INSET = 0.6       // recul depuis le bord du trottoir
// Les lampadaires ne suivent pas le rayon de chargement : à 4 chunks cela fait
// plus de cinq mille mâts à l'écran, soit une dizaine de millions de
// triangles par image. Au-delà de deux chunks le brouillard les a de toute
// façon avalés, on éteint donc simplement les lots trop lointains.


const lampPostMaterial = new THREE.MeshStandardMaterial({
  color: settings.lampColor,
  roughness: 0.55,
  metalness: 0.1,
})

// La lampe elle-même : le seul point allumé du lampadaire. Émissive, donc
// elle garde son jaune quelle que soit la lumière qui l'atteint.
const lampGlassMaterial = new THREE.MeshStandardMaterial({
  color: '#2b2b16',
  emissive: new THREE.Color(settings.lampLightColor),
  emissiveIntensity: 2.6,
  roughness: 0.25,
})

// Déduites du modèle une fois chargé : le mât et la vasque, fusionnés chacun
// en une seule géométrie pour tenir en deux InstancedMesh par chunk.
let lampPostGeometry = null
let lampGlassGeometry = null

// Le bras du modèle part vers +X : l'angle fait pointer ce +X vers la rue.
const LAMP_EDGES = [
  { dx: 1, dz: 0, angle: 0 },
  { dx: -1, dz: 0, angle: Math.PI },
  { dx: 0, dz: 1, angle: -Math.PI / 2 },
  { dx: 0, dz: -1, angle: Math.PI / 2 },
]

// Chunk sous la caméra, tenu à jour par updateChunks : il décide quels lots
// de lampadaires sont allumés.
const lampCenter = { x: 0, z: 0 }

function addLamps(group, cx, cz) {
  if (!lampPostGeometry || group.userData.lamps) return

  const count = BLOCKS_PER_CHUNK * BLOCKS_PER_CHUNK * LAMP_EDGES.length
  const posts = new THREE.InstancedMesh(lampPostGeometry, lampPostMaterial, count)
  const glass = new THREE.InstancedMesh(lampGlassGeometry, lampGlassMaterial, count)
  // Ni l'un ni l'autre ne porte d'ombre : un mât est trop fin pour que la
  // sienne se lise, et la passe d'ombre redessinait toute la géométrie une
  // seconde fois.

  const edge = BLOCK / 2 - LAMP_INSET
  let i = 0
  for (let bx = 0; bx < BLOCKS_PER_CHUNK; bx++) {
    for (let bz = 0; bz < BLOCKS_PER_CHUNK; bz++) {
      const centerX = (cx * BLOCKS_PER_CHUNK + bx) * CELL + CELL / 2
      const centerZ = (cz * BLOCKS_PER_CHUNK + bz) * CELL + CELL / 2
      for (const e of LAMP_EDGES) {
        const x = centerX + e.dx * edge
        const z = centerZ + e.dz * edge
        _matrix.compose(
          _position.set(x, city.sidewalkHeight, z),
          _quat.setFromEuler(_euler.set(0, e.angle, 0)),
          ONE
        )
        posts.setMatrixAt(i, _matrix)
        glass.setMatrixAt(i, _matrix)
        i++
      }
    }
  }

  group.add(posts, glass)
  group.userData.lamps = [posts, glass]
  // updateChunks tranche à la frame suivante ; d'ici là, mieux vaut éteint
  // qu'un lot lointain allumé le temps d'une image.
  const near =
    Math.abs(cx - lampCenter.x) <= settings.lampRadius &&
    Math.abs(cz - lampCenter.z) <= settings.lampRadius
  group.userData.lamps.forEach((mesh) => (mesh.visible = near))
}

// Attributs réduits au strict nécessaire : les sous-objets du modèle n'ont
// pas tous les mêmes canaux, et la fusion refuse un jeu d'attributs mélangé.
function lampGeometry(mesh) {
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  const kept = new THREE.BufferGeometry()
  kept.setAttribute('position', geometry.getAttribute('position'))
  const normal = geometry.getAttribute('normal')
  if (normal) kept.setAttribute('normal', normal)
  else kept.computeVertexNormals()
  return kept
}

new OBJLoader(loadingManager).load(asset('models/street-lamp.obj'), (object) => {
  object.updateMatrixWorld(true)

  const postParts = []
  const glassParts = []
  const foot = new THREE.Box3()
  object.traverse((o) => {
    if (!o.isMesh) return
    // Le modèle embarque un carré de sol pour son rendu d'origine : il n'a
    // rien à faire ici, la ville a déjà le sien.
    if (o.name === 'ground') return
    const geometry = lampGeometry(o)
    if (o.name === 'Glass_Cap') glassParts.push(geometry)
    else postParts.push(geometry)
    // L'embase donne l'aplomb du mât : c'est elle, et non le volume total
    // (bras compris), qui doit tomber sur le point de pose.
    if (o.name.startsWith('Cube.1')) foot.expandByObject(o)
  })
  if (!postParts.length || !glassParts.length) return

  const post = mergeGeometries(postParts)
  const glass = mergeGeometries(glassParts)
  if (!post || !glass) return

  // Repère cible : pied du mât à l'origine, sol à y = 0, bras vers +X
  const bounds = new THREE.Box3().setFromBufferAttribute(post.getAttribute('position'))
  bounds.union(new THREE.Box3().setFromBufferAttribute(glass.getAttribute('position')))
  const pivot = foot.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : foot.getCenter(new THREE.Vector3())
  const scale = LAMP_HEIGHT / (bounds.max.y - bounds.min.y)

  for (const geometry of [post, glass]) {
    geometry.translate(-pivot.x, -bounds.min.y, -pivot.z)
    geometry.scale(scale, scale, scale)
    geometry.computeVertexNormals()
  }

  // La vasque du modèle pèse 828 triangles pour une lentille de onze
  // centimètres, qui ne fait jamais plus que quelques pixels à l'écran et
  // qui est entièrement émissive. Une primitive calée sur son encombrement
  // donne exactement la même lueur pour quarante triangles.
  const head = new THREE.Box3().setFromBufferAttribute(glass.getAttribute('position'))
  const headSize = head.getSize(new THREE.Vector3())
  const headCenter = head.getCenter(new THREE.Vector3())
  const radius = Math.max(headSize.x, headSize.z) / 2
  lampGlassGeometry = new THREE.CylinderGeometry(radius, radius * 0.75, headSize.y, 10)
  lampGlassGeometry.translate(headCenter.x, headCenter.y, headCenter.z)
  glass.dispose()

  // Posé en dernier : addLamps s'en sert comme drapeau « tout est prêt », et
  // un chunk bâti entre-temps repartirait sans vasque.
  lampPostGeometry = post

  // Les premiers chunks sont bâtis bien avant l'arrivée du modèle : on les
  // rattrape, les suivants seront équipés dès leur construction.
  chunks.forEach((group, k) => {
    const [gx, gz] = k.split(',').map(Number)
    addLamps(group, gx, gz)
  })
})


/* ---------- Streaming des chunks ---------- */
const chunks = new Map()
const key = (cx, cz) => `${cx},${cz}`

// La caméra étant dans la ville, c'est sa propre position qui pilote le chargement
const _target = new THREE.Vector3()
function cameraTarget(out) {
  return out.set(carPosition.x, 0, carPosition.z)
}

function updateChunks() {
  if (whiteSpace) return
  cameraTarget(_target)
  const cx = Math.round(_target.x / CHUNK)
  const cz = Math.round(_target.z / CHUNK)
  lampCenter.x = cx
  lampCenter.z = cz

  // Charge ce qui entre dans le rayon
  for (let x = cx - settings.viewRadius; x <= cx + settings.viewRadius; x++) {
    for (let z = cz - settings.viewRadius; z <= cz + settings.viewRadius; z++) {
      const k = key(x, z)
      if (chunks.has(k)) continue
      const chunk = buildChunk(x, z)
      chunks.set(k, chunk)
      world.add(chunk)
    }
  }

  // Décharge ce qui en sort (avec une marge d'un chunk pour éviter le yoyo)
  for (const [k, chunk] of chunks) {
    const [x, z] = k.split(',').map(Number)

    // Les lampadaires ne vivent que dans les chunks proches : au-delà, ils
    // sont éteints plutôt que déchargés — c'est gratuit et sans à-coup.
    if (chunk.userData.lamps) {
      const near =
        Math.abs(x - cx) <= settings.lampRadius && Math.abs(z - cz) <= settings.lampRadius
      chunk.userData.lamps.forEach((mesh) => (mesh.visible = near))
    }

    if (Math.abs(x - cx) > settings.viewRadius + 1 || Math.abs(z - cz) > settings.viewRadius + 1) {
      world.remove(chunk)
      chunk.traverse((o) => o.isInstancedMesh && o.dispose())
      chunk.userData.panelKeys?.forEach((pk) => panelLookup.delete(pk))
      chunks.delete(k)
    }
  }
}

/* ---------- Lumières ---------- */
const hemiLight = new THREE.HemisphereLight(SKY_LIGHT, GROUND, 1.2)
scene.add(hemiLight)

// Direction du soleil, partagée par le shader du ciel et la lumière directionnelle
const SUN_DISTANCE = 150
const sunDirection = new THREE.Vector3()
const sunOffset = new THREE.Vector3()

function updateSun() {
  // sunHeight 0 = rasant sur l'horizon, 1 = au zénith
  const elevation = THREE.MathUtils.lerp(0.02, Math.PI / 2, settings.sunHeight)
  const azimuth = Math.atan2(-1, -0.4) // orientation conservée depuis la scène d'origine
  const cos = Math.cos(elevation)
  sunDirection.set(Math.cos(azimuth) * cos, Math.sin(elevation), Math.sin(azimuth) * cos).normalize()
  skyMaterial.uniforms.uSunDirection.value.copy(sunDirection)
  sunOffset.copy(sunDirection).multiplyScalar(SUN_DISTANCE)
  follow() // repositionne la lumière sur la nouvelle direction
}

const sunLight = new THREE.DirectionalLight(SUN, 2.2)
sunLight.castShadow = true
sunLight.shadow.mapSize.set(settings.shadowSize, settings.shadowSize)
const shadowCam = sunLight.shadow.camera
// Cadrage resserré : c'est lui qui fait la netteté. Le même nombre de texels
// étalé sur 200 unités au lieu de 240 gagne 20 % de définition, et la passe
// d'ombre dessine d'autant moins de géométrie. Au-delà, les ombres ne sont de
// toute façon plus lisibles à la taille où les bâtiments apparaissent.
shadowCam.left = -100; shadowCam.right = 100; shadowCam.top = 100; shadowCam.bottom = -100
shadowCam.near = 1; shadowCam.far = 400
// Décalage le long de la normale plutôt que dans la profondeur seule : c'est
// ce qui permet de garder un biais minuscule à haute définition sans voir
// réapparaître le moirage, et sans décoller l'ombre de son objet.
sunLight.shadow.bias = -0.0002
sunLight.shadow.normalBias = 0.02
scene.add(sunLight, sunLight.target)


/* ---------- Voiture ---------- */
// Le modèle est normalisé à une longueur cible : on ne dépend pas de l'échelle
// à laquelle il a été exporté, et les collisions restent calées sur le gabarit.
const CAR_LENGTH = 4.2 // longueur de référence, avant application de carScale
const CAR_GROUND = 0.02 // la voiture roule sur la chaussée, pas sur le trottoir
const carGroup = new THREE.Group()
// La voiture est hors du groupe "world" : pendant la transition de portail,
// la ville descend mais le véhicule reste en place à l'écran.
scene.add(carGroup)

let carHeading = 0     // cap de la voiture (axe d'avancement)
let prevHeading = 0    // état précédent, pour l'interpolation du rendu

// Le rayon de collision suit l'échelle du véhicule
const carRadius = () => 1.2 * settings.carScale

// Normalisation commune aux deux véhicules : longueur cible, roues au sol,
// axe long aligné sur +Z (l'axe d'avancement du contrôleur).
function normalizeCarModel(model) {
  model.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
  })

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const scale = CAR_LENGTH / Math.max(size.x, size.z)
  model.scale.setScalar(scale)

  const center = box.getCenter(new THREE.Vector3())
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
  if (size.x > size.z) model.rotation.y = Math.PI / 2
  return model
}

new GLTFLoader(loadingManager).load(asset('models/car_1.glb'), (gltf) => {
  carGroup.add(normalizeCarModel(gltf.scene))
  applyCarScale()
})

// carScale s'applique au groupe : le modèle garde sa normalisation interne
function applyCarScale() {
  carGroup.scale.setScalar(settings.carScale)
}

/* ---------- Dégâts : fumée puis flammes sur le capot ---------- */
// Un sprite animé par palier. Les planches ont été recomposées en cellules
// strictement uniformes (voir tools/atlas.py) : toutes les vignettes tiennent
// sur une seule ligne, recadrées et calées en bas.
// Une planche par palier de dégâts : le panache s'épaissit à mesure que la
// voiture encaisse. `ratio` est le format de la cellule après recomposition
// (voir tools/atlas.py), `scale` la hauteur du panache en unités monde — la
// voiture faisant environ 3 de long, il doit rester plus étroit qu'elle.
const DAMAGE_STAGES = [
  { file: 'sprites/smoke_1.png', frames: 10, fps: 12, scale: 1.1, ratio: 138 / 170 },
  { file: 'sprites/smoke_2.png', frames: 10, fps: 12, scale: 1.5, ratio: 154 / 171 },
  { file: 'sprites/smoke_3.png', frames: 10, fps: 12, scale: 1.9, ratio: 197 / 207 },
  { file: 'sprites/flammes.png', frames: 10, fps: 12, scale: 2.1, ratio: 205 / 308 },
]

// Un quad orienté vers la caméra plutôt qu'un THREE.Sprite : le matériau de
// sprite n'applique pas la transformation UV de la texture (sa matrice reste
// l'identité), ce qui affichait la planche entière au lieu d'une vignette.
const damageGeometry = new THREE.PlaneGeometry(1, 1)
damageGeometry.translate(0, 0.5, 0) // pivot en bas : la fumée monte du capot

const damageSprite = new THREE.Mesh(
  damageGeometry,
  new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    // Coupe les pixels quasi transparents des planches : sans ça le rectangle
    // du quad se devine en clair autour de la flamme.
    alphaTest: 0.12,
  })
)
damageSprite.visible = false
damageSprite.renderOrder = 5
scene.add(damageSprite) // hors du carGroup : il fait face à la caméra, pas à la voiture

// Position du capot, dans le repère de la voiture
const DAMAGE_OFFSET = new THREE.Vector3(0, 0.75, 1.5)
const _damagePos = new THREE.Vector3()

const damageTextures = []
let damageStage = -1
let damageTime = 0

function setDamageStage(stage) {
  if (stage === damageStage) return
  damageStage = stage

  if (stage < 0) {
    damageSprite.visible = false
    return
  }

  const preset = DAMAGE_STAGES[stage]
  if (!damageTextures[stage]) {
    const texture = textureLoader.load(asset(preset.file))
    texture.colorSpace = THREE.SRGBColorSpace
    // Filtrage au plus proche : une planche d'animation se lit vignette par
    // vignette, comme un dessin animé. Le filtrage linéaire mélangeait les
    // texels et donnait une impression de glissement entre les images.
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    // Une seule vignette visible à la fois
    texture.repeat.set(1 / preset.frames, 1)
    // Sans ce bridage, le filtrage va chercher des texels de la vignette
    // voisine sur les bords et laisse un liseré fantôme.
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
    damageTextures[stage] = texture
  }

  damageSprite.material.map = damageTextures[stage]
  damageSprite.material.needsUpdate = true
  damageSprite.scale.set(preset.scale * preset.ratio, preset.scale, 1)
  damageSprite.visible = true
  damageTime = 0
}

function updateDamageSprite(delta) {
  if (damageStage < 0 || !damageSprite.visible) return

  const preset = DAMAGE_STAGES[damageStage]
  damageTime += delta

  const frame = Math.floor(damageTime * preset.fps) % preset.frames
  damageTextures[damageStage].offset.x = frame / preset.frames

  // Position sur le capot, puis orientation face caméra
  _damagePos.copy(DAMAGE_OFFSET).applyAxisAngle(THREE.Object3D.DEFAULT_UP, carGroup.rotation.y)
  damageSprite.position.copy(carGroup.position).addScaledVector(_damagePos, settings.carScale)
  damageSprite.quaternion.copy(camera.quaternion)
}

/* ---------- Poursuivants ---------- */
// Voitures de police semées sur la grille de façon déterministe, puis
// pilotées par une IA volontairement simple : foncer sur le joueur, glisser
// le long des façades quand elles sont gênées.
const POLICE_SPACING = [9, 8, 7, 6, 5] // en blocs, selon le niveau de recherche
const POLICE_VIEW = 170      // rayon de présence autour du joueur
const POLICE_FORGET = 260    // au-delà, la voiture est retirée
// Au doigt, la conduite est moins précise : une police calée à 81 % de la
// pointe du joueur ne lui laisse aucune marge d'erreur et la poursuite tourne
// à la corvée. On la ralentit, sans la rendre semable pour autant.
const POLICE_SPEED = COARSE ? 20 : 26 // toujours sous la pointe du joueur (32)
const POLICE_ACCEL = 10
const POLICE_TURN = 1.5      // vitesse de braquage, rad/s : elles ratent leurs virages
// Seules les plus proches attaquent. Les autres suivent à distance, sans quoi
// on se retrouve encerclé en permanence et le jeu devient injouable.
const POLICE_ATTACKERS = 2   // nombre de poursuivants autorisés à foncer
const POLICE_STANDOFF = 22   // distance que gardent les autres
// Embuscade : quand le joueur file droit, les renforts apparaissent devant
// lui plutôt que dans son dos, pour provoquer des face-à-face.
const AMBUSH_DELAY = 1.2      // secondes en ligne droite avant de basculer
const AMBUSH_CONE = 0.55      // cosinus mini avec le cap : largeur du cône avant
const AMBUSH_MIN = 55         // distance mini : le temps de les voir arriver
// Une voiture est en plus envoyée droit sur le joueur à intervalles réguliers.
// Sans ça, filer en ligne droite ne provoque jamais rien : les points
// d'apparition sont sur une grille fixe, et rien ne tombe forcément devant.
const AMBUSH_INTERVAL = 11    // secondes de conduite entre deux face-à-face
const AMBUSH_SPAWN = 95       // distance d'apparition, droit devant
let straightTime = 0          // durée de conduite sans braquer
let ambushTimer = 0           // temps écoulé depuis le dernier face-à-face
let ambushCount = 0           // compteur, pour donner une clé unique
const policeRadius = () => carRadius() // même gabarit que la voiture du joueur
const CAR_IMPACT = 1.9       // distance de contact entre deux voitures
const CAR_RESTITUTION = 1.6  // rebond entre véhicules : franchement nerveux
const POLICE_RETREAT = 1.6   // secondes de marche arrière après un choc
const POLICE_CALM = 2.5      // secondes de prudence qui suivent le recul
const MAX_WANTED = 5

let wanted = 1
const policeCars = []
let policeTemplate = null

new GLTFLoader(loadingManager).load(asset('models/car_2.glb'), (gltf) => {
  policeTemplate = normalizeCarModel(gltf.scene)
  restorePolice() // rien à faire s'il n'y a pas de sauvegarde
  refreshPoliceFleet()
})

// Gyrophare : un petit volume émissif qui alterne bleu et rouge
function makeBeacon() {
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.22, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x3e78ff, emissiveIntensity: 2 })
  )
  beacon.position.set(0, 1.45, 0)
  return beacon
}

const policeKey = (bx, bz) => `${bx},${bz}`

// Points d'apparition : un croisement sur N, N décroissant avec le niveau
function policeSpawnStep() {
  return POLICE_SPACING[Math.min(wanted, MAX_WANTED) - 1]
}

function refreshPoliceFleet() {
  if (!policeTemplate || whiteSpace) return
  if (pendingPolice) return // on attend d'avoir remis la flotte sauvegardée

  const step = policeSpawnStep()
  const here = new Set(policeCars.map((c) => c.key))
  const ambush = straightTime > AMBUSH_DELAY
  const blockX = Math.round(body.x / CELL)
  const blockZ = Math.round(body.z / CELL)
  const reach = Math.ceil(POLICE_VIEW / CELL)

  for (let bx = blockX - reach; bx <= blockX + reach; bx++) {
    for (let bz = blockZ - reach; bz <= blockZ + reach; bz++) {
      if (bx % step !== 0 || bz % step !== 0) continue

      const x = bx * CELL
      const z = bz * CELL
      const distance = Math.hypot(x - body.x, z - body.z)
      // Ni trop loin, ni collé au joueur au moment où il réapparaît
      if (distance > POLICE_VIEW || distance < 30) continue

      if (ambush) {
        // Projection sur le cap du joueur : ne garder que ce qui est devant
        const toward = ((x - body.x) * Math.sin(carHeading) + (z - body.z) * Math.cos(carHeading)) / distance
        if (toward < AMBUSH_CONE || distance < AMBUSH_MIN) continue
      }

      const k = policeKey(bx, bz)
      if (here.has(k)) continue
      spawnPolice(k, x, z)
    }
  }
}

// Renfort lancé à la rencontre du joueur, sur la rue qu'il emprunte
function spawnAmbush() {
  if (!policeTemplate || whiteSpace) return

  const sin = Math.sin(carHeading)
  const cos = Math.cos(carHeading)
  let x = body.x + sin * AMBUSH_SPAWN
  let z = body.z + cos * AMBUSH_SPAWN

  // Recalage sur l'axe de la rue : la voiture doit apparaître sur la chaussée,
  // pas au milieu d'un pâté de maisons. On ne corrige que la coordonnée
  // transversale, celle qui reste constante le long de la rue.
  if (Math.abs(sin) > Math.abs(cos)) z = Math.round(z / CELL) * CELL
  else x = Math.round(x / CELL) * CELL

  ambushCount += 1
  spawnPolice(`ambush-${ambushCount}`, x, z)
  const car = policeCars[policeCars.length - 1]
  car.heading = carHeading + Math.PI // elle arrive de face
  car.speed = POLICE_SPEED
  car.velocity.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed)
}

function spawnPolice(key, x, z) {
  const group = new THREE.Group()
  group.add(policeTemplate.clone(true))
  group.add(makeBeacon())
  group.position.set(x, CAR_GROUND, z)
  group.scale.setScalar(settings.carScale) // même échelle que la voiture du joueur
  world.add(group)

  policeCars.push({
    key,
    group,
    body: new THREE.Vector3(x, 0, z),
    // État du pas précédent : le rendu interpole entre les deux, sinon les
    // voitures avancent par à-coups au rythme de la simulation.
    prev: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(),
    heading: Math.atan2(body.x - x, body.z - z),
    prevHeading: Math.atan2(body.x - x, body.z - z),
    speed: 0,
    retreat: 0, // secondes de recul restantes après un choc
    calm: 0,    // secondes de prudence après un recul : elle suit sans charger
    role: policeCars.length % 2, // 0 = poursuivant, 1 = bloqueur
  })
}

function removePolice(car) {
  world.remove(car.group)
  const index = policeCars.indexOf(car)
  if (index >= 0) policeCars.splice(index, 1)
}

function clearPolice() {
  while (policeCars.length) removePolice(policeCars[0])
}


// Navigation routière : foncer en ligne droite fait entrer les poursuivants
// dans les façades, où ils raclent et s'arrêtent. Tant qu'un immeuble barre
// la route, ils visent donc un point du réseau de rues plutôt que le joueur.
const _sight = new THREE.Vector3()

// Rien entre les deux ? Un simple balayage de collision suffit à le dire.
function hasLineOfSight(fromX, fromZ, toX, toZ) {
  return !sweep(fromX, fromZ, toX - fromX, toZ - fromZ, policeRadius())
}

// Axe de rue le plus proche d'une position : les rues passent sur les
// multiples de CELL, dans les deux directions.
const nearestRoad = (v) => Math.round(v / CELL) * CELL

function policeWaypoint(car, out) {
  // Vue dégagée : autant couper au plus court
  if (hasLineOfSight(car.body.x, car.body.z, body.x, body.z)) {
    return out.set(body.x, 0, body.z)
  }

  const roadX = nearestRoad(car.body.x)
  const roadZ = nearestRoad(car.body.z)
  const targetRoadX = nearestRoad(body.x)
  const targetRoadZ = nearestRoad(body.z)

  // Sur quelle rue roule-t-elle ? Celle dont elle est le plus près.
  const onVertical = Math.abs(car.body.x - roadX) < Math.abs(car.body.z - roadZ)

  if (onVertical) {
    // Rue nord-sud : on la remonte jusqu'au croisement de la rue du joueur,
    // puis on tourne. Une fois au croisement, on vise la rue suivante.
    if (Math.abs(car.body.z - targetRoadZ) > CELL * 0.5) {
      return out.set(roadX, 0, targetRoadZ)
    }
    return out.set(targetRoadX, 0, targetRoadZ)
  }

  if (Math.abs(car.body.x - targetRoadX) > CELL * 0.5) {
    return out.set(targetRoadX, 0, roadZ)
  }
  return out.set(targetRoadX, 0, targetRoadZ)
}

// Déplacement partagé avec le joueur : même balayage, même glissement, mais
// sans rebond ni embardée — une IA qui ricoche serait illisible.
function policeMove(car, dt) {
  depenetrate(car.body, policeRadius())

  let dx = car.velocity.x * dt
  let dz = car.velocity.z * dt

  for (let i = 0; i < MAX_SLIDES; i++) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) break

    const hit = sweep(car.body.x, car.body.z, dx, dz, policeRadius())
    if (!hit) {
      car.body.x += dx
      car.body.z += dz
      break
    }

    const t = Math.max(0, hit.t - SKIN)
    car.body.x += dx * t
    car.body.z += dz * t

    const rx = dx * (1 - t)
    const rz = dz * (1 - t)
    const into = rx * hit.nx + rz * hit.nz
    dx = rx - into * hit.nx
    dz = rz - into * hit.nz

    const vInto = car.velocity.x * hit.nx + car.velocity.z * hit.nz
    if (vInto < 0) {
      car.velocity.x -= vInto * hit.nx
      car.velocity.z -= vInto * hit.nz
    }
  }
}

// Les poursuivants se gênent aussi entre eux : sans ça, deux voitures qui
// convergent sur le joueur se traversent, et on voit une carrosserie sortir
// de l'autre. Même principe que le choc avec le joueur, sans embardée.
const POLICE_BOUNCE = 0.6

function resolvePoliceCollisions() {
  const contact = policeRadius() * 2

  for (let i = 0; i < policeCars.length; i++) {
    const a = policeCars[i]
    for (let j = i + 1; j < policeCars.length; j++) {
      const b = policeCars[j]
      const dx = b.body.x - a.body.x
      const dz = b.body.z - a.body.z
      const distance = Math.hypot(dx, dz)
      if (distance > contact || distance < 1e-4) continue

      const nx = dx / distance
      const nz = dz / distance

      // Séparation à parts égales : les deux véhicules ont la même masse
      const overlap = (contact - distance) / 2
      a.body.x -= nx * overlap
      a.body.z -= nz * overlap
      b.body.x += nx * overlap
      b.body.z += nz * overlap

      // Vitesse d'approche le long de la normale : nulle ou négative, elles
      // s'éloignent déjà et il n'y a rien à corriger.
      const approach = (a.velocity.x - b.velocity.x) * nx + (a.velocity.z - b.velocity.z) * nz
      if (approach <= 0) continue

      const impulse = approach * POLICE_BOUNCE
      a.velocity.x -= nx * impulse
      a.velocity.z -= nz * impulse
      b.velocity.x += nx * impulse
      b.velocity.z += nz * impulse

      // La vitesse le long du cap est recalculée, sinon l'IA repart comme si
      // de rien n'était au pas suivant.
      a.speed = a.velocity.x * Math.sin(a.heading) + a.velocity.z * Math.cos(a.heading)
      b.speed = b.velocity.x * Math.sin(b.heading) + b.velocity.z * Math.cos(b.heading)

      // Elles se dégagent un instant avant de reprendre la poursuite
      a.retreat = Math.max(a.retreat, POLICE_RETREAT * 0.4)
      b.retreat = Math.max(b.retreat, POLICE_RETREAT * 0.4)

    }
  }
}

// Choc entre véhicules : les deux sont repoussés le long de l'axe qui les
// sépare, le joueur encaissant en plus une embardée.
function collideWithPlayer(car) {
  const dx = body.x - car.body.x
  const dz = body.z - car.body.z
  const distance = Math.hypot(dx, dz)
  const contact = CAR_IMPACT * settings.carScale + policeRadius()
  if (distance > contact || distance < 1e-4) return

  const nx = dx / distance
  const nz = dz / distance

  // Séparation immédiate, sinon les deux restent imbriqués et se repoussent
  // en boucle à chaque pas
  const overlap = contact - distance
  body.x += nx * overlap * 0.5
  body.z += nz * overlap * 0.5
  car.body.x -= nx * overlap * 0.5
  car.body.z -= nz * overlap * 0.5

  // Vitesse d'approche le long de la normale
  const approach = (car.velocity.x - velocity.x) * nx + (car.velocity.z - velocity.z) * nz
  if (approach <= 0) return

  const impulse = approach * CAR_RESTITUTION
  velocity.x += nx * impulse
  velocity.z += nz * impulse
  car.velocity.x -= nx * impulse * 0.6
  car.velocity.z -= nz * impulse * 0.6

  registerHit()

  // Elle prend du champ après l'impact : sans ce recul, deux voitures
  // suffisent à plaquer le joueur contre une façade sans qu'il puisse repartir.
  car.retreat = POLICE_RETREAT
  car.calm = POLICE_CALM

  // Le joueur part en travers, proportionnellement à l'angle du choc
  const cross = Math.sin(carHeading) * nz - Math.cos(carHeading) * nx
  spin = THREE.MathUtils.clamp(spin + cross * impulse * 0.12, -MAX_SPIN, MAX_SPIN)

  // La vitesse le long du cap est recalculée depuis la vélocité modifiée
  const sin = Math.sin(carHeading)
  const cos = Math.cos(carHeading)
  speed = velocity.x * sin + velocity.z * cos
  _lateral.x = velocity.x - sin * speed
  _lateral.z = velocity.z - cos * speed
}

// Game over aux chocs : encaisser MAX_HITS tamponnages dans une même
// séquence — c'est-à-dire entre deux passages de panneau — vaut la capture.
const MAX_HITS = 8       // impacts encaissés avant la capture
const HITS_PER_STAGE = 2 // un palier de dégâts tous les deux impacts
const HIT_COOLDOWN = 1.2 // secondes avant qu'un nouveau choc soit compté
let hits = 0
let hitCooldown = 0
let gameOver = false

function registerHit() {
  if (gameOver || hitCooldown > 0) return
  hitCooldown = HIT_COOLDOWN
  hits += 1
  gamepad.rumble(1, 0.8, 300)
  updateDamageStage()
  if (hits >= MAX_HITS) triggerGameOver()
  else showNotice(`Tamponné ! ${hits}/${MAX_HITS}`)
}

// Séquence de capture : la simulation vire au gris, la caméra s'envole en
// gardant la voiture dans le cadre, puis fondu au noir derrière l'écran final.
const BUSTED_RISE = 3.4   // secondes d'envolée
const BUSTED_FADE = 1.1   // secondes de fondu au noir
const RISE_SPEED = 9      // montée de la caméra, u/s
const RISE_BACK = 3.5     // recul simultané, u/s
let bustedTime = 0
const _bustedDir = new THREE.Vector3()

function triggerGameOver() {
  gameOver = true
  bustedTime = 0
  canvas.classList.add('is-busted')
  document.body.classList.add('is-busted')
  // Le logo et le bouton apparaissent tout de suite, le cinématique continue
  // derrière eux jusqu'au noir complet
  gameOverElement.classList.add('is-visible')
  keys.clear()
  // Le contact prend le focus : c'est l'action que l'écran propose, et elle
  // doit être atteignable sans toucher la souris.
  gameOverElement.querySelector('#gameover-contact')?.focus({ preventScroll: true })
}

function updateBusted(delta) {
  if (!gameOver) return
  bustedTime += delta

  if (bustedTime < BUSTED_RISE) {
    // La caméra prend de la hauteur et recule, sans jamais lâcher la voiture
    camera.getWorldDirection(_bustedDir)
    camera.position.y += RISE_SPEED * delta
    camera.position.x -= _bustedDir.x * RISE_BACK * delta
    camera.position.z -= _bustedDir.z * RISE_BACK * delta
    camera.lookAt(carGroup.position)
    return
  }

  fadeElement.classList.add('is-visible')
}

function restart() {
  gameOver = false
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    // sans stockage, il n'y avait rien à effacer
  }
  hits = 0
  hitCooldown = 0
  updateDamageStage()
  bustedTime = 0
  wanted = 1
  updateWantedHud()
  gameOverElement.classList.remove('is-visible')
  fadeElement.classList.remove('is-visible')
  canvas.classList.remove('is-busted')
  document.body.classList.remove('is-busted')
  respawn()
}

function stepPolice(dt) {
  if (whiteSpace) return

  // Classement par distance : seules les premières ont le droit d'attaquer
  const ranked = policeCars
    .map((car) => ({ car, d: Math.hypot(body.x - car.body.x, body.z - car.body.z) }))
    .sort((a, b) => a.d - b.d)
  const attackers = new Set(ranked.slice(0, POLICE_ATTACKERS).map((r) => r.car))

  for (let i = policeCars.length - 1; i >= 0; i--) {
    const car = policeCars[i]
    const dx = body.x - car.body.x
    const dz = body.z - car.body.z
    const distance = Math.hypot(dx, dz)

    if (distance > POLICE_FORGET) {
      removePolice(car)
      continue
    }

    car.prev.copy(car.body)
    car.prevHeading = car.heading

    // Interception : on vise là où le joueur SERA, pas où il est. Une voiture
    // sur deux joue le bloqueur et anticipe bien plus loin, pour se placer en
    // travers de la route plutôt que de coller au pare-chocs.
    const blocker = car.role === 1
    const lead = Math.min(3.2, distance / POLICE_SPEED) * (blocker ? 1.8 : 0.7)

    // Point de passage : le joueur directement s'il est en vue, sinon le
    // croisement qui mène à lui.
    policeWaypoint(car, _sight)
    const direct = _sight.x === body.x && _sight.z === body.z
    // L'anticipation n'a de sens que quand on vise vraiment le joueur
    const aimX = _sight.x + (direct ? velocity.x * lead : 0)
    const aimZ = _sight.z + (direct ? velocity.z * lead : 0)
    const target = Math.atan2(aimX - car.body.x, aimZ - car.body.z)

    let diff = ((target - car.heading + Math.PI) % (Math.PI * 2)) - Math.PI
    if (diff < -Math.PI) diff += Math.PI * 2
    car.heading += THREE.MathUtils.clamp(diff, -POLICE_TURN * dt, POLICE_TURN * dt)

    if (car.calm > 0) car.calm -= dt

    if (car.retreat > 0) {
      car.retreat -= dt
      // Marche arrière franche, cap inchangé : elle se dégage puis repart
      car.speed += (-POLICE_SPEED * 0.5 - car.speed) * (1 - Math.exp(-POLICE_ACCEL * dt))
      car.velocity.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed)
      policeMove(car, dt)
      continue
    }

    // Le bloqueur freine une fois en position devant le joueur : il fait
    // barrage au lieu de continuer à avancer et de libérer le passage.
    const ahead = (car.body.x - body.x) * velocity.x + (car.body.z - body.z) * velocity.z > 0
    const blocking = blocker && ahead && distance < 22 && direct

    // Les non-attaquants et celles qui sortent d'un choc restent en retrait :
    // elles escortent le joueur au lieu de le percuter en meute.
    const holdsBack = !attackers.has(car) || car.calm > 0
    const tooClose = holdsBack && distance < POLICE_STANDOFF

    let wantedSpeed = POLICE_SPEED
    if (distance < 4) wantedSpeed = POLICE_SPEED * 0.3
    else if (tooClose) wantedSpeed = POLICE_SPEED * 0.25
    else if (blocking) wantedSpeed = POLICE_SPEED * 0.35

    car.speed += (wantedSpeed - car.speed) * (1 - Math.exp(-POLICE_ACCEL * dt))
    car.velocity.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed)

    policeMove(car, dt)
    collideWithPlayer(car)
  }

  resolvePoliceCollisions()
}

// Rendu : position, cap et gyrophare. Comme pour le joueur, la position
// affichée est interpolée entre les deux derniers pas de simulation.
function updatePoliceVisuals(time, alpha) {
  const blue = Math.sin(time * 9) > 0
  policeCars.forEach((car) => {
    car.group.position.set(
      car.prev.x + (car.body.x - car.prev.x) * alpha,
      CAR_GROUND,
      car.prev.z + (car.body.z - car.prev.z) * alpha
    )

    // Cap interpolé par le plus court chemin angulaire
    let diff = ((car.heading - car.prevHeading + Math.PI) % (Math.PI * 2)) - Math.PI
    if (diff < -Math.PI) diff += Math.PI * 2
    car.group.rotation.y = car.prevHeading + diff * alpha
    car.group.scale.setScalar(settings.carScale)
    const beacon = car.group.children[1]
    if (beacon) beacon.material.emissive.setHex(blue ? 0x3e78ff : 0xf2ff28)
  })
}



/* ---------- Commandes tactiles ---------- */
// Deux manettes virtuelles : la gauche conduit, la droite oriente la caméra.
// Elles renvoient un vecteur normalisé dans [-1, 1], ce qui donne des
// commandes analogiques là où le clavier est en tout ou rien.
const STICK_RADIUS = 52   // course maximale du bouton, en pixels
const STICK_DEADZONE = 0.14 // sous ce seuil, on considère la manette au repos

function createStick(id) {
  const element = document.querySelector(id)
  const knob = element.querySelector('i')
  const state = { x: 0, y: 0, active: false }
  let pointerId = null

  function move(event) {
    const rect = element.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)

    // Le vecteur est borné au rayon de la manette : pousser plus loin ne
    // donne pas plus de commande, mais le doigt peut sortir du cercle.
    const distance = Math.hypot(dx, dy)
    const clamp = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1
    const px = dx * clamp
    const py = dy * clamp

    knob.style.transform = `translate(${px}px, ${py}px)`
    state.x = px / STICK_RADIUS
    state.y = -py / STICK_RADIUS // vers le haut = valeurs positives
  }

  function release() {
    pointerId = null
    state.active = false
    state.x = 0
    state.y = 0
    knob.style.transform = ''
    element.classList.remove('is-active')
  }

  element.addEventListener('pointerdown', (event) => {
    pointerId = event.pointerId
    state.active = true
    element.classList.add('is-active')
    element.setPointerCapture(event.pointerId)
    move(event)
  })

  element.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return
    move(event)
  })

  element.addEventListener('pointerup', release)
  element.addEventListener('pointercancel', release)

  return state
}

const driveStick = createStick('#stick-drive')

// Écran tactile : la voiture doit occuper assez de place pour qu'on la suive
// du coin de l'œil tout en gardant le pouce sur la manette.
const TOUCH_CAMERA_DISTANCE = 6.4
if (COARSE) {
  settings.cameraDistance = TOUCH_CAMERA_DISTANCE
}
// Au doigt, la caméra se recadre toute seule derrière la voiture : un second
// joystick pour l'orienter prenait de la place et de l'attention pour un
// gain nul. L'objet reste défini pour que updateLook garde une forme unique.
const lookStick = { x: 0, y: 0 }

// Manette physique, aux commandes de GTA V : stick gauche pour braquer,
// gâchettes analogiques pour accélérer et freiner, RB frein à main, stick
// droit pour la caméra et clic du stick droit pour regarder derrière. Les
// autres boutons reprennent les raccourcis clavier (Entrée, Échap, Tab) :
// le téléphone s'ouvre, comme dans GTA, avec la croix vers le haut.
const gamepad = createGamepad({
  onPress(button) {
    if (button === BUTTON.A) {
      // Dans les menus, A clique sous le curseur ; en jeu, il vaut Entrée
      if (menuHome()) padCursor.click()
      else validate()
    } else if (button === BUTTON.B) {
      if (confirmOpen) closeContact()
    } else if (button === BUTTON.MENU) {
      toggleMenu()
    } else if (button === BUTTON.UP) {
      togglePhone()
    }
  },
  onActivity: () => setInputSource('pad'),
  onConnect: updateControlHints,
  onDisconnect: updateControlHints,
})
const pad = gamepad.state
const padCursor = createPadCursor(pad.sticks)

// Dernière source utilisée : dès que la manette sert, le curseur natif est
// masqué et les aides passent aux boutons de la manette ; le premier vrai
// mouvement de souris ou appui clavier rétablit l'un et l'autre.
let inputSource = 'keyboard'
function setInputSource(next) {
  if (inputSource === next) return
  inputSource = next
  document.documentElement.classList.toggle('is-pad-input', next === 'pad')
  if (next === 'pad') canvas.style.cursor = '' // pointeur posé au survol d'une cible
  updateControlHints()
}

window.addEventListener('pointermove', (event) => {
  // Un mouvement nul peut être émis quand la page bouge sous la souris
  if (event.pointerType !== 'mouse' || !(event.movementX || event.movementY)) return
  setInputSource('keyboard')
})
window.addEventListener('keydown', () => setInputSource('keyboard'))

// Une valeur sous la zone morte est traitée comme nulle : un doigt posé ne
// doit pas faire dériver la voiture.
function axis(value) {
  return Math.abs(value) < STICK_DEADZONE ? 0 : value
}

// L'orientation paysage ne peut être verrouillée qu'en plein écran, et
// seulement sur les navigateurs mobiles qui l'autorisent. On tente, sans
// dépendre du résultat : l'invitation à pivoter reste le vrai garde-fou.
function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement)
}

async function lockLandscape() {
  if (!COARSE || isFullscreen()) return
  const root = document.documentElement
  // Safari n'a jamais adopté la version sans préfixe sur l'élément racine :
  // sans ce repli, le plein écran ne se déclenchait pas du tout sur iPad.
  const request = root.requestFullscreen || root.webkitRequestFullscreen
  try {
    await request?.call(root)
    // Le verrouillage d'orientation exige le plein écran : inutile d'essayer
    // si la demande précédente n'a rien donné.
    if (isFullscreen()) await screen.orientation?.lock?.('landscape')
  } catch {
    // Refusé par le navigateur ou déjà en plein écran : sans conséquence
  }
}

/* ---------- Installation sur l'écran d'accueil ---------- */
// Safari n'accorde l'API Fullscreen qu'aux vidéos : sur iPhone, aucun réglage
// ni aucune astuce ne donnera le plein écran dans l'onglet. La seule voie est
// l'écran d'accueil — une page lancée de là s'ouvre sans barre d'adresse ni
// barre d'outils. D'où ce mode d'emploi, proposé en portrait, au moment où le
// joueur est de toute façon arrêté par l'invitation à tourner l'écran.
const installBlock = document.querySelector('#install')

// Déjà installé : la page tourne hors du navigateur, il n'y a rien à montrer.
const standalone =
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||
  navigator.standalone === true

// Le geste diffère d'un système à l'autre, et il n'existe aucun moyen fiable
// de le deviner autrement que par l'agent utilisateur. Un iPad récent se
// déclare en Mac : on le reconnaît à son écran tactile.
function mobileOS() {
  const ua = navigator.userAgent
  if (/android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios'
  return null
}

if (!standalone) {
  const os = mobileOS()
  // Sans système identifié, on n'affiche aucun parcours : un mode d'emploi
  // qui ne correspond à rien est pire que pas de mode d'emploi du tout.
  if (os) installBlock.dataset.os = os
}


// Le plein écran exige un geste de l'utilisateur, et le navigateur peut
// refuser le premier. On retente donc au contact suivant avec la scène,
// jusqu'à l'obtenir — puis l'écouteur se retire de lui-même.
canvas.addEventListener('pointerdown', function retryLandscape() {
  if (isFullscreen()) {
    canvas.removeEventListener('pointerdown', retryLandscape)
    return
  }
  lockLandscape()
})

/* ---------- Contrôleur de déplacement : Z Q S D ---------- */
// Approche classique de character controller : une position autoritaire qui
// n'est JAMAIS en pénétration, déplacée à pas de temps fixe par une vélocité
// résolue en "collide and slide".
const keys = new Set()

// Dynamique longitudinale : la voiture n'avance que sur son propre axe.
// Z accélère, S freine puis passe en marche arrière, Q/D braquent.
const ENGINE_ACCEL = 21    // accélération moteur, u/s²
const BRAKE_DECEL = 30     // freinage, bien plus mordant que le moteur
const REVERSE_ACCEL = 10   // marche arrière, plus molle que la marche avant
const MAX_SPEED = 32       // vitesse de pointe en marche avant
const MAX_REVERSE = 10     // vitesse de pointe en marche arrière
const DRAG = 0.9           // traînée proportionnelle à la vitesse (aéro)
const ROLL_RESIST = 2.5    // résistance constante (frein moteur, roulement)
const STEER_RATE = 2.0     // braquage max, rad/s
// Montée et retour au centre du volant. Plus mou au doigt : un pouce n'a ni
// la précision ni la course d'un clavier, et la même réactivité y donne une
// voiture qui part au quart de tour.
const STEER_SMOOTH = COARSE ? 3.6 : 5.5
const HANDBRAKE_DECEL = 9  // ralentissement roues bloquées
const HANDBRAKE_GRIP = 0.5 // adhérence latérale frein à main tiré : ça glisse
const HANDBRAKE_STEER = 1.6// gain de braquage pendant la glissade
const GRIP_SPEED = 7       // vitesse à partir de laquelle on braque à fond

const FIXED_DT = 1 / 60    // pas de simulation
// Garde-fou contre la spirale : si le rendu décroche, on cesse de rattraper.
// Mais le plafond doit couvrir la plus longue image qu'on accepte — `delta`
// est écrêté à 0,1 s dans la boucle, soit six pas. À cinq, une image de
// 100 ms ne simulait que 83 ms : le jeu tournait au ralenti sur un appareil
// à 10 images par seconde, et la voiture semblait ne plus répondre.
const MAX_STEPS = Math.ceil(0.1 / FIXED_DT)
const SKIN = 0.01          // marge anti-recollage sur les façades
const MAX_SLIDES = 4       // itérations de glissement par pas
const RESTITUTION = 0.7    // rebond sur les façades : 0 = on colle, 1 = billard
const BOUNCE_MIN = 2       // en dessous, on glisse au lieu de rebondir (anti-vibration)
const LATERAL_GRIP = 3.5   // vitesse de résorption d'une dérive latérale
const SPIN_GAIN = 0.05     // embardée induite par un choc en biais, rad/s par u/s
const SPIN_DAMP = 2.5      // amortissement de l'embardée
const MAX_SPIN = 3.5       // embardée max, rad/s

window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  // Espace et flèches font défiler la page par défaut. Menu ouvert, on les
  // laisse au navigateur : Espace active le bouton focalisé, et les flèches
  // servent à naviguer.
  if (paused) return
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
window.addEventListener('blur', () => keys.clear())

const body = new THREE.Vector3()     // position autoritaire (x, z utilisés)
const prevBody = new THREE.Vector3() // état précédent, pour l'interpolation
const velocity = new THREE.Vector3()
let speed = 0 // vitesse signée le long du cap : négative = marche arrière
let spin = 0  // vitesse de rotation subie (embardée après un choc), rad/s
let steerInput = 0 // position lissée du volant, dans [-1, 1]

// Dérive latérale : ce qui, dans la vélocité, n'est pas aligné sur le cap.
// C'est elle qui rend les chocs de flanc perceptibles — sans elle, la voiture
// repart instantanément dans l'axe et le rebond latéral est invisible.
const _lateral = new THREE.Vector3()

// KeyZ/KeyQ et KeyW/KeyA : fonctionne en AZERTY comme en QWERTY.
// Clavier et tactile sont en tout ou rien ; les gâchettes de la manette
// dosent l'accélération et le freinage.
const pressed = {
  get throttle() {
    return this.throttleLevel > 0
  },
  get throttleLevel() {
    if (keys.has('KeyW') || keys.has('KeyZ') || axis(driveStick.y) > 0.2) return 1
    return pad.throttle
  },
  get brake() {
    return this.brakeLevel > 0
  },
  get brakeLevel() {
    if (keys.has('KeyS') || axis(driveStick.y) < -0.2) return 1
    return pad.brake
  },
  get left() {
    return keys.has('KeyA') || keys.has('KeyQ') || axis(driveStick.x) < -0.2
  },
  get right() {
    return keys.has('KeyD') || axis(driveStick.x) > 0.2
  },
  get handbrake() {
    return keys.has('Space') || pad.handbrake
  },
}

/* ---------- Collisions ---------- */
// Les immeubles sont des boîtes alignées sur les axes : on élargit chaque
// emprise du rayon du corps et on lance un rayon depuis un point — le test
// "swept AABB" standard. Le corps est ainsi réduit à un point, sans sweep de
// capsule à écrire.
const _hit = { t: 0, nx: 0, nz: 0 }

function raycastBox(px, pz, dx, dz, minX, maxX, minZ, maxZ) {
  let tmin = 0
  let tmax = 1
  let nx = 0
  let nz = 0

  // Axe X
  if (Math.abs(dx) < 1e-9) {
    if (px < minX || px > maxX) return null
  } else {
    let t1 = (minX - px) / dx
    let t2 = (maxX - px) / dx
    let n = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      n = 1
    }
    if (t1 > tmin) {
      tmin = t1
      nx = n
      nz = 0
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }

  // Axe Z
  if (Math.abs(dz) < 1e-9) {
    if (pz < minZ || pz > maxZ) return null
  } else {
    let t1 = (minZ - pz) / dz
    let t2 = (maxZ - pz) / dz
    let n = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      n = 1
    }
    if (t1 > tmin) {
      tmin = t1
      nx = 0
      nz = n
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }

  if (tmin <= 0 || tmin > 1) return null // déjà dedans, ou hors du segment
  _hit.t = tmin
  _hit.nx = nx
  _hit.nz = nz
  return _hit
}

// Parcourt les blocs traversés par le déplacement et garde l'impact le plus proche
function sweep(px, pz, dx, dz, radius = carRadius()) {
  if (whiteSpace) return null // rien à heurter dans le vide
  const minBX = Math.floor(Math.min(px, px + dx) / CELL) - 1
  const maxBX = Math.floor(Math.max(px, px + dx) / CELL) + 1
  const minBZ = Math.floor(Math.min(pz, pz + dz) / CELL) - 1
  const maxBZ = Math.floor(Math.max(pz, pz + dz) / CELL) + 1

  let best = null
  for (let bx = minBX; bx <= maxBX; bx++) {
    for (let bz = minBZ; bz <= maxBZ; bz++) {
      eachBuilding(bx, bz, (b) => {
        if (b.base) return // volume en retrait : il est en hauteur
        const hw = b.w / 2 + radius
        const hd = b.d / 2 + radius
        const h = raycastBox(px, pz, dx, dz, b.x - hw, b.x + hw, b.z - hd, b.z + hd)
        if (!h || (best !== null && h.t >= best.t)) return
        best = { t: h.t, nx: h.nx, nz: h.nz }
      })
    }
  }
  return best
}

// Spring arm : longueur utilisable du bras de caméra. On lance un rayon du
// pivot vers la caméra et on s'arrête au premier immeuble rencontré. Les
// immeubles plus bas que le pivot sont ignorés : la caméra passe au-dessus.
const CAMERA_MARGIN = 0.4 // décollement de la façade, évite de voir dedans

function springArm(pivot, dir, maxLength) {
  if (whiteSpace) return maxLength
  const dx = dir.x * maxLength
  const dz = dir.z * maxLength
  const minBX = Math.floor(Math.min(pivot.x, pivot.x + dx) / CELL) - 1
  const maxBX = Math.floor(Math.max(pivot.x, pivot.x + dx) / CELL) + 1
  const minBZ = Math.floor(Math.min(pivot.z, pivot.z + dz) / CELL) - 1
  const maxBZ = Math.floor(Math.max(pivot.z, pivot.z + dz) / CELL) + 1

  let best = 1
  for (let bx = minBX; bx <= maxBX; bx++) {
    for (let bz = minBZ; bz <= maxBZ; bz++) {
      eachBuilding(bx, bz, (b) => {
        // Toit sous le pivot, ou volume en retrait : rien ne bouche la vue
        const top = city.sidewalkHeight + (b.base || 0) + b.h
        if (top < pivot.y) return
        const hw = b.w / 2 + CAMERA_MARGIN
        const hd = b.d / 2 + CAMERA_MARGIN
        const h = raycastBox(pivot.x, pivot.z, dx, dz, b.x - hw, b.x + hw, b.z - hd, b.z + hd)
        if (h && h.t < best) best = h.t
      })
    }
  }
  return best * maxLength
}

// Filet de sécurité : ne sert que si le corps se retrouve DÉJÀ dans un mur
// (changement de réglages de génération, spawn malheureux). Ce n'est pas le
// mécanisme de collision, juste un rattrapage.
function depenetrate(p, radius = carRadius()) {
  if (whiteSpace) return
  const blockX = Math.floor(p.x / CELL)
  const blockZ = Math.floor(p.z / CELL)
  for (let bx = blockX - 1; bx <= blockX + 1; bx++) {
    for (let bz = blockZ - 1; bz <= blockZ + 1; bz++) {
      eachBuilding(bx, bz, (b) => {
        if (b.base) return
        push(b.x, b.z, b.w / 2 + radius, b.d / 2 + radius)
      })

      // Sortie par l'axe de moindre pénétration
      function push(cx, cz, hw, hd) {
        const dx = p.x - cx
        const dz = p.z - cz
        const penX = hw - Math.abs(dx)
        const penZ = hd - Math.abs(dz)
        if (penX <= 0 || penZ <= 0) return
        if (penX < penZ) p.x = cx + (dx >= 0 ? hw : -hw) + Math.sign(dx || 1) * SKIN
        else p.z = cz + (dz >= 0 ? hd : -hd) + Math.sign(dz || 1) * SKIN
      }
    }
  }
}

// Collide and slide : on avance jusqu'au contact, on projette le déplacement
// ET la vélocité restants sur le plan touché, et on recommence. Le glissement
// le long des façades découle de cette projection, pas d'un bricolage par axe.
function moveAndSlide(dt) {
  depenetrate(body)

  let dx = velocity.x * dt
  let dz = velocity.z * dt

  for (let i = 0; i < MAX_SLIDES; i++) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) break

    const hit = sweep(body.x, body.z, dx, dz)
    if (!hit) {
      body.x += dx
      body.z += dz
      break
    }

    const t = Math.max(0, hit.t - SKIN)
    body.x += dx * t
    body.z += dz * t

    // Composante entrant dans la façade. Au-delà d'une vitesse d'impact
    // minimale on la renvoie (rebond) ; en dessous on l'annule simplement,
    // sinon un contact rasant ferait vibrer la voiture contre le mur.
    const vInto = velocity.x * hit.nx + velocity.z * hit.nz
    const bounce = -vInto > BOUNCE_MIN ? RESTITUTION : 0
    const factor = 1 + bounce

    // Déplacement restant : réfléchi ou projeté, selon le même facteur
    const rx = dx * (1 - t)
    const rz = dz * (1 - t)
    const into = rx * hit.nx + rz * hit.nz
    dx = rx - factor * into * hit.nx
    dz = rz - factor * into * hit.nz

    if (vInto < 0) {
      velocity.x -= factor * vInto * hit.nx
      velocity.z -= factor * vInto * hit.nz
    }

    // Le choc s'entend : l'intensité suit la vitesse d'impact
    // Choc en biais : le produit vectoriel cap × normale donne le sens dans
    // lequel la voiture part en embardée. Nul sur un impact frontal parfait,
    // maximal quand on frotte un mur de flanc.
    if (bounce) {
      gamepad.rumble(-vInto / MAX_SPEED, 0.4, 120)
      const cross = Math.sin(carHeading) * hit.nz - Math.cos(carHeading) * hit.nx
      spin = THREE.MathUtils.clamp(spin + cross * -vInto * SPIN_GAIN, -MAX_SPIN, MAX_SPIN)
    }
  }
}

// Coincé entre deux obstacles : le joueur appuie mais n'avance plus. Plutôt
// que de le téléporter, la voiture fait un bond et survole ce qui la bloque —
// en l'air, les collisions sont ignorées.
const STUCK_DELAY = 1.1 // secondes bloqué avant le saut de dégagement
// Le saut suffit à sortir d'un mur affleurant, pas d'un interstice entre deux
// bâtiments : on y retombe aussi serré qu'on en est parti. Au-delà de ce
// nombre de tentatives, on cesse d'insister et on repose la voiture au milieu
// de la chaussée la plus proche.
const STUCK_HOPS_BEFORE_RESCUE = 2
const STUCK_SPEED = 1.5 // en dessous, on considère la voiture immobile
const HOP_SPEED = 15    // impulsion verticale du saut
const HOP_PUSH = 11     // poussée horizontale qui accompagne le saut
let stuckTime = 0
let stuckHops = 0

// Milieu de la chaussée la plus proche. Les rues courent sur les frontières
// de blocs, en x comme en z : on ramène donc la coordonnée la plus proche de
// sa ligne de grille, et on laisse l'autre où elle est — la voiture glisse
// latéralement jusqu'à l'axe plutôt que d'être expédiée à un croisement.
function nearestRoadCentre(out) {
  const gx = Math.round(body.x / CELL) * CELL
  const gz = Math.round(body.z / CELL) * CELL
  if (Math.abs(body.x - gx) <= Math.abs(body.z - gz)) out.set(gx, 0, body.z)
  else out.set(body.x, 0, gz)
  return out
}

const _rescue = new THREE.Vector3()

// Dernier recours : la voiture est déposée sur la chaussée, à l'arrêt et
// tournée dans l'axe de la rue. Ce n'est pas une réapparition — on ne perd ni
// sa position dans la ville, ni sa partie.
function rescueToRoad() {
  nearestRoadCentre(_rescue)
  body.x = _rescue.x
  body.z = _rescue.z
  // Dégagement de sécurité : le milieu de la chaussée est libre par
  // construction, mais un véhicule de police peut s'y trouver.
  depenetrate(body)
  prevBody.copy(body)
  carPosition.copy(body)

  // Orientation le long de la rue : sur un axe en x, la rue court en z.
  const alongZ = Math.abs(body.x - Math.round(body.x / CELL) * CELL) < 0.5
  const facing = alongZ ? (velocity.z < 0 ? Math.PI : 0) : velocity.x < 0 ? -Math.PI / 2 : Math.PI / 2
  carHeading = facing
  prevHeading = facing

  velocity.set(0, 0, 0)
  _lateral.set(0, 0, 0)
  speed = 0
  spin = 0
  airborne = false
  fallHeight = 0
  fallSpeed = 0
  stuckTime = 0
  stuckHops = 0
  showNotice('Remise sur la route')
}

function checkStuck() {
  const pushing = pressed.throttle || pressed.brake
  const moving = Math.hypot(velocity.x, velocity.z) > STUCK_SPEED

  if (!pushing || moving) {
    stuckTime = 0
    stuckHops = 0
    return
  }

  stuckTime += FIXED_DT
  if (stuckTime < STUCK_DELAY) return

  // Le saut n'a rien donné les fois précédentes : on ne s'acharne pas.
  if (stuckHops >= STUCK_HOPS_BEFORE_RESCUE) return rescueToRoad()

  stuckTime = 0
  stuckHops++
  airborne = true
  fallHeight = 0.01
  fallSpeed = -HOP_SPEED

  // Poussée dans la direction demandée, pour retomber ailleurs
  const way = pressed.brake && !pressed.throttle ? -1 : 1
  velocity.set(Math.sin(carHeading) * HOP_PUSH * way, 0, Math.cos(carHeading) * HOP_PUSH * way)
  speed = HOP_PUSH * way
  _lateral.set(0, 0, 0)
  showNotice('Dégagement')
}

// Respawn : la voiture est lâchée d'une certaine hauteur et retombe.
// Le pilotage est rendu à l'atterrissage.
const RESPAWN_HEIGHT = 40
const GRAVITY = 55
const LAND_RESTITUTION = 0.45 // rebond sur le bitume
const LAND_STOP = 4           // en dessous, la voiture se pose pour de bon
let fallHeight = 0
let fallSpeed = 0
let airborne = false

function respawn() {
  falling = null
  carGroup.rotation.x = 0
  if (whiteSpace) exitWhiteSpace()
  if (portal) {
    setPanelInstanceVisible(portal.key, true)
    portal = null
  }
  currentPortal = null
  world.position.y = 0
  portalMesh.visible = false
  portalLight.visible = false

  // Nouveau point de chute : un croisement, quelque part dans la ville
  const dx = Math.round((Math.random() - 0.5) * 12)
  const dz = Math.round((Math.random() - 0.5) * 12)
  body.set(Math.round(body.x / CELL + dx) * CELL, 0, Math.round(body.z / CELL + dz) * CELL)
  prevBody.copy(body)
  carPosition.copy(body)

  velocity.set(0, 0, 0)
  _lateral.set(0, 0, 0)
  speed = 0
  spin = 0
  steerInput = 0
  straightTime = 0
  ambushTimer = 0
  accumulator = 0

  carHeading = Math.round(Math.random() * 3) * (Math.PI / 2)
  prevHeading = carHeading

  framingBlend = null
  cameraOffset.set(0, 0, 0)
  stuckTime = 0
  fallHeight = RESPAWN_HEIGHT
  fallSpeed = 0
  airborne = true

  updateChunks()
  clearPolice()
  refreshPoliceFleet()
  applyCameraOrientation()
  showNotice('Respawn')
}

function step() {
  prevBody.copy(body)
  prevHeading = carHeading

  if (airborne) {
    fallSpeed += GRAVITY * FIXED_DT
    fallHeight -= fallSpeed * FIXED_DT

    // En l'air, la voiture survole : elle avance sans être arrêtée par les
    // façades. C'est ce qui permet au saut de dégagement de la sortir d'un
    // coincement au lieu de la faire retomber au même endroit.
    body.x += velocity.x * FIXED_DT
    body.z += velocity.z * FIXED_DT

    if (fallHeight <= 0) {
      fallHeight = 0
      // Rebond amorti, jusqu'à ce qu'il ne reste plus assez d'énergie
      if (fallSpeed > LAND_STOP) fallSpeed = -fallSpeed * LAND_RESTITUTION
      else {
        fallSpeed = 0
        airborne = false
        depenetrate(body) // à l'atterrissage, jamais dans un mur
      }
    }
    return // en l'air : aucun pilotage
  }

  const handbrake = pressed.handbrake

  /* Embardée subie : elle tourne la voiture puis s'amortit */
  carHeading += spin * FIXED_DT
  spin *= Math.exp(-SPIN_DAMP * FIXED_DT)

  /* Braquage : proportionnel à la vitesse — une voiture à l'arrêt ne tourne
     pas sur elle-même — et inversé en marche arrière, comme un vrai volant.
     Le volant ne saute pas d'un bord à l'autre : il rejoint progressivement
     la position demandée, et revient au centre quand on relâche. */
  // La manette donne une consigne continue ; le clavier reste en tout ou rien
  // La course de la manette tactile est adoucie par une courbe : le centre
  // devient plus fin, les grands angles restent atteignables. Sans elle, le
  // moindre frémissement du pouce braquait déjà franchement. Le stick d'une
  // manette physique y échappe — il a la précision qu'un pouce n'a pas.
  const touchSteer = axis(driveStick.x)
  const stickSteer = touchSteer ? touchSteer * Math.abs(touchSteer) : pad.steer
  const steerTarget = stickSteer
    ? -stickSteer
    : (pressed.left ? 1 : 0) - (pressed.right ? 1 : 0)
  steerInput += (steerTarget - steerInput) * (1 - Math.exp(-STEER_SMOOTH * FIXED_DT))

  const forwardSpeed = velocity.x * Math.sin(carHeading) + velocity.z * Math.cos(carHeading)
  if (Math.abs(steerInput) > 1e-3 && Math.abs(forwardSpeed) > 0.3) {
    const grip = Math.min(1, Math.abs(forwardSpeed) / GRIP_SPEED)
    const rate = STEER_RATE * (handbrake ? HANDBRAKE_STEER : 1)
    carHeading += steerInput * rate * grip * Math.sign(forwardSpeed) * FIXED_DT
  }

  /* Décomposition de la vélocité MONDE dans le repère du nouveau cap.
     C'est l'ordre qui compte : le châssis tourne, le vecteur vitesse non —
     l'écart entre les deux est exactement la dérive. */
  const sin = Math.sin(carHeading)
  const cos = Math.cos(carHeading)
  speed = velocity.x * sin + velocity.z * cos
  _lateral.x = velocity.x - sin * speed
  _lateral.z = velocity.z - cos * speed

  /* Accélération, frein, marche arrière, frein à main */
  if (handbrake) {
    // Roues bloquées : plus de moteur, un ralentissement franc mais pas brutal
    const decel = HANDBRAKE_DECEL * FIXED_DT
    speed = Math.abs(decel) >= Math.abs(speed) ? 0 : speed - Math.sign(speed) * decel
  } else if (pressed.throttle) {
    speed += ENGINE_ACCEL * pressed.throttleLevel * FIXED_DT
  } else if (pressed.brake) {
    // Tant qu'on avance, S freine. Une fois à l'arrêt, il enclenche la
    // marche arrière : un seul appui maintenu fait les deux dans l'ordre.
    const level = pressed.brakeLevel
    if (speed > 0.1) speed -= BRAKE_DECEL * level * FIXED_DT
    else speed -= REVERSE_ACCEL * level * FIXED_DT
  } else {
    // Décélération libre : traînée proportionnelle à la vitesse (courbe
    // exponentielle, mord fort en haut) + résistance constante qui finit
    // le travail et amène vraiment à zéro.
    const decel = speed * DRAG * FIXED_DT + Math.sign(speed) * ROLL_RESIST * FIXED_DT
    speed = Math.abs(decel) >= Math.abs(speed) ? 0 : speed - decel
  }
  speed = THREE.MathUtils.clamp(speed, -MAX_REVERSE, MAX_SPEED)

  /* Adhérence latérale : la dérive se résorbe vite en temps normal, très
     lentement frein à main tiré — c'est tout ce qui fait le drift. */
  const gripRate = handbrake ? HANDBRAKE_GRIP : LATERAL_GRIP
  const grip = Math.exp(-gripRate * FIXED_DT)
  _lateral.x *= grip
  _lateral.z *= grip

  /* Recomposition et collisions */
  velocity.x = sin * speed + _lateral.x
  velocity.z = cos * speed + _lateral.z

  // Ligne droite maintenue : c'est ce qui déclenche les embuscades frontales
  if (Math.abs(steerInput) < 0.15 && speed > 8) straightTime += FIXED_DT
  else straightTime = 0

  // Rendez-vous périodique : un véhicule est lancé de face dès qu'on roule
  if (speed > 8) ambushTimer += FIXED_DT
  if (ambushTimer > AMBUSH_INTERVAL && straightTime > AMBUSH_DELAY) {
    ambushTimer = 0
    spawnAmbush()
  }

  moveAndSlide(FIXED_DT)
  checkStuck()
  if (hitCooldown > 0) hitCooldown -= FIXED_DT
  stepPolice(FIXED_DT)
  checkPortals(body.x, body.z)
}

// Boucle à pas fixe + interpolation du rendu : la réponse aux collisions ne
// dépend plus du framerate, et l'affichage reste fluide entre deux pas.
let accumulator = 0
let renderAlpha = 0 // avancement dans le pas de simulation en cours
function updateMovement(delta) {
  if (gameOver || paused) return
  if (falling) {
    // La caméra n'est pas replacée : elle reste au bord du trou et regarde
    // la voiture descendre.
    updateFalling(delta)
    return
  }
  if (portal) {
    stepPortal(delta)
    return
  }

  accumulator += delta
  let steps = 0
  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    step()
    accumulator -= FIXED_DT
    steps++
  }
  if (steps === MAX_STEPS) accumulator = 0 // on abandonne le retard accumulé
  refreshPoliceFleet()

  const alpha = accumulator / FIXED_DT
  renderAlpha = alpha
  carPosition.x = prevBody.x + (body.x - prevBody.x) * alpha
  carPosition.z = prevBody.z + (body.z - prevBody.z) * alpha

  // Cap interpolé par le plus court chemin angulaire, pour ne pas faire un
  // tour complet au passage par ±180°
  let diff = ((carHeading - prevHeading + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2

  carGroup.position.set(carPosition.x, CAR_GROUND + fallHeight, carPosition.z)
  carGroup.rotation.y = prevHeading + diff * alpha
  placeCamera()
}


/* ---------- Routes ---------- */
// Trois routes : la ville à la racine, le menu, et une par projet. L'URL est
// la source de vérité au chargement — recharger sur /un-projet doit rouvrir
// ce projet, pas retomber en ville.
const BASE = import.meta.env.BASE_URL
const MENU_ROUTE = 'menu'

function currentRoute() {
  const path = decodeURIComponent(location.pathname)
  return path.startsWith(BASE) ? path.slice(BASE.length).replace(/\/+$/, '') : ''
}

function routeToPath(route) {
  return `${BASE}${route}`
}

// Index du projet correspondant à une route, ou -1
function projectFromRoute(route) {
  return PROJECTS.findIndex((project) => project.slug === route)
}

/* ---------- Espace blanc : entrée et sortie ---------- */
// Arrivée dans l'espace blanc : le panneau a fini de s'ouvrir, il n'a plus
// rien à masquer. La ville est simplement mise de côté — elle n'est ni
// détruite ni régénérée, le respawn la retrouve telle quelle.
// `push` à faux quand l'URL décrit déjà la destination : au chargement direct
// sur /un-projet, empiler une entrée d'historique ferait reculer vers la même
// page au premier clic sur Précédent.
function enterWhiteSpace({ push = true } = {}) {
  whiteSpace = true

  // Point de vue conservé pour la fenêtre de la porte de retour
  cityView.x = body.x
  cityView.z = body.z
  cityView.heading = carHeading

  // Lumières neutralisées : le soleil orange et l'ambiance bleue de la ville
  // teintaient le sol en rose et la carrosserie en violet, alors que le
  // panneau qu'on vient de traverser était d'un blanc pur.
  sunLight.color.set(0xffffff)
  hemiLight.color.set(0xffffff)
  hemiLight.groundColor.set(0xffffff)

  // La caméra reprend EXACTEMENT là où la transition l'a laissée, puis
  // rejoint le cadrage d'arrivée. Sauter directement d'une pose à l'autre
  // produisait une coupure très visible.
  _euler.setFromQuaternion(camera.quaternion, 'YXZ')
  yaw = _euler.y
  settings.cameraPitch = THREE.MathUtils.radToDeg(_euler.x)

  // Cadrage d'arrivée par défaut : pile dans l'axe de la voiture, vue de
  // l'arrière et légèrement en plongée. `chase` demande de recalculer la
  // cible à chaque frame, pour finir exactement derrière elle même si elle a
  // tourné. aimAtMainMedia() le remplace plus bas, une fois les plans posés.
  framingBlend = { chase: true, pitch: WHITE_EXIT_PITCH, elapsed: 0 }

  portal = null
  currentPortal = null

  // La position aussi doit être continue : la caméra de transition est bien
  // plus haute et plus loin que la caméra de poursuite. On mesure l'écart et
  // on le laisse se résorber, au lieu de basculer d'une pose à l'autre.
  // placeCamera() ne calcule la pose de poursuite qu'une fois `portal` libéré.
  cameraOffset.set(0, 0, 0)
  _camGoal.copy(camera.position) // pose laissée par la transition
  placeCamera() // pose de poursuite correspondante
  cameraOffset.copy(_camGoal).sub(camera.position)

  portalMesh.visible = false
  portalLight.visible = false

  world.visible = false
  sky.visible = false
  scene.fog = null
  scene.background = WHITE_SPACE_COLOR
  // Les poursuivants ne franchissent pas les panneaux : on les dissout ici,
  // ils seront re-semés au retour, avec un niveau de recherche de plus.
  clearPolice()
  // Nouvelle séquence : le compteur de chocs repart de zéro
  hits = 0
  hitCooldown = 0
  updateDamageStage()

  whiteGround.visible = true
  whiteGround.position.set(carPosition.x, 0, carPosition.z)

  // Constellation de médias du projet, et URL dédiée
  const project = PROJECTS[whiteProject]
  setProjectTitle(project)
  titleMesh.visible = true
  titleGround.visible = true
  spawnProjectPlanes(project)
  aimAtMainMedia()
  placeCta(project)
  placeHole()
  mediaGroup.visible = true
  mediaFade = 0
  const state = { slug: project.slug }
  if (push) history.pushState(state, '', routeToPath(project.slug))
  else history.replaceState(state, '', routeToPath(project.slug))

  // La voiture repart de zéro, dans l'axe où elle a franchi le panneau
  velocity.set(0, 0, 0)
  _lateral.set(0, 0, 0)
  speed = 0
  spin = 0
  steerInput = 0
  accumulator = 0

  applyCameraOrientation()
  showNotice('White space')
}

function exitWhiteSpace() {
  whiteSpace = false
  wanted = Math.min(MAX_WANTED, wanted + 1)
  updateWantedHud()
  sunLight.color.set(settings.sunColor)
  hemiLight.color.copy(SKY_LIGHT)
  hemiLight.groundColor.copy(GROUND)
  mediaGroup.visible = false
  titleMesh.visible = false
  titleGround.visible = false
  hideCta()
  holeMesh.visible = false
  whiteGroundHole.value.w = 0 // le sol se referme en quittant l'espace blanc
  canvas.style.cursor = ''
  clearProjectPlanes()
  world.visible = true
  sky.visible = true
  scene.fog = cityFog
  scene.background = null
  whiteGround.visible = false
  if (currentRoute() !== '') history.pushState({}, '', BASE)
}


// Ouverture d'un projet sans passer par le panneau : la voiture est posée sur
// un croisement, puis l'espace blanc s'installe comme après une transition.
function openProject(index, options) {
  if (whiteSpace) exitWhiteSpace()
  whiteProject = index
  body.set(Math.round(body.x / CELL) * CELL, 0, Math.round(body.z / CELL) * CELL)
  prevBody.copy(body)
  carPosition.copy(body)
  velocity.set(0, 0, 0)
  speed = 0
  updateChunks() // la fenêtre du puits montre la ville : elle doit exister
  enterWhiteSpace(options)
}

/* ---------- Courbes d'animation ---------- */
// Deux profils : l'ensemble doit démarrer sec et finir posé.
const ease = {
  // Longue retenue, puis accélération brutale, puis freinage : le panneau
  // semble aspiré vers l'écran.
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  // Départ instantané puis approche asymptotique : le masque claque.
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
}

/* ---------- Ouverture du portail : masque polygonal ---------- */
// Séquence inspirée du storyboard : un éclat blanc naît au centre du panneau
// et grandit en polygone irrégulier jusqu'à tout recouvrir. Noir = média du
// panneau, blanc = espace vide. Les images clés partagent le même nombre de
// sommets, ce qui permet de les interpoler deux à deux.
const MASK_VERTICES = 6
const MASK_KEYFRAMES = [
  // 1. entièrement contracté sur un point : rien n'est visible
  [0.455, 0.54, 0.455, 0.54, 0.455, 0.54, 0.455, 0.54, 0.455, 0.54, 0.455, 0.54],
  // 2. première ouverture, en biais
  [0.2, 0.9, 0.62, 0.75, 0.66, 0.54, 0.5, 0.32, 0.32, 0.5, 0.25, 0.72],
  // 3. le polygone occupe l'essentiel de la surface
  [0.13, 0.78, 0.58, 0.87, 0.72, 0.4, 0.5, 0.07, 0.27, 0.2, 0.08, 0.55],
  // 4. débordement franc : plus rien du panneau n'est visible
  [-0.6, 1.8, 1.6, 1.8, 1.9, -0.5, 1.2, -0.9, -0.4, -0.8, -0.9, 0.6],
]

// Tampon envoyé au shader, réécrit à chaque frame par interpolation
const maskPoints = new Float32Array(MASK_VERTICES * 2)

const portalFrontMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  toneMapped: false,
  uniforms: {
    uMap: { value: null },
    uHasMap: { value: 0 },
    uRepeat: { value: new THREE.Vector2(1, 1) },
    uOffset: { value: new THREE.Vector2(0, 0) },
    uPoly: { value: maskPoints },
    uWarp: { value: 0 }, // intensité du trou de ver, 0 au repos
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform float uHasMap;
    uniform vec2 uRepeat;
    uniform vec2 uOffset;
    uniform vec2 uPoly[${MASK_VERTICES}];
    uniform float uWarp;
    varying vec2 vUv;

    // Échantillon du média, recadrage "cover" compris
    vec3 sampleMedia(vec2 uv) {
      if (uHasMap < 0.5) return vec3(1.0);
      return texture2D(uMap, clamp(uv, 0.0, 1.0) * uRepeat + uOffset).rgb;
    }

    // Test d'appartenance par lancer de rayon : on compte les arêtes
    // franchies à droite du point. Impair = dedans.
    bool insideMask(vec2 p) {
      bool inside = false;
      for (int i = 0; i < ${MASK_VERTICES}; i++) {
        int j = i + 1;
        if (j == ${MASK_VERTICES}) j = 0;
        vec2 a = uPoly[i];
        vec2 b = uPoly[j];
        if ((a.y > p.y) != (b.y > p.y)) {
          float x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
          if (p.x < x) inside = !inside;
        }
      }
      return inside;
    }

    void main() {
      if (insideMask(vUv)) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec2 centered = vUv - 0.5;
      float radius = length(centered);

      // Vrille : l'angle augmente avec le rayon, donc le bord tourne plus vite
      // que le centre — c'est ce qui donne la spirale du trou de ver.
      float angle = atan(centered.y, centered.x) + uWarp * radius * 2.6;
      vec2 twisted = vec2(cos(angle), sin(angle)) * radius;

      // Flou de mouvement radial : plusieurs échantillons pris en s'éloignant
      // du centre, ce qui étire l'image vers l'extérieur comme une aspiration.
      const int SAMPLES = 10;
      vec3 color = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float k = float(i) / float(SAMPLES - 1);
        // Les échantillons s'écartent d'autant plus qu'on est loin du centre
        float zoom = 1.0 + k * uWarp * 0.55 * (0.25 + radius);
        float weight = 1.0 - k * 0.65;
        color += sampleMedia(twisted * zoom + 0.5) * weight;
        total += weight;
      }
      color /= total;

      // Assombrissement vers le bord : la lumière est aspirée dans le tunnel
      color *= mix(1.0, 1.0 - smoothstep(0.15, 0.72, radius) * 0.85, uWarp);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
})

// Interpole la forme entre deux images clés. `t` parcourt toute la séquence.
function updateMaskShape(t) {
  const span = MASK_KEYFRAMES.length - 1
  const scaled = THREE.MathUtils.clamp(t, 0, 1) * span
  const index = Math.min(Math.floor(scaled), span - 1)
  const local = scaled - index
  const from = MASK_KEYFRAMES[index]
  const to = MASK_KEYFRAMES[index + 1]
  for (let i = 0; i < maskPoints.length; i++) {
    maskPoints[i] = from[i] + (to[i] - from[i]) * local
  }
  portalFrontMaterial.uniforms.uPoly.value = maskPoints
}

// Les tranches du caisson s'effacent elles aussi : blanc pur non éclairé.
const portalEdgeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
const portalMaterials = [
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalFrontMaterial,
  portalEdgeMaterial,
]

// Panneau "actif" : une copie autonome du panneau en cours de franchissement,
// que l'on peut agrandir librement — les autres vivent dans un InstancedMesh
// et ne sont pas animables individuellement.
const portalMesh = new THREE.Mesh(billboardGeometry, portalMaterials)
portalMesh.visible = false
portalMesh.frustumCulled = false
scene.add(portalMesh)

// Le logo du client suit le panneau pendant toute la transition : c'est la
// seule chose qui reste lisible une fois le média étiré par le tunnel.
// Enfant du portail, donc entraîné par son agrandissement.
// Matériau propre au portail : il partage la texture des panneaux mais pas
// leur opacité, qui est animée pendant la transition.
const portalLogo = new THREE.Mesh(
  logoGeometry,
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
)
portalLogo.visible = false
portalLogo.position.z = 0.55 // devant la face avant du caisson
portalLogo.renderOrder = 1
portalMesh.add(portalLogo)

// Débord lumineux du panneau sur son environnement immédiat. Une seule
// lumière, portée par le panneau actif : la diffusion de tous les panneaux
// coûterait bien trop cher.
const portalLight = new THREE.PointLight(0xffffff, 0, 30, 2)
portalLight.visible = false
scene.add(portalLight)

const PORTAL_DURATION = 1.6  // secondes d'animation automatique, une fois amorcé
const MASK_DURATION = 1.1    // secondes d'ouverture du masque
const MASK_TRIGGER = 0.5     // mi-parcours du tunnel : le masque blanc s'ouvre alors
const PORTAL_STRAIGHTEN = 7  // vitesse de redressement de la voiture face au panneau
const PORTAL_COVER = 1.25    // marge de recouvrement du viewport
const PORTAL_DROP_DEPTH = 2.5 // la ville descend largement sous le champ de vision
const PORTAL_CAM_BLEND = 6   // vitesse de recadrage de la caméra face au panneau

// Une fois amorcée, la séquence se joue seule : ni les touches ni la souris
// n'ont plus de prise. Le bouton de fermeture est la seule sortie.
function stepPortal(delta) {
  if (portal.progress < 1) {
    portal.progress = Math.min(1, portal.progress + delta / PORTAL_DURATION)
  }

  // Le masque blanc s'amorce à mi-parcours du trou de ver : les deux effets
  // se recouvrent largement, l'aspiration est encore bien visible quand
  // l'ouverture commence.
  if (portal.progress >= MASK_TRIGGER && portal.mask < 1) {
    portal.mask = Math.min(1, portal.mask + delta / MASK_DURATION)
    if (portal.mask >= 1) {
      // enterWhiteSpace() libère `portal` : plus rien à animer ici.
      enterWhiteSpace()
      return
    }
  }

  // Redressement : la voiture pivote face au panneau, pour l'aborder droit.
  // Le cap visé est l'opposé de la normale, puisqu'elle roule vers la façade.
  const b = portal.billboard
  const target = Math.atan2(-b.nx, -b.nz)
  let diff = ((target - carHeading + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  carHeading += diff * (1 - Math.exp(-PORTAL_STRAIGHTEN * delta))
  prevHeading = carHeading

  // updateMovement est court-circuité pendant la transition : c'est ici que
  // la voiture doit être posée.
  carGroup.rotation.y = carHeading
}

/* ---------- Resize ---------- */
function resize() {
  const w = window.innerWidth
  const h = window.innerHeight
  camera.aspect = w / h
  camera.fov = settings.fov
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio))
  // Le titre est peint à la résolution de l'affichage : changer celle-ci
  // périme la texture, il faut la repeindre pour qu'elle reste nette.
  if (whiteSpace && titleProject) setProjectTitle(titleProject)
}
window.addEventListener('resize', resize)
resize()

/* ---------- Interface ---------- */
// Recolorer les façades ne nécessite pas de régénérer la ville : on réécrit
// simplement l'attribut de couleur de chaque InstancedMesh déjà en scène.
function refreshBuildingColors() {
  for (const chunk of chunks.values()) {
    chunk.traverse((o) => {
      if (!o.isInstancedMesh || !o.userData.shades) return
      o.userData.shades.forEach((shade, i) => {
        _color.copy(BUILDING).lerp(WHITE, shade * 0.8)
        o.setColorAt(i, _color)
      })
      o.instanceColor.needsUpdate = true
    })
  }
}

// Le panneau de réglages est masqué par défaut : il ne concerne que le
// réglage de la scène, pas le joueur. `debugBTA()` dans la console le révèle
// (et le remasque), sans avoir à recharger ni à recompiler.
const gui = new GUI({ title: 'Brand Theft Auto' })
gui.hide()

window.debugBTA = () => {
  const hidden = gui.domElement.style.display === 'none'
  if (hidden) gui.show()
  else gui.hide()
  return hidden ? 'réglages affichés' : 'réglages masqués'
}

gui.add(settings, 'cameraHeight', 0.5, 40, 0.1).name('Hauteur caméra').onChange(applyCameraOrientation)
gui.add(settings, 'cameraDistance', 0, 40, 0.5).name('Recul caméra').onChange(applyCameraOrientation)
const pitchController = gui
  .add(settings, 'cameraPitch', -80, 80, 0.5)
  .name('Inclinaison')
  .onChange(applyCameraOrientation)
gui.add(settings, 'fov', 25, 110, 1).name('Champ de vision').onChange(resize)
gui.add(settings, 'carScale', 0.2, 2, 0.05).name('Taille du véhicule').onChange(applyCarScale)
gui.add(settings, 'sunHeight', 0, 1, 0.001).name('Hauteur du soleil').onChange(updateSun)

// Les deux postes qui pèsent vraiment, réglables à chaud : on voit tout de
// suite lequel des deux tient le compteur, ce qu'aucune lecture du code ne
// dira à ma place.
const perf = gui.addFolder('Performance')
perf.add(settings, 'pixelRatio', 0.5, 2, 0.05).name('Densité de pixels').onChange(resize)
// Le cadrage de la vue projet se juge à l'œil : tout ce qui le compose est
// réglable à chaud plutôt que figé dans des constantes.
const projectView = gui.addFolder('Vue projet')
projectView.add(settings, 'whiteCameraGaze', 0, 40, 0.5).name('Relèvement du regard')
projectView.add(settings, 'titleHeight', 0.08, 0.4, 0.005).name('Taille du titre')
projectView.add(settings, 'titleOffset', 0, 0.45, 0.005).name('Remontée du titre')
projectView.add(settings, 'titleWidth', 0.25, 1, 0.01).name('Largeur max du titre')

let qualityController = null
qualityController = perf
  .add(settings, 'quality', 0, QUALITY_LEVELS.length - 1, 1)
  .name('Palier de qualité')
  .onChange(applyQuality)
perf.add(settings, 'qualityAuto').name('Baisse automatique')
perf.add(settings, 'viewRadius', 1, 5, 1).name('Rayon de ville')
perf.add(settings, 'maxVideos', 0, 7, 1).name('Vidéos simultanées')

perf.add(settings, 'shadowSize', [1024, 2048, 4096]).name('Netteté des ombres').onChange((v) => {
  sunLight.shadow.mapSize.set(v, v)
  // La carte est déjà allouée : il faut la jeter pour que three la recrée à
  // la nouvelle définition.
  sunLight.shadow.map?.dispose()
  sunLight.shadow.map = null
})
perf.add(settings, 'shadows').name('Ombres portées').onChange((v) => {
  renderer.shadowMap.enabled = v
  // Activer ou couper les ombres change le programme compilé : sans cette
  // invalidation, la scène garde l'ancien rendu jusqu'au prochain matériau.
  scene.traverse((o) => {
    if (o.material) o.material.needsUpdate = true
  })
})

const colors = gui.addFolder('Couleurs')
colors.addColor(settings, 'skyColor').name('Ciel').onChange(() => {
  // SKY et HORIZON sont référencés par les uniforms et le fog : il suffit de
  // les muter sur place. La lumière d'ambiance, elle, ne les suit plus.
  applySkyColor()
})
colors.addColor(settings, 'skyLightColor').name('Lumière du ciel').onChange((v) => {
  SKY_LIGHT.set(v)
  hemiLight.color.copy(SKY_LIGHT)
})
colors.add(settings, 'showSun').name('Disque solaire').onChange((v) => {
  skyMaterial.uniforms.uSunGlow.value = v ? 1 : 0
})
colors.addColor(settings, 'sunColor').name('Soleil').onChange((v) => {
  SUN.set(v)
  sunLight.color.set(v)
  // l'uniform pointe sur SUN : la mise à jour se propage au ciel toute seule
})
colors.addColor(settings, 'buildingColor').name('Immeubles').onChange((v) => {
  BUILDING.set(v)
  refreshBuildingColors()
})
colors.addColor(settings, 'roadColor').name('Rues').onChange((v) => roadMaterial.color.set(v))
colors.addColor(settings, 'sidewalkColor').name('Trottoirs').onChange((v) => sidewalkMaterial.color.set(v))
colors.addColor(settings, 'lampColor').name('Lampadaires').onChange((v) => lampPostMaterial.color.set(v))
colors.addColor(settings, 'lampLightColor').name('Lampes').onChange((v) => lampGlassMaterial.emissive.set(v))

// Bouton « copier en JSON » réutilisable : chaque onglet a le sien, sur son
// propre objet de réglages, avec son propre retour visuel.
function addCopyButton(folder, label, source) {
  let timer
  const controller = folder
    .add(
      {
        async copy() {
          const json = JSON.stringify(source, null, 2)
          try {
            await navigator.clipboard.writeText(json)
            flash('Copié !')
          } catch {
            // navigator.clipboard exige un contexte sécurisé (https / localhost)
            flash('Copie refusée')
            console.log(json)
          }
        },
      },
      'copy'
    )
    .name(label)

  function flash(text) {
    clearTimeout(timer)
    controller.name(text)
    timer = setTimeout(() => controller.name(label), 1200)
  }
  return controller
}

addCopyButton(gui, 'Copier le JSON', settings)

/* ---------- Onglet Ville ---------- */
// Les paramètres de génération changent la géométrie : il faut reconstruire
// les chunks. Le hash étant déterministe, la ville reste identique à elle-même
// d'une régénération à l'autre pour des réglages donnés.
function regenerateCity() {
  for (const [k, chunk] of chunks) {
    world.remove(chunk)
    chunk.traverse((o) => o.isInstancedMesh && o.dispose())
    chunk.userData.panelKeys?.forEach((pk) => panelLookup.delete(pk))
    chunks.delete(k)
  }
  updateChunks()
}

const cityFolder = gui.addFolder('Ville')
cityFolder.add(city, 'density', 0.2, 1, 0.01).name('Densité par bloc')
cityFolder.add(city, 'thickness', 0.25, 0.98, 0.01).name('Épaisseur')
cityFolder.add(city, 'thicknessVariation', 0, 0.8, 0.01).name('Variation épaisseur')
cityFolder.add(city, 'minHeight', 1, 30, 0.5).name('Hauteur min')
cityFolder.add(city, 'maxHeight', 10, 160, 1).name('Hauteur max')
cityFolder.add(city, 'verticality', 1, 6, 0.1).name('Verticalité')
cityFolder.add(city, 'towerRatio', 0, 1, 0.01).name('Tours à gradins')
cityFolder.add(city, 'sidewalkHeight', 0, 3, 0.05).name('Hauteur trottoir')
cityFolder.add(city, 'billboardFrequency', 0, 1, 0.01).name('Fréquence panneaux')
cityFolder.controllers.forEach((c) =>
  c.onChange(() => {
    regenerateCity()
    applyCameraOrientation() // la hauteur de trottoir décale le sol sous la caméra
  })
)
addCopyButton(cityFolder, 'Copier le JSON', city)




/* ---------- Plans flottants de l'espace blanc ---------- */
// Un plan par média du projet franchi. Ils flottent devant la voiture et se
// déforment à son passage, comme une membrane souple.
const MEDIA_HEIGHT = 3.4 // hauteur de référence d'un plan

// Réglages du shader, exposés dans le GUI. Les uniforms sont partagés par
// tous les plans : une seule valeur à changer pour les affecter tous.
const CAR_CABIN_Y = 0.7 // centre du volume de la voiture, au-dessus du sol

const planeShader = {
  eraseRadius: 1.9,   // rayon d'effacement autour de la voiture
  eraseHeight: 1.1,   // demi-hauteur de la zone effacée
  edge: 0.005,        // largeur du dégradé de bord : petit = frontière nette
  wobble: 0.06,       // amplitude de l'ondulation du contour
  wobbleSpeed: 1.7,   // vitesse de l'ondulation
  cameraRadius: 6,    // rayon d'effacement autour de la caméra
  cameraFalloff: 4,   // profondeur du fondu devant la caméra
  fade: 1.25,         // secondes d'apparition des plans
  floatAmplitude: 0.5,// amplitude du flottement vertical
  floatSpeed: 0.55,   // vitesse du flottement
}

// Arrivée : les plans surgissent de très loin et fondent sur le joueur avant
// de se figer à leur place. Ils partent tous du même point — la voiture —
// donc les trajectoires convergent, comme un couloir qui se referme.
const MEDIA_ENTRY_FAR = 45      // multiplicateur de distance au départ
const MEDIA_ENTRY_TIME = 0.75   // secondes de vol, par plan
const MEDIA_ENTRY_STAGGER = 0.05 // décalage d'un plan au suivant
// Cercle complet : les plans cernent la scène au lieu de la barrer. Le rayon
// doit englober le trou de sortie, posé à HOLE_DISTANCE derrière la voiture —
// sous 25 unités (sa distance plus son rayon), la couronne lui passerait au
// travers. Au-delà, plus la couronne est resserrée, plus les médias sont gros
// et lisibles à l'écran.
const MEDIA_ARC = Math.PI * 2
const MEDIA_RINGS = [25, 31, 37] // trois profondeurs, toutes au-delà du trou
// Un cercle complet est bien plus long à garnir qu'un arc : en dessous de ce
// compte, les médias du projet sont repris pour le refermer. Resserrée, la
// couronne a besoin de moins de plans pour se fermer sans les empiler.
const MEDIA_MIN_PLANES = 22
const TITLE_FADE = 0.7          // secondes de fondu du titre, après les plans

const mediaGroup = new THREE.Group()
mediaGroup.visible = false
scene.add(mediaGroup)

// Point d'où partent les trajectoires : la position de la voiture à l'arrivée
const mediaAnchor = new THREE.Vector3()
let mediaEntry = 0
let mediaEntryTotal = 0 // durée totale du vol, titre et logo attendent la fin

// L'effacement se joue entièrement au fragment : un quad suffit.
const mediaGeometry = new THREE.PlaneGeometry(1, 1)

// Uniforms communs à tous les plans : un seul objet à mettre à jour par frame
const mediaUniforms = {
  uCar: { value: new THREE.Vector3() },
  uCamera: { value: new THREE.Vector3() },
  uTime: { value: 0 },
  uRadius: { value: planeShader.eraseRadius },
  uHalfHeight: { value: planeShader.eraseHeight },
  uEdge: { value: planeShader.edge },
  uWobble: { value: planeShader.wobble },
  uWobbleSpeed: { value: planeShader.wobbleSpeed },
  uCameraRadius: { value: planeShader.cameraRadius },
  uCameraFalloff: { value: planeShader.cameraFalloff },
  uOpacity: { value: 0 },
}

function syncPlaneShader() {
  mediaUniforms.uRadius.value = planeShader.eraseRadius
  mediaUniforms.uHalfHeight.value = planeShader.eraseHeight
  mediaUniforms.uEdge.value = planeShader.edge
  mediaUniforms.uWobble.value = planeShader.wobble
  mediaUniforms.uWobbleSpeed.value = planeShader.wobbleSpeed
  mediaUniforms.uCameraRadius.value = planeShader.cameraRadius
  mediaUniforms.uCameraFalloff.value = planeShader.cameraFalloff
}

function makeMediaMaterial(map) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false, // sinon un plan effacé masque quand même ceux de derrière
    uniforms: { uMap: { value: map }, ...mediaUniforms },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;

      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uCar;
      uniform vec3 uCamera;
      uniform float uTime;
      uniform float uRadius;
      uniform float uHalfHeight;
      uniform float uEdge;
      uniform float uWobble;
      uniform float uWobbleSpeed;
      uniform float uCameraRadius;
      uniform float uCameraFalloff;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorld;

      void main() {
        vec3 delta = vWorld - uCar;

        // Distance normalisee dans un ellipsoide : large au sol, ecrase en
        // hauteur, pour epouser le gabarit de la voiture.
        // Attention : "flat" est un mot reserve en GLSL ES 3.0.
        vec2 planar = delta.xz / uRadius;
        float vertical = delta.y / uHalfHeight;
        float d = length(vec3(planar, vertical));

        // Contour liquide : deux ondulations lentes dephasees, indexees sur
        // l angle, donnent un bord qui coule au lieu d un cercle net.
        float angle = atan(delta.y, length(delta.xz));
        float wobble = 1.0
          + uWobble * sin(angle * 5.0 + uTime * uWobbleSpeed)
          + uWobble * 0.6 * sin(angle * 3.0 - uTime * uWobbleSpeed * 0.65);

        float erased = 1.0 - smoothstep(wobble - uEdge, wobble, d);

        // Meme traitement autour de la camera : traverser un plan en gros plan
        // donnerait un aplat de texture illisible.
        float camDist = distance(vWorld, uCamera);
        float camErase = 1.0 - smoothstep(uCameraRadius, uCameraRadius + uCameraFalloff, camDist);

        float visible = (1.0 - erased) * (1.0 - camErase);
        vec4 texel = texture2D(uMap, vUv);
        float alpha = texel.a * uOpacity * visible;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(texel.rgb, alpha);
      }
    `,
  })
}

// Les plans sont créés d'abord, puis disposés ensemble : c'est la seule
// façon de les répartir régulièrement en arc, le nombre total n'étant connu
// qu'une fois vidéos et images ajoutées.
function layoutMediaPlanes() {
  const items = mediaGroup.children
  const count = items.length
  mediaEntryTotal = (count - 1) * MEDIA_ENTRY_STAGGER + MEDIA_ENTRY_TIME

  items.forEach((mesh, i) => {
    // Cercle refermé : le dernier plan ne doit pas retomber sur le premier,
    // on divise donc par le compte et non par le compte moins un.
    const ratio = count ? i / count : 0
    // Le tour commence dans l'axe de la voiture, et non derrière elle : le
    // premier plan — le média principal du projet — se retrouve donc pile
    // devant, et les autres se répartissent de part et d'autre.
    const angle = carHeading + ratio * MEDIA_ARC
    const radius = MEDIA_RINGS[i % MEDIA_RINGS.length]

    mesh.position.set(
      mediaAnchor.x + Math.sin(angle) * radius,
      CAR_GROUND + mesh.scale.y / 2, // le bas du plan affleure le sol
      mediaAnchor.z + Math.cos(angle) * radius
    )
    mesh.lookAt(mediaAnchor.x, mesh.position.y, mediaAnchor.z)

    mesh.userData.baseY = mesh.position.y
    mesh.userData.home = mesh.position.clone()
    // Les plans les plus proches arrivent en premier
    mesh.userData.delay = i * MEDIA_ENTRY_STAGGER
    mesh.userData.phase = i * 1.7
  })
}

// Dispersion déterministe : même projet, même constellation de plans.
const _aimTarget = new THREE.Vector3()

// À l'arrivée, la mire se pose au centre du média principal — celui qui est
// planté dans l'axe de la voiture. Le calcul part du point visé par la
// caméra, pas de la caméra elle-même : celle-ci orbite autour de ce point,
// donc toute direction alignée avec lui l'est aussi avec l'axe de visée. Ça
// évite d'avoir à résoudre une position qui dépend elle-même de l'angle
// cherché.
function aimAtMainMedia() {
  const hero = mediaGroup.children[0]
  if (!hero) return
  // Sa place définitive, pas sa position courante : les plans arrivent encore
  // en vol, et viser leur point de départ enverrait la caméra à l'opposé.
  _aimTarget.copy(hero.userData.home || hero.position)

  const dx = _aimTarget.x - carPosition.x
  const dz = _aimTarget.z - carPosition.z
  const dy = _aimTarget.y - (city.sidewalkHeight + settings.cameraHeight)
  const ground = Math.hypot(dx, dz)
  if (ground < 1e-3) return

  // La caméra regarde selon -Z : le lacet qui pointe vers une direction est
  // donc celui de son opposé.
  const yawTo = Math.atan2(-dx, -dz)
  // Le relèvement de l'espace blanc s'ajoute au tangage au moment du rendu :
  // on le retranche ici pour que la somme vise juste.
  const pitchTo =
    THREE.MathUtils.radToDeg(Math.atan2(dy, ground)) - settings.whiteCameraGaze

  framingBlend = { yaw: yawTo, pitch: pitchTo, elapsed: 0 }
}

function spawnProjectPlanes(project) {
  clearProjectPlanes()
  mediaAnchor.copy(carPosition)
  mediaEntry = 0
  const files = PROJECT_MEDIA[project.slug] || []

  // Les vidéos du projet, en version non recadrée — celle du panneau est
  // rognée au 16:9 et ferait un plan tronqué. On ne réutilise donc plus son
  // élément ici : chaque monde a son encodage.
  // Plafonnées en nombre pour préserver le framerate.
  const streams = (PROJECT_STREAMS[project.slug] || []).slice(0, MAX_STREAMS)
  streams.forEach((url, i) => {
    const video = createStreamVideo(url)
    if (video) addVideoPlane(video, i)
  })

  // Les médias sont repris autant de fois qu'il le faut pour refermer le
  // cercle. Chaque fichier n'est chargé qu'une fois : les doublons partagent
  // la texture, ils ne coûtent qu'un quadrilatère de plus.
  const wanted = []
  while (files.length && wanted.length + mediaGroup.children.length < MEDIA_MIN_PLANES) {
    wanted.push(...files)
  }
  const loaded = new Map()

  wanted.forEach((url) => {
    const material = makeMediaMaterial(null)
    const mesh = new THREE.Mesh(mediaGeometry, material)

    mesh.scale.set(MEDIA_HEIGHT * 1.6, MEDIA_HEIGHT, 1)
    mesh.visible = false
    mediaGroup.add(mesh)

    const apply = (texture) => {
      material.uniforms.uMap.value = texture
      // Proportions réelles du média, une fois connues
      const aspect = texture.image.width / texture.image.height
      mesh.scale.set(MEDIA_HEIGHT * aspect, MEDIA_HEIGHT, 1)
      mesh.visible = true
      layoutMediaPlanes() // l'échelle a changé : le plan se repose au sol
    }

    const cached = loaded.get(url)
    if (cached) {
      if (cached.texture) apply(cached.texture)
      else cached.waiting.push(apply)
      return
    }

    const entry = { texture: null, waiting: [apply] }
    loaded.set(url, entry)
    textureLoader.load(asset(url), (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      entry.texture = texture
      entry.waiting.forEach((fn) => fn(texture))
      entry.waiting.length = 0
    })
  })

  layoutMediaPlanes()
}

// Vidéos secondaires du projet. Elles étaient des flux HLS distants servis
// par Mux ; ce sont désormais des MP4 transcodés par tools/absolu-projects.py
// et servis avec le jeu. Plus de dépendance réseau tierce, plus de lecteur
// HLS à embarquer, et un poids qu'on maîtrise puisqu'on encode nous-mêmes.
const MAX_STREAMS = 3 // décoder plus de flux simultanés fait chuter le framerate
const activeStreams = []

function createStreamVideo(url) {
  const video = document.createElement('video')
  video.loop = true
  video.muted = true // sans quoi l'autoplay est refusé
  video.playsInline = true
  video.preload = 'auto'
  video.src = asset(url)
  activeStreams.push(video) // conservé pour pouvoir le libérer à la sortie
  video.play().catch(() => {})
  return video
}

// À la sortie de l'espace blanc, les éléments sont détachés de leur source :
// sans cela Chrome garde les tampons de décodage de chaque vidéo visitée.
function releaseStreams() {
  activeStreams.forEach((video) => {
    video.pause()
    video.removeAttribute('src')
    video.load()
  })
  activeStreams.length = 0
}

// Un plan de plus, porteur de la vidéo du projet
function addVideoPlane(video, index = 0) {
  const texture = new THREE.VideoTexture(video)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  const mesh = new THREE.Mesh(mediaGeometry, makeMediaMaterial(texture))
  // La vidéo d'en-tête (index 0) est la pièce maîtresse : elle reste plus
  // grande que les autres, la disposition en arc est réglée à part.
  const height = MEDIA_HEIGHT * (index ? 1.3 : 1.8)
  // Les dimensions réelles ne sont connues qu'une fois les métadonnées lues :
  // on pose un 16:9 par défaut, puis on recale dès qu'elles arrivent.
  const applyRatio = () => {
    const ratio = video.videoWidth / video.videoHeight || 16 / 9
    mesh.scale.set(height * ratio, height, 1)
  }
  applyRatio()
  if (!video.videoWidth) video.addEventListener('loadedmetadata', applyRatio, { once: true })

  // Invisible tant que la vidéo n'a pas de quoi peindre — exactement ce que
  // font déjà les plans images. Sans ça, le plan s'affichait dès sa création
  // avec une texture vide : un rectangle sans rien dedans, au centre de la
  // constellation, le temps que les quelques mégaoctets arrivent. C'est le
  // plan principal qui en souffrait le plus, puisque c'est le plus lourd.
  mesh.visible = video.readyState >= video.HAVE_CURRENT_DATA
  if (!mesh.visible) {
    video.addEventListener('loadeddata', () => (mesh.visible = true), { once: true })
  }
  mediaGroup.add(mesh)

  video.play().catch(() => {}) // flux de l'espace blanc : géré à part
}

function clearProjectPlanes() {
  releaseStreams()
  mediaGroup.children.forEach((mesh) => {
    mesh.material.uniforms.uMap.value?.dispose()
    mesh.material.dispose()
  })
  mediaGroup.clear()
}

// Apparition en fondu, puis suivi de la voiture pour la déformation
let mediaFade = 0
function updateMediaPlanes(delta) {
  if (!mediaGroup.visible) return
  // Centre calé sur l'habitacle, indépendant de la hauteur d'effacement :
  // sinon régler celle-ci faisait aussi monter ou descendre le trou.
  mediaUniforms.uCar.value.set(carPosition.x, CAR_GROUND + CAR_CABIN_Y, carPosition.z)
  mediaUniforms.uCamera.value.copy(camera.position)
  mediaUniforms.uTime.value += delta
  mediaFade = Math.min(1, mediaFade + delta / planeShader.fade)
  mediaUniforms.uOpacity.value = mediaFade

  mediaEntry += delta

  // Flottement : une oscillation lente, déphasée d'un plan à l'autre
  const t = mediaUniforms.uTime.value * planeShader.floatSpeed
  mediaGroup.children.forEach((mesh) => {
    const home = mesh.userData.home
    if (!home) return

    // Vol d'arrivée : le plan part à seize fois sa distance et se rapproche.
    // La courbe expo freine très tard, ce qui donne la ruée puis l'arrêt net.
    const progress = THREE.MathUtils.clamp(
      (mediaEntry - mesh.userData.delay) / MEDIA_ENTRY_TIME,
      0,
      1
    )
    const reach = THREE.MathUtils.lerp(MEDIA_ENTRY_FAR, 1, ease.outExpo(progress))

    // Seules les distances horizontales sont dilatées : les plans arrivent de
    // l'horizon, pas du ciel.
    mesh.position.x = mediaAnchor.x + (home.x - mediaAnchor.x) * reach
    mesh.position.z = mediaAnchor.z + (home.z - mediaAnchor.z) * reach
    mesh.position.y =
      mesh.userData.baseY + Math.sin(t + mesh.userData.phase) * planeShader.floatAmplitude
  })
}

/* ---------- Onglet Plans ---------- */
const planeFolder = gui.addFolder('Plans (espace blanc)')
planeFolder.add(planeShader, 'eraseRadius', 0.5, 8, 0.05).name('Rayon voiture')
planeFolder.add(planeShader, 'eraseHeight', 0.3, 6, 0.05).name('Demi-hauteur')
planeFolder.add(planeShader, 'edge', 0.005, 0.4, 0.005).name('Netteté du bord')
planeFolder.add(planeShader, 'wobble', 0, 0.6, 0.01).name('Ondulation')
planeFolder.add(planeShader, 'wobbleSpeed', 0, 5, 0.05).name('Vitesse ondulation')
planeFolder.add(planeShader, 'cameraRadius', 0, 20, 0.1).name('Rayon caméra')
planeFolder.add(planeShader, 'cameraFalloff', 0.1, 20, 0.1).name('Fondu caméra')
planeFolder.add(planeShader, 'fade', 0.1, 4, 0.05).name('Apparition (s)')
planeFolder.add(planeShader, 'floatAmplitude', 0, 3, 0.05).name('Flottement')
planeFolder.add(planeShader, 'floatSpeed', 0, 3, 0.05).name('Vitesse flottement')
planeFolder.controllers.forEach((c) => c.onChange(syncPlaneShader))
addCopyButton(planeFolder, 'Copier le JSON', planeShader)

/* ---------- Onglet Dégâts ---------- */
const damageDebug = { stage: 0 }
gui
  .addFolder('Dégâts')
  .add(damageDebug, 'stage', 0, DAMAGE_STAGES.length, 1)
  .name('Palier (aperçu)')
  .onChange((v) => setDamageStage(v - 1))


/* ---------- Titre du projet, en arrière-plan ---------- */
// Plan texté placé très loin, verrouillé sur le regard de la caméra. Sa
// taille est recalculée en fonction de la distance et du FOV, donc il occupe
// toujours la même surface d'écran : la perspective ne le déforme pas.
const TITLE_DISTANCE = 260        // bien au-delà de la constellation de plans
// Cadrage du bloc de titre, en parts d'écran. Le plafond de largeur borne le
// bloc quoi qu'il arrive : un sous-titre long se réduit au lieu de s'étaler,
// puisque la hauteur suit la largeur à proportions constantes.

const titleMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    opacity: 0, // révélé une fois les plans arrivés
  })
)
titleMesh.visible = false
titleMesh.frustumCulled = false
// Les plans médias ont depthWrite:false et ne peuvent donc pas masquer le
// titre par le depth buffer : c'est l'ordre de rendu qui les place devant.
titleMesh.renderOrder = -2
scene.add(titleMesh)

let titleAspect = 8

// La composition — nom du projet au-dessus, baseline en dessous sur
// plusieurs lignes — est dessinée dans un canvas 2D. Une seule texture, pas
// de géométrie de texte ni de dépendance à une police 3D. Le nom remplace le
// logo de l'ancienne version : les projets Absolu n'en ont pas de détouré.
// Le nom porte le grand style serif, la baseline le suit en Poppins léger :
// c'est le nom qu'on doit lire en premier, pas la phrase.
// Les `*_FACE` servent à document.fonts.load, qui charge la fonte entière
// quel que soit le corps demandé.
const NAME_PX = 136
const SUB_PX = 54
const NAME_FACE = `400 ${NAME_PX}px 'Instrument Serif'`
// Graisse allégée : en gras, une phrase longue à ce corps écrasait le nom.
const TITLE_FACE = `300 ${SUB_PX}px Poppins`

// Métriques de référence. Elles ne décrivent pas des pixels de texture mais
// des proportions : c'est l'échelle calculée au moment de peindre qui les
// convertit, voir titlePixelScale.
const TITLE_WRAP_BASE = 1800 * 0.78 // largeur de retour à la ligne
const TITLE_LINE_BASE = 74          // interligne de la baseline
const NAME_BLOCK_BASE = 176         // hauteur réservée au nom, interligne compris
const TITLE_PAD_BASE = 40
const TITLE_INK = '#000000'

const nameFontAt = (s) => `400 ${NAME_PX * s}px 'Instrument Serif', Georgia, serif`
const subFontAt = (s) => `300 ${SUB_PX * s}px Poppins, ui-sans-serif, system-ui, sans-serif`

// Nombre de pixels d'écran que le bloc va réellement couvrir, rapporté à sa
// largeur de référence. Peindre à cette échelle, c'est obtenir une texture
// qui n'est ni agrandie ni réduite à l'affichage : le seul cas où un texte
// reste parfaitement net. Peindre plus gros ne sert à rien — le GPU réduit,
// et la réduction coûte précisément la finesse qu'on croyait gagner.
function titlePixelScale(baseWidth) {
  const heightFraction = Math.min(
    settings.titleHeight,
    (settings.titleWidth * camera.aspect) / titleAspect
  )
  const screenWidth = (heightFraction * titleAspect) / camera.aspect
  const target = renderer.domElement.width * screenWidth
  return THREE.MathUtils.clamp(target / baseWidth, 1, 4)
}

// Découpe le titre en lignes qui tiennent dans la largeur donnée
function wrapTitle(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawTitleComposition(name, text) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  // Première passe au corps de référence : elle donne le découpage en lignes
  // et les proportions du bloc — les seules choses dont dépend le cadrage.
  ctx.font = subFontAt(1)
  const lines = wrapTitle(ctx, text, TITLE_WRAP_BASE)
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width))
  ctx.font = nameFontAt(1)
  const nameWidth = name ? ctx.measureText(name).width : 0

  const baseWidth = Math.ceil(Math.max(textWidth, nameWidth)) + TITLE_PAD_BASE
  const baseBlock = name ? NAME_BLOCK_BASE : 0
  const baseHeight = Math.ceil(baseBlock + lines.length * TITLE_LINE_BASE)
  titleAspect = baseWidth / baseHeight

  // Seconde passe à la résolution d'affichage, maintenant que les proportions
  // sont connues — et elles ne dépendent pas de l'échelle.
  const scale = titlePixelScale(baseWidth)
  canvas.width = Math.ceil(baseWidth * scale)
  canvas.height = Math.ceil(baseHeight * scale)

  // Redimensionner le canvas réinitialise le contexte : tout est à refaire
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = TITLE_INK
  ctx.globalAlpha = 1

  const center = canvas.width / 2
  if (name) {
    ctx.font = nameFontAt(scale)
    ctx.fillText(name, center, (NAME_BLOCK_BASE * scale) / 2)
  }

  ctx.font = subFontAt(scale)
  lines.forEach((line, i) => {
    ctx.fillText(line, center, (baseBlock + (i + 0.5) * TITLE_LINE_BASE) * scale)
  })

  titleMesh.material.map?.dispose()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // Ni mipmaps ni filtrage adouci : la texture fait déjà la taille de son
  // affichage, il n'y a donc rien à réduire. Une pyramide de mipmaps ferait
  // ici l'inverse de ce qu'on attend d'elle — le GPU basculerait vers un
  // niveau deux fois plus grossier et rendrait le texte pâteux.
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  titleMesh.material.map = texture
  titleMesh.material.needsUpdate = true
}

let titleProject = null

function setProjectTitle(project) {
  titleProject = project
  // Les polices arrivent de façon asynchrone : on compose une première fois
  // avec ce qu'on a — quitte à mesurer sur la fonte de repli — puis on
  // recompose dès qu'elles sont disponibles.
  const render = () => drawTitleComposition(project.name, project.title)
  render()

  if (!document.fonts) return
  Promise.all([document.fonts.load(TITLE_FACE), document.fonts.load(NAME_FACE)])
    .then(render)
    .catch(() => {})
}

// Projection au sol : le même titre, peint sur le plancher, exactement dans
// le prolongement écran du panneau lointain. On raisonne en coordonnées
// d'écran plutôt qu'en monde — c'est ce qui garantit la continuité parfaite
// à la ligne d'horizon, quelle que soit l'inclinaison de la caméra.
const titleGroundMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  toneMapped: false,
  uniforms: {
    uMap: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCenter: { value: new THREE.Vector2(0, 0) }, // rectangle du titre, en NDC
    uSize: { value: new THREE.Vector2(1, 1) },
    uOpacity: { value: 0 }, // même fondu que le panneau lointain
  },
  vertexShader: /* glsl */ `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform vec2 uResolution;
    uniform vec2 uCenter;
    uniform vec2 uSize;
    uniform float uOpacity;

    void main() {
      // Position du fragment en coordonnées normalisées de l'écran
      vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;

      // Ramenée dans le rectangle occupé par le titre
      vec2 uv = (ndc - uCenter) / uSize + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

      vec4 texel = texture2D(uMap, uv);
      float alpha = texel.a * uOpacity;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(texel.rgb, alpha);
    }
  `,
})

const titleGround = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), titleGroundMaterial)
titleGround.rotation.x = -Math.PI * 0.5
titleGround.position.y = 0.02 // juste au-dessus du sol blanc
titleGround.visible = false
titleGround.renderOrder = -1
scene.add(titleGround)

const _titleDir = new THREE.Vector3()

function updateProjectTitle(delta) {
  if (!titleMesh.visible) return

  // Le titre n'entre qu'une fois la constellation posée : il conclut la
  // séquence au lieu de rivaliser avec le vol des plans.
  const waited = Math.max(0, mediaEntry - mediaEntryTotal)
  const fade = THREE.MathUtils.clamp(waited / TITLE_FADE, 0, 1)
  titleMesh.material.opacity = fade
  titleGroundMaterial.uniforms.uOpacity.value = fade

  camera.getWorldDirection(_titleDir)
  titleMesh.position.copy(camera.position).addScaledVector(_titleDir, TITLE_DISTANCE)
  titleMesh.quaternion.copy(camera.quaternion)

  // Hauteur du champ de vision à cette distance : c'est elle qui garantit une
  // taille apparente constante, quels que soient le FOV et la distance.
  const viewHeight = 2 * TITLE_DISTANCE * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)

  // Hauteur d'écran visée, mais rabotée si le titre déborde en largeur :
  // les phrases longues étaient coupées à gauche et à droite.
  const heightFraction = Math.min(
    settings.titleHeight,
    (settings.titleWidth * camera.aspect) / titleAspect
  )
  const height = viewHeight * heightFraction
  titleMesh.scale.set(height * titleAspect, height, 1)
  // Décalage appliqué dans le repère de la caméra, pour rester à la même
  // hauteur d'écran quelle que soit l'inclinaison
  titleMesh.translateY(viewHeight * settings.titleOffset)

  // Le rectangle occupé à l'écran est constant : il découle directement des
  // fractions choisies, pas d'une reprojection.
  const uniforms = titleGroundMaterial.uniforms
  uniforms.uCenter.value.set(0, 2 * settings.titleOffset)
  uniforms.uSize.value.set((2 * heightFraction * titleAspect) / camera.aspect, 2 * heightFraction)
  uniforms.uMap.value = titleMesh.material.map
  // gl_FragCoord est en pixels physiques : la résolution doit l'être aussi.
  // Relu ici plutôt qu'au resize, qui tourne avant la création du matériau.
  renderer.getDrawingBufferSize(uniforms.uResolution.value)
  titleGround.position.set(carPosition.x, 0.02, carPosition.z)
}


/* ---------- CTA au sol ---------- */
// Dalle peinte sur le sol de l'espace blanc : rouler dessus ouvre la page du
// projet. C'est une navigation dans le même onglet, donc elle n'est pas
// bloquée comme le serait une popup déclenchée hors interaction utilisateur.
const CTA_LABEL = 'Voir le projet'
const BACK_LABEL = 'Retour en ville'

// Les deux appels à l'action étaient des dalles peintes dans la scène, à
// viser au réticule. Ils sont désormais de vrais boutons HTML posés en bas à
// droite : lisibles d'emblée quelle que soit la taille d'écran, cliquables
// au doigt, et sans la gymnastique de cadrage qu'imposait leur ancienne
// présence dans le flux 3D.
const projectActions = document.querySelector('#project-actions')
const projectOpen = document.querySelector('#project-open')
const projectBack = document.querySelector('#project-back')

let ctaUrl = null

function placeCta(project) {
  ctaUrl = project.url
  projectActions.classList.add('is-visible')
}

function hideCta() {
  projectActions.classList.remove('is-visible')
}

projectOpen.addEventListener('click', () => openExternal(ctaUrl))
projectBack.addEventListener('click', () => returnToCity())


/* ---------- Trou dans le sol ---------- */
// Sortie de l'espace blanc : un puits creusé dans le sol blanc, dont le fond
// laisse voir la ville vue du ciel. Y conduire la voiture la fait tomber.
const HOLE_RADIUS = 3.4
const HOLE_DEPTH = 30
const HOLE_DISTANCE = 15 // derrière la voiture : il faut faire demi-tour

// Résolution volontairement basse : l'image est vue au fond d'un puits, la
// différence ne se voit pas et la passe coûte deux fois moins.
const CITY_VIEW_SIZE = 512
const CITY_VIEW_EVERY = 2 // une frame sur deux suffit pour une vue quasi fixe

const cityTarget = new THREE.WebGLRenderTarget(CITY_VIEW_SIZE, CITY_VIEW_SIZE)
const windowCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200)
windowCamera.rotation.order = 'YXZ'
const cityView = { x: 0, z: 0, heading: 0 }
let cityViewFrame = 0

// Le puits est un groupe : paroi cylindrique, fond qui porte la vue de la
// ville, et anneau sombre qui détache la margelle du sol blanc.
const holeMesh = new THREE.Group()
holeMesh.visible = false

const holeWall = new THREE.Mesh(
  new THREE.CylinderGeometry(HOLE_RADIUS, HOLE_RADIUS * 0.82, HOLE_DEPTH, 64, 1, true),
  new THREE.MeshStandardMaterial({
    color: 0x10131a,
    roughness: 1,
    metalness: 0,
    side: THREE.BackSide, // on regarde la paroi depuis l'intérieur du puits
  })
)
holeWall.position.y = -HOLE_DEPTH / 2
holeMesh.add(holeWall)

const holeFloor = new THREE.Mesh(
  new THREE.CircleGeometry(HOLE_RADIUS * 0.82, 64),
  new THREE.MeshBasicMaterial({ map: cityTarget.texture, toneMapped: false })
)
holeFloor.rotation.x = -Math.PI * 0.5
holeFloor.position.y = -HOLE_DEPTH + 0.05
holeMesh.add(holeFloor)

const holeRim = new THREE.Mesh(
  new THREE.RingGeometry(HOLE_RADIUS, HOLE_RADIUS * 1.1, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.85 })
)
holeRim.rotation.x = -Math.PI * 0.5
holeRim.position.y = 0.04
holeMesh.add(holeRim)

scene.add(holeMesh)

// Rend la ville dans la texture du fond. Tout le décor de l'espace blanc est
// masqué le temps de la passe, puis rétabli : une seule scène sert aux deux
// mondes, il n'y en a pas de seconde à maintenir.
function renderCityWindow() {
  if (!holeMesh.visible) return
  if (cityViewFrame++ % CITY_VIEW_EVERY !== 0) return

  const hidden = [whiteGround, mediaGroup, titleMesh, titleGround, holeMesh, carGroup]
  hidden.forEach((o) => (o.visible = false))
  world.visible = true
  sky.visible = true
  scene.fog = cityFog
  scene.background = null

  // Vue plongeante : on regarde la ville d'en haut, comme par une trappe
  windowCamera.position.set(cityView.x, 52, cityView.z)
  windowCamera.rotation.set(
    -Math.PI / 2 + 0.22,
    cityView.heading + Math.sin(mediaUniforms.uTime.value * 0.2) * 0.1,
    0
  )
  sky.position.copy(windowCamera.position)

  renderer.setRenderTarget(cityTarget)
  renderer.render(scene, windowCamera)
  renderer.setRenderTarget(null)

  hidden.forEach((o) => (o.visible = true))
  world.visible = false
  sky.visible = false
  scene.fog = null
  scene.background = WHITE_SPACE_COLOR
}

function placeHole() {
  // Dans le dos de la voiture, donc jamais franchi par accident à l'arrivée
  holeMesh.position.set(
    carPosition.x - Math.sin(carHeading) * HOLE_DISTANCE,
    0,
    carPosition.z - Math.cos(carHeading) * HOLE_DISTANCE
  )
  holeMesh.visible = true

  // Perçage du sol, très légèrement plus petit que la margelle pour qu'aucun
  // liseré blanc ne subsiste entre les deux
  whiteGroundHole.value.set(holeMesh.position.x, holeMesh.position.z, HOLE_RADIUS * 0.99, 1)
}

/* ---------- Chute dans le puits ---------- */
// La voiture bascule dans le trou pendant que la caméra reste sur place : on
// la regarde s'éloigner vers le fond. Elle ne réapparaît en ville qu'à
// l'impact, où la caméra reprend son cadrage habituel.
const HOLE_GRAVITY = 26
const HOLE_TUMBLE = 1.6 // basculement vers l'avant, rad/s
let falling = null

// Retour en ville depuis le bouton : une coupure franche, sans mise en scène.
// Le puits garde la sienne — on y entre en roulant, la chute raconte quelque
// chose ; cliquer un bouton, non.
const WIPE_FADE = 300 // millisecondes, à garder en phase avec la feuille de style
const wipeElement = document.querySelector('#wipe')
let wiping = false

function returnToCity() {
  if (wiping || falling) return
  wiping = true
  wipeElement.classList.add('is-visible')

  setTimeout(() => {
    respawn()
    // Pas de chute depuis le ciel ici : le blanc doit se retirer sur une
    // voiture déjà posée, pas sur une voiture en vol.
    fallHeight = 0
    fallSpeed = 0
    airborne = false
    // Sauter la chute, c'est aussi sauter le dégagement que fait
    // l'atterrissage : sans lui, rien ne garantit que le point de réapparition
    // ne tombe pas dans une façade.
    depenetrate(body)
    carPosition.copy(body)
    prevBody.copy(body)
    carGroup.position.set(carPosition.x, CAR_GROUND, carPosition.z)

    // Deux images d'attente : la première bâtit les chunks du nouveau point
    // de chute, la seconde les rend. Découvrir avant, c'est découvrir du vide.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        wipeElement.classList.remove('is-visible')
        wiping = false
      })
    )
  }, WIPE_FADE)
}

function startFalling() {
  if (falling) return
  falling = { y: CAR_GROUND, speed: 2, tilt: 0 }
  showNotice('Retour en ville')
}

function updateFalling(delta) {
  falling.speed += HOLE_GRAVITY * delta
  falling.y -= falling.speed * delta
  falling.tilt += HOLE_TUMBLE * delta

  // Recentrage sur l'axe du puits : la voiture est aspirée vers le milieu
  const k = 1 - Math.exp(-3 * delta)
  carPosition.x += (holeMesh.position.x - carPosition.x) * k
  carPosition.z += (holeMesh.position.z - carPosition.z) * k

  carGroup.position.set(carPosition.x, falling.y, carPosition.z)
  carGroup.rotation.x = -falling.tilt

  // Arrivée au fond : la ville reprend la main, avec sa propre chute
  if (falling.y > -HOLE_DEPTH) return
  falling = null
  carGroup.rotation.x = 0
  respawn()
}

function updateHole() {
  if (!holeMesh.visible || falling) return

  const dx = carPosition.x - holeMesh.position.x
  const dz = carPosition.z - holeMesh.position.z
  // On bascule une fois le véhicule bien engagé au-dessus du vide
  if (dx * dx + dz * dz > (HOLE_RADIUS * 0.75) ** 2) return

  startFalling()
}

/* ---------- Aimant sur les cibles ---------- */
// Approcher le réticule d'une cible suffit : la caméra termine l'alignement
// toute seule et la cible devient activable. Viser au pixel près en roulant
// serait pénible.

// En ville, l'aimant vise les panneaux franchissables. Il est volontairement
// plus étroit et plus mou : il doit aider à cadrer un panneau repéré, jamais
// contrarier une manœuvre ou une esquive.
const CITY_MAGNET_RADIUS = 0.26 // rayon d'accroche à l'écran
const CITY_MAGNET_PULL = 2.2    // attraction, volontairement douce
const CITY_MAGNET_MIN = 14      // trop près : on n'a plus le temps de se placer
const CITY_MAGNET_MAX = 70      // trop loin : le panneau n'est pas encore un objectif
const CITY_MAGNET_STEER = 0.55  // au-delà, le joueur manœuvre : on le laisse tranquille

const _magnetPos = new THREE.Vector3()
let magnetTarget = null

// Cible la plus proche du centre de l'écran, parmi les objets fournis
function screenClosest(candidates, radius, getPosition) {
  let best = null
  for (const candidate of candidates) {
    getPosition(candidate, _magnetPos)
    _magnetPos.project(camera)
    // Derrière la caméra : la projection se replie et donnerait un faux proche
    if (_magnetPos.z > 1) continue
    const distance = Math.hypot(_magnetPos.x, _magnetPos.y)
    if (distance > radius) continue
    if (!best || distance < best.distance) {
      best = { candidate, distance, x: _magnetPos.x, y: _magnetPos.y }
    }
  }
  return best
}

// Panneaux franchissables autour de la voiture, à portée utile
function nearbyPortals() {
  const found = []
  const blockX = Math.floor(body.x / CELL)
  const blockZ = Math.floor(body.z / CELL)
  const reach = Math.ceil(CITY_MAGNET_MAX / CELL)

  for (let bx = blockX - reach; bx <= blockX + reach; bx++) {
    for (let bz = blockZ - reach; bz <= blockZ + reach; bz++) {
      eachBuilding(bx, bz, (b) => {
        const p = b.billboard
        if (!p || !p.ground) return
        const distance = Math.hypot(p.x - body.x, p.z - body.z)
        if (distance < CITY_MAGNET_MIN || distance > CITY_MAGNET_MAX) return
        found.push(p)
      })
    }
  }
  return found
}

// L'aimant ne sert plus qu'en ville, pour aider à cadrer un panneau avant de
// foncer dedans. Dans l'espace blanc il visait les deux appels à l'action,
// devenus des boutons HTML : il n'a plus rien à viser, et le regard y est
// entièrement rendu au joueur.
function updateMagnet(delta) {
  magnetTarget = null
  if (portal || gameOver || falling || paused || whiteSpace) return

  // Une manœuvre en cours prime sur l'aide au cadrage
  if (Math.abs(steerInput) > CITY_MAGNET_STEER) return
  const best = screenClosest(nearbyPortals(), CITY_MAGNET_RADIUS, (p, out) =>
    out.set(p.x, city.sidewalkHeight + p.y, p.z)
  )
  if (!best) return

  const pull = CITY_MAGNET_PULL
  const reach = CITY_MAGNET_RADIUS

  // Attraction proportionnelle à la proximité : franche au centre, douce au
  // bord, pour qu'on puisse encore balayer la scène sans être happé. Le rayon
  // est celui qui a servi à retenir la cible — s'en écarter rendrait la
  // force négative, donc répulsive, dès qu'on dépasse le rayon d'accroche.
  const strength = (1 - best.distance / reach) * pull
  const k = 1 - Math.exp(-strength * delta)

  // L'écart écran est converti en angles : la moitié du champ vertical vaut
  // fov/2, et l'horizontal suit l'aspect.
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2
  yaw -= best.x * Math.atan(Math.tan(halfFov) * camera.aspect) * k
  settings.cameraPitch += THREE.MathUtils.radToDeg(best.y * halfFov) * k

  // Le retour derrière la voiture reste prioritaire : l'aimant ne fait que
  // ralentir le recentrage, il ne le bloque pas.
  pitchController?.updateDisplay()
  applyCameraOrientation()
}

// Cibles pointables : au curseur, ou au réticule de visée avec Entrée.
// Un clic comme un appui sur Entrée sont de vrais gestes utilisateur, donc
// l'ouverture d'un nouvel onglet n'est jamais bloquée.
const ctaRaycaster = new THREE.Raycaster()
const _pointer = new THREE.Vector2()
const reticleElement = document.querySelector('#reticle')
const reticleLabel = document.querySelector('#reticle-label')

// Seul l'espace blanc propose des cibles : en ville, on franchit un panneau
// en roulant dedans, il n'y a rien à valider.
// Le trou de sortie est désormais la seule cible de la scène : les appels à
// l'action sont sortis du flux 3D.
function interactiveTargets() {
  if (!whiteSpace || !holeMesh.visible) return []
  return [holeMesh]
}

function labelFor() {
  return BACK_LABEL
}

function pickAt(ndcX, ndcY) {
  const targets = interactiveTargets()
  if (!targets.length) return null
  _pointer.set(ndcX, ndcY)
  ctaRaycaster.setFromCamera(_pointer, camera)

  // Récursif : le puits est un groupe (paroi, fond, margelle). On remonte
  // ensuite au parent inscrit comme cible, pour ne pas renvoyer un morceau.
  const hit = ctaRaycaster.intersectObjects(targets, true)[0]
  if (!hit) return null
  let object = hit.object
  while (object && !targets.includes(object)) object = object.parent
  return object ? { object, point: hit.point } : null
}

function activate(target) {
  if (target === holeMesh) startFalling()
}

// Cible sous le réticule, réévaluée à chaque frame
let aimed = null
let validateKey = 'Entrée' // touche affichée dans l'étiquette, selon la manette
function updateReticle() {
  // Toujours affiché : il sert aussi de repère de direction en ville, où il
  // n'y a simplement rien à pointer.
  const hit = pickAt(0, 0)
  // L'aimant sert de repli : on peut valider une cible simplement approchée
  aimed = hit?.object || magnetTarget || null

  reticleElement.classList.toggle('is-active', Boolean(aimed))
  reticleLabel.classList.toggle('is-active', Boolean(aimed))
  if (aimed) reticleLabel.innerHTML = `<kbd>${validateKey}</kbd>${labelFor(aimed)}`
}

// Entrée au clavier, A / ✕ à la manette
function validate() {
  if (confirmOpen) return contactAgency() // Entrée valide la confirmation
  if (paused) return // menu ouvert : Entrée revient au bouton focalisé
  // Le téléphone prime : quand il a le focus, c'est lui qu'on valide
  if (phoneGroup.visible && (phoneHovered || phonePinned)) askContact()
  else if (aimed) activate(aimed)
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return
  validate()
})

canvas.addEventListener('pointermove', (event) => {
  const x = (event.clientX / window.innerWidth) * 2 - 1
  const y = -(event.clientY / window.innerHeight) * 2 + 1
  canvas.style.cursor = pickAt(x, y) ? 'pointer' : ''
})

canvas.addEventListener('click', (event) => {
  const x = (event.clientX / window.innerWidth) * 2 - 1
  const y = -(event.clientY / window.innerHeight) * 2 + 1
  const hit = pickAt(x, y)
  if (hit) activate(hit.object)
})

/* ---------- Portails ---------- */
// Déclenché quand le centre de la voiture entre dans le volume d'un panneau
// au sol. Un seul déclenchement par panneau tant qu'on n'en est pas ressorti.
const noticeElement = document.querySelector('#notice')
// Navigation du navigateur : l'URL reste la source de vérité, on aligne
// l'état du jeu dessus plutôt que d'ignorer les boutons Précédent et Suivant.
window.addEventListener('popstate', () => {
  const route = currentRoute()

  if (route === MENU_ROUTE) {
    if (!paused) openSplash({ push: false })
    return
  }

  const index = projectFromRoute(route)
  if (index >= 0) {
    if (!whiteSpace || whiteProject !== index) openProject(index, { push: false })
    return
  }

  if (whiteSpace) respawn() // retour à la racine : on rentre en ville
  else if (paused) closeSplash()
})
let currentPortal = null
let portal = null // { billboard, progress } quand un portail est en cours
let noticeTimer

function showNotice(text) {
  noticeElement.textContent = text
  noticeElement.classList.add('is-visible')
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => noticeElement.classList.remove('is-visible'), 2000)
}

function checkPortals(x, z) {
  if (whiteSpace) return
  const blockX = Math.floor(x / CELL)
  const blockZ = Math.floor(z / CELL)
  let inside = null
  let entered = null

  for (let bx = blockX - 1; bx <= blockX + 1 && !inside; bx++) {
    for (let bz = blockZ - 1; bz <= blockZ + 1 && !inside; bz++) {
      eachBuilding(bx, bz, (b) => {
        const p = b.billboard
        if (inside || !p || !p.ground) return
        if (Math.abs(x - p.tx) < p.thx && Math.abs(z - p.tz) < p.thz) {
          inside = `${p.x.toFixed(2)},${p.z.toFixed(2)}`
          entered = p
        }
      })
    }
  }

  if (inside && inside !== currentPortal) {
    showNotice('Portal triggered !')
    // La voiture reste pilotable mais ne se déplace plus : c'est le panneau
    // qui s'ouvre, proportionnellement à ce qu'on roule.
    // Deux étapes enchaînées : le panneau grandit (progress), puis le masque
    // s'ouvre (mask). Le bouton de sortie n'apparaît qu'une fois les deux finies.
    portal = { billboard: entered, progress: 0, mask: 0, key: inside }
    whiteProject = entered.project
    setPanelInstanceVisible(inside, false)
  }
  currentPortal = inside
}

// Agrandissement du panneau : il grandit depuis sa position d'origine vers le
// centre du champ de vision, jusqu'à recouvrir tout le viewport.
const _planePoint = new THREE.Vector3()
const _viewDir = new THREE.Vector3()

function updatePortalVisual() {
  if (!portal) {
    portalMesh.visible = false
    portalLight.visible = false
    world.position.y = 0
    return
  }

  const b = portal.billboard
  const t = ease.inOutExpo(portal.progress)
  const y = city.sidewalkHeight + b.y

  // Taille nécessaire pour couvrir l'écran à la distance du panneau
  _planePoint.set(b.x, y, b.z)
  const distance = camera.position.distanceTo(_planePoint)
  const coverH = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * PORTAL_COVER
  const coverW = coverH * camera.aspect
  const full = Math.max(coverW / b.w, coverH / b.h)
  const scale = 1 + (full - 1) * t

  // Cible : l'intersection de l'axe de visée avec le plan du panneau, pour que
  // l'agrandissement se recentre sur l'écran et couvre vraiment tout
  camera.getWorldDirection(_viewDir)
  const denom = _viewDir.x * b.nx + _viewDir.z * b.nz
  let targetX = b.x
  let targetY = y
  let targetZ = b.z
  if (Math.abs(denom) > 1e-3) {
    const hit =
      ((b.x - camera.position.x) * b.nx + (b.z - camera.position.z) * b.nz) / denom
    targetX = camera.position.x + _viewDir.x * hit
    targetY = camera.position.y + _viewDir.y * hit
    targetZ = camera.position.z + _viewDir.z * hit
  }

  // La ville s'efface par le bas, exactement au rythme de l'ouverture :
  // la hauteur de chute est celle du viewport à la distance du panneau.
  // Même courbe et même horloge que l'agrandissement : les deux mouvements
  // démarrent ensemble, sans à-coup.
  world.position.y = -coverH * PORTAL_DROP_DEPTH * t

  portalMesh.visible = true

  // Le média du projet est relayé au shader : la texture peut changer en cours
  // de route (le poster cède la place à la vidéo dès qu'elle est prête).
  const source = projectMaterials[b.project][4].map
  const uniforms = portalFrontMaterial.uniforms
  uniforms.uMap.value = source || null
  uniforms.uHasMap.value = source ? 1 : 0
  if (source) {
    uniforms.uRepeat.value.copy(source.repeat)
    uniforms.uOffset.value.copy(source.offset)
  }

  // Le tunnel s'installe avec l'agrandissement, puis reste à fond
  portalFrontMaterial.uniforms.uWarp.value = t

  // Libellé : ses proportions sont exprimées dans le repère local du panneau,
  // dont les deux axes sont mis à l'échelle différemment.
  const label = projectLabel(b.project)
  portalLogo.material.map = label.material.map
  // Il s'efface au rythme du masque : le nom disparaît avec le média qu'il
  // accompagne, au lieu de flotter seul sur le blanc.
  portalLogo.material.opacity = 1 - ease.outExpo(portal.mask)
  portalLogo.visible = Boolean(label.material.map) && portalLogo.material.opacity > 0.01
  const localW = LOGO_WIDTH
  const localH = (localW * b.w) / (label.aspect * b.h)
  portalLogo.scale.set(localW, localH, 1)
  portalLogo.position.y = -0.5 + localH / 2 + LOGO_MARGIN

  updateMaskShape(ease.outExpo(portal.mask))
  portalMesh.position.set(
    THREE.MathUtils.lerp(b.x, targetX, t) + b.nx * 0.03, // léger décollement
    THREE.MathUtils.lerp(y, targetY, t),
    THREE.MathUtils.lerp(b.z, targetZ, t) + b.nz * 0.03
  )
  portalMesh.rotation.y = b.angle
  portalMesh.scale.set(b.w * scale, b.h * scale, b.thick)

  // La lumière se pose devant la face, et monte avec l'ouverture
  portalLight.visible = true
  portalLight.intensity = 40 + 260 * t
  portalLight.distance = 20 + 120 * t
  portalLight.position.set(
    portalMesh.position.x + b.nx * (1 + b.w * scale * 0.25),
    portalMesh.position.y,
    portalMesh.position.z + b.nz * (1 + b.w * scale * 0.25)
  )
}

// Pendant la transition, la caméra est reprise en main : elle glisse jusqu'en
// face du panneau et le regarde de face. Le suivi automatique et la souris
// sont neutralisés pendant ce temps, sinon ils lutteraient contre ce recadrage.
const _camGoal = new THREE.Vector3()
const _camMatrix = new THREE.Matrix4()
const _camQuat = new THREE.Quaternion()

function updatePortalCamera(delta) {
  if (!portal) return
  const b = portal.billboard
  _planePoint.set(b.x, city.sidewalkHeight + b.y, b.z)

  // Pile dans l'axe de la normale du panneau, à la distance de suivi habituelle
  _camGoal.set(
    b.x + b.nx * settings.cameraDistance,
    city.sidewalkHeight + b.y + settings.cameraHeight * 0.5,
    b.z + b.nz * settings.cameraDistance
  )

  const k = 1 - Math.exp(-PORTAL_CAM_BLEND * delta)
  camera.position.lerp(_camGoal, k)
  clampAboveGround(camera.position)
  _camMatrix.lookAt(camera.position, _planePoint, camera.up)
  _camQuat.setFromRotationMatrix(_camMatrix)
  camera.quaternion.slerp(_camQuat, k)
}



/* ---------- Téléphone ---------- */
// Nokia 3310 isolé de la collection de modèles (voir tools/isolate-phone.py :
// le fichier d'origine contient neuf téléphones, plus un sol et un fond, tous
// dans un seul OBJ). Il est accroché à la caméra, donc fixe à l'écran.
// Fond perdu : le téléphone déborde du bas de l'écran, seule sa moitié haute
// est visible au repos. Prendre le focus le fait remonter.
const PHONE_HEIGHT = 0.62    // hauteur à l'écran, en unités de la caméra
const PHONE_POSITION = new THREE.Vector3(-0.95, -0.78, -1.3) // repère caméra
const PHONE_TILT = new THREE.Euler(0.12, 0.4, -0.04)
const PHONE_FOCUS_LIFT = 0.22 // remontée quand il prend le focus
const PHONE_FOCUS_SMOOTH = 8  // vitesse de la translation

const phoneGroup = new THREE.Group()
phoneGroup.position.copy(PHONE_POSITION)
phoneGroup.renderOrder = 20
phoneGroup.rotation.copy(PHONE_TILT)
phoneGroup.visible = false
camera.add(phoneGroup)

// Coque : un seul matériau sombre, dans l'esprit géométrique de la ville.
// depthTest désactivé et renderOrder élevé : c'est un élément d'interface,
// il ne doit jamais être mangé par un immeuble au premier plan.
const phoneMaterial = new THREE.MeshStandardMaterial({
  color: 0x1e1e1e, // le noir de la charte
  transparent: true, // pour passer dans la même passe que le halo, voir plus bas
  roughness: 0.5,
  metalness: 0.1,
  // Un fond d'émission garantit qu'il reste lisible même si le soleil est
  // rasant ou dans son dos : c'est une interface, pas un objet de la scène.
  // Sur une coque noire il doit rester très sourd, sinon elle vire au gris.
  emissive: 0x141414,
  emissiveIntensity: 1,
  depthTest: false,
})

// Éclairage dédié. La portée courte ne suffisait pas : la lumière débordait
// largement sur la ville. On l'isole sur une couche de rendu à laquelle seuls
// les objets du téléphone appartiennent — three ne l'applique qu'à eux.
const PHONE_LAYER = 1
const phoneLight = new THREE.PointLight(0xffffff, 9, 3, 2)
phoneLight.layers.set(PHONE_LAYER)
phoneLight.position.set(-0.45, 0.25, -0.55)

// Écran : fond vert LCD, icône de messagerie, et le libellé qui n'apparaît
// qu'au focus — le tout redessiné dans le même canvas, c'est plus fidèle
// qu'une étiquette HTML posée par-dessus.
const SCREEN_BG = '#ffffff'
const SCREEN_BLUE = '#3e78ff' // bleu de l'agence : fond de l'icône et du label
const SCREEN_ACCENT = '#f2ff28' // jaune de charte : le fond du bouton
const SCREEN_INK = '#1e1e1e' // encre du bouton jaune, le blanc s'y perdrait
const SCREEN_MUTED = '#929292'
const PHONE_HINT = 'Appuyez sur Entrée'
const PHONE_CTA = "Contacter l'agence"
// Bouton de validation de la manette (A, ✕) quand c'est elle qui sert ;
// null au clavier, où la pastille porte la flèche de la touche Entrée
let phoneScreenPadKey = null

const phoneScreenCanvas = document.createElement('canvas')
phoneScreenCanvas.width = 320
phoneScreenCanvas.height = 400

// Rectangle à coins arrondis : roundRect n'existe pas partout, on le garde
// sous la main plutôt que de dépendre du navigateur.
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawPhoneScreen(focused) {
  const ctx = phoneScreenCanvas.getContext('2d')
  const { width, height } = phoneScreenCanvas

  ctx.fillStyle = SCREEN_BG
  ctx.fillRect(0, 0, width, height)

  // Appel à l'action : le bouton de la charte, repris au format de l'écran.
  // Sa hauteur est fixe, le rappel de raccourci se cale juste au-dessus.
  const BTN_H = 54
  const BTN_MARGIN = 20
  const HINT_GAP = 26
  const bandH = HINT_GAP + BTN_H
  const bandY = height - 22 - bandH

  // Icône de messagerie : enveloppe blanche sur une tuile bleue
  const tile = 130
  const tileX = (width - tile) / 2
  const tileY = focused ? (bandY - tile) / 2 : (height - tile) / 2
  ctx.fillStyle = SCREEN_BLUE
  roundedRect(ctx, tileX, tileY, tile, tile, 28)
  ctx.fill()

  const w = 80
  const h = 56
  const x = tileX + (tile - w) / 2
  const y = tileY + (tile - h) / 2
  ctx.strokeStyle = SCREEN_BG
  ctx.lineWidth = 8
  ctx.lineJoin = 'round'
  ctx.strokeRect(x, y, w, h)
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + w / 2, y + h * 0.58)
  ctx.lineTo(x + w, y)
  ctx.stroke()

  if (!focused) {
    phoneScreenTexture.needsUpdate = true
    return
  }

  // Rappel du raccourci, au-dessus du bouton
  ctx.fillStyle = SCREEN_MUTED
  ctx.font = '400 17px Poppins, ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(PHONE_HINT, width / 2, bandY + HINT_GAP / 2)

  // Le bouton de la charte : pastille jaune, libellé noir à gauche, carré
  // d'icône sombre à droite portant la flèche nord-est.
  const btnY = bandY + HINT_GAP
  const btnX = BTN_MARGIN
  const btnW = width - BTN_MARGIN * 2
  ctx.fillStyle = SCREEN_ACCENT
  roundedRect(ctx, btnX, btnY, btnW, BTN_H, 10)
  ctx.fill()

  const pad = 5
  const square = BTN_H - pad * 2
  const squareX = btnX + btnW - pad - square
  ctx.fillStyle = SCREEN_INK
  roundedRect(ctx, squareX, btnY + pad, square, square, 8)
  ctx.fill()

  ctx.fillStyle = SCREEN_INK
  ctx.font = '400 19px Poppins, ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(PHONE_CTA, btnX + 16, btnY + BTN_H / 2)

  // Flèche nord-est, tracée au trait : même signe que le carré d'icône des
  // boutons de l'interface, à la taille où un glyphe serait illisible.
  const a = square * 0.3 // demi-longueur de la diagonale
  const cx = squareX + square / 2
  const cy = btnY + pad + square / 2
  ctx.strokeStyle = SCREEN_BG
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - a, cy + a)
  ctx.lineTo(cx + a, cy - a)
  ctx.moveTo(cx - a * 0.1, cy - a) // barbes de la pointe
  ctx.lineTo(cx + a, cy - a)
  ctx.lineTo(cx + a, cy + a * 0.1)
  ctx.stroke()

  phoneScreenTexture.needsUpdate = true
}

const phoneScreenTexture = new THREE.CanvasTexture(phoneScreenCanvas)
phoneScreenTexture.colorSpace = THREE.SRGBColorSpace
phoneScreenTexture.minFilter = THREE.LinearFilter
phoneScreenTexture.generateMipmaps = false
drawPhoneScreen(false)

// Halo : dégradé radial dessiné une fois, animé ensuite par sa seule échelle.
// Il signale que le téléphone est actif, sans rien éclairer.
function makeHaloTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(128, 128, 20, 128, 128, 128)
  // Bleu de la charte, le même que l'icône de messagerie de l'écran
  gradient.addColorStop(0, 'rgba(62, 120, 255, 0.55)')
  gradient.addColorStop(0.55, 'rgba(62, 120, 255, 0.22)')
  gradient.addColorStop(1, 'rgba(62, 120, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const phoneHalo = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: makeHaloTexture(),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
)
phoneHalo.renderOrder = 19
phoneHalo.visible = false

const phoneScreen = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: phoneScreenTexture,
    transparent: true,
    depthTest: false,
    toneMapped: false,
  })
)
phoneScreen.renderOrder = 22

// Rétro-éclairage : un plan blanc légèrement plus grand, posé juste derrière
// la dalle. Il déborde en un liseré lumineux, comme la lumière qui fuit sur
// les bords d'un écran LCD éclairé par l'arrière.
const phoneBacklight = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthTest: false,
    toneMapped: false,
  })
)
phoneBacklight.renderOrder = 21
phoneGroup.add(phoneHalo)
phoneGroup.add(phoneBacklight)
phoneGroup.add(phoneScreen)
phoneGroup.add(phoneLight)

// Touches : le modèle porte un matériau nommé "keypad" sur les douze touches,
// ce qui permet de les rétro-éclairer sans les identifier une à une.
// Clavier : les seules touches claires de la coque noire, à peine allumées
const keypadMaterial = new THREE.MeshStandardMaterial({
  color: 0x5e5e5e,
  transparent: true,
  emissive: 0x272727,
  emissiveIntensity: 1.4,
  roughness: 0.4,
  depthTest: false,
})

new OBJLoader(loadingManager).load(asset('models/nokia-3310.obj'), (object) => {
  object.traverse((o) => {
    if (!o.isMesh) return
    o.material = o.material?.name === 'keypad' ? keypadMaterial : phoneMaterial
    o.renderOrder = 20
    o.layers.enable(PHONE_LAYER) // reste sur la couche 0 : la caméra le voit
  })

  // Normalisation : centré sur son volume, mis à l'échelle par sa hauteur
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const scale = PHONE_HEIGHT / size.y
  object.scale.setScalar(scale)
  object.position.copy(center).multiplyScalar(-scale)
  phoneGroup.add(object)

  // L'écran se pose sur la face avant, dans le tiers supérieur de la coque
  const width = size.x * scale
  const height = size.y * scale
  // Grand écran, aux proportions du canvas, plaqué sur la face avant
  const screenWidth = width * 0.74
  const screenHeight = (screenWidth * phoneScreenCanvas.height) / phoneScreenCanvas.width
  phoneScreen.scale.set(screenWidth, screenHeight, 1)
  phoneScreen.position.set(0, height * 0.17, (size.z * scale) / 2 + 0.002)
  // Le rétro-éclairage déborde d'un liseré tout autour de la dalle
  phoneBacklight.scale.set(screenWidth * 1.06, screenHeight * 1.05, 1)
  phoneBacklight.position.copy(phoneScreen.position).setZ(phoneScreen.position.z - 0.001)
  phoneHalo.userData.size = Math.max(width, height) * 1.9
  // Derrière la face arrière, pas à l'intérieur du boîtier : le décalage se
  // déduit de l'épaisseur réelle du modèle une fois mis à l'échelle.
  phoneHalo.position.set(0, 0, -(size.z * scale) / 2 - 0.02)
})

/* ---------- Focus du téléphone ---------- */
// Il se met en avant au survol, ou sur Tab — une touche libre, et c'est le
// geste attendu pour « passer au prochain élément interactif ».
const phoneRaycaster = new THREE.Raycaster()
const _phonePointer = new THREE.Vector2()
let phoneHovered = false
let phoneScreenFocused = false
let phonePinned = false // mise en avant verrouillée par Tab
let phoneLift = 0
let phoneHaloTime = 0

function phoneUnderPointer(event) {
  if (!phoneGroup.visible) return false
  _phonePointer.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  )
  phoneRaycaster.setFromCamera(_phonePointer, camera)
  return phoneRaycaster.intersectObject(phoneGroup, true).length > 0
}

canvas.addEventListener('pointermove', (event) => {
  phoneHovered = phoneUnderPointer(event)
})

const phoneHint = document.querySelector('#phone-hint')
const phoneHintLabel = phoneHint.querySelector('.hint-label')
const phoneContactHint = phoneHint.querySelector('.hint--contact')

// « Masquer » le remet en fond perdu, « afficher » le fait remonter :
// l'appareil reste toujours à l'écran, c'est sa mise en avant qui bascule.
// Partagée par la touche Tab et par la croix haut de la manette.
function togglePhone() {
  phonePinned = !phonePinned
  phoneHintLabel.textContent = phonePinned ? 'masquer le téléphone' : 'afficher le téléphone'
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Tab' || paused) return // menu ouvert : Tab navigue
  event.preventDefault() // sinon le focus part dans le panneau de réglages

  // Écran de capture : le téléphone n'y est même pas affiché, intercepter Tab
  // pour une bascule invisible revenait à confisquer la touche. Elle passe
  // d'un bouton à l'autre — on garde la main plutôt que de rendre la
  // tabulation native, qui irait se perdre dans le panneau de réglages.
  if (gameOver) {
    moveFocus(gameOverElement, event.shiftKey ? -1 : 1)
    return
  }
  togglePhone()
})

// Adresse encodée : elle n'apparaît pas en clair dans le bundle, ce qui
// suffit à décourager les robots qui moissonnent les sources.
const CONTACT = 'bmV3Yml6QGFnZW5jZS1hYnNvbHUuY29t'

// Quitter la page pour le client mail est brutal : on demande confirmation
// avant, et le jeu est mis en pause le temps de la décision.
const confirmElement = document.querySelector('#confirm')
let confirmOpen = false

function askContact() {
  confirmOpen = true
  paused = true
  keys.clear()
  confirmElement.classList.add('is-visible')
}

function closeContact() {
  confirmOpen = false
  confirmElement.classList.remove('is-visible')
  paused = false
}

// Navigation directe plutôt qu'un clic sur un lien détaché du document :
// celui-ci était ignoré par certains navigateurs, la page n'ayant jamais vu
// l'élément. Déclenchée depuis un vrai clic, elle passe sans blocage.
function openMailTo() {
  const subject = encodeURIComponent('Brand Theft Auto')
  window.location.href = `mailto:${atob(CONTACT)}?subject=${subject}`
}

// Lancée depuis l'écran d'accueil, l'application n'a plus de barre d'adresse :
// une page ouverte en son sein y resterait prisonnière, sans moyen d'en
// revenir. Un vrai lien cliqué ouvre le navigateur par défaut, là où
// window.open se contente d'une vue intégrée — ou de rien du tout.
function openExternal(url) {
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  // Safari ignore un clic sur un élément qu'il n'a jamais vu dans le document
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function contactAgency() {
  closeContact()
  openSplash() // on revient sur l'écran de pause, le jeu reprend d'un clic
  openMailTo()
}

document.querySelector('#confirm-ok').addEventListener('click', contactAgency)
document.querySelector('#confirm-cancel').addEventListener('click', closeContact)

// Le téléphone n'a de sens qu'en ville : dans l'espace blanc, on est déjà
// dans le projet qu'il sert à annoncer.
// Rappel du menu. Son état se calcule à chaque image plutôt qu'au gré des
// bascules : la partie passe par trop d'états — portail, chute, capture — pour
// qu'une poignée d'appels dispersés reste juste longtemps.
const menuButton = document.querySelector('#menu-open')
menuButton.addEventListener('click', () => openSplash())

function updateMenuButton() {
  menuButton.classList.toggle(
    'is-visible',
    !paused && !portal && !falling && !gameOver && !confirmOpen
  )
}

function updatePhone(delta) {
  const playable = !whiteSpace && !portal && !falling && !gameOver
  // Au doigt, l'écran est trop petit pour que le téléphone reste en fond
  // perdu pendant la conduite : il n'apparaît que dans le menu, et disparaît
  // dès qu'on reprend la main. Au curseur, c'est l'inverse — le menu le
  // masque, puisqu'il n'y a rien à y faire.
  const shown = playable && (COARSE ? paused : !paused)
  phoneGroup.visible = shown
  // Les rappels de raccourci n'ont de sens qu'au clavier, et seulement en
  // cours de partie.
  phoneHint.classList.toggle('is-visible', shown && !COARSE)
  if (!shown) {
    phoneContactHint.classList.remove('is-visible')
    return
  }

  // Dans le menu mobile, le téléphone est la raison d'être de l'écran : il
  // est mis en avant d'office, sans attendre un survol impossible au doigt.
  const focused = (COARSE && paused) || phoneHovered || phonePinned
  // L'appel à l'action ne s'affiche que quand Entrée ferait vraiment quelque
  // chose : exactement la condition que teste le gestionnaire de touche.
  phoneContactHint.classList.toggle('is-visible', focused && !COARSE)
  const target = focused ? PHONE_FOCUS_LIFT : 0
  phoneLift += (target - phoneLift) * (1 - Math.exp(-PHONE_FOCUS_SMOOTH * delta))
  phoneGroup.position.y = PHONE_POSITION.y + phoneLift

  // Halo : il respire tant que l'appareil est survolé, et se résorbe sinon
  phoneHaloTime += delta
  phoneHalo.visible = phoneLift > 0.002
  if (phoneHalo.visible) {
    const pulse = 1 + Math.sin(phoneHaloTime * 3.2) * 0.07
    const ratio = phoneLift / PHONE_FOCUS_LIFT // 0 au repos, 1 en pleine mise en avant
    const size = (phoneHalo.userData.size || 1) * pulse
    phoneHalo.scale.set(size, size, 1)
    phoneHalo.material.opacity = ratio * (0.75 + Math.sin(phoneHaloTime * 4.1) * 0.25)
  }

  // L'écran n'est redessiné qu'au changement d'état, pas à chaque frame
  if (focused !== phoneScreenFocused) {
    phoneScreenFocused = focused
    drawPhoneScreen(focused)
  }
}

/* ---------- Minimap ---------- */
// Vue de dessus, centrée sur la voiture et tournée avec elle : le haut du
// disque est toujours la direction suivie. Elle ne sert qu'en ville, où il y
// a une trame de rues à lire et des poursuivants à repérer.
const MAP_RANGE = 68        // rayon couvert, en unités monde
const MAP_REFRESH = 0.25    // secondes entre deux relevés des panneaux
// La minimap est redessinée en canvas 2D : à 60 images par seconde c'est
// autant de travail que personne ne voit. Vingt fois par seconde suffisent
// largement pour un disque de cent quatre-vingts pixels.
const MAP_DRAW_EVERY = 1 / 20
let mapDraw = 0
const MAP_CONE_LENGTH = 26  // portée du cône de vue des poursuivants
const MAP_CONE_ANGLE = 0.6  // demi-angle du cône, en radians

const minimapCanvas = document.querySelector('#minimap')
const minimapCtx = minimapCanvas.getContext('2d')
const MAP_SIZE = minimapCanvas.width
const MAP_CENTER = MAP_SIZE / 2
const MAP_SCALE = MAP_CENTER / MAP_RANGE // unités monde -> pixels

let mapBillboards = []
let mapRefresh = 0

// Logo Absolu des marqueurs, aplati en blanc une fois pour toutes dans un
// canvas hors écran : le dessiner à chaque frame depuis le SVG coûterait un
// décodage complet, et la teinte d'origine ne ressortirait pas sur le bleu.
const MAP_LOGO_WIDTH = 44
const mapLogo = document.createElement('canvas')
let mapLogoReady = false

const mapLogoImage = new Image()
mapLogoImage.onload = () => {
  const ratio = mapLogoImage.width / mapLogoImage.height
  mapLogo.width = MAP_LOGO_WIDTH
  mapLogo.height = Math.round(MAP_LOGO_WIDTH / ratio)
  const ctx = mapLogo.getContext('2d')
  ctx.drawImage(mapLogoImage, 0, 0, mapLogo.width, mapLogo.height)
  // On ne repeint que les pixels déjà opaques : la silhouette devient blanche
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, mapLogo.width, mapLogo.height)
  mapLogoReady = true
}
mapLogoImage.src = asset('logo-absolu.svg')

// Repère local : la voiture au centre, son cap vers le haut du disque.
// Le terme horizontal est négatif : dans le repère du jeu, la droite de la
// voiture pointe vers les X négatifs, elle se retrouvait donc à gauche de la
// carte, ce qui inversait la lecture.
function toMap(x, z, out) {
  const dx = x - body.x
  const dz = z - body.z
  const sin = Math.sin(carHeading)
  const cos = Math.cos(carHeading)
  out.x = MAP_CENTER - (dx * cos - dz * sin) * MAP_SCALE
  out.y = MAP_CENTER - (dx * sin + dz * cos) * MAP_SCALE
  return out
}

const _mapPoint = { x: 0, y: 0 }

// Les panneaux ne bougent pas : inutile de rebalayer la grille à chaque frame
function refreshMapBillboards() {
  mapBillboards = []
  const blockX = Math.floor(body.x / CELL)
  const blockZ = Math.floor(body.z / CELL)
  const reach = Math.ceil(MAP_RANGE / CELL)

  for (let bx = blockX - reach; bx <= blockX + reach; bx++) {
    for (let bz = blockZ - reach; bz <= blockZ + reach; bz++) {
      eachBuilding(bx, bz, (b) => {
        const p = b.billboard
        if (p && p.ground) mapBillboards.push(p)
      })
    }
  }
}

function drawMinimap(delta) {
  const visible = !whiteSpace && !portal && !falling && !gameOver
  minimapCanvas.classList.toggle('is-hidden', !visible)
  if (!visible) return

  mapDraw -= delta
  if (mapDraw > 0) return
  mapDraw = MAP_DRAW_EVERY

  mapRefresh -= delta
  if (mapRefresh <= 0) {
    mapRefresh = MAP_REFRESH
    refreshMapBillboards()
  }

  const ctx = minimapCtx
  ctx.save()
  ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE)

  // Tout est découpé au disque : rien ne déborde du cadre rond
  ctx.beginPath()
  ctx.arc(MAP_CENTER, MAP_CENTER, MAP_CENTER, 0, Math.PI * 2)
  ctx.clip()

  // Fond : la couleur des îlots, sur laquelle on trace les rues
  ctx.fillStyle = '#e7e9ee'
  ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE)

  // Rues : les axes de la grille, à leur largeur réelle
  ctx.strokeStyle = '#1d2b4d'
  ctx.lineWidth = ROAD * MAP_SCALE
  ctx.lineCap = 'butt'
  const first = Math.floor((body.x - MAP_RANGE) / CELL)
  const last = Math.ceil((body.x + MAP_RANGE) / CELL)
  const firstZ = Math.floor((body.z - MAP_RANGE) / CELL)
  const lastZ = Math.ceil((body.z + MAP_RANGE) / CELL)
  const span = MAP_RANGE * 1.6 // les axes dépassent du disque, ils seront rognés

  ctx.beginPath()
  for (let i = first; i <= last; i++) {
    const x = i * CELL
    toMap(x, body.z - span, _mapPoint)
    ctx.moveTo(_mapPoint.x, _mapPoint.y)
    toMap(x, body.z + span, _mapPoint)
    ctx.lineTo(_mapPoint.x, _mapPoint.y)
  }
  for (let i = firstZ; i <= lastZ; i++) {
    const z = i * CELL
    toMap(body.x - span, z, _mapPoint)
    ctx.moveTo(_mapPoint.x, _mapPoint.y)
    toMap(body.x + span, z, _mapPoint)
    ctx.lineTo(_mapPoint.x, _mapPoint.y)
  }
  ctx.stroke()

  // Panneaux franchissables : les objectifs du joueur, marqués au logo Absolu
  mapBillboards.forEach((p) => {
    toMap(p.x, p.z, _mapPoint)
    ctx.fillStyle = '#3e78ff'
    ctx.beginPath()
    ctx.arc(_mapPoint.x, _mapPoint.y, 19, 0, Math.PI * 2)
    ctx.fill()
    if (!mapLogoReady) return
    ctx.drawImage(
      mapLogo,
      _mapPoint.x - mapLogo.width / 2,
      _mapPoint.y - mapLogo.height / 2,
      mapLogo.width,
      mapLogo.height
    )
  })

  // Poursuivants : point clignotant et cône de vue orienté sur leur cap
  const blink = Math.sin(timer.getElapsed() * 9) > 0
  policeCars.forEach((car) => {
    toMap(car.body.x, car.body.z, _mapPoint)
    const x = _mapPoint.x
    const y = _mapPoint.y

    // Le cap du poursuivant, ramené dans le repère tourné de la carte
    const heading = car.heading - carHeading
    const start = -Math.PI / 2 + heading - MAP_CONE_ANGLE
    const end = -Math.PI / 2 + heading + MAP_CONE_ANGLE

    ctx.fillStyle = blink ? 'rgba(62, 120, 255, 0.38)' : 'rgba(242, 255, 40, 0.38)'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.arc(x, y, MAP_CONE_LENGTH * MAP_SCALE, start, end)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = blink ? '#3e78ff' : '#f2ff28'
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fill()
  })

  // Joueur : grosse flèche blanche cernée de noir, toujours au centre et
  // pointée vers le haut. Le contour la détache aussi bien du fond clair des
  // îlots que du bleu sombre des rues.
  ctx.beginPath()
  ctx.moveTo(MAP_CENTER, MAP_CENTER - 24)
  ctx.lineTo(MAP_CENTER + 17, MAP_CENTER + 19)
  ctx.lineTo(MAP_CENTER, MAP_CENTER + 9)
  ctx.lineTo(MAP_CENTER - 17, MAP_CENTER + 19)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#101010'
  ctx.stroke()

  ctx.restore()

  // Nord : le disque tourne avec la voiture, ce repère dit où est l'origine
  const northAngle = -carHeading - Math.PI / 2
  const nx = MAP_CENTER + Math.cos(northAngle) * (MAP_CENTER - 22)
  const ny = MAP_CENTER + Math.sin(northAngle) * (MAP_CENTER - 22)
  ctx.fillStyle = '#101010'
  ctx.beginPath()
  ctx.arc(nx, ny, 14, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = '500 17px Poppins, ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', nx, ny + 1)
}


/* ---------- Compteur de FPS ---------- */
// Moyenne glissante sur ~0,5 s : lisible, contrairement à l'instantané qui
// saute à chaque frame.
// Niveau de recherche : autant d'étoiles que de niveaux atteints
const wantedElement = document.querySelector('#wanted')
function updateWantedHud() {
  // Étoile du niveau de recherche, reprise via <use> du symbole global
  let markup = ''
  for (let i = 0; i < MAX_WANTED; i += 1) {
    const state = i < wanted ? ' is-on' : ''
    markup += `<svg class="wanted-star${state}" viewBox="0 0 24 24" aria-hidden="true"><use href="#star-shape" /></svg>`
  }
  wantedElement.innerHTML = markup
}

const gameOverElement = document.querySelector('#gameover')
const fadeElement = document.querySelector('#fade')
document.querySelector('#gameover-restart').addEventListener('click', () => restart())
// Contact direct : l'écran de capture est déjà un point d'arrêt. Ni demande
// de confirmation, ni retour au menu de pause — la partie est finie, il n'y
// a rien à reprendre derrière.
document.querySelector('#gameover-contact').addEventListener('click', openMailTo)

// Le niveau de dégâts remplace la jauge : il se lit directement sur la voiture
function updateDamageStage() {
  setDamageStage(Math.min(DAMAGE_STAGES.length, Math.floor(hits / HITS_PER_STAGE)) - 1)
}

const fpsElement = document.querySelector('#fps')
let fpsFrames = 0
let fpsElapsed = 0
// Temps réellement passé dans la boucle, cumulé sur la même fenêtre que le
// compteur. Comparé à l'intervalle entre deux images, il dit tout : si la
// boucle coûte 5 ms et que les images tombent toutes les 33 ms, ce ne sont
// pas nos calculs qui tiennent le compteur, c'est une limite imposée en
// amont — mode économie d'énergie, écran à 30 Hz, onglet en arrière-plan.
let fpsCost = 0
// Le temps de boucle est ventilé en deux : ce que coûte la soumission du
// rendu, et tout le reste. C'est la seule mesure qui sépare « trop d'objets
// à dessiner » de « trop de calcul avant de dessiner », sans profileur.
let fpsDraw = 0

function updateFps(delta) {
  fpsFrames++
  fpsElapsed += delta
  if (fpsElapsed < 0.5) return
  // Le compteur seul ne dit pas d'où vient la charge. Les appels de dessin
  // et les triangles réellement soumis, eux, tranchent entre « trop d'objets »
  // et « trop de pixels » sans avoir à ouvrir un profileur.
  const info = renderer.info.render
  const pixels = renderer.domElement.width * renderer.domElement.height
  const interval = (fpsElapsed / fpsFrames) * 1000 // ms entre deux images
  const cost = fpsCost / fpsFrames                 // ms de boucle par image
  const draw = fpsDraw / fpsFrames                 // dont la soumission du rendu
  fpsElement.textContent =
    `${Math.round(fpsFrames / fpsElapsed)} fps · Q${settings.quality} · ` +
    `boucle ${cost.toFixed(1)}ms (rendu ${draw.toFixed(1)} · jeu ${(cost - draw).toFixed(1)}) ` +
    `/ image ${interval.toFixed(1)}ms · ` +
    `${info.calls} appels · ${(info.triangles / 1e6).toFixed(2)}M tris · ` +
    `${(pixels / 1e6).toFixed(1)}M px`
  governQuality(fpsFrames / fpsElapsed, fpsElapsed)
  fpsFrames = 0
  fpsElapsed = 0
  fpsCost = 0
  fpsDraw = 0
}


/* ---------- Sauvegarde ---------- */
// L'état est écrit à chaque pause (Échap) et à la fermeture de l'onglet, puis
// relu au chargement : on reprend exactement où l'on s'était arrêté, position
// des poursuivants comprise. Le stockage local suffit, il n'y a rien de
// sensible et la partie est propre à la machine.
const SAVE_KEY = 'bta:save'
const SAVE_VERSION = 1
let pendingPolice = null // flotte à restaurer, en attente du modèle 3D

function saveGame() {
  // On ne sauvegarde pas pendant une séquence scénarisée : l'état y est
  // transitoire et ne se rejoue pas proprement.
  if (portal || falling || gameOver || whiteSpace) return

  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        version: SAVE_VERSION,
        car: { x: body.x, z: body.z, heading: carHeading, speed },
        camera: { yaw, pitch: settings.cameraPitch },
        wanted,
        hits,
        police: policeCars.map((c) => ({
          key: c.key,
          x: c.body.x,
          z: c.body.z,
          heading: c.heading,
          speed: c.speed,
          role: c.role,
        })),
      })
    )
  } catch {
    // Mode privé, quota plein : la partie continue, sans sauvegarde
  }
}

function loadGame() {
  let data
  try {
    data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null')
  } catch {
    return false
  }
  if (!data || data.version !== SAVE_VERSION) return false

  body.set(data.car.x, 0, data.car.z)
  prevBody.copy(body)
  carPosition.copy(body)
  carHeading = data.car.heading
  prevHeading = carHeading
  // La vitesse est restituée dans l'axe du cap, comme après un pas de simulation
  speed = data.car.speed || 0
  velocity.set(Math.sin(carHeading) * speed, 0, Math.cos(carHeading) * speed)

  yaw = data.camera.yaw
  settings.cameraPitch = data.camera.pitch

  wanted = Math.min(MAX_WANTED, Math.max(1, data.wanted || 1))
  hits = Math.min(MAX_HITS - 1, Math.max(0, data.hits || 0))

  // Le modèle des poursuivants arrive de façon asynchrone : on garde la
  // flotte de côté et on la recrée dès qu'il est là.
  pendingPolice = data.police || []
  return true
}

function restorePolice() {
  if (!pendingPolice || !policeTemplate) return
  clearPolice()
  pendingPolice.forEach((c) => {
    spawnPolice(c.key, c.x, c.z)
    const car = policeCars[policeCars.length - 1]
    car.heading = c.heading
    car.speed = c.speed
    car.role = c.role
    car.velocity.set(Math.sin(c.heading) * c.speed, 0, Math.cos(c.heading) * c.speed)
  })
  pendingPolice = null
}

window.addEventListener('beforeunload', saveGame)


/* ---------- Écran de chargement et animation d'ouverture ---------- */
// Le gestionnaire de three ne connaît que ce qu'on lui demande : on précharge
// donc explicitement tout ce qui serait sinon chargé à la volée en cours de
// partie (planches de dégâts, logos), pour que la barre décrive vraiment
// l'attente et qu'aucune texture ne manque au premier affichage.
// Durée du fondu du panneau de chargement, puis de l'entrée des mots. Les
// décalages entre « Brand », « Theft » et « Auto » sont portés par la feuille
// de style (délais de transition) : le script ne pose qu'une classe.
const VEIL_FADE = 600 // millisecondes de fondu du panneau noir

const bootElement = document.querySelector('#boot')
const bootBar = document.querySelector('#boot-bar i')
const bootPercent = document.querySelector('#boot-percent')

let bootDone = false

function setBootProgress(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio))
  bootBar.style.transform = `scaleX(${clamped})`
  bootPercent.textContent = `${Math.round(clamped * 100)}%`
}

function preloadAssets() {
  // Planches de sprites : elles n'apparaissent qu'au premier choc, mais les
  // charger après coup provoquerait un à-coup au pire moment.
  DAMAGE_STAGES.forEach((stage) => textureLoader.load(asset(stage.file)))
  // Logos des panneaux, et logo de l'agence pour le titre des projets
  textureLoader.load(asset('logo-absolu.svg'))
}

// Ouverture de l'accueil : le panneau de chargement s'efface, puis les trois
// mots du titre entrent l'un après l'autre, et le reste de la carte suit.
// L'accueil porte déjà le noir de charte, le fondu du panneau est donc
// invisible — c'est l'entrée des mots qui fait l'ouverture.
let revealing = false

function playSplashReveal() {
  if (revealing) return
  revealing = true

  bootElement.classList.add('is-revealing')
  setTimeout(() => {
    bootElement.style.display = 'none'
    // Les deux classes basculent ensemble : la carte redevient visible et la
    // séquence de fondus démarre au même instant.
    document.body.classList.remove('is-booting')
    document.body.classList.add('is-revealed')
    focusMenu() // le joueur peut lancer la partie sans toucher la souris
  }, VEIL_FADE)
}

function finishBoot() {
  if (bootDone) return
  bootDone = true
  setBootProgress(1)
  // La barre doit avoir le temps d'atteindre sa butée avant qu'on efface tout
  setTimeout(playSplashReveal, 320)
}

loadingManager.onProgress = (url, loaded, total) => {
  if (!bootDone) setBootProgress(total ? loaded / total : 0)
}
loadingManager.onLoad = finishBoot
// Un asset manquant ne doit pas laisser le joueur sur un écran noir
loadingManager.onError = () => finishBoot()

preloadAssets()

// Le chargeur ne se montre qu'une fois Poppins disponible : il porte la
// typo de la charte, et l'afficher avant provoquerait un recalage visible.
//
// `fonts.ready` ne suffit pas : tant que la feuille Google Fonts n'est pas
// analysée, aucun chargement n'est en attente et la promesse se résout
// immédiatement, avec les métriques de la police de repli.
const BOOT_FACES = ['400 16px Poppins', "400 86px 'Instrument Serif'"]
const fontsReady = document.fonts
  ? Promise.all(BOOT_FACES.map((face) => document.fonts.load(face))).then(
      () => document.fonts.ready
    )
  : Promise.resolve()

fontsReady.then(() => document.body.classList.add('is-ready'))
// Si la police tarde, l'écran ne doit pas rester vide pour autant
setTimeout(() => document.body.classList.add('is-ready'), 2000)

// Filet de sécurité : si un chargement s'éternise, on entre quand même
setTimeout(finishBoot, 12000)

/* ---------- Splashscreen ---------- */
// Écran d'accueil, rappelé à tout moment par Échap. Le bouton de lancement
// sert aussi de geste utilisateur : c'est lui qui autorise la lecture des
// vidéos des panneaux, refusée avant toute interaction.
const splashElement = document.querySelector('#splash')
const splashButton = document.querySelector('#splash-start')
const resumed = loadGame()
if (resumed) splashButton.textContent = 'Reprendre la partie'
let paused = true // la simulation ne tourne pas tant que l'accueil est ouvert
let splashTimer
// Route à retrouver en quittant le menu : celle d'où l'on venait
let routeBeforeMenu = ''

// Projet à ouvrir dès la fermeture de l'accueil, quand l'URL en désigne un.
// On attend ce clic plutôt que d'ouvrir tout de suite : c'est lui qui autorise
// la lecture des vidéos, refusée avant toute interaction.
let pendingProject = -1

function openSplash({ push = true } = {}) {
  paused = true
  saveGame()
  if (push && currentRoute() !== MENU_ROUTE) {
    routeBeforeMenu = currentRoute()
    history.pushState({ menu: true }, '', routeToPath(MENU_ROUTE))
  }
  keys.clear() // sinon on retrouve la voiture accélérant toute seule au retour
  clearTimeout(splashTimer)
  splashElement.style.display = ''
  // Le navigateur doit voir l'élément affiché avant la transition d'opacité
  requestAnimationFrame(() => {
    splashElement.classList.remove('is-hidden')
    focusMenu()
  })
  splashButton.textContent = 'Retour au jeu'
}

function closeSplash() {
  paused = false
  splashElement.classList.add('is-hidden')
  startPanelVideos()
  lockLandscape() // tentative de verrouillage, au premier geste de l'utilisateur

  // Le menu a sa propre URL : en sortir remet celle du jeu, sans empiler
  // d'entrée d'historique — ce n'est pas une navigation, juste une reprise.
  if (currentRoute() === MENU_ROUTE) {
    history.replaceState({}, '', routeToPath(routeBeforeMenu))
  }

  if (pendingProject >= 0) {
    const index = pendingProject
    pendingProject = -1
    openProject(index, { push: false }) // l'URL décrit déjà ce projet
  }

  // Retiré du flux une fois le fondu terminé, pour libérer le clic sur la scène
  clearTimeout(splashTimer)
  splashTimer = setTimeout(() => (splashElement.style.display = 'none'), 500)
}

// Au chargement, l'URL décide de la destination
const bootRoute = currentRoute()
const bootProject = projectFromRoute(bootRoute)
if (bootProject >= 0) {
  pendingProject = bootProject
  routeBeforeMenu = bootRoute
} else if (bootRoute === MENU_ROUTE) {
  routeBeforeMenu = ''
} else if (bootRoute !== '') {
  // Route inconnue atteinte côté client : on retombe sur la ville, et l'URL
  // est corrigée pour ne pas rester sur une adresse qui ne mène nulle part.
  history.replaceState({}, '', BASE)
}

// Navigation clavier de l'accueil : le bouton prend le focus à l'ouverture,
// les flèches circulent entre les éléments activables. Sans ce focus initial,
// une première frappe partirait dans le vide.
function focusableIn(container) {
  return [...container.querySelectorAll('button, a[href]')]
}

// Déplace le focus à l'intérieur d'un écran, en circulaire. Sans activable
// déjà ciblé, l'index vaut -1 et le calcul retombe naturellement sur le
// premier élément dans le sens avant.
function moveFocus(container, direction) {
  const items = focusableIn(container)
  if (!items.length) return
  const index = items.indexOf(document.activeElement)
  const next = (index + direction + items.length) % items.length
  items[next].focus({ preventScroll: true })
}

function focusMenu() {
  const items = focusableIn(splashElement)
  if (items.length) items[0].focus({ preventScroll: true })
}

function moveMenuFocus(direction) {
  if (focusableIn(splashElement).length < 2) return
  moveFocus(splashElement, direction)
}

window.addEventListener('keydown', (event) => {
  if (!paused || confirmOpen) return
  if (event.code === 'ArrowRight' || event.code === 'ArrowDown') moveMenuFocus(1)
  else if (event.code === 'ArrowLeft' || event.code === 'ArrowUp') moveMenuFocus(-1)
})

splashButton.addEventListener('click', closeSplash)

// Reprise à zéro depuis le menu : la sauvegarde est effacée, la ville
// resemée, et la partie reprend aussitôt — inutile de repasser par le menu
// qu'on vient de quitter.
document.querySelector('#splash-restart').addEventListener('click', () => {
  restart()
  closeSplash()
})

// Bascule de l'accueil, partagée par Échap et par le bouton Menu de la
// manette. La confirmation passe avant : Échap l'annule au lieu de basculer.
function toggleMenu() {
  if (confirmOpen) closeContact()
  else if (paused) closeSplash()
  else openSplash()
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape') return
  toggleMenu()
})

/* ---------- Aides manette ---------- */
// Quand la manette est la dernière source utilisée, ses boutons remplacent
// les touches, nommés selon la marque (A / ✕, View / Share…), dans l'accueil
// et dans le jeu.
const keyboardControls = document.querySelector('#controls-keyboard')
const padControls = document.querySelector('#controls-pad')
const phoneHintKey = phoneHint.querySelector('kbd')
const padNote = document.querySelector('#pad-note')
const padHidButton = document.querySelector('#pad-hid')
padHidButton.hidden = !gamepad.hidSupported // les aides ne sont redessinées qu'au premier changement
// Sélecteur refusé ou fermé : la note invite toujours à brancher la manette
padHidButton.addEventListener('click', () => gamepad.connectHid().catch(() => {}))
const pauseHint = document.querySelector('#pause-hint')

// Affiche un bouton de la manette dans une touche : pictogramme quand le
// profil en a un (View, Menu sur Xbox), nom du bouton sinon
function showPadButton(kbd, button) {
  const name = pad.profile.labels[button]
  const icon = pad.profile.icons?.[button]
  if (icon) {
    kbd.innerHTML = icon
    kbd.setAttribute('aria-label', name)
  } else {
    kbd.textContent = name
    kbd.removeAttribute('aria-label')
  }
}

function updateControlHints() {
  const usingPad = pad.connected && inputSource === 'pad'
  const label = (button) => pad.profile.labels[button]
  validateKey = usingPad ? label(BUTTON.A) : 'Entrée'
  const screenKey = usingPad ? label(BUTTON.A) : null
  if (screenKey !== phoneScreenPadKey) {
    phoneScreenPadKey = screenKey
    drawPhoneScreen(phoneScreenFocused) // l'écran n'est sinon redessiné qu'au focus
  }
  if (usingPad) {
    showPadButton(phoneHintKey, BUTTON.UP)
  } else {
    phoneHintKey.textContent = 'Tab'
    phoneHintKey.removeAttribute('aria-label')
  }
  // Rappel du bouton de pause, propre à la manette
  pauseHint.hidden = !usingPad
  if (usingPad) showPadButton(pauseHint.querySelector('kbd'), BUTTON.MENU)
  keyboardControls.hidden = usingPad
  padControls.hidden = !usingPad
  // Le mot sous les contrôles accompagne chaque étape : manette à brancher,
  // branchée mais pas encore utilisée, puis en service
  // Recours WebHID pour les Switch Pro que Chrome ne présente pas au jeu
  padHidButton.hidden = pad.connected || !gamepad.hidSupported
  if (!pad.connected) {
    padNote.textContent = '🎮 Jouable à la manette : branchez-en une et appuyez sur un bouton.'
  } else if (!usingPad) {
    padNote.textContent = `🎮 Manette ${pad.profile.name} connectée : touchez un stick pour jouer avec.`
  } else {
    padNote.textContent = `🎮 Manette ${pad.profile.name} connectée.`
  }
  if (!usingPad) return

  padControls.querySelectorAll('[data-button]').forEach((el) => {
    el.textContent = label(BUTTON[el.dataset.button])
  })
}

// Le curseur n'existe que dans les écrans à boutons, et n'apparaît que
// quand la manette est la dernière source utilisée. Il se pose d'abord sur
// l'action par défaut de l'écran.
const confirmCancelButton = document.querySelector('#confirm-cancel')
const gameOverButton = document.querySelector('#gameover button')

function menuHome() {
  if (confirmOpen) return confirmCancelButton
  if (gameOver) return gameOverButton
  if (paused) return splashButton
  return null
}

function updatePadCursor(delta) {
  const home = menuHome()
  if (pad.connected && home && inputSource === 'pad') padCursor.show(home)
  else padCursor.hide()
  padCursor.update(delta)
}

/* ---------- Boucle ---------- */
// Timer remplace Clock, déprécié. La différence tient à l'appel : Clock
// calculait le delta à la lecture, Timer veut un update() par image, après
// quoi getDelta() et getElapsed() renvoient les valeurs de l'image en cours.
// On le branche sur le document : quand l'onglet passe en arrière-plan, le
// delta tombe à zéro et le temps se remet d'aplomb au retour, au lieu de
// sauter d'un bond de toute la durée de l'absence.
const timer = new THREE.Timer()
timer.connect(document)
body.copy(carPosition)
prevBody.copy(body)
updateWantedHud()
updateDamageStage() // une partie reprise garde ses dégâts
applyCameraOrientation()
// Palier de départ : plus bas sur tactile, voir QUALITY_START
applyQuality(QUALITY_START)
updateSun()
follow()
updateChunks()

function tick() {
  requestAnimationFrame(tick)
  const frameStart = performance.now()
  timer.update()
  const delta = Math.min(timer.getDelta(), 0.1)
  updateFps(delta)
  drawMinimap(delta)
  updatePhone(delta)
  updateMenuButton()
  updatePanelVideos(delta)
  updatePoliceVisuals(timer.getElapsed(), renderAlpha)
  updateLook(delta)
  updateMagnet(delta)
  updateFollowCamera(delta)
  updateFraming(delta)
  updateMovement(delta)
  updateMediaPlanes(delta)
  updateProjectTitle(delta)
  updateHole()
  updateReticle()
  updateBusted(delta)
  updateDamageSprite(delta)
  updatePortalCamera(delta)
  updatePortalVisual()
  follow()
  updateChunks()
  renderCityWindow()
  const drawStart = performance.now()
  renderer.render(scene, camera)
  const now = performance.now()
  // `render` ne fait en principe que soumettre des commandes. Quand sa part
  // enfle, c'est soit le nombre d'objets soumis, soit un téléversement de
  // texture qui bloque — typiquement une trame vidéo décodée.
  fpsDraw += now - drawStart
  fpsCost += now - frameStart
}
tick()
