import { createHttpServer } from './lib/http-server.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 4173)

const server = createHttpServer({ root, profileStore: null, themeHandler: null, token: '' })
server.listen(port, '127.0.0.1', () => console.log(`Touchstone is running at http://127.0.0.1:${port}`))
