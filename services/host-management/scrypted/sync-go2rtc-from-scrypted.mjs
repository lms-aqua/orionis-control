#!/usr/bin/env node
/**
 * Regenerates go2rtc's stream list from Scrypted.
 *
 * Scrypted's prebuffer rebroadcast allocates a fresh RTSP port AND a fresh path
 * hash every time it restarts, so any hand-written go2rtc config is one Scrypted
 * restart away from being dead. Pinning those URLs by hand is therefore not a
 * configuration choice, it is a scheduled outage. This asks Scrypted what the
 * URLs are now.
 *
 * Auth note: the token from `npx scrypted login` is passed as the *password*.
 * @scrypted/client only sets the Authorization header on the username+password
 * path, so `previousLoginResult` alone gets a 401 from the engine.io endpoint.
 *
 * Run with --dry-run to print what would change without touching anything.
 */
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { connectScryptedClient } from '@scrypted/client';
import { installRedactingConsole } from './log-redaction.mjs';

const execFile = promisify(execFileCb);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Scrypted serves its own cert.

const DRY_RUN = process.argv.includes('--dry-run');
const GO2RTC_CONTAINER = process.env.GO2RTC_CONTAINER ?? 'orionis-guard-go2rtc-1';
const SCRYPTED_CONTAINER = process.env.SCRYPTED_CONTAINER ?? 'scrypted';
const SCRYPTED_URL = process.env.SCRYPTED_URL ?? 'https://127.0.0.1:10443';
const CONFIG_PATH =
  process.env.GO2RTC_CONFIG ?? '/home/appbox/apps/orionis-guard/go2rtc/go2rtc.yaml';

/**
 * @scrypted/client logs its login result, including live bearer and query
 * tokens. Keep the dependency's useful connection diagnostics while ensuring
 * credentials can never reach cron's redirected output.
 */
installRedactingConsole();

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Scrypted reports rebroadcast URLs as localhost; go2rtc needs a routable host. */
async function scryptedAddress() {
  const { stdout } = await execFile('docker', [
    'inspect',
    SCRYPTED_CONTAINER,
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
  ]);
  const ip = stdout.trim().split(/\s+/).filter(Boolean)[0];
  if (!ip) throw new Error(`could not determine ${SCRYPTED_CONTAINER} address`);
  return ip;
}

async function connect() {
  const loginPath = path.join(os.homedir(), '.scrypted', 'login.json');
  const stored = Object.values(JSON.parse(fs.readFileSync(loginPath, 'utf8')))[0];
  if (!stored?.username || !stored?.token) {
    throw new Error(`no usable login in ${loginPath}; run: npx -y scrypted@latest login 127.0.0.1:10443`);
  }
  return connectScryptedClient({
    baseUrl: SCRYPTED_URL,
    pluginId: '@scrypted/core',
    username: stored.username,
    password: stored.token,
  });
}

/** Every camera Scrypted currently exposes an RTSP rebroadcast for. */
async function discover(sdk, host) {
  const { systemManager } = sdk;
  const state = systemManager.getSystemState();
  const found = [];

  for (const id of Object.keys(state)) {
    const interfaces = state[id]?.interfaces?.value ?? [];
    if (!interfaces.includes('VideoCamera')) continue;

    const name = String(state[id]?.name?.value ?? '').trim();
    let url = null;
    try {
      const settings = (await systemManager.getDeviceById(id).getSettings?.()) ?? [];
      for (const setting of settings) {
        const value = String(setting?.value ?? '');
        if (value.startsWith('rtsp://')) {
          // localhost is Scrypted's own view of itself.
          url = value.replace('://localhost:', `://${host}:`).replace('://127.0.0.1:', `://${host}:`);
          break;
        }
      }
    } catch (error) {
      log(`  ! device ${id} (${name}): settings unavailable: ${error.message}`);
      continue;
    }

    found.push({
      id,
      name,
      url,
      online: state[id]?.online?.value !== false,
      ptz: interfaces.includes('PanTiltZoom'),
      motion: interfaces.includes('MotionSensor'),
    });
  }
  return found;
}

