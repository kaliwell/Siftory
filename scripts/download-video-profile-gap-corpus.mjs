#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ProxyAgent } from 'undici'

const USER_AGENT = 'SiftorySemanticCorpus/1.0 (local profile validation)'
const MAX_DOWNLOAD_BYTES = 160 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const API_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_DELAY_MS = 3_000
const MAX_RETRIES = 4
const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptRoot, '..')
const defaultCorpusRoot = process.env.VIDEO_GAP_CORPUS || ''

const SOURCES = Object.freeze([
  {
    category: '02_meeting',
    title: 'File:Aida Thomas Interviews Nancy Many - Part 1.ogv',
  },
  { category: '02_meeting', title: 'File:Entrevista Michael Bauer CCCB.webm' },
  { category: '02_meeting', title: 'File:Entervista César Rendueles CCCB.webm' },
  {
    category: '02_meeting',
    title: 'File:Interview with Lisa Marie Thalhammer at Boxer Girl mural.ogv',
  },
  { category: '02_meeting', title: 'File:Armen Martirosyan interview.ogv' },
  {
    category: '02_meeting',
    title: 'File:Fête de la Fraternité - Jean-Louis Bianco by Mikani.ogv',
  },
  { category: '02_meeting', title: 'File:HelenHillInterview.theora.ogv' },
  { category: '02_meeting', title: 'File:Auto-Interview de Dominique Gisin.webm' },
  { category: '02_meeting', title: 'File:Interview Romaine.webm' },
  {
    category: '02_meeting',
    title: 'File:Direitos humanos - entrevista com Flávia Pinto.webm',
  },
  { category: '02_meeting', title: 'File:AmalMurkus.ogv' },
  {
    category: '02_meeting',
    title: 'File:Interview with Ton Roosendaal introducing Project Gooseberry.ogv',
  },
  {
    category: '03_sports',
    title: 'File:Rugby Nederland - Zuid-Afrika Weeknummer 72-02 - Open Beelden - 12820.ogv',
  },
  {
    category: '03_sports',
    title: 'File:Rugbywedstrijd AAC - Bank of England Weeknummer 55-16 - Open Beelden - 56766.ogv',
  },
  { category: '03_sports', title: 'File:Combate tang soo do..ogv' },
  {
    category: '03_sports',
    title: 'File:Blood Diamonds v Punk blockers Roller derby jam.webm',
  },
  { category: '03_sports', title: 'File:BoysKhoKho SRVKSchool2007.webm' },
  { category: '03_sports', title: 'File:Rockerball home movie.webm' },
  {
    category: '03_sports',
    title:
      'File:2016 리우 올림픽 국가대표 최종 선발전(2016.6.8) 오전 8th 경기 그레코로만형 75kg 김현우(삼성생명) vs 박상혁(조폐공사).webm',
  },
  { category: '03_sports', title: 'File:Rowing canal.webm' },
  {
    category: '03_sports',
    title: 'File:Day 7 (July 7) Highlights of Team Navy at DoD Warrior Games.webm',
  },
  {
    category: '03_sports',
    title: 'File:Boxing Match Yrjö Piitulainen vs Jean Wanes at Helsinki 30.9.1947.webm',
  },
  { category: '03_sports', title: 'File:The Grey Cup 2016 Finale.webm' },
  { category: '03_sports', title: 'File:Poweriser, Brněnské běhy 2010.ogv' },
  { category: '04_general', title: 'File:A Aesthetic Parota making part 1.ogv' },
  {
    category: '04_general',
    title: 'File:Cooking pots over a fire in Eastern Cape - South Africa.webm',
  },
  { category: '04_general', title: 'File:Cooking Salmon 20200410 141528.webm' },
  { category: '04_general', title: 'File:2013-01-20 neige, Paris 06.ogv' },
  { category: '04_general', title: 'File:Pasejo en Hong Kong Island (2014).webm' },
  { category: '04_general', title: 'File:Walking in the sands.webm' },
  { category: '04_general', title: 'File:Abgeworfener Schwanz einer Blindschleiche.webm' },
  { category: '04_general', title: 'File:Cicada exoskeletons.webm' },
  { category: '04_general', title: 'File:Common green bottle fly (Phaenicia sericata).webm' },
  { category: '04_general', title: 'File:Aankomst Hondekop.webm' },
  {
    category: '04_general',
    title: 'File:Caltrain Train 145 departing from Tamien, September 20, 2024.webm',
  },
  {
    category: '04_general',
    title:
      'File:Cross Country Super Voyager speeding past platform 2 at Bromsgrove Station - HD video clip.webm',
  },
  {
    category: '05_surveillance',
    title: 'File:Bek Air Flight 2100 Crash Footage 27 December 2019 Almaty, Kazakhstan.webm',
  },
  {
    category: '05_surveillance',
    title: 'File:CCTV footage of the Crimean Bridge explosion on October 8, 2022.webm',
  },
  {
    category: '05_surveillance',
    title: 'File:MLRS attack on K2 blockpost near Volnovakha (CCTV).webm',
  },
  {
    category: '05_surveillance',
    title: 'File:Arrest of Nathaniel Veltman, June 6, 2021.webm',
  },
  {
    category: '05_surveillance',
    title:
      'File:Security camera footage from the home of Joe Velaidum shows the moment a meteorite struck his home outside Charlottetown, P.E.I., on July 25, 2024.webm',
  },
  { category: '05_surveillance', title: 'File:COVID-19 in Chile - Street sanitation.webm' },
  {
    category: '05_surveillance',
    title: 'File:2025 Shandong chemical explosion on CCTV.webm',
  },
  { category: '05_surveillance', title: 'File:The van crashed into the building.webm' },
  {
    category: '05_surveillance',
    title: "File:St. John's Security Camera Footage.webm",
  },
  {
    category: '05_surveillance',
    title: 'File:Chelyabinsk meteor security camera footage, Yekaterinburg.webm',
  },
  { category: '05_surveillance', title: 'File:Pentagon Security Camera 1.ogv' },
  { category: '05_surveillance', title: 'File:Pentagon Security Camera 2.ogv' },
])

