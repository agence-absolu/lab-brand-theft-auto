import { defineConfig } from 'vite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECTS } from './src/projects.js'

// Le lab sert chaque démo sur /<nom npm>/ : la base doit donc être préfixée en
// production, sinon tous les chemins absolus (/projects/…, /busted.png) visent
// la racine du domaine. BASE_PATH permet au workflow de la forcer ; par défaut
// on la déduit du nom du paquet, et le serveur de dev reste sur "/".
const { name } = JSON.parse(readFileSync('./package.json', 'utf8'))

// Routes de l'application : le menu et une page par projet.
const ROUTES = ['menu', ...PROJECTS.map((project) => project.slug)]

// L'application a de vraies URLs (/mon-projet, /menu) mais l'hébergement sert
// des fichiers statiques : sans réécriture, un rechargement sur l'une d'elles
// renvoie un 404. Plutôt que de dépendre d'une configuration serveur qu'on ne
// maîtrise pas, on écrit une copie de index.html à chaque route. N'importe
// quel serveur statique sait alors les servir.
function staticRoutes(base) {
  return {
    name: 'routes-statiques',
    apply: 'build',
    closeBundle() {
      const outDir = resolve('dist')
      const html = readFileSync(resolve(outDir, 'index.html'), 'utf8')
      for (const route of ROUTES) {
        const dir = resolve(outDir, route)
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'index.html'), html)
      }

      // Filet pour tout le reste : la plupart des hébergements statiques
      // servent 404.html sur une URL inconnue. On y renvoie vers la racine.
      // La redirection est écrite deux fois — en script et en meta — pour
      // couvrir le cas où le JavaScript est bloqué.
      writeFileSync(
        resolve(outDir, '404.html'),
        `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Brand Theft Auto</title>
    <meta http-equiv="refresh" content="0; url=${base}" />
    <script>location.replace(${JSON.stringify(base)})</script>
  </head>
  <body>
    <p>Page introuvable. <a href="${base}">Retour au jeu</a></p>
  </body>
</html>
`
      )

      console.log(`routes statiques écrites : ${ROUTES.length} (+ 404)`)
    },
  }
}

export default defineConfig(({ command }) => {
  const base = process.env.BASE_PATH || (command === 'build' ? `/${name}/` : '/')
  return { base, plugins: [staticRoutes(base)] }
})