/**
 * A URL that no longer answers is worse than absent: go2rtc would advertise the
 * camera as a stream that never produces a frame, which the app then has to
 * present as a camera that is somehow both present and broken.
 */
async function carriesVideo(url) {
  try {
    const { stdout } = await execFile('docker', [
      'exec',
      GO2RTC_CONTAINER,
      'timeout',
      '12',
      'ffprobe',
      '-v',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
    ]);
    return stdout.includes('video');
  } catch {
    return false;
  }
}

/**
 * go2rtc's config is bind-mounted from the host, so it is read and written there
 * directly. It must NOT be written with `docker cp`: copying onto a bind-mounted
 * file fails with "device or resource busy", which would leave this sync silently
 * unable to apply anything.
 */
async function readConfig() {
  if (fs.existsSync(CONFIG_PATH)) return fs.readFileSync(CONFIG_PATH, 'utf8');
  const { stdout } = await execFile('docker', [
    'exec',
    GO2RTC_CONTAINER,
    'cat',
    '/config/go2rtc.yaml',
  ]);
  return stdout;
}

/** Replaces only the streams block, leaving api/rtsp/webrtc settings untouched. */
function rewriteStreams(config, streams) {
  const body = Object.entries(streams)
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
    .map(([name, src]) => `  "${name}": ${src}`)
    .join('\n');
  // Carried across untouched. Replacing the whole block used to delete these
  // within fifteen minutes of them being registered, and the camera stopped
  // playing with nothing in any log to say why.
  const foreign = foreignStreamText(config);
  const block = `streams:\n${body}\n${foreign ? `${foreign}\n` : ''}`;
  if (/^streams:\n(?:[ \t]+[^\n]*\n)*/m.test(config)) {
    return config.replace(/^streams:\n(?:[ \t]+[^\n]*\n)*/m, block);
  }
  return `${block}\n${config}`;
}

async function writeConfig(contents) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`${CONFIG_PATH} is missing; refusing to guess where the config lives`);
  }
  // Write via a temp file and rename, so a crash mid-write cannot leave go2rtc
  // with a half-written stream list.
  const tmp = `${CONFIG_PATH}.sync-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, CONFIG_PATH);
}

/**
 * Names this script owns.
 *
 * Scrypted device ids are numeric, so an owned stream is a number with an
 * optional rendition suffix. Anything else was registered by somebody else --
 * a camera connection pointing go2rtc at its own bridge, for instance -- and
 * must survive a sync.
 */
const OWNED = /^[0-9]+(_aac|_ll|_hq)?$/;

/**
 * The streams block, split into one chunk per stream.
 *
 * Chunk rather than key/value because go2rtc does not write the shape this
 * script does. Registering a stream over its API produces
 *
 *     driveway:
 *       - rtsp://host:8554/driveway
 *
 * where this script writes `  "57": rtsp://…` on one line. A parser that only
 * understood the single-line form read that list item as a stream named `-`,
 * and the block regex stopped at the first four-space line, so everything
 * after it was invisible. Keeping foreign chunks as raw text sidesteps having
 * to model every shape go2rtc might emit.
 */
function parseStreamChunks(config) {
  const match = /^streams:\n((?:[ \t]+[^\n]*\n)*)/m.exec(config);
  if (!match) return [];
  const chunks = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const head = /^  ("?)([^":]+)\1:\s*(.*)$/.exec(line);
    if (head) {
      chunks.push({ name: head[2], inline: head[3].trim(), lines: [line] });
    } else if (chunks.length > 0) {
      // A deeper-indented continuation belongs to the stream above it.
      chunks[chunks.length - 1].lines.push(line);
    }
  }
  return chunks;
}

/** Only the streams this script owns, for comparing against Scrypted. */
function parseStreams(config) {
  const streams = {};
  for (const chunk of parseStreamChunks(config)) {
    if (OWNED.test(chunk.name) && chunk.inline) streams[chunk.name] = chunk.inline;
  }
  return streams;
}

