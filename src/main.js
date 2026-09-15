import * as THREE from 'three'
import Hls from 'hls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
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
  cameraHeight: 2.6,      // hauteur du point visé, au-dessus du toit de la voiture
  cameraDistance: 9,      // recul de la caméra derrière la voiture
  carScale: 0.7,          // échelle du véhicule
  cameraPitch: -21,       // inclinaison en degrés : négatif = regard vers le bas
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

// Regard au clavier : les flèches orientent la caméra. Pas de pointer lock,
// donc le curseur reste disponible pour le GUI et le bouton de fermeture.
const YAW_RATE = 1.9                 // rad/s
const PITCH_RATE = 70                // degrés/s
const MAX_PITCH = 80                 // pour ne pas basculer par-dessus la verticale
const LOOK_SMOOTH = 6                // inertie de la caméra au départ et à l'arrêt

// Les flèches ne pilotent pas l'angle directement mais une vitesse de
// rotation, elle-même lissée : la caméra démarre et s'arrête en douceur au
// lieu de claquer d'un cran à chaque appui.
let yawVelocity = 0
let pitchVelocity = 0

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

function updateLook(delta) {
  if (portal) return // recadrage automatique pendant la transition

  const turn = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)
  const tilt = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0)
  if (turn || tilt) framingBlend = null // toute entrée reprend la main

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
const ROAD = 5                        // largeur de rue
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

// Trois raisons de devoir relancer la lecture : l'autoplay muet est refusé par
// certains navigateurs, un onglet en arrière-plan diffère le chargement des
// médias, et revenir sur l'onglet laisse les vidéos en pause.
function startPanelVideos() {
  PROJECTS.forEach((project) => {
    const video = project.element
    if (!video) return
    if (video.readyState === 0) video.load()
    video.play().catch(() => {})
  })
}
addEventListener('pointerdown', startPanelVideos)
addEventListener('keydown', startPanelVideos)
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') startPanelVideos()
})

// Panneau "actif" : une copie autonome du panneau en cours de franchissement,
// que l'on peut agrandir librement — les autres vivent dans un InstancedMesh
// et ne sont pas animables individuellement.

/* ---------- Courbes d'animation ---------- */
// Trois profils, un par mouvement : l'ensemble doit démarrer sec et finir posé.
const ease = {
  // Longue retenue, puis accélération brutale, puis freinage : le panneau
  // semble aspiré vers l'écran.
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  // Départ instantané puis approche asymptotique : le masque claque.
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
}

/* ---------- Ouverture du portail : masque polygonal ---------- */
// Séquence inspirée du storyboard fourni : un éclat blanc naît au centre du
// panneau et grandit en polygone irrégulier jusqu'à tout recouvrir. Noir =
// média du panneau, blanc = espace vide. Les images clés partagent le même
// nombre de sommets, ce qui permet de les interpoler deux à deux.
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
    varying vec2 vUv;

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
      // Le recadrage "cover" vit dans repeat/offset de la texture : il faut le
      // refaire à la main, un ShaderMaterial n'applique pas ces transformations.
      vec4 media = uHasMap > 0.5
        ? texture2D(uMap, vUv * uRepeat + uOffset)
        : vec4(1.0);
      gl_FragColor = vec4(media.rgb, 1.0);
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

// Les tranches du caisson s'effacent elles aussi : elles sont déjà blanches,
// il suffit de les remplacer par un blanc pur non éclairé en fin de séquence.
const portalEdgeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
const portalMaterials = [
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalEdgeMaterial,
  portalFrontMaterial,
  portalEdgeMaterial,
]

const portalMesh = new THREE.Mesh(billboardGeometry, portalMaterials)
portalMesh.visible = false
portalMesh.frustumCulled = false
scene.add(portalMesh)

// Débord lumineux du panneau sur son environnement immédiat. Une seule
// lumière, portée par le panneau actif : la diffusion de tous les panneaux
// coûterait bien trop cher.
const portalLight = new THREE.PointLight(0xffffff, 0, 30, 2)
portalLight.visible = false
scene.add(portalLight)

const PORTAL_DURATION = 1.6 // secondes d'animation automatique, une fois amorcé
const PORTAL_STRAIGHTEN = 7 // vitesse de redressement de la voiture face au panneau
const MASK_DURATION = 1.1   // secondes d'ouverture du masque
const MASK_TRIGGER = 0.8    // part de l'agrandissement atteinte avant de l'amorcer
const PORTAL_COVER = 1.25   // marge de recouvrement du viewport
const PORTAL_DROP_DEPTH = 2.5 // la ville descend largement sous le champ de vision
const PORTAL_CAM_BLEND = 6  // vitesse de recadrage de la caméra face au panneau
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

