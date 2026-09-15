import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// Le lab sert chaque démo sur /<nom npm>/ : la base doit donc être préfixée en
// production, sinon tous les chemins absolus (/projects/…, /busted.png) visent
// la racine du domaine. BASE_PATH permet au workflow de la forcer ; par défaut
// on la déduit du nom du paquet, et le serveur de dev reste sur "/".
const { name } = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH || (command === 'build' ? `/${name}/` : '/'),
}))