/** The raw text of every stream this script does not own. */
function foreignStreamText(config) {
  return parseStreamChunks(config)
    .filter((chunk) => !OWNED.test(chunk.name))
    .map((chunk) => chunk.lines.join('\n'))
    .join('\n');
}

async function main() {
  const host = await scryptedAddress();
  log(`scrypted at ${host}`);

  const sdk = await connect();
  const cameras = await discover(sdk, host);
  log(`scrypted knows ${cameras.length} cameras`);

  const withUrls = cameras.filter((camera) => camera.url);
  log(`${withUrls.length} expose an RTSP rebroadcast; probing each`);

  const streams = {};
  const labels = [];
  for (const camera of withUrls) {
    const ok = await carriesVideo(camera.url);
    log(
      `  ${camera.id} ${camera.name || '(unnamed)'}: ${ok ? 'carries video' : 'no video, skipping'}${camera.ptz ? ' [ptz]' : ''}`,
    );
    if (!ok) continue;
    streams[camera.id] = camera.url;
    // AAC-transcoded twin for HLS + recording (G.711 is undecodable there);
    // the raw stream stays for WebRTC. Quoted so the # is not a YAML comment.
    streams[`${camera.id}_aac`] = `"ffmpeg:${camera.id}#video=copy#audio=aac"`;
    // Short-keyframe (0.5s GOP) re-encode for WebRTC so a lost packet recovers
    // almost instantly instead of freezing until the camera's 2s keyframe.
    // exec = on-demand: only runs while a WebRTC client is actually watching.
    streams[`${camera.id}_ll`] = `"exec:ffmpeg -hide_banner -v error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/${camera.id} -vf scale=-2:720 -c:v libx264 -vf scale=-2:720 -preset veryfast -tune zerolatency -b:v 900k -maxrate 1200k -bufsize 1200k -g 20 -keyint_min 20 -sc_threshold 0 -c:a copy -rtsp_transport tcp -f rtsp {output}"`;
    // Full-resolution top rung. It is deliberately capped and faster to encode
    // than the archival source; Auto/High clients may choose it, while recovery
    // immediately moves to the `_ll` rendition above on a weak path.
    streams[`${camera.id}_hq`] = `"exec:ffmpeg -hide_banner -v error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/${camera.id} -vf format=yuv420p -c:v libx264 -preset superfast -tune zerolatency -profile:v main -level 4.1 -b:v 4500k -maxrate 5500k -bufsize 2250k -g 10 -keyint_min 10 -sc_threshold 0 -c:a copy -rtsp_transport tcp -f rtsp {output}"`;
    if (camera.name) labels.push(`${camera.id}=${camera.name.replace(/[,|]/g, ' ').trim()}`);
  }

  if (Object.keys(streams).length === 0) {
    log('refusing to write an empty stream list; leaving the existing config alone');
    process.exitCode = 1;
    return;
  }

  const config = await readConfig();
  const before = parseStreams(config);

  const unchanged =
    Object.keys(before).length === Object.keys(streams).length &&
    Object.entries(streams).every(([name, src]) => before[name] === src);

  log(`gateway camera labels: ORIONIS_CAMERA_LABELS=${labels.join(',')}`);

  if (unchanged) {
    log('streams already match Scrypted; nothing to do');
    return;
  }

  log('streams differ from Scrypted:');
  for (const [name, src] of Object.entries(streams)) {
    if (before[name] !== src) log(`  ~ ${name}: ${before[name] ?? '(absent)'} -> ${src}`);
  }
  for (const name of Object.keys(before)) {
    if (!(name in streams)) log(`  - ${name}: ${before[name]} (gone)`);
  }

  if (DRY_RUN) {
    log('dry run: no changes written');
    return;
  }

  await writeConfig(rewriteStreams(config, streams));
  await execFile('docker', ['restart', GO2RTC_CONTAINER]);
  log('go2rtc config updated and restarted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      log(`FAILED: ${error.message}`);
      process.exit(1);
    });
}
