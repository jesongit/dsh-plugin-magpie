// Explicit opt-in, read-only integration probe. Never prints .env values or saves credentials.
import { readFile } from 'node:fs/promises'
import { ConnectorError, MagpieTransport, normalizeUrl } from '../lib/transport.js'
import { parseCatalog, providerNames } from '../lib/catalog.js'
import { discoverGateway } from '../lib/service.js'

const envPath = process.argv[2]
if (!envPath) throw new Error('Pass the explicit local test configuration path')
function localConfiguration(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
  const values = Object.fromEntries(lines.flatMap(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : []
  }))
  let rawUrl = values.MAGPIE_URL ?? values.MAGPIE_WEB_URL ?? values.URL
  let loginKey = values.MAGPIE_WEB_KEY ?? values.MAGPIE_LOGIN_KEY ?? values.LOGIN_KEY ?? values.KEY
  if (!rawUrl) rawUrl = lines.map(line => /https?:\/\/[^\s'"<>]+/.exec(line)?.[0]).find(Boolean)
  if (!loginKey) {
    const line = lines.find(line => !line.includes('://'))
    if (line) loginKey = line.replace(/^[^:=：]+[:=：]\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  if (!rawUrl || !loginKey) throw new Error('Local configuration needs a URL and backend login key; values were not logged')
  // Existing user-supplied signed-in URLs are stripped before any diagnostic or request.
  const url = new URL(rawUrl)
  if (!loginKey && url.searchParams.get('k')) loginKey = url.searchParams.get('k')
  url.search = ''; url.hash = ''
  return { url: normalizeUrl(url.toString()), loginKey, gatewayKey: values.MAGPIE_GATEWAY_KEY ?? values.GATEWAY_KEY, gatewayUrl: values.MAGPIE_GATEWAY_URL }
}
try {
  const config = localConfiguration(await readFile(envPath, 'utf8'))
  const transport = new MagpieTransport(async (url, init) => {
    const response = await fetch(url, init)
    console.log('probe response:', init?.method ?? 'GET', new URL(url).pathname, response.status, response.headers.get('content-type')?.split(';')[0] ?? 'no-content-type')
    return response
  })
  const cookie = await transport.login(config.url, config.loginKey)
  console.log('PASS backend form authentication (no URL key)')
  const providers = await transport.management(config.url, cookie, '/api/providers')
  const options = await transport.management(config.url, cookie, '/api/caller-keys/models')
  const bootstrap = await transport.management(config.url, cookie, '/api/state')
  console.log('PASS provider directory / caller-key catalog / bootstrap API')
  console.log('management provider count:', Array.isArray(providers.providers) ? providers.providers.length : 'unknown')
  console.log('management offered model count:', Array.isArray(options.models) ? options.models.length : 'unknown')
  console.log('backend version:', /^[a-zA-Z0-9.+_-]{1,100}$/.test(bootstrap.settings?.version ?? '') ? bootstrap.settings.version : 'undisclosed')
  const gatewayUrl = discoverGateway(config.url, providers, config.gatewayUrl)
  if (config.gatewayKey) {
    const directory = await transport.gateway({ gatewayUrl, gatewayKey: config.gatewayKey }, '/v1/models')
    const groups = parseCatalog(directory, providerNames(providers))
    console.log('PASS gateway authentication and provider grouping')
    console.log('group counts:', groups.map(group => `${group.upstream}:${group.models.length}`).join(', '))
  } else {
    console.log('SKIP authenticated /v1/models: no explicit gateway API key; no key was created or copied')
    // Check whether a local, uncredentialed directory is permitted. Never spend a model call here.
    const response = await fetch(`${gatewayUrl}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const groups = parseCatalog(await response.json(), providerNames(providers))
      console.log('PASS available gateway model directory and grouping')
      console.log('group counts:', groups.map(group => `${group.upstream}:${group.models.length}`).join(', '))
    } else { console.log('gateway directory without key HTTP', response.status); await response.body?.cancel() }
  }
  console.log('No settings were changed, no gateway key created, no model request sent, no credentials persisted.')
} catch (error) {
  console.error('FAIL integration probe:', error instanceof ConnectorError ? error.message : 'configuration parsing or response handling failed; values withheld')
  process.exitCode = 1
}
