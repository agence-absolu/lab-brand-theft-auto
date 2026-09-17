import * as THREE from 'three'
import Hls from 'hls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import GUI from 'lil-gui'
import { PROJECTS } from './projects.js'
import { PROJECT_MEDIA, PROJECT_LOGOS, PROJECT_STREAMS } from './project-media.js'
import './style.css'

// Tous les médias sont servis depuis public/. En production le site vit sous
// un sous-chemin (/brand-theft-auto/), il faut donc préfixer les URL absolues
// stockées dans les données. Les URL distantes (flux Mux) passent telles quelles.
const asset = (path) =>
  /^https?:/.test(path) ? path : `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

const SKY = new THREE.Color('#244697')
const SUN = new THREE.Color('#F26749')
const GROUND = new THREE.Color('#2970F4')
const BUILDING = new THREE.Color('#244697') // teinte de base des façades
const ROAD_COLOR = SKY.clone().lerp(new THREE.Color('#000000'), 0.45)
const SIDEWALK_COLOR = new THREE.Color('#bfc6d4')
// Couleur d'horizon : le ciel éclairci. Partagée par le dégradé et le
// brouillard, pour que la ville se fonde exactement dans le fond.
const HORIZON = new THREE.Color()

// Valeurs pilotées par l'interface
const settings = {
  fov: 60,                // champ de vision de la caméra perspective
  cameraHeight: 1.9,      // hauteur du point visé, au-dessus du toit de la voiture
  cameraDistance: 9,      // recul de la caméra derrière la voiture
  carScale: 0.7,          // échelle du véhicule
  cameraPitch: -11,       // inclinaison en degrés : négatif = regard vers le bas
  sunColor: '#f26749',
  buildingColor: '#d3d3d3',
  roadColor: '#244697',
  sidewalkColor: '#bfc6d4',
  skyColor: '#244697',
  sunHeight: 0.349,       // élévation du soleil, de l'horizon (0) au zénith (1)
}
BUILDING.set(settings.buildingColor)
SUN.set(settings.sunColor)
ROAD_COLOR.set(settings.roadColor)
SIDEWALK_COLOR.set(settings.sidewalkColor)

function applySkyColor() {
  SKY.set(settings.skyColor)
  HORIZON.copy(SKY).lerp(new THREE.Color('#ffffff'), 0.35)
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

const canvas = document.querySelector('#scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()

// Tout ce qui constitue la ville vit dans ce groupe : il permet de la faire
// descendre d'un bloc pendant la transition de portail, sans toucher au ciel,
// aux lumières ni à la caméra.
const world = new THREE.Group()
scene.add(world)
// Le brouillard fond la ville dans le ciel : la limite de chargement des
// chunks n'est jamais visible, contrairement à une coupure nette.
const cityFog = new THREE.Fog(HORIZON, 60, 420)
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
  camera.rotation.x = THREE.MathUtils.degToRad(settings.cameraPitch)
  placeCamera()
}

// Écart résiduel entre la pose réelle et la pose de poursuite, résorbé après
// une transition pour que la caméra ne se téléporte jamais.
const cameraOffset = new THREE.Vector3()

function placeCamera() {
  if (portal) return // la caméra est pilotée par la transition
  _pivot.set(carPosition.x, city.sidewalkHeight + settings.cameraHeight, carPosition.z)
  camera.getWorldDirection(_back).multiplyScalar(-1)

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

  const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)
  const tilt = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0)
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
function updateFollowCamera(delta) {
  if (portal || gameOver || falling || paused || framingBlend) return // recadrages prioritaires

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
const FRAMING_DECAY = 2.6  // résorption de l'écart de position
let framingBlend = null

function updateFraming(delta) {
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
    varying vec3 vWorldDirection;

    void main() {
      vec3 dir = normalize(vWorldDirection);

      // Dégradé vertical
      float h = smoothstep(-0.15, 0.75, dir.y);
      vec3 color = mix(uSkyBottom, uSkyTop, h);

      // Halo + disque solaire
      float d = dot(dir, normalize(uSunDirection));
      float halo = pow(max(d, 0.0), 48.0);
      float disc = smoothstep(0.9965, 0.9985, d);
      color = mix(color, uSunColor, halo * 0.75);
      color = mix(color, uSunColor, disc);

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
const ROAD = 9                        // largeur de rue
const CELL = BLOCK + ROAD             // pas de la grille
const BLOCKS_PER_CHUNK = 4            // blocs par côté de chunk
const CHUNK = BLOCKS_PER_CHUNK * CELL // côté d'un chunk en unités monde
const PLOTS = 2                       // parcelles par côté de bloc
const BILLBOARD_THICKNESS = 0.14      // épaisseur des panneaux
const BILLBOARD_RATIO = 9 / 16        // les panneaux sont toujours en 16:9
const PORTAL_MIN_WIDTH = 3.4          // largeur mini pour laisser entrer la voiture
const PORTAL_DEPTH = 2.2              // profondeur de la zone de déclenchement, DEVANT le panneau
const VIEW_RADIUS = 4                 // chunks chargés autour de la caméra (rayon)

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

// Tranche du caisson : blanc neutre, commun à tous les panneaux.
const billboardEdgeMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xffffff,
  emissiveIntensity: 0.35,
  roughness: 0.4,
})

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

const textureLoader = new THREE.TextureLoader()

// Un matériau par projet. La face avant du caisson (groupe 4 de la BoxGeometry,
// soit +Z) porte le média ; les cinq autres gardent la tranche blanche.
const projectMaterials = PROJECTS.map((project) => {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    roughness: 0.4,
    side: THREE.DoubleSide,
  })

  // Le poster s'affiche tout de suite, la vidéo prend le relais quand elle
  // a de quoi jouer : jamais de panneau noir en attendant le réseau.
  const poster = panelTexture(textureLoader.load(asset(project.poster), (t) => {
    if (material.map === t) coverTexture(t, t.image.width, t.image.height)
  }))
  material.map = poster
  material.emissiveMap = poster

  if (project.video) {
    const video = document.createElement('video')
    video.src = asset(project.video)
    video.loop = true
    video.muted = true // sans quoi l'autoplay est refusé par le navigateur
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    project.element = video

    video.addEventListener('loadeddata', () => {
      const map = panelTexture(new THREE.VideoTexture(video))
      coverTexture(map, video.videoWidth, video.videoHeight)
      material.map = map
      material.emissiveMap = map
      material.needsUpdate = true
      poster.dispose()
      video.play().catch(() => {}) // voir startPanelVideos pour les reprises
    })
    video.load()
  }

  return [
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    billboardEdgeMaterial,
    material, // +Z : la face visible depuis la rue
    billboardEdgeMaterial,
  ]
})

// Logo du client, plaqué en blanc sur le média du panneau. Les fichiers
// sources sont sombres : on les aplatit en blanc dans un canvas, en ne
// gardant que leur silhouette.
const logoGeometry = new THREE.PlaneGeometry(1, 1)
const projectLogos = [] // { material, aspect, ready } par projet

function projectLogo(index) {
  if (projectLogos[index]) return projectLogos[index]

  const entry = {
    material: new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.95,
    }),
    aspect: 3,
    ready: false,
  }
  projectLogos[index] = entry

  const url = PROJECT_LOGOS[PROJECTS[index].slug]
  if (!url) return entry

  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    // On ne repeint que les pixels déjà opaques : la silhouette devient
    // blanche et la transparence d'origine est préservée.
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    entry.material.map = texture
    entry.material.needsUpdate = true
    entry.aspect = image.width / image.height
    entry.ready = true
    // Les chunks déjà construits ont été dimensionnés sur l'aspect par
    // défaut : on les recale maintenant que le logo est connu.
    refreshLogoInstances(index)
  }
  image.src = asset(url)
  return entry
}

// Position et taille du logo sur un panneau, partagées par la construction
// des chunks et le recalage après chargement.
const LOGO_WIDTH = 0.26  // part de la largeur du panneau
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

function refreshLogoInstances(projectIndex) {
  for (const chunk of chunks.values()) {
    chunk.userData.logos?.forEach((entry) => {
      if (entry.project !== projectIndex) return
      const aspect = projectLogos[projectIndex].aspect
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
function startPanelVideos() {
  PROJECTS.forEach((project) => {
    const video = project.element
    if (video && video.paused) video.play().catch(() => {})
  })
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
            // Projet affiché sur ce panneau, tiré lui aussi du hash
            project: Math.floor(hash(blockX * 3 + 1, blockZ * 7 + 5, 121 + salt) * PROJECTS.length),
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
    billboards.forEach((b) => {
      const list = byProject.get(b.billboard.project)
      if (list) list.push(b)
      else byProject.set(b.billboard.project, [b])
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

      // Logo du client, en blanc, plaqué sur la face du panneau
      const logo = projectLogo(projectIndex)
      const logos = new THREE.InstancedMesh(logoGeometry, logo.material, group_.length)
      group_.forEach((b, i) => logos.setMatrixAt(i, logoMatrix(b.billboard, logo.aspect, _matrix)))
      group.add(logos)
      group.userData.logos.push({ mesh: logos, project: projectIndex, items: group_ })
    })
    group.userData.panelKeys = billboards.map((b) => panelKey(b.billboard))
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

  return group
}

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

  // Charge ce qui entre dans le rayon
  for (let x = cx - VIEW_RADIUS; x <= cx + VIEW_RADIUS; x++) {
    for (let z = cz - VIEW_RADIUS; z <= cz + VIEW_RADIUS; z++) {
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
    if (Math.abs(x - cx) > VIEW_RADIUS + 1 || Math.abs(z - cz) > VIEW_RADIUS + 1) {
      world.remove(chunk)
      chunk.traverse((o) => o.isInstancedMesh && o.dispose())
      chunk.userData.panelKeys?.forEach((pk) => panelLookup.delete(pk))
      chunks.delete(k)
    }
  }
}

/* ---------- Lumières ---------- */
const hemiLight = new THREE.HemisphereLight(SKY, GROUND, 1.2)
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
sunLight.shadow.mapSize.set(2048, 2048)
const shadowCam = sunLight.shadow.camera
shadowCam.left = -120; shadowCam.right = 120; shadowCam.top = 120; shadowCam.bottom = -120
shadowCam.near = 1; shadowCam.far = 400
sunLight.shadow.bias = -0.0008
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

new GLTFLoader().load(asset('models/car_1.glb'), (gltf) => {
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
const POLICE_SPEED = 19.5    // toujours sous la pointe du joueur (24)
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

new GLTFLoader().load(asset('models/car_2.glb'), (gltf) => {
  policeTemplate = normalizeCarModel(gltf.scene)
  restorePolice() // rien à faire s'il n'y a pas de sauvegarde
  refreshPoliceFleet()
})

// Gyrophare : un petit volume émissif qui alterne bleu et rouge
function makeBeacon() {
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.22, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x2970f4, emissiveIntensity: 2 })
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
    if (beacon) beacon.material.emissive.setHex(blue ? 0x2970f4 : 0xf26749)
  })
}


/* ---------- Contrôleur de déplacement : Z Q S D ---------- */
// Approche classique de character controller : une position autoritaire qui
// n'est JAMAIS en pénétration, déplacée à pas de temps fixe par une vélocité
// résolue en "collide and slide".
const keys = new Set()

// Dynamique longitudinale : la voiture n'avance que sur son propre axe.
// Z accélère, S freine puis passe en marche arrière, Q/D braquent.
const ENGINE_ACCEL = 16    // accélération moteur, u/s²
const BRAKE_DECEL = 30     // freinage, bien plus mordant que le moteur
const REVERSE_ACCEL = 8    // marche arrière, plus molle que la marche avant
const MAX_SPEED = 24       // vitesse de pointe en marche avant
const MAX_REVERSE = 8      // vitesse de pointe en marche arrière
const DRAG = 0.9           // traînée proportionnelle à la vitesse (aéro)
const ROLL_RESIST = 2.5    // résistance constante (frein moteur, roulement)
const STEER_RATE = 2.0     // braquage max, rad/s
const STEER_SMOOTH = 5.5   // montée et retour au centre du volant
const HANDBRAKE_DECEL = 9  // ralentissement roues bloquées
const HANDBRAKE_GRIP = 0.5 // adhérence latérale frein à main tiré : ça glisse
const HANDBRAKE_STEER = 1.6// gain de braquage pendant la glissade
const GRIP_SPEED = 7       // vitesse à partir de laquelle on braque à fond

const FIXED_DT = 1 / 60    // pas de simulation
const MAX_STEPS = 5        // garde-fou si le rendu décroche
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
  // Espace et flèches font défiler la page par défaut
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

// KeyZ/KeyQ et KeyW/KeyA : fonctionne en AZERTY comme en QWERTY
const pressed = {
  get throttle() {
    return keys.has('KeyW') || keys.has('KeyZ')
  },
  get brake() {
    return keys.has('KeyS')
  },
  get left() {
    return keys.has('KeyA') || keys.has('KeyQ')
  },
  get right() {
    return keys.has('KeyD')
  },
  get handbrake() {
    return keys.has('Space')
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
      const cross = Math.sin(carHeading) * hit.nz - Math.cos(carHeading) * hit.nx
      spin = THREE.MathUtils.clamp(spin + cross * -vInto * SPIN_GAIN, -MAX_SPIN, MAX_SPIN)
    }
  }
}

// Coincé entre deux obstacles : le joueur appuie mais n'avance plus. Plutôt
// que de le téléporter, la voiture fait un bond et survole ce qui la bloque —
// en l'air, les collisions sont ignorées.
const STUCK_DELAY = 1.1 // secondes bloqué avant le saut de dégagement
const STUCK_SPEED = 1.5 // en dessous, on considère la voiture immobile
const HOP_SPEED = 15    // impulsion verticale du saut
const HOP_PUSH = 11     // poussée horizontale qui accompagne le saut
let stuckTime = 0

function checkStuck() {
  const pushing = pressed.throttle || pressed.brake
  const moving = Math.hypot(velocity.x, velocity.z) > STUCK_SPEED

  if (!pushing || moving) {
    stuckTime = 0
    return
  }

  stuckTime += FIXED_DT
  if (stuckTime < STUCK_DELAY) return

  stuckTime = 0
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
  const steerTarget = (pressed.left ? 1 : 0) - (pressed.right ? 1 : 0)
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
    speed += ENGINE_ACCEL * FIXED_DT
  } else if (pressed.brake) {
    // Tant qu'on avance, S freine. Une fois à l'arrêt, il enclenche la
    // marche arrière : un seul appui maintenu fait les deux dans l'ordre.
    if (speed > 0.1) speed -= BRAKE_DECEL * FIXED_DT
    else speed -= REVERSE_ACCEL * FIXED_DT
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

  // Cadrage d'arrivée : pile dans l'axe de la voiture, vue de l'arrière et
  // légèrement en plongée. `chase` demande de recalculer la cible à chaque
  // frame, pour finir exactement derrière elle même si elle a tourné.
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
  hemiLight.color.copy(SKY)
  hemiLight.groundColor.copy(GROUND)
  mediaGroup.visible = false
  titleMesh.visible = false
  titleGround.visible = false
  ctaMesh.visible = false
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

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

const colors = gui.addFolder('Couleurs')
colors.addColor(settings, 'skyColor').name('Ciel').onChange(() => {
  // SKY et HORIZON sont référencés par les uniforms, le fog et la lumière
  // d'ambiance : il suffit de les muter sur place.
  applySkyColor()
  hemiLight.color.copy(SKY)
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
const MEDIA_ARC = THREE.MathUtils.degToRad(165) // ouverture du demi-cercle
const MEDIA_RINGS = [17, 26, 35] // trois profondeurs, pour dégager la vue
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
    // Demi-cercle ouvert devant la voiture, dans l'axe où elle a débouché
    const ratio = count > 1 ? i / (count - 1) : 0.5
    const angle = carHeading - MEDIA_ARC / 2 + ratio * MEDIA_ARC
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
function spawnProjectPlanes(project) {
  clearProjectPlanes()
  mediaAnchor.copy(carPosition)
  mediaEntry = 0
  const files = PROJECT_MEDIA[project.slug] || []

  // La vidéo d'en-tête du projet occupe le premier plan de la constellation.
  // On repart de l'élément <video> déjà créé pour les panneaux de la ville :
  // une seule lecture alimente les deux textures.
  if (project.element) addVideoPlane(project.element)

  // Vidéos supplémentaires du projet, plafonnées pour préserver le framerate
  const streams = (PROJECT_STREAMS[project.slug] || []).slice(0, MAX_STREAMS)
  streams.forEach((url, i) => {
    const video = createStreamVideo(url)
    if (video) addVideoPlane(video, i + 1)
  })

  files.forEach((url, i) => {
    const material = makeMediaMaterial(null)
    const mesh = new THREE.Mesh(mediaGeometry, material)

    mesh.scale.set(MEDIA_HEIGHT * 1.6, MEDIA_HEIGHT, 1)
    mesh.visible = false
    mediaGroup.add(mesh)

    textureLoader.load(asset(url), (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      material.uniforms.uMap.value = texture
      // Proportions réelles du média, une fois connues
      const aspect = texture.image.width / texture.image.height
      mesh.scale.set(MEDIA_HEIGHT * aspect, MEDIA_HEIGHT, 1)
      mesh.visible = true
    })
  })

  layoutMediaPlanes()
}

// Vidéos secondaires : flux HLS Mux, montés à la volée. Safari lit le .m3u8
// nativement, les autres navigateurs passent par hls.js.
const MAX_STREAMS = 3 // décoder plus de flux simultanés fait chuter le framerate
const activeStreams = []

function createStreamVideo(url) {
  const video = document.createElement('video')
  video.loop = true
  video.muted = true // sans quoi l'autoplay est refusé
  video.playsInline = true
  video.crossOrigin = 'anonymous'

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
  } else if (Hls.isSupported()) {
    const hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 8 })
    hls.loadSource(url)
    hls.attachMedia(video)
    activeStreams.push(hls) // conservé pour pouvoir détruire le flux à la sortie
  } else {
    return null
  }

  video.play().catch(() => {})
  return video
}

function releaseStreams() {
  activeStreams.forEach((hls) => hls.destroy())
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
  mediaGroup.add(mesh)

  video.play().catch(() => {}) // relancée aussi par startPanelVideos
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
  if (ctaMesh.visible) {
    ctaMesh.position.y =
      ctaMesh.userData.baseY + Math.sin(t * 0.8) * planeShader.floatAmplitude * 1.6
  }
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
const TITLE_SCREEN_HEIGHT = 0.28  // part de la hauteur de l'écran occupée
const TITLE_SCREEN_OFFSET = 0.16  // décalage vertical, en part d'écran
const TITLE_SCREEN_WIDTH = 0.92   // largeur max : un titre long doit tenir en entier

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

// La composition — logo au-dessus, titre en dessous sur plusieurs lignes —
// est dessinée dans un canvas 2D. Une seule texture, pas de géométrie de
// texte ni de dépendance à une police 3D.
const TITLE_FACE = '700 120px Poppins' // format attendu par document.fonts.load
const TITLE_FONT = `${TITLE_FACE}, ui-sans-serif, system-ui, sans-serif`
const TITLE_CANVAS_WIDTH = 1800
const TITLE_LINE_HEIGHT = 148
const TITLE_LOGO_HEIGHT = 250 // hauteur du logo, relative au corps du titre
const TITLE_LOGO_GAP = 70
const TITLE_INK = '#000000'

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

function drawTitleComposition(text, logo) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  // Première passe : mesurer pour dimensionner le canvas au plus juste
  canvas.width = TITLE_CANVAS_WIDTH
  ctx.font = TITLE_FONT
  const lines = wrapTitle(ctx, text, TITLE_CANVAS_WIDTH * 0.92)

  const logoWidth = logo ? (logo.width / logo.height) * TITLE_LOGO_HEIGHT : 0
  const logoBlock = logo ? TITLE_LOGO_HEIGHT + TITLE_LOGO_GAP : 0
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width))

  canvas.width = Math.ceil(Math.max(textWidth, logoWidth)) + 40
  canvas.height = Math.ceil(logoBlock + lines.length * TITLE_LINE_HEIGHT)

  // Redimensionner le canvas réinitialise le contexte : tout est à refaire
  ctx.font = TITLE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = TITLE_INK
  ctx.globalAlpha = 1

  const center = canvas.width / 2
  if (logo) {
    const x = center - logoWidth / 2
    ctx.drawImage(logo, x, 0, logoWidth, TITLE_LOGO_HEIGHT)
    // Le logo est aplati en noir : on peint un rectangle noir en ne gardant
    // que les pixels déjà opaques, ce qui revient à encrer sa silhouette.
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillRect(x, 0, logoWidth, TITLE_LOGO_HEIGHT)
    ctx.globalCompositeOperation = 'source-over'
  }

  lines.forEach((line, i) => {
    ctx.fillText(line, center, logoBlock + (i + 0.5) * TITLE_LINE_HEIGHT)
  })

  titleAspect = canvas.width / canvas.height
  titleMesh.material.map?.dispose()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  titleMesh.material.map = texture
  titleMesh.material.needsUpdate = true
}

function setProjectTitle(project) {
  const logoUrl = PROJECT_LOGOS[project.slug]

  // La police et le logo arrivent de façon asynchrone : on compose une
  // première fois avec ce qu'on a, puis on recompose dès qu'ils sont prêts.
  const render = (logo) => drawTitleComposition(project.title, logo)
  render(null)

  const ready = document.fonts ? document.fonts.load(TITLE_FACE) : Promise.resolve()
  if (!logoUrl) {
    ready.then(() => render(null))
    return
  }

  const image = new Image()
  image.onload = () => ready.then(() => render(image))
  image.src = asset(logoUrl)
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
    TITLE_SCREEN_HEIGHT,
    (TITLE_SCREEN_WIDTH * camera.aspect) / titleAspect
  )
  const height = viewHeight * heightFraction
  titleMesh.scale.set(height * titleAspect, height, 1)
  // Décalage appliqué dans le repère de la caméra, pour rester à la même
  // hauteur d'écran quelle que soit l'inclinaison
  titleMesh.translateY(viewHeight * TITLE_SCREEN_OFFSET)

  // Le rectangle occupé à l'écran est constant : il découle directement des
  // fractions choisies, pas d'une reprojection.
  const uniforms = titleGroundMaterial.uniforms
  uniforms.uCenter.value.set(0, 2 * TITLE_SCREEN_OFFSET)
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
const CTA_COLOR = '#F26749'
const CTA_LABEL = 'Voir le projet'
// Placé au-delà de la constellation de plans, donc agrandi pour rester lisible
const CTA_WIDTH = 30          // unités monde
const CTA_HEIGHT = 9.4
const CTA_DISTANCE = 115      // devant la voiture, dans son axe d'arrivée
const CTA_FLOAT = 6           // hauteur de flottaison du bas de la dalle

function makeCtaTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 320
  const ctx = canvas.getContext('2d')

  const radius = 60
  ctx.fillStyle = CTA_COLOR
  ctx.beginPath()
  ctx.roundRect(0, 0, canvas.width, canvas.height, radius)
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.font = '700 104px Poppins, ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  // Libellé et icône sont centrés ensemble : on mesure d'abord le bloc entier
  const icon = 78
  const gap = 34
  const textWidth = ctx.measureText(CTA_LABEL).width
  const startX = (canvas.width - (textWidth + gap + icon)) / 2
  const middle = canvas.height / 2

  ctx.textAlign = 'left'
  ctx.fillText(CTA_LABEL, startX, middle + 6)

  // Icône "lien externe" : un cadre ouvert et une flèche sortante
  const ix = startX + textWidth + gap
  const iy = middle - icon / 2
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 9
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(ix + icon * 0.58, iy + icon * 0.06)
  ctx.lineTo(ix + icon * 0.06, iy + icon * 0.06)
  ctx.lineTo(ix + icon * 0.06, iy + icon * 0.94)
  ctx.lineTo(ix + icon * 0.94, iy + icon * 0.94)
  ctx.lineTo(ix + icon * 0.94, iy + icon * 0.42)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ix + icon * 0.44, iy + icon * 0.56)
  ctx.lineTo(ix + icon * 0.96, iy + icon * 0.04)
  ctx.moveTo(ix + icon * 0.62, iy + icon * 0.04)
  ctx.lineTo(ix + icon * 0.96, iy + icon * 0.04)
  ctx.lineTo(ix + icon * 0.96, iy + icon * 0.38)
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}

const ctaMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(CTA_WIDTH, CTA_HEIGHT),
  new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false })
)
ctaMesh.visible = false
// Les plans médias ont depthWrite:false et ne peuvent pas masquer le CTA par
// le depth buffer : c'est l'ordre de rendu qui le renvoie à l'arrière-plan.
ctaMesh.renderOrder = -1
scene.add(ctaMesh)

let ctaUrl = null

function placeCta(project) {
  if (!ctaMesh.material.map) {
    // La police doit être chargée avant de peindre le libellé
    const paint = () => (ctaMesh.material.map = makeCtaTexture())
    paint()
    document.fonts?.load('700 104px Poppins').then(() => {
      ctaMesh.material.map?.dispose()
      paint()
      ctaMesh.material.needsUpdate = true
    })
  }

  // Flottant dans l'axe d'arrivée de la voiture, comme les plans médias
  const x = carPosition.x + Math.sin(carHeading) * CTA_DISTANCE
  const z = carPosition.z + Math.cos(carHeading) * CTA_DISTANCE
  ctaMesh.position.set(x, CAR_GROUND + CTA_FLOAT + CTA_HEIGHT / 2, z)
  ctaMesh.lookAt(carPosition.x, ctaMesh.position.y, carPosition.z)
  ctaMesh.userData.baseY = ctaMesh.position.y
  ctaMesh.visible = true

  ctaUrl = project.url
}


/* ---------- Trou dans le sol ---------- */
// Sortie de l'espace blanc : un puits creusé dans le sol blanc, dont le fond
// laisse voir la ville vue du ciel. Y conduire la voiture la fait tomber.
const HOLE_RADIUS = 7
const HOLE_DEPTH = 30
const HOLE_DISTANCE = 34 // derrière la voiture : il faut faire demi-tour

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

  const hidden = [whiteGround, mediaGroup, titleMesh, titleGround, ctaMesh, holeMesh, carGroup]
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
const MAGNET_RADIUS = 0.34   // rayon d'accroche, en coordonnées écran (NDC)
const MAGNET_PULL = 3.4      // vitesse d'alignement

// En ville, l'aimant vise les panneaux franchissables. Il est volontairement
// plus étroit et plus mou : il doit aider à cadrer un panneau repéré, jamais
// contrarier une manœuvre ou une esquive.
const CITY_MAGNET_RADIUS = 0.26 // rayon d'accroche à l'écran
const CITY_MAGNET_PULL = 2.2    // attraction, plus douce qu'en espace blanc
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

function updateMagnet(delta) {
  magnetTarget = null
  if (portal || gameOver || falling || paused) return

  let best = null
  let pull = MAGNET_PULL

  if (whiteSpace) {
    const targets = interactiveTargets()
    if (!targets.length) return
    best = screenClosest(targets, MAGNET_RADIUS, (t, out) => t.getWorldPosition(out))
    if (best) magnetTarget = best.candidate
  } else {
    // Une manœuvre en cours prime sur l'aide au cadrage
    if (Math.abs(steerInput) > CITY_MAGNET_STEER) return
    best = screenClosest(nearbyPortals(), CITY_MAGNET_RADIUS, (p, out) =>
      out.set(p.x, city.sidewalkHeight + p.y, p.z)
    )
    pull = CITY_MAGNET_PULL
  }
  if (!best) return

  const radius = whiteSpace ? MAGNET_RADIUS : CITY_MAGNET_RADIUS

  // Attraction proportionnelle à la proximité : franche au centre, douce au
  // bord, pour qu'on puisse encore balayer la scène sans être happé.
  const strength = (1 - best.distance / radius) * pull
  const k = 1 - Math.exp(-strength * delta)

  // L'écart écran est converti en angles : la moitié du champ vertical vaut
  // fov/2, et l'horizontal suit l'aspect.
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2
  yaw -= best.x * Math.atan(Math.tan(halfFov) * camera.aspect) * k
  settings.cameraPitch += THREE.MathUtils.radToDeg(best.y * halfFov) * k

  // En ville, le retour derrière la voiture reste prioritaire : l'aimant ne
  // fait que ralentir le recentrage, il ne le bloque pas.
  if (whiteSpace) lookIdle = 0
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
function interactiveTargets() {
  if (!whiteSpace) return []
  const targets = []
  if (ctaMesh.visible) targets.push(ctaMesh)
  if (holeMesh.visible) targets.push(holeMesh)
  return targets
}

function labelFor(target) {
  return target === ctaMesh ? 'Voir le projet' : 'Retour en ville'
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
  if (target === ctaMesh) window.open(ctaUrl, '_blank', 'noopener')
  else if (target === holeMesh) startFalling()
}

// Cible sous le réticule, réévaluée à chaque frame
let aimed = null
function updateReticle() {
  // Toujours affiché : il sert aussi de repère de direction en ville, où il
  // n'y a simplement rien à pointer.
  const hit = pickAt(0, 0)
  // L'aimant sert de repli : on peut valider une cible simplement approchée
  aimed = hit?.object || magnetTarget || null

  reticleElement.classList.toggle('is-active', Boolean(aimed))
  reticleLabel.classList.toggle('is-active', Boolean(aimed))
  if (aimed) reticleLabel.innerHTML = `<kbd>Entrée</kbd>${labelFor(aimed)}`
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return
  if (confirmOpen) return contactAgency() // Entrée valide la confirmation
  // Le téléphone prime : quand il a le focus, c'est lui qu'on valide
  if (phoneGroup.visible && (phoneHovered || phonePinned)) askContact()
  else if (aimed) activate(aimed)
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

  // Logo : ses proportions sont exprimées dans le repère local du panneau,
  // dont les deux axes sont mis à l'échelle différemment.
  const logo = projectLogo(b.project)
  portalLogo.material.map = logo.material.map
  // Il s'efface au rythme du masque : le logo disparaît avec le média qu'il
  // accompagne, au lieu de flotter seul sur le blanc.
  portalLogo.material.opacity = 1 - ease.outExpo(portal.mask)
  portalLogo.visible = Boolean(logo.material.map) && portalLogo.material.opacity > 0.01
  const localW = LOGO_WIDTH
  const localH = (localW * b.w) / (logo.aspect * b.h)
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
  color: 0x39445c,
  roughness: 0.5,
  metalness: 0.1,
  // Un fond d'émission garantit qu'il reste lisible même si le soleil est
  // rasant ou dans son dos : c'est une interface, pas un objet de la scène.
  emissive: 0x263149,
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
const SCREEN_BLUE = '#2970f4' // bleu de l'agence : fond de l'icône et du label
const SCREEN_CORAL = '#f26749'
const PHONE_MESSAGE = ['Appuie sur entrée', 'pour contacter', "l'agence"]

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

  // Bandeau d'appel à l'action : sa hauteur découle de son contenu, et
  // l'icône se cale au-dessus. Sans ce calcul, la dernière ligne de texte
  // débordait du bloc bleu.
  const KEY = 46
  const LINE = 26
  const PAD = 16
  const bandH = PAD + KEY + 18 + PHONE_MESSAGE.length * LINE + PAD
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

  ctx.fillStyle = SCREEN_BLUE
  roundedRect(ctx, 20, bandY, width - 40, bandH, 20)
  ctx.fill()

  // Touche Entrée : pastille corail portant la flèche de retour à la ligne
  const key = KEY
  const keyX = (width - key) / 2
  const keyY = bandY + PAD
  ctx.fillStyle = SCREEN_CORAL
  roundedRect(ctx, keyX, keyY, key, key, 12)
  ctx.fill()

  ctx.strokeStyle = SCREEN_BG
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(keyX + 34, keyY + 14) // barre haute
  ctx.lineTo(keyX + 34, keyY + 27)
  ctx.lineTo(keyX + 14, keyY + 27) // retour vers la gauche
  ctx.moveTo(keyX + 21, keyY + 20) // pointe de la flèche
  ctx.lineTo(keyX + 13, keyY + 27)
  ctx.lineTo(keyX + 21, keyY + 34)
  ctx.stroke()

  ctx.fillStyle = SCREEN_BG
  ctx.font = "700 21px Poppins, ui-sans-serif, system-ui, sans-serif"
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const textTop = keyY + key + 18 + LINE / 2
  PHONE_MESSAGE.forEach((line, i) => {
    ctx.fillText(line, width / 2, textTop + i * LINE)
  })

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
  gradient.addColorStop(0, 'rgba(41, 112, 244, 0.55)')
  gradient.addColorStop(0.55, 'rgba(41, 112, 244, 0.22)')
  gradient.addColorStop(1, 'rgba(41, 112, 244, 0)')
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
  new THREE.MeshBasicMaterial({ map: phoneScreenTexture, depthTest: false, toneMapped: false })
)
phoneScreen.renderOrder = 22

// Rétro-éclairage : un plan blanc légèrement plus grand, posé juste derrière
// la dalle. Il déborde en un liseré lumineux, comme la lumière qui fuit sur
// les bords d'un écran LCD éclairé par l'arrière.
const phoneBacklight = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, toneMapped: false })
)
phoneBacklight.renderOrder = 21
phoneGroup.add(phoneHalo)
phoneGroup.add(phoneBacklight)
phoneGroup.add(phoneScreen)
phoneGroup.add(phoneLight)

// Touches : le modèle porte un matériau nommé "keypad" sur les douze touches,
// ce qui permet de les rétro-éclairer sans les identifier une à une.
const keypadMaterial = new THREE.MeshStandardMaterial({
  color: 0xbfe4ff,
  emissive: 0x2f8ff5,
  emissiveIntensity: 1.6,
  roughness: 0.4,
  depthTest: false,
})

new OBJLoader().load(asset('models/nokia-3310.obj'), (object) => {
  object.traverse((o) => {
    if (!o.isMesh) return
    o.material = o.material?.name === 'keypad' ? keypadMaterial : phoneMaterial
    o.renderOrder = 21
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
  phoneHalo.position.set(0, 0, -0.02) // derrière la coque
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
const phoneHintLabel = phoneHint.querySelector('span')

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Tab') return
  event.preventDefault() // sinon le focus part dans le GUI
  // « Masquer » le remet en fond perdu, « afficher » le fait remonter :
  // l'appareil reste toujours à l'écran, c'est sa mise en avant qui bascule.
  phonePinned = !phonePinned
  phoneHintLabel.textContent = phonePinned ? 'masquer le téléphone' : 'afficher le téléphone'
})

// Adresse encodée : elle n'apparaît pas en clair dans le bundle, ce qui
// suffit à décourager les robots qui moissonnent les sources.
const CONTACT = 'bmV3Yml6QGxtd3IuZnI='

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

function contactAgency() {
  closeContact()
  openSplash() // on revient sur l'écran de pause, le jeu reprend d'un clic

  // Navigation directe plutôt qu'un clic sur un lien détaché du document :
  // celui-ci était ignoré par certains navigateurs, la page n'ayant jamais
  // vu l'élément. Déclenchée depuis un vrai clic, elle passe sans blocage.
  const subject = encodeURIComponent('Brand Theft Auto')
  window.location.href = `mailto:${atob(CONTACT)}?subject=${subject}`
}

document.querySelector('#confirm-ok').addEventListener('click', contactAgency)
document.querySelector('#confirm-cancel').addEventListener('click', closeContact)

// Le téléphone n'a de sens qu'en ville : dans l'espace blanc, on est déjà
// dans le projet qu'il sert à annoncer.
function updatePhone(delta) {
  const inCity = !whiteSpace && !portal && !falling && !gameOver && !paused
  phoneGroup.visible = inCity
  phoneHint.classList.toggle('is-visible', inCity)
  if (!inCity) return

  const focused = phoneHovered || phonePinned
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
const MAP_CONE_LENGTH = 26  // portée du cône de vue des poursuivants
const MAP_CONE_ANGLE = 0.6  // demi-angle du cône, en radians

const minimapCanvas = document.querySelector('#minimap')
const minimapCtx = minimapCanvas.getContext('2d')
const MAP_SIZE = minimapCanvas.width
const MAP_CENTER = MAP_SIZE / 2
const MAP_SCALE = MAP_CENTER / MAP_RANGE // unités monde -> pixels

let mapBillboards = []
let mapRefresh = 0

// Logo lmwr des marqueurs, aplati en blanc une fois pour toutes dans un
// canvas hors écran : le dessiner à chaque frame depuis le SVG coûterait un
// décodage complet, et la teinte d'origine ne ressortirait pas sur le corail.
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
mapLogoImage.src = asset('logo-lmwr.svg')

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

  // Panneaux franchissables : les objectifs du joueur, marqués au logo lmwr
  mapBillboards.forEach((p) => {
    toMap(p.x, p.z, _mapPoint)
    ctx.fillStyle = '#2970f4'
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
  const blink = Math.sin(clock.elapsedTime * 9) > 0
  policeCars.forEach((car) => {
    toMap(car.body.x, car.body.z, _mapPoint)
    const x = _mapPoint.x
    const y = _mapPoint.y

    // Le cap du poursuivant, ramené dans le repère tourné de la carte
    const heading = car.heading - carHeading
    const start = -Math.PI / 2 + heading - MAP_CONE_ANGLE
    const end = -Math.PI / 2 + heading + MAP_CONE_ANGLE

    ctx.fillStyle = blink ? 'rgba(41, 112, 244, 0.38)' : 'rgba(242, 103, 73, 0.38)'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.arc(x, y, MAP_CONE_LENGTH * MAP_SCALE, start, end)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = blink ? '#2970f4' : '#f26749'
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
  ctx.font = '700 17px Poppins, ui-sans-serif, system-ui, sans-serif'
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
  // Étoile de la charte lmwr (la même que le réticule), reprise via <use>
  let markup = ''
  for (let i = 0; i < MAX_WANTED; i += 1) {
    const state = i < wanted ? ' is-on' : ''
    markup += `<svg class="wanted-star${state}" viewBox="0 0 462 500" aria-hidden="true"><use href="#star-shape" /></svg>`
  }
  wantedElement.innerHTML = markup
}

const gameOverElement = document.querySelector('#gameover')
const fadeElement = document.querySelector('#fade')
document.querySelector('#gameover button').addEventListener('click', () => restart())

// Le niveau de dégâts remplace la jauge : il se lit directement sur la voiture
function updateDamageStage() {
  setDamageStage(Math.min(DAMAGE_STAGES.length, Math.floor(hits / HITS_PER_STAGE)) - 1)
}

const fpsElement = document.querySelector('#fps')
let fpsFrames = 0
let fpsElapsed = 0

function updateFps(delta) {
  fpsFrames++
  fpsElapsed += delta
  if (fpsElapsed < 0.5) return
  fpsElement.textContent = `${Math.round(fpsFrames / fpsElapsed)} fps`
  fpsFrames = 0
  fpsElapsed = 0
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
  requestAnimationFrame(() => splashElement.classList.remove('is-hidden'))
  splashButton.textContent = 'Retour au jeu'
}

function closeSplash() {
  paused = false
  splashElement.classList.add('is-hidden')
  startPanelVideos()

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

splashButton.addEventListener('click', closeSplash)

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape') return
  // La confirmation passe avant : Échap l'annule au lieu de basculer l'accueil
  if (confirmOpen) closeContact()
  else if (paused) closeSplash()
  else openSplash()
})

/* ---------- Boucle ---------- */
const clock = new THREE.Clock()
body.copy(carPosition)
prevBody.copy(body)
updateWantedHud()
updateDamageStage() // une partie reprise garde ses dégâts
applyCameraOrientation()
updateSun()
follow()
updateChunks()

function tick() {
  requestAnimationFrame(tick)
  const delta = Math.min(clock.getDelta(), 0.1)
  updateFps(delta)
  drawMinimap(delta)
  updatePhone(delta)
  updatePoliceVisuals(clock.elapsedTime, renderAlpha)
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
  renderer.render(scene, camera)
}
tick()