const SOURCE_SET_CATEGORIES = Object.freeze({
  'meeting-sports': Object.freeze(['02_meeting', '03_sports']),
  'final-coverage': Object.freeze(['04_general', '05_surveillance']),
  all: Object.freeze(['02_meeting', '03_sports', '04_general', '05_surveillance']),
})

const CATEGORY_PREFIXES = Object.freeze({
  '02_meeting': 'commons_meeting',
  '03_sports': 'commons_sports',
  '04_general': 'commons_general',
  '05_surveillance': 'commons_surveillance',
})

function argumentValue(prefix, fallback) {
  return (
    process.argv
      .slice(2)
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) || fallback
  )
}

function safeCorpusRoot(value) {
  const resolved = path.resolve(value)
  const parsed = path.parse(resolved)
  if (
    resolved === parsed.root ||
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isDirectory()
  ) {
    throw new Error(`Corpus root must be an existing non-root directory: ${resolved}`)
  }
  return resolved
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchWithBackoff(url, options, label, timeoutMs) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    if (response.status !== 429 && response.status < 500) return response
    if (attempt === MAX_RETRIES) return response
    const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') || '', 10)
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(30_000, Math.max(3_000, retryAfterSeconds * 1_000))
      : Math.min(30_000, 4_000 * 2 ** (attempt - 1))
    await response.body?.cancel()
    process.stdout.write(
      `  ${label} HTTP ${response.status}; retry ${attempt}/${MAX_RETRIES} in ${delayMs} ms\n`,
    )
    await wait(delayMs)
  }
  throw new Error(`${label} retry loop exhausted`)
}

function selectDerivative(videoInfo) {
  const candidates = (videoInfo.derivatives || [])
    .filter(
      (item) =>
        String(item.type || '').startsWith('video/webm') &&
        Number(item.height) >= 144 &&
        Number(item.height) <= 480,
    )
    .sort((left, right) => Number(right.height) - Number(left.height))
  const selected = candidates[0]
  if (selected) return selected
  if (String(videoInfo.mime || '').includes('webm')) {
    return {
      src: videoInfo.url,
      type: videoInfo.mime,
      width: videoInfo.width,
      height: videoInfo.height,
      transcodekey: 'original',
    }
  }
  throw new Error('No bounded WebM derivative is available')
}

async function querySource(title) {
  const api = new URL('https://commons.wikimedia.org/w/api.php')
  api.search = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'videoinfo',
    viprop: 'url|size|mime|extmetadata|derivatives',
    format: 'json',
    formatversion: '2',
  })
  const response = await fetchWithBackoff(
    api,
    {
      dispatcher,
      headers: { 'User-Agent': USER_AGENT },
    },
    'Commons API',
    API_TIMEOUT_MS,
  )
  if (!response.ok) throw new Error(`Commons API returned HTTP ${response.status}`)
  const payload = await response.json()
  const page = payload?.query?.pages?.[0]
  const videoInfo = page?.videoinfo?.[0]
  if (!page || page.missing || !videoInfo) throw new Error('Commons video metadata is missing')
  const derivative = selectDerivative(videoInfo)
  const sourceUrl = new URL(derivative.src)
  if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'upload.wikimedia.org') {
    throw new Error('Derivative URL is outside upload.wikimedia.org')
  }
  const license = String(videoInfo.extmetadata?.LicenseShortName?.value || '')
  if (!/^(?:CC BY(?:-SA)?|Public domain)/i.test(license)) {
    throw new Error(`Unsupported license: ${license || 'missing'}`)
  }
  return {
    sourceTitle: page.title,
    sourcePage: videoInfo.descriptionurl,
    sourceUrl: sourceUrl.toString(),
    derivative: String(derivative.transcodekey || 'webm'),
    license,
    licenseUrl: String(videoInfo.extmetadata?.LicenseUrl?.value || ''),
    attribution: stripHtml(videoInfo.extmetadata?.Artist?.value).slice(0, 500),
    description: stripHtml(videoInfo.extmetadata?.ImageDescription?.value).slice(0, 500),
  }
}