// Le panneau repris par portalMesh doit disparaître de son InstancedMesh,
// sinon on en voit deux au même endroit.
function setPanelInstanceVisible(key, visible) {
  const entry = panelLookup.get(key)
  if (!entry) return
  entry.mesh.setMatrixAt(entry.index, visible ? entry.matrix : ZERO_MATRIX)
  entry.mesh.instanceMatrix.needsUpdate = true
}
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
            // Projet affiché. Les coordonnées sont décalées avant hachage :
            // sur les mêmes coordonnées, le tirage resterait corrélé à celui
            // qui vient de décider la présence du panneau, et deux ou trois
            // projets rafleraient la moitié de la ville. Ainsi décalé, le
            // tirage répartit les 15 projets à parts égales (±7 % mesuré) tout
            // en restant stable : un panneau montre toujours le même projet.
            project: Math.floor(hash(blockX * 3 + 1, blockZ * 7 + 5, 121 + salt) * PROJECTS.length),
            w: bw,
            h: bh,
            thick,
            x: x + nx * out,
            z: z + nz * out,
            // Au sol : posé sur le trottoir. En hauteur : ancré sous le toit.
            y: atGround ? bh / 2 + 0.05 : height - bh / 2 - Math.min(1.5, height * 0.08),
            ground: atGround,
            // Zone de déclenchement, plaquée DEVANT le panneau : le portail
            // s'amorce juste avant le contact, la voiture ne le touche jamais.
            nx,
            nz,
            tx: x + nx * (out + PORTAL_DEPTH / 2),
            tz: z + nz * (out + PORTAL_DEPTH / 2),
            thx: alongX ? bw / 2 : PORTAL_DEPTH / 2,
            thz: alongX ? PORTAL_DEPTH / 2 : bw / 2,
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
    _matrix.compose(
      _position.set(originX + offset, 0.01, originZ + CHUNK / 2),
      FLAT_Z,
      ONE
    )
    roads.setMatrixAt(r++, _matrix)
    _matrix.compose(
      _position.set(originX + CHUNK / 2, 0.01, originZ + offset),
      FLAT_X,
      ONE
    )
    roads.setMatrixAt(r++, _matrix)
  }
  group.add(roads)

  return group
}

