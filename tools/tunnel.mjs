#!/usr/bin/env node
/**
 * Ouvre le jeu sur un tunnel public, pour le tester sur un vrai téléphone.
 *
 *   npm run tunnel
 *
 * Deux raisons de passer par un tunnel plutôt que par l'adresse locale :
 * le téléphone n'a pas besoin d'être sur le même réseau, et surtout l'URL est
 * en HTTPS. Plusieurs API du jeu — plein écran, verrouillage d'orientation —
 * se comportent différemment hors contexte sécurisé, et c'est précisément ce
 * qu'on vient vérifier sur mobile.
 *
 * Si un serveur de dev tourne déjà sur le port, on se contente de l'exposer.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'

// Vite prend 5173, puis le suivant libre si celui-ci est déjà pris. Plutôt
// que de figer un numéro qui sera faux une fois sur deux, on balaie la plage
// et on expose le serveur qu'on trouve. PORT force la main si besoin.
const PORT_RANGE = [5173, 5174, 5175, 5176, 5177]
const FORCED_PORT = process.env.PORT ? Number(process.env.PORT) : null
const children = []

function portBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    socket.on('connect', () => (socket.end(), resolve(true)))
    socket.on('error', () => resolve(false))
    socket.setTimeout(700, () => (socket.destroy(), resolve(false)))
  })
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

function run(command, args, label) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.on('error', (error) => {
    if (error.code === 'ENOENT') {
      console.error(`\n✗ ${command} est introuvable.`)
      if (command === 'cloudflared') console.error('  Installation : brew install cloudflared\n')
      process.exit(1)
    }
    console.error(`✗ ${label} : ${error.message}`)
  })
  return child
}

async function waitForPort(port, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await portBusy(port)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// Ctrl+C doit emporter les processus enfants : sans cela, cloudflared et vite
// survivent au script et le port reste occupé au lancement suivant.
function stop() {
  for (const child of children) child.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

async function findRunning() {
  for (const port of FORCED_PORT ? [FORCED_PORT] : PORT_RANGE) {
    if (await portBusy(port)) return port
  }
  return null
}

let PORT = await findRunning()

if (PORT) {
  console.log(`→ serveur déjà en écoute sur ${PORT}, on l'expose tel quel`)
} else {
  PORT = FORCED_PORT || PORT_RANGE[0]
  console.log(`→ aucun serveur trouvé, démarrage sur ${PORT}`)
  const vite = run('npx', ['vite', '--host', '--port', String(PORT), '--strictPort'], 'vite')
  vite.stdout.on('data', (d) => process.stdout.write(d))
  vite.stderr.on('data', (d) => process.stderr.write(d))
  if (!(await waitForPort(PORT))) {
    console.error(`✗ le serveur n'a pas démarré sur ${PORT}`)
    stop()
  }
}

console.log('→ ouverture du tunnel…\n')
const tunnel = run(
  'cloudflared',
  ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
  'cloudflared'
)

let announced = false
async function announce(url) {
  // L'adresse locale n'est annoncée que si le serveur y répond vraiment.
  // `npm run dev` n'écoute que sur localhost : afficher une IP de réseau
  // local dans ce cas, c'est envoyer le téléphone vers une page morte.
  const lan = lanAddress()
  const reachable = lan ? await portBusy(PORT, lan) : false

  console.log('\n' + '─'.repeat(58))
  console.log(`  Sur mobile   ${url}`)
  if (reachable) console.log(`  Même wifi    http://${lan}:${PORT}`)
  console.log('─'.repeat(58))
  if (lan && !reachable) {
    console.log('  (serveur en écoute sur localhost seulement :')
    console.log('   `npm run dev:host` pour l\'exposer aussi au réseau local)')
  }
  console.log('  Inspecteur : Safari › Développement › <ton iPhone>')
  console.log('  Ctrl+C pour tout arrêter\n')
}

// cloudflared écrit son journal sur stderr, URL comprise.
const watch = (chunk) => {
  const text = chunk.toString()
  const match = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i)
  if (match && !announced) {
    announced = true
    announce(match[0])
  }
  // Seules les lignes de niveau ERR remontent. cloudflared écrit un bilan de
  // connectivité où « FAIL » et « failed » sont des constats de routine — le
  // repli de QUIC vers HTTP/2 en est un — et les laisser passer noyait l'URL
  // sous des lignes qui ont l'air d'incidents sans en être.
  if (/\bERR\b/.test(text)) process.stderr.write(text)
}
tunnel.stdout.on('data', watch)
tunnel.stderr.on('data', watch)