async function download(sourceUrl, destination) {
  const partial = `${destination}.partial`
  fs.rmSync(partial, { force: true })
  const response = await fetchWithBackoff(
    sourceUrl,
    {
      dispatcher,
      headers: { 'User-Agent': USER_AGENT },
    },
    'Download',
    DOWNLOAD_TIMEOUT_MS,
  )
  if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > MAX_DOWNLOAD_BYTES) callback(new Error('Download exceeded hard byte limit'))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      fs.createWriteStream(partial, { flags: 'wx' }),
    )
    fs.renameSync(partial, destination)
  } catch (error) {
    fs.rmSync(partial, { force: true })
    throw error
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

function resolveFfprobe() {
  const bundled = path.join(projectRoot, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe')
  return fs.existsSync(bundled) ? bundled : 'ffprobe.exe'
}

function probeMedia(file) {
  const result = spawnSync(
    resolveFfprobe(),
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  )
  if (result.status !== 0) throw new Error(`ffprobe failed: ${String(result.stderr || '').trim()}`)
  const data = JSON.parse(result.stdout)
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
  const durationMs = Math.round(Number(data.format?.duration) * 1_000)
  if (!video || !Number.isSafeInteger(durationMs) || durationMs < 5_000) {
    throw new Error('Downloaded file has invalid video metadata')
  }
  return {
    durationMs,
    width: Number(video.width),
    height: Number(video.height),
    videoCodec: String(video.codec_name || ''),
    audioCodec: String(audio?.codec_name || ''),
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function readManifest(corpusRoot) {
  try {
    const parsed = JSON.parse(
      fs
        .readFileSync(path.join(corpusRoot, 'local-curated-manifest.json'), 'utf8')
        .replace(/^\uFEFF/, ''),
    )
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeManifests(corpusRoot, records) {
  const manifestPath = path.join(corpusRoot, 'local-curated-manifest.json')
  const previous = readManifest(corpusRoot)
  const replacementTitles = new Set(records.map((record) => record.sourceTitle))
  const merged = [
    ...previous.filter(
      (record) =>
        record?.sourceType !== 'wikimedia-commons' || !replacementTitles.has(record?.sourceTitle),
    ),
    ...records,
  ]
  fs.writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  const csvColumns = [
    'candidateId',
    'category',
    'fileName',
    'description',
    'sourceType',
    'redistribution',
    'sizeBytes',
    'sha256',
  ]
  const csv = [
    csvColumns.map(csvCell).join(','),
    ...merged.map((record) => csvColumns.map((column) => csvCell(record[column])).join(',')),
  ].join('\n')
  fs.writeFileSync(path.join(corpusRoot, 'local-curated-manifest.csv'), `${csv}\n`, 'utf8')
  const attributions = merged
    .filter((record) => record?.sourceType === 'wikimedia-commons')
    .map(
      (record, index) =>
        `${index + 1}. ${record.sourceTitle}\n   - Source: ${record.sourcePage}\n   - License: ${record.license}${record.licenseUrl ? ` (${record.licenseUrl})` : ''}\n   - Attribution: ${record.attribution || 'See source page'}`,
    )
    .join('\n\n')
  fs.writeFileSync(
    path.join(corpusRoot, 'wikimedia-commons-attribution.md'),
    `# Wikimedia Commons validation corpus attribution\n\nLocal validation corpus only; files are not packaged with the application. Follow each source license when redistributing.\n\n${attributions}\n`,
    'utf8',
  )
  return merged
}

const proxyUrl = argumentValue('--proxy=', process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '')
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

async function main() {
  const corpusArgument = argumentValue('--corpus=', defaultCorpusRoot)
  if (!corpusArgument) {
    throw new Error(
      'Corpus directory is not configured: pass --corpus=<dir> or set VIDEO_GAP_CORPUS',
    )
  }
  const corpusRoot = safeCorpusRoot(corpusArgument)
  const sourceSet = argumentValue('--set=', 'meeting-sports')
  const selectedCategories = SOURCE_SET_CATEGORIES[sourceSet]
  if (!selectedCategories) {
    throw new Error(`Unknown --set=${sourceSet}; use meeting-sports, final-coverage, or all`)
  }
  const selectedSources = SOURCES.filter((source) => selectedCategories.includes(source.category))
  const requestDelayMs = Math.min(
    30_000,
    Math.max(
      0,
      Number.parseInt(argumentValue('--delay-ms=', String(DEFAULT_REQUEST_DELAY_MS)), 10) || 0,
    ),
  )
  const limit = Math.min(
    selectedSources.length,
    Math.max(
      1,
      Number.parseInt(argumentValue('--limit=', String(selectedSources.length)), 10) ||
        selectedSources.length,
    ),
  )
  const existingByTitle = new Map(
    readManifest(corpusRoot)
      .filter((record) => record?.sourceType === 'wikimedia-commons' && record?.sourceTitle)
      .map((record) => [record.sourceTitle, record]),
  )
  const records = []
  const failures = []
  const categoryOrdinals = new Map()
  for (const [index, source] of selectedSources.slice(0, limit).entries()) {
    const categoryOrdinal = (categoryOrdinals.get(source.category) || 0) + 1
    categoryOrdinals.set(source.category, categoryOrdinal)
    const ordinal = String(categoryOrdinal).padStart(2, '0')
    const prefix = CATEGORY_PREFIXES[source.category]
    const targetRoot = path.join(corpusRoot, source.category)
    const destination = path.join(targetRoot, `${prefix}_${ordinal}.webm`)
    fs.mkdirSync(targetRoot, { recursive: true })
    process.stdout.write(`[${index + 1}/${limit}] ${source.title}\n`)
    try {
      const existing = existingByTitle.get(source.title)
      const metadata =
        existing && fs.existsSync(destination)
          ? {
              sourceTitle: existing.sourceTitle,
              sourcePage: existing.sourcePage,
              sourceUrl: existing.sourceUrl,
              derivative: existing.derivative,
              license: existing.license,
              licenseUrl: existing.licenseUrl,
              attribution: existing.attribution,
              description: existing.description,
            }
          : await querySource(source.title)
      if (!fs.existsSync(destination)) await download(metadata.sourceUrl, destination)
      const stat = fs.statSync(destination)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DOWNLOAD_BYTES) {
        throw new Error('Downloaded file size is invalid')
      }
      const media = probeMedia(destination)
      const digest = await sha256File(destination)
      if (existing && (existing.sha256 !== digest || existing.sizeBytes !== stat.size)) {
        throw new Error('Existing file no longer matches its recorded digest and size')
      }
      records.push({
        candidateId: `candidate-${crypto
          .createHash('sha256')
          .update(`profile-gap-external:${digest}`)
          .digest('hex')
          .slice(0, 12)}`,
        category: source.category,
        fileName: path.basename(destination),
        localPath: destination,
        description: metadata.description || source.title.replace(/^File:/, ''),
        sourceType: 'wikimedia-commons',
        sourceTitle: metadata.sourceTitle,
        sourcePage: metadata.sourcePage,
        sourceUrl: metadata.sourceUrl,
        derivative: metadata.derivative,
        license: metadata.license,
        licenseUrl: metadata.licenseUrl,
        attribution: metadata.attribution,
        redistribution: 'follow-source-license',
        sizeBytes: stat.size,
        sha256: digest,
        ...media,
      })
      process.stdout.write(`  ready ${Math.round(stat.size / 1024)} KiB, ${media.durationMs} ms\n`)
    } catch (error) {
      failures.push({
        title: source.title,
        error: error instanceof Error ? error.message : String(error),
      })
      process.stdout.write(`  failed: ${failures.at(-1).error}\n`)
    }
    if (index + 1 < limit && requestDelayMs > 0) await wait(requestDelayMs)
  }
  const merged = writeManifests(corpusRoot, records)
  const perCategory = Object.fromEntries(
    selectedCategories.map((category) => [
      category,
      records.filter((record) => record.category === category).length,
    ]),
  )
  process.stdout.write(
    `${JSON.stringify(
      {
        corpusRoot,
        sourceSet,
        proxyEnabled: Boolean(proxyUrl),
        requestDelayMs,
        requested: limit,
        downloadedOrVerified: records.length,
        failures,
        perCategory,
        manifestRecords: merged.length,
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length) process.exitCode = 2
}

try {
  await main()
} finally {
  await dispatcher?.close()
}