// Index des panneaux instanciés : permet de masquer celui qui est repris par
// portalMesh pendant la transition, pour qu'on n'en voie pas deux.
const panelLookup = new Map()
const panelKey = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`

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
const carGroup = new THREE.Group()
// La voiture est hors du groupe "world" : pendant la transition de portail,
// la ville descend mais le véhicule reste en place à l'écran.
scene.add(carGroup)

let carHeading = 0     // cap de la voiture (axe d'avancement)
let prevHeading = 0    // état précédent, pour l'interpolation du rendu

// Le rayon de collision suit l'échelle du véhicule
const carRadius = () => 1.2 * settings.carScale

new GLTFLoader().load(asset('models/car_1.glb'), (gltf) => {
  const model = gltf.scene
  model.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
  })

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  // Le plus grand côté horizontal est la longueur du véhicule
  const scale = CAR_LENGTH / Math.max(size.x, size.z)
  model.scale.setScalar(scale)

  // Recentre à plat sur le sol, roues posées
  const center = box.getCenter(new THREE.Vector3())
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)

  // Le modèle est orienté selon son axe long ; on l'aligne sur +Z, l'axe
  // d'avancement utilisé par le contrôleur
  if (size.x > size.z) model.rotation.y = Math.PI / 2

  carGroup.add(model)
  applyCarScale()
})

// carScale s'applique au groupe : le modèle garde sa normalisation interne
function applyCarScale() {
  carGroup.scale.setScalar(settings.carScale)
}



/* ---------- Dégâts : fumée puis flammes sur le capot ---------- */
// Un sprite animé par palier. Les planches sont des bandes de vignettes :
// on ne déplace que les UV, il n'y a donc qu'un seul quad et qu'une texture
// en mémoire par palier.
// Les planches ont été recomposées en cellules strictement uniformes
// (voir tools/atlas.py) : toutes les vignettes tiennent sur une seule ligne,
// recadrées et calées en bas, donc l'animation ne saute plus.
const DAMAGE_STAGES = [
  { file: 'sprites/smoke_1.png', frames: 12, fps: 12, scale: 2.2, ratio: 167 / 172 },
  { file: 'sprites/smoke_2.png', frames: 12, fps: 12, scale: 2.8, ratio: 169 / 179 },
  { file: 'sprites/smoke_3.png', frames: 12, fps: 12, scale: 3.4, ratio: 170 / 210 },
  { file: 'sprites/flamme_sprite.png', frames: 20, fps: 14, scale: 3.2, ratio: 218 / 337 },
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
    // texels et donnait cette impression de glissement entre les images.
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    // Une seule vignette visible à la fois
    texture.repeat.set(1 / preset.frames, 1)
    // Sans ce bridage, le filtrage linéaire va chercher des texels de la
    // vignette voisine sur les bords et laisse un liseré fantôme.
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
const POLICE_SPACING = [10, 8, 6, 4, 3] // en blocs, selon le niveau de recherche
const POLICE_VIEW = 170      // rayon de présence autour du joueur
const POLICE_FORGET = 260    // au-delà, la voiture est retirée
const POLICE_SPEED = 20
const POLICE_ACCEL = 13
const POLICE_TURN = 1.9      // vitesse de braquage, rad/s
const policeRadius = () => carRadius() // même gabarit que la voiture du joueur
const CAR_IMPACT = 1.9       // distance de contact entre deux voitures
const CAR_RESTITUTION = 1.6  // rebond entre véhicules : franchement nerveux
const POLICE_RETREAT = 0.9   // secondes de marche arrière après un choc
const MAX_WANTED = 5

let wanted = 1
const policeCars = []
let policeTemplate = null

new GLTFLoader().load(asset('models/car_2.glb'), (gltf) => {
  const model = gltf.scene
  model.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
  })

  // Même normalisation que la voiture du joueur : longueur cible, roues au sol
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const scale = CAR_LENGTH / Math.max(size.x, size.z)
  model.scale.setScalar(scale)
  const center = box.getCenter(new THREE.Vector3())
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
  if (size.x > size.z) model.rotation.y = Math.PI / 2

  policeTemplate = model
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

  const step = policeSpawnStep()
  const here = new Set(policeCars.map((c) => c.key))
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

      const key = policeKey(bx, bz)
      if (here.has(key)) continue
      spawnPolice(key, x, z)
    }
  }
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
    velocity: new THREE.Vector3(),
    heading: Math.atan2(body.x - x, body.z - z),
    speed: 0,
    retreat: 0, // secondes de recul restantes après un choc
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
const MAX_HITS = 8      // impacts encaissés avant la capture
const HITS_PER_STAGE = 2 // un palier de dégâts tous les deux impacts
const HIT_COOLDOWN = 0.6 // secondes avant qu'un nouveau choc soit compté
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

  for (let i = policeCars.length - 1; i >= 0; i--) {
    const car = policeCars[i]
    const dx = body.x - car.body.x
    const dz = body.z - car.body.z
    const distance = Math.hypot(dx, dz)

    if (distance > POLICE_FORGET) {
      removePolice(car)
      continue
    }

    // Interception : on vise là où le joueur SERA, pas où il est. Une voiture
    // sur deux joue le bloqueur et anticipe bien plus loin, pour se placer en
    // travers de la route plutôt que de coller au pare-chocs.
    const blocker = car.role === 1
    const lead = Math.min(3.2, distance / POLICE_SPEED) * (blocker ? 2.6 : 0.8)
    const aimX = body.x + velocity.x * lead
    const aimZ = body.z + velocity.z * lead
    const target = Math.atan2(aimX - car.body.x, aimZ - car.body.z)
    let diff = ((target - car.heading + Math.PI) % (Math.PI * 2)) - Math.PI
    if (diff < -Math.PI) diff += Math.PI * 2
    car.heading += THREE.MathUtils.clamp(diff, -POLICE_TURN * dt, POLICE_TURN * dt)

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
    const blocking = blocker && ahead && distance < 22
    const wantedSpeed =
      distance < 4 ? POLICE_SPEED * 0.3 : blocking ? POLICE_SPEED * 0.35 : POLICE_SPEED
    car.speed += (wantedSpeed - car.speed) * (1 - Math.exp(-POLICE_ACCEL * dt))
    car.velocity.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed)

    policeMove(car, dt)
    collideWithPlayer(car)
  }
}

// Rendu : position, cap et gyrophare
function updatePoliceVisuals(time) {
  const blue = Math.sin(time * 9) > 0
  policeCars.forEach((car) => {
    car.group.position.set(car.body.x, CAR_GROUND, car.body.z)
    car.group.scale.setScalar(settings.carScale)
    car.group.rotation.y = car.heading
    const beacon = car.group.children[1]
    if (beacon) beacon.material.emissive.setHex(blue ? 0x2970f4 : 0xf26749)
  })
}

/* ---------- Contrôleur de déplacement : Z Q S D ---------- */
// Approche classique de character controller : une position autoritaire qui
// n'est JAMAIS en pénétration, déplacée à pas de temps fixe par une vélocité
// résolue en "collide and slide". Le lissage se fait par-dessus, au rendu.
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
  get handbrake() {
    return keys.has('Space')
  },
  get left() {
    return keys.has('KeyA') || keys.has('KeyQ')
  },
  get right() {
    return keys.has('KeyD')
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
        const r = radius
        const hw = b.w / 2 + r
        const hd = b.d / 2 + r
        const h = raycastBox(px, pz, dx, dz, b.x - hw, b.x + hw, b.z - hd, b.z + hd)
        if (!h || (best !== null && h.t >= best.t)) return
        best = { t: h.t, nx: h.nx, nz: h.nz }
      })
    }
  }
  return best
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

    // Choc en biais : le produit vectoriel cap × normale donne le sens dans
    // lequel la voiture part en embardée. Nul sur un impact frontal parfait,
    // maximal quand on frotte un mur de flanc.
    if (bounce) {
      const cross = Math.sin(carHeading) * hit.nz - Math.cos(carHeading) * hit.nx
      spin = THREE.MathUtils.clamp(spin + cross * -vInto * SPIN_GAIN, -MAX_SPIN, MAX_SPIN)
    }
  }
}

// Arrivée dans l'espace blanc : le panneau a fini de s'ouvrir, il n'a plus
// rien à masquer. La ville est simplement mise de côté — elle n'est ni
// détruite ni régénérée, le respawn la retrouve telle quelle.
function enterWhiteSpace() {
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

  // La position aussi doit être continue : la caméra de transition est bien
  // plus haute et plus loin que la caméra de poursuite. On mesure l'écart et
  // on le laisse se résorber, au lieu de basculer d'une pose à l'autre.
  // placeCamera() ne calcule la pose de poursuite qu'une fois `portal` libéré.
  portal = null
  currentPortal = null

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
  placeDoor()
  mediaGroup.visible = true
  mediaFade = 0
  history.pushState({ slug: project.slug }, '', `/${project.slug}`)

  // La voiture repart de zéro, dans l'axe où elle a franchi le panneau
  velocity.set(0, 0, 0)
  _lateral.set(0, 0, 0)
  speed = 0
  spin = 0
  steerInput = 0
  accumulator = 0

  applyCameraOrientation()
  closeButton.classList.add('is-visible')
  showNotice('White space')
}

function exitWhiteSpace() {
  whiteSpace = false
  wanted = Math.min(MAX_WANTED, wanted + 1)
  updateWantedHud()
  mediaGroup.visible = false
  titleMesh.visible = false
  titleGround.visible = false
  ctaMesh.visible = false
  doorMesh.visible = false
  canvas.style.cursor = ''
  clearProjectPlanes()
  if (location.pathname !== '/') history.pushState({}, '', '/')
  sunLight.color.set(settings.sunColor)
  hemiLight.color.copy(SKY)
  hemiLight.groundColor.copy(GROUND)
  world.visible = true
  sky.visible = true
  scene.fog = cityFog
  scene.background = null
  whiteGround.visible = false
}

// Respawn : la voiture est lâchée d'une certaine hauteur et retombe.
// Le pilotage est rendu à l'atterrissage.
const CAR_GROUND = 0.02 // la voiture roule sur la chaussée, pas sur le trottoir
const RESPAWN_HEIGHT = 40
const GRAVITY = 55
const LAND_RESTITUTION = 0.45 // rebond sur le bitume
const STUCK_DELAY = 1.1       // secondes bloqué avant le saut de dégagement
const STUCK_SPEED = 1.5       // en dessous, on considère la voiture immobile
const HOP_SPEED = 15          // impulsion verticale du saut
const HOP_PUSH = 11           // poussée horizontale qui accompagne le saut
const LAND_STOP = 4           // en dessous, la voiture se pose pour de bon
let fallHeight = 0
let fallSpeed = 0
let airborne = false
let stuckTime = 0

function respawn() {
  if (whiteSpace) exitWhiteSpace()
  if (portal) {
    setPanelInstanceVisible(portal.key, true)
    portal = null
  }
  currentPortal = null
  closeButton.classList.remove('is-visible')
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
  carHeading = Math.round(Math.random() * 3) * (Math.PI / 2)
  prevHeading = carHeading

  framingBlend = null
  cameraOffset.set(0, 0, 0)
  stuckTime = 0
  fallHeight = RESPAWN_HEIGHT
  fallSpeed = 0
  airborne = true
  accumulator = 0

  updateChunks()
  clearPolice()
  refreshPoliceFleet()
  applyCameraOrientation()
  showNotice('Respawn')
}

// Coincé entre deux obstacles : le joueur appuie mais n'avance plus. Plutôt
// que de le téléporter, la voiture fait un bond et survole ce qui la bloque —
// en l'air, les collisions sont ignorées.
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
     pas sur elle-même — et inversé en marche arrière, comme un vrai volant. */
  // Le volant ne saute pas d'un bord à l'autre : il rejoint progressivement
  // la position demandée, et revient au centre quand on relâche.
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

  /* Recomposition */
  velocity.x = sin * speed + _lateral.x
  velocity.z = cos * speed + _lateral.z

  moveAndSlide(FIXED_DT)
  checkStuck()
  if (hitCooldown > 0) hitCooldown -= FIXED_DT
  stepPolice(FIXED_DT)
  checkPortals(body.x, body.z)
}

// Une fois amorcée, la séquence se joue seule : ni les touches ni la souris
// n'ont plus de prise. Échap est la seule sortie (respawn).
function stepPortal(delta) {
  if (portal.progress < 1) {
    portal.progress = Math.min(1, portal.progress + delta / PORTAL_DURATION)
  }

  // Le masque s'amorce avant la fin de l'agrandissement : les deux se
  // recouvrent, la séquence s'enchaîne sans temps mort.
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

// Boucle à pas fixe + interpolation du rendu : la réponse aux collisions ne
// dépend plus du framerate, et l'affichage reste fluide entre deux pas.
let accumulator = 0
function updateMovement(delta) {
  if (gameOver) return
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

const gui = new GUI({ title: 'Brand Theft Auto' })

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

const mediaGroup = new THREE.Group()
mediaGroup.visible = false
scene.add(mediaGroup)

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

// Dispersion déterministe : même projet, même constellation de plans.
function spawnProjectPlanes(project) {
  clearProjectPlanes()
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

    // Répartition en spirale devant la voiture, à des hauteurs variées
    const angle = i * 2.399963 // angle d'or : évite les alignements
    const radius = 14 + i * 3.1
    // Le bas du plan affleure le sol, comme les roues de la voiture
    mesh.position.set(
      carPosition.x + Math.cos(angle) * radius,
      CAR_GROUND + MEDIA_HEIGHT / 2,
      carPosition.z + Math.sin(angle) * radius
    )
    // Chaque plan fait face au centre de la constellation
    mesh.lookAt(carPosition.x, mesh.position.y, carPosition.z)
    mesh.scale.set(MEDIA_HEIGHT * 1.6, MEDIA_HEIGHT, 1)
    // Hauteur de repos et déphasage : sans phase propre, tous les plans
    // monteraient et descendraient à l'unisson.
    mesh.userData.baseY = mesh.position.y
    mesh.userData.phase = i * 1.7
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
  // La vidéo d'en-tête (index 0) est la pièce maîtresse, les suivantes sont
  // réparties autour d'elle, un peu plus loin.
  const height = MEDIA_HEIGHT * (index ? 1.3 : 1.8)
  const angle = -0.9 + index * 1.15
  const radius = index ? 20 + index * 6 : 17
  mesh.position.set(
    carPosition.x + Math.sin(angle) * radius,
    CAR_GROUND + height / 2,
    carPosition.z + Math.cos(angle) * radius
  )
  mesh.lookAt(carPosition.x, mesh.position.y, carPosition.z)
  // Les dimensions réelles ne sont connues qu'une fois les métadonnées lues :
  // on pose un 16:9 par défaut, puis on recale dès qu'elles arrivent.
  const applyRatio = () => {
    const ratio = video.videoWidth / video.videoHeight || 16 / 9
    mesh.scale.set(height * ratio, height, 1)
  }
  applyRatio()
  if (!video.videoWidth) video.addEventListener('loadedmetadata', applyRatio, { once: true })
  mesh.userData.baseY = mesh.position.y
  mesh.userData.phase = index * 2.1
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

  // Flottement : une oscillation lente, déphasée d'un plan à l'autre
  const t = mediaUniforms.uTime.value * planeShader.floatSpeed
  mediaGroup.children.forEach((mesh) => {
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
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
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

    void main() {
      // Position du fragment en coordonnées normalisées de l'écran
      vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;

      // Ramenée dans le rectangle occupé par le titre
      vec2 uv = (ndc - uCenter) / uSize + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

      vec4 texel = texture2D(uMap, uv);
      if (texel.a < 0.01) discard;
      gl_FragColor = texel;
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

function updateProjectTitle() {
  if (!titleMesh.visible) return

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


/* ---------- Porte de retour ---------- */
// Rectangle flottant posé derrière la voiture : le traverser, ou le viser et
// valider, ramène en ville. Son ouverture est évidée et laisse voir la ville
// en direct, rendue dans une texture hors écran.
const DOOR_LABEL = 'Retour en ville'
const DOOR_WIDTH = 9
const DOOR_HEIGHT = 5.6
const DOOR_DISTANCE = 34 // derrière la voiture : il faut faire demi-tour

// Résolution volontairement basse : l'image est vue au travers d'une petite
// ouverture, la différence ne se voit pas et la passe coûte deux fois moins.
const CITY_VIEW_WIDTH = 480
const CITY_VIEW_HEIGHT = 300
const CITY_VIEW_EVERY = 2 // une frame sur deux suffit pour une vue quasi fixe

const cityTarget = new THREE.WebGLRenderTarget(CITY_VIEW_WIDTH, CITY_VIEW_HEIGHT)
const windowCamera = new THREE.PerspectiveCamera(55, CITY_VIEW_WIDTH / CITY_VIEW_HEIGHT, 0.1, 1200)
windowCamera.rotation.order = 'YXZ'
const cityView = { x: 0, z: 0, heading: 0 }
let cityViewFrame = 0

function makeDoorTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 900
  canvas.height = 560
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#244697'
  ctx.beginPath()
  ctx.roundRect(0, 0, canvas.width, canvas.height, 40)
  ctx.fill()

  // Ouverture centrale réellement évidée : c'est par là qu'on voit la ville,
  // rendue sur un plan placé juste derrière le cadre.
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.roundRect(70, 70, canvas.width - 140, canvas.height - 190, 24)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'

  ctx.fillStyle = '#ffffff'
  ctx.font = '700 52px Poppins, ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`← ${DOOR_LABEL}`, canvas.width / 2, canvas.height - 62)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}

const doorWindow = new THREE.Mesh(
  new THREE.PlaneGeometry(DOOR_WIDTH * 0.845, DOOR_HEIGHT * 0.536),
  // DoubleSide : la porte se regarde aussi de dos, la ville doit s'y voir
  new THREE.MeshBasicMaterial({
    map: cityTarget.texture,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
)
doorWindow.position.set(0, DOOR_HEIGHT * 0.107, -0.02) // derrière le cadre

const doorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(DOOR_WIDTH, DOOR_HEIGHT),
  new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, side: THREE.DoubleSide })
)
doorMesh.visible = false
doorMesh.add(doorWindow)
scene.add(doorMesh)

// Rend la ville dans la texture de la fenêtre. Tout le décor de l'espace
// blanc est masqué le temps de la passe, puis rétabli : une seule scène sert
// aux deux mondes, il n'y en a pas de seconde à maintenir.
function renderCityWindow() {
  if (!doorMesh.visible) return
  if (cityViewFrame++ % CITY_VIEW_EVERY !== 0) return

  const hidden = [whiteGround, mediaGroup, titleMesh, titleGround, ctaMesh, doorMesh, carGroup]
  hidden.forEach((o) => (o.visible = false))
  world.visible = true
  sky.visible = true
  scene.fog = cityFog
  scene.background = null

  // Vue de rue : on se place là où la voiture a franchi le panneau, tourné
  // vers l'avenue plutôt que vers la façade.
  windowCamera.position.set(
    cityView.x - Math.sin(cityView.heading) * 6,
    2.6,
    cityView.z - Math.cos(cityView.heading) * 6
  )
  windowCamera.rotation.set(
    THREE.MathUtils.degToRad(-4),
    cityView.heading + Math.PI + Math.sin(mediaUniforms.uTime.value * 0.25) * 0.12,
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
  // Les poursuivants ne franchissent pas les panneaux : on les dissout ici,
  // ils seront re-semés au retour, avec un niveau de recherche de plus.
  clearPolice()
}

function placeDoor() {
  if (!doorMesh.material.map) {
    const paint = () => (doorMesh.material.map = makeDoorTexture())
    paint()
    document.fonts?.load('700 52px Poppins').then(() => {
      doorMesh.material.map?.dispose()
      paint()
      doorMesh.material.needsUpdate = true
    })
  }

  // Dans le dos de la voiture, donc jamais franchie par accident à l'arrivée
  const x = carPosition.x - Math.sin(carHeading) * DOOR_DISTANCE
  const z = carPosition.z - Math.cos(carHeading) * DOOR_DISTANCE
  doorMesh.position.set(x, CAR_GROUND + DOOR_HEIGHT / 2, z)
  doorMesh.lookAt(carPosition.x, doorMesh.position.y, carPosition.z)
  doorMesh.userData.baseY = doorMesh.position.y
  doorMesh.visible = true
}

function updateDoor() {
  if (!doorMesh.visible) return

  // Flottement, comme les plans
  doorMesh.position.y =
    doorMesh.userData.baseY +
    Math.sin(mediaUniforms.uTime.value * planeShader.floatSpeed * 0.9) *
      planeShader.floatAmplitude

  const dx = carPosition.x - doorMesh.position.x
  const dz = carPosition.z - doorMesh.position.z
  if (dx * dx + dz * dz > (DOOR_WIDTH / 2) * (DOOR_WIDTH / 2)) return

  showNotice('Retour en ville')
  respawn()
}


/* ---------- Flèche de cap ---------- */
// Volume 3D placé devant la caméra, à la position du réticule, qui pointe le
// panneau visé dans le repère du monde : sa direction est donc juste en
// profondeur aussi, pas seulement à l'écran.
const ARROW_DISTANCE = 7 // devant la caméra : la taille apparente reste stable

function makeArrowShape() {
  const shape = new THREE.Shape()
  shape.moveTo(0, 1)
  shape.lineTo(0.72, -0.62)
  shape.lineTo(0, -0.2)
  shape.lineTo(-0.72, -0.62)
  shape.closePath()
  return shape
}

const arrowGeometry = new THREE.ExtrudeGeometry(makeArrowShape(), {
  depth: 0.34,
  bevelEnabled: true,
  bevelThickness: 0.05,
  bevelSize: 0.05,
  bevelSegments: 2,
})
// La pointe passe sur +Z : pour un objet ordinaire (contrairement à une
// caméra), c'est cet axe que lookAt() oriente vers la cible.
arrowGeometry.rotateX(Math.PI / 2)
arrowGeometry.center()

const arrowMesh = new THREE.Mesh(
  arrowGeometry,
  new THREE.MeshStandardMaterial({
    color: 0x2970f4,
    emissive: 0x2970f4,
    emissiveIntensity: 0.35,
    roughness: 0.35,
    metalness: 0.1,
    depthTest: false, // toujours lisible, même un panneau devant elle
  })
)
arrowMesh.visible = false
arrowMesh.renderOrder = 10
arrowMesh.scale.setScalar(0.2)
scene.add(arrowMesh)

const ARROW_DROP = 1.05 // décalage sous le réticule, en unités monde
const _arrowDir = new THREE.Vector3()
const _arrowUp = new THREE.Vector3()

function updateArrow(point) {
  if (!point) {
    arrowMesh.visible = false
    return
  }

  camera.getWorldDirection(_arrowDir)
  arrowMesh.position.copy(camera.position).addScaledVector(_arrowDir, ARROW_DISTANCE)

  // Descendue sous le réticule : elle ne pointe donc jamais pile dans l'axe
  // du regard, et son volume reste lisible même en visant le panneau de face.
  _arrowUp.setFromMatrixColumn(camera.matrixWorld, 1) // axe Y de la caméra
  arrowMesh.position.addScaledVector(_arrowUp, -ARROW_DROP)

  // Pointée sur le panneau lui-même, en 3D : elle vise le point exact touché
  // par le rayon, hauteur comprise, et pas seulement une direction au sol.
  arrowMesh.lookAt(point)
  arrowMesh.visible = true
}

// Cibles pointables : au curseur, ou au réticule de visée avec Entrée.
// Un clic comme un appui sur Entrée sont de vrais gestes utilisateur, donc
// l'ouverture d'un nouvel onglet n'est jamais bloquée.
const ctaRaycaster = new THREE.Raycaster()
const _pointer = new THREE.Vector2()
const reticleElement = document.querySelector('#reticle')
const reticleLabel = document.querySelector('#reticle-label')

function interactiveTargets() {
  if (whiteSpace) {
    const targets = []
    if (ctaMesh.visible) targets.push(ctaMesh)
    if (doorMesh.visible) targets.push(doorMesh)
    return targets
  }

  // En ville, les cibles sont les panneaux : un InstancedMesh par chunk
  const panels = []
  for (const chunk of chunks.values()) {
    if (chunk.userData.panels) panels.push(...chunk.userData.panels)
  }
  return panels
}

function labelFor(target) {
  if (target === ctaMesh) return 'Voir le projet'
  if (target === doorMesh) return 'Retour en ville'
  return 'Jump into void'
}

function pickAt(ndcX, ndcY) {
  const targets = interactiveTargets()
  if (!targets.length) return null
  _pointer.set(ndcX, ndcY)
  ctaRaycaster.setFromCamera(_pointer, camera)
  return ctaRaycaster.intersectObjects(targets, false)[0] || null
}

function activate(target) {
  if (target === ctaMesh) window.open(ctaUrl, '_blank', 'noopener')
  else if (target === doorMesh) respawn()
}

// Cible sous le réticule, réévaluée à chaque frame
let aimed = null
function updateReticle() {
  // Toujours affiché : il sert aussi de repère de direction en ville, où il
  // n'y a simplement rien à pointer.
  const hit = pickAt(0, 0)
  aimed = hit?.object || null

  // En ville, viser un panneau affiche une flèche de cap à la place de
  // l'étoile : elle indique la direction à prendre depuis la VOITURE, ce que
  // le réticule seul ne dit pas puisqu'il suit la caméra.
  const isPanel = Boolean(aimed) && !whiteSpace
  updateArrow(isPanel ? hit.point : null)
  reticleElement.classList.toggle('is-hidden', isPanel)
  reticleElement.classList.toggle('is-active', Boolean(aimed) && !isPanel)
  reticleLabel.classList.toggle('is-active', Boolean(aimed))
  if (aimed) reticleLabel.textContent = labelFor(aimed)

}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return
  if (aimed) activate(aimed)
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
// Échap est déjà pris par le pointer lock : la sortie de transition passe par
// un bouton, qui a en plus l'avantage d'être visible.
const closeButton = document.querySelector('#portal-close')
closeButton.addEventListener('click', () => respawn())

// Le bouton Précédent du navigateur ramène en ville, comme la croix
window.addEventListener('popstate', () => {
  if (whiteSpace) respawn()
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
// face du panneau et le regarde de face. Les flèches sont ignorées (voir
// updateLook), sinon on lutterait contre ce recadrage.
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

/* ---------- Compteur de FPS ---------- */
// Moyenne glissante sur ~0,5 s : lisible, contrairement à l'instantané qui
// saute à chaque frame.
// Niveau de recherche : autant d'étoiles que de niveaux atteints
const wantedElement = document.querySelector('#wanted')
function updateWantedHud() {
  wantedElement.textContent = '★'.repeat(wanted) + '☆'.repeat(MAX_WANTED - wanted)
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

/* ---------- Boucle ---------- */
const clock = new THREE.Clock()
body.copy(carPosition)
prevBody.copy(body)
updateWantedHud()
applyCameraOrientation()
updateSun()
follow()
updateChunks()

function tick() {
  requestAnimationFrame(tick)
  const delta = Math.min(clock.getDelta(), 0.1)
  updateFps(delta)
  updatePoliceVisuals(clock.elapsedTime)
  updateLook(delta)
  updateFraming(delta)
  updateMovement(delta)
  updateMediaPlanes(delta)
  updateProjectTitle()
  updateDoor()
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
