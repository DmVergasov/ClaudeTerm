import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type AppInfo, type ClipboardContent, type ImagesUpdate, type RestoreInfo, type SetSettingResult, type SettingsView } from '../shared/ipc'
import { socketDir } from '../shared/protocol'
import { isSettingKey, isSettingValue } from '../shared/settings-keys'
import type { OpenTabRequest, ProfileDef, RecentSession, SessionSummary, Settings, TabInfo } from '../shared/types'
import { parseArgs, resolveLaunchDir, type LaunchCommand } from './args'
import { Attention } from './attention'
import { autoUpdater } from 'electron-updater'
import { writeClaudeTabFiles } from './claude-tab-settings'
import { buildChildEnv } from './child-env'
import { initDataDir, resolvePipeName } from './data-dir'
import { isAbsPath, isHash, isId, isIdList, isImageAction, isLineNo, isOptionalTitle, isPtyData, isPtySize, isReviewScope, isUserInput } from './ipc-guards'
import { NOT_RUNNING } from '../shared/review'
import { EditLedger } from './edit-ledger'
import { launchEditor, spawnDetached } from './editor-launch'
import { ReviewHub } from './review-hub'
import { createSources, nodeIo } from './review-sources'
import { checkImageFile, DEFAULT_IMAGE_EXTENSIONS } from '../shared/image-file'
import { ImageHub } from './image-hub'
import { claudeTempRoot, sessionTempDir, watchImages, type ImageWatcherHandle } from './image-watcher'
import { handleImgProtocol, registerImgScheme } from './img-protocol'
import { createLogger } from './log'
import { findExecutable, isExecutableFile } from './login-env'
import { ensureMcpRegistered, execRunner, resolveClaude, resolveClaudePosix, type ClaudeCli } from './mcp-registrar'
import { pathKey } from './path-key'
import { startPipeServer, type PipeServerHandle } from './pipe-server'
import { buildLaunch, detectInstalledProfiles, loginShell, pickClaudeProfile, pickProfile, profileResolver } from './profiles'
import { allPtysExited, spawnPty } from './pty-host'
import { resourcePath } from './resources'
import { applySettingEdit, loadSettingsSafe, type ParsedSettings } from './settings'
import { SettingsWindow } from './settings-window'
import { claudeProjectsDir, SessionHistory } from './session-history'
import { SessionStore } from './session-store'
import { socketProblem } from './socket-file'
import { createSoundPlayer, linuxSoundDeps, wavPlayer } from './sound'
import { StatusHub } from './status-hub'
import { TabManager } from './tab-manager'
import { readAgentMeta } from './transcript-agent-info'
import { consumeUpdateMarker, writeUpdateMarker } from './update-marker'
import { Updater } from './updater'
import { createUpdateBackend } from './update-backend'
import { cleanupImageCache, findTranscript, locateTranscript, TranscriptFeed } from './transcript-feed'
import { loadWindowState, trackWindowState } from './window-state'

const dataDir = initDataDir()
const log = createLogger(join(dataDir, 'logs'))
const pipeName = resolvePipeName()
const settingsPath = join(dataDir, 'settings.json')
const isTest = process.env.CLAUDETERM_TEST === '1'

registerImgScheme()

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function childEnv(): Record<string, string> {
  return buildChildEnv(process.env)
}

if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.quit()
} else {
  app.whenReady().then(bootstrap).catch((e: unknown) => {
    log.error(`bootstrap failed: ${String(e)}`)
    app.exit(1)
  })
}

function bootstrap(): void {
  Menu.setApplicationMenu(null)
  let win: BrowserWindow | null = null
  let rendererReady = false
  let pipe: PipeServerHandle | null = null
  const pendingLaunches: LaunchCommand[] = [parseArgs(process.argv)]
  const startupNotices: string[] = []

  const send = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
  const toast = (message: string): void => {
    log.warn(message)
    if (rendererReady) send(IPC.evToast, message)
    else startupNotices.push(message)
  }

  // a settings change (every click in the settings window) must not start the shell detection again
  const resolveProfiles = profileResolver(detectInstalledProfiles, existsSync)
  const computeProfiles = (s: Settings): { profiles: ProfileDef[]; notices: string[] } => resolveProfiles(s.profiles)

  const loaded = loadSettingsSafe(settingsPath)
  let settings: Settings = loaded.settings
  let lastLoad: ParsedSettings = loaded
  if (loaded.failed) log.error(loaded.errors[0])
  const startProfiles = computeProfiles(settings)
  let profiles = startProfiles.profiles
  // notices toast when they appear, not again on every reload that still has them
  let lastNotices = [...loaded.errors, ...startProfiles.notices]
  startupNotices.push(...lastNotices)
  const claudeFiles = writeClaudeTabFiles(dataDir, process.execPath, resourcePath('hook/session-hook.js'))
  const sessions = new SessionStore(dataDir, { onError: (m) => log.warn(m) })
  // the previous run restarted into an update: reopen its tabs without asking
  const restoreAfterUpdate = consumeUpdateMarker(dataDir, Date.now())
  let previous = sessions.rotateOnStartup({ afterUpdate: restoreAfterUpdate })
  const history = new SessionHistory(claudeProjectsDir(process.env, homedir()))
  // what the window was last shown; opening looks the id up here, so the renderer only passes an id
  let listedSessions = new Map<string, SessionSummary>()
  const restoreInfo = (): RestoreInfo | null =>
    previous ? { tabs: previous.tabs.length, claudeTabs: previous.tabs.filter((t) => t.kind === 'claude').length, savedAt: previous.savedAt } : null

  const imageCacheRoot = join(tmpdir(), 'ClaudeTerm', 'images')
  const claudeRoot = claudeTempRoot({ platform: process.platform, env: process.env, tmpdir: tmpdir(), uid: process.getuid?.() ?? -1 })
  cleanupImageCache(imageCacheRoot, 7 * 24 * 60 * 60 * 1000)
  const imageTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const images = new ImageHub({
    maxItems: () => settings.imagePanel.maxItems,
    // coalesce bursts (e.g. transcript history on --resume) into one update per tab
    onChange: (tabId) => {
      if (imageTimers.has(tabId)) return
      imageTimers.set(tabId, setTimeout(() => {
        imageTimers.delete(tabId)
        send(IPC.evImages, imagesUpdate(tabId))
      }, 50))
    }
  })
  const imagesUpdate = (tabId: string): ImagesUpdate => ({ tabId, cards: images.list(tabId), unseen: images.unseenCount(tabId), notice: images.notice(tabId) })

  interface TabImageSources {
    tempWatcher: ImageWatcherHandle | null
    feed: TranscriptFeed | null
    transcriptPath: string | null
  }
  const sources = new Map<string, TabImageSources>()

  const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const statusHub = new StatusHub({
    now: () => Date.now(),
    readMeta: (tabId, agentId) => {
      const dir = sources.get(tabId)?.feed?.subagentDir
      return dir ? readAgentMeta(dir, agentId) : null
    },
    // coalesce bursts (statusLine, hooks, subagent transcripts) into one update per tab
    onChange: (tabId) => {
      if (statusTimers.has(tabId)) return
      statusTimers.set(tabId, setTimeout(() => {
        statusTimers.delete(tabId)
        send(IPC.evStatus, statusHub.get(tabId))
      }, 50))
    }
  })

  const playSound = createSoundPlayer({
    ...(process.platform === 'win32'
      ? { player: (f: string) => wavPlayer(f, process.env), systemSound: null }
      : linuxSoundDeps(process.env, (cmd) => findExecutable(cmd, process.env.PATH ?? '', isExecutableFile) !== null, existsSync)),
    beep: () => shell.beep(),
    spawn: (p) => spawn(p.file, p.args, { env: p.env, windowsHide: true, stdio: 'ignore' }),
    warn: toast
  })

  const stopTabStatus = (tabId: string): void => {
    const timer = statusTimers.get(tabId)
    if (timer) clearTimeout(timer)
    statusTimers.delete(tabId)
    statusHub.removeTab(tabId)
  }

  /** the session's temp folder (its scratchpad): images that appear there are the session's own */
  const watchTemp = (tabId: string, dir: string): ImageWatcherHandle => {
    const handle: ImageWatcherHandle = watchImages(dir, settings.imageWatch, {
      added: (p) => images.add(tabId, p, 'created', null),
      changed: (p) => images.add(tabId, p, 'created', null, undefined, true),
      removed: (p) => images.markDeleted(tabId, p),
      error: (err) => {
        log.warn(`watcher ${dir}: ${err.message}`)
        const s = sources.get(tabId)
        // ignore a late error from a watcher that was already replaced
        if (s?.tempWatcher && s.tempWatcher !== handle) return
        if (s) {
          void s.tempWatcher?.close()
          s.tempWatcher = null
        }
        images.setNotice(tabId, `Stopped watching for new images: ${err.message}`)
      }
    })
    return handle
  }

  const reviewRoot = join(dataDir, 'review')
  // Claude's edits of sessions untouched for a week go, like the image cache
  cleanupImageCache(reviewRoot, 7 * 24 * 60 * 60 * 1000)
  const review = new ReviewHub({
    sources: createSources(nodeIo),
    ledgerFor: (sessionId) => new EditLedger({ dir: join(reviewRoot, sessionId), now: () => Date.now(), onError: (m) => log.warn(m) }),
    activeTabId: () => tabs.activeTabId(),
    publish: (u) => send(IPC.evReview, u),
    onError: (m) => log.warn(m),
    hideIgnored: () => settings.review.hideIgnored
  })

  const startTabImages = (tab: TabInfo): void => {
    images.addTab(tab.id, tab.cwd)
    review.addTab(tab.id, tab.cwd, tab.kind === 'claude')
    sources.set(tab.id, { tempWatcher: null, feed: null, transcriptPath: null })
  }

  const stopTabImages = (tabId: string): void => {
    const s = sources.get(tabId)
    if (s) {
      void s.tempWatcher?.close()
      s.feed?.stop()
    }
    sources.delete(tabId)
    const timer = imageTimers.get(tabId)
    if (timer) clearTimeout(timer)
    imageTimers.delete(tabId)
    images.removeTab(tabId)
  }

  const attachTranscript = (tabId: string, sessionId: string, transcriptPath: string): void => {
    const s = sources.get(tabId)
    if (!s || (s.transcriptPath !== null && pathKey(s.transcriptPath) === pathKey(transcriptPath))) return
    s.feed?.stop()
    void s.tempWatcher?.close()
    s.tempWatcher = null
    s.transcriptPath = transcriptPath
    s.feed = new TranscriptFeed({
      transcriptPath,
      sessionId,
      cacheRoot: imageCacheRoot,
      fileExists: existsSync,
      locate: () => findTranscript(transcriptPath, sessionId),
      onImage: (img) => images.add(tabId, img.path, img.source, img.caption, img.at ?? undefined),
      onError: (m) => log.warn(m),
      onSubagentInfo: (agentId, info) => statusHub.subagentInfo(tabId, agentId, info),
      onEditEvent: (ev) => review.transcriptEvent(tabId, ev),
      onAssistant: (agentId, at) => review.assistantEntry(tabId, agentId, at),
      onInterrupt: (agentId, at) => review.interrupted(tabId, agentId, at)
    })
    // images there, also ones Claude reads, are shown by their path inside it (scratchpad\plot.png)
    const temp = sessionTempDir(transcriptPath, sessionId, claudeRoot)
    images.setTempDir(tabId, temp)
    s.feed.start()
    if (!settings.imageWatch.enabled) return
    try {
      // private, as Claude Code makes it: on Linux it refuses a temp root others can enter
      mkdirSync(temp, { recursive: true, mode: 0o700 })
      s.tempWatcher = watchTemp(tabId, temp)
    } catch (e) {
      log.warn(`cannot watch ${temp}: ${(e as Error).message}`)
    }
  }

  handleImgProtocol(images, () => [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions])

  let claudeCli: ClaudeCli | null | undefined
  // looked up once: on Linux this starts the login shell
  const findingClaude = process.platform === 'win32'
    ? resolveClaude(execRunner)
    : resolveClaudePosix({ run: execRunner, shell: loginShell(), env: process.env, isExecutable: isExecutableFile })
  void findingClaude.then((cli) => { claudeCli = cli })

  const tabs = new TabManager({
    onTabStarted: startTabImages,
    onTabClosed: (tabId) => {
      stopTabImages(tabId)
      stopTabStatus(tabId)
      attention.removeTab(tabId)
      review.removeTab(tabId)
    },
    spawn: spawnPty,
    pipeName,
    baseEnv: childEnv,
    resolveLaunch: (req) => {
      if (req.kind === 'claude') {
        if (claudeCli === null && settings.claude.command === 'claude') toast('claude not found in PATH — install Claude Code: https://claude.com/claude-code')
        const { profile, warning } = pickClaudeProfile(profiles, settings.claude.shellProfile)
        if (warning) toast(warning)
        const claude = { command: settings.claude.command, settingsPath: claudeFiles.settingsPath, resumeSessionId: req.resumeSessionId ?? null }
        return { profileName: profile.name, spec: buildLaunch(profile, 'claude', claude) }
      }
      const profile = profiles.find((p) => p.name === req.profile) ?? pickProfile(profiles, settings.defaultProfile)
      if (req.profile && profile.name !== req.profile) toast(`Profile "${req.profile}" not found; using ${profile.name}`)
      return { profileName: profile.name, spec: buildLaunch(profile, 'shell', null) }
    },
    onStateChanged: () => sessions.scheduleSave(tabs.snapshot()),
    // Claude Code writes the transcript with the first message; --resume of a conversation without one fails
    resumable: (tabId, sessionId) => {
      const p = sources.get(tabId)?.transcriptPath
      return p ? locateTranscript(p, sessionId) !== null : true
    },
    events: {
      opened: (t) => send(IPC.evTabOpened, t),
      updated: (t) => send(IPC.evTabUpdated, t),
      closed: (id) => send(IPC.evTabClosed, id),
      activated: (id) => { send(IPC.evTabActivated, id); review.activated(id) },
      order: (ids) => send(IPC.evTabsOrder, ids),
      data: (id, d) => send(IPC.evPtyData, id, d),
      exit: (id, code) => send(IPC.evPtyExit, id, code),
      reset: (id) => send(IPC.evPtyReset, id)
    }
  })
  const isClaudeTab = (tabId: string): boolean => tabs.get(tabId)?.kind === 'claude'

  const attention = new Attention({
    windowFocused: () => Boolean(win && !win.isDestroyed() && win.isFocused()),
    activeTabId: () => tabs.activeTabId(),
    settings: () => settings.notifications,
    flash: () => { if (win && !win.isDestroyed()) win.flashFrame(true) },
    play: playSound,
    markTab: (tabId, reason) => send(IPC.evAttention, tabId, reason)
  })

  const openTab = (req: OpenTabRequest, activate = true): TabInfo | null => {
    try {
      return tabs.open(req, { activate })
    } catch (e) {
      toast(`Cannot open tab: ${(e as Error).message}`)
      return null
    }
  }

  // the tab opened by a no-argument start; replaced by a restore unless the user typed into it
  let autoTabId: string | null = null
  const openFromLaunch = (cmd: LaunchCommand): void => {
    if (cmd.kind === 'default') {
      if (tabs.list().length === 0) {
        const t = openTab({ kind: 'shell', cwd: homedir() })
        autoTabId = t?.id ?? null
      }
      return
    }
    const { cwd, warning } = resolveLaunchDir(cmd.dir, homedir(), isDirectory)
    if (warning) toast(warning)
    openTab(cmd.kind === 'claude' ? { kind: 'claude', cwd } : { kind: 'shell', cwd, profile: cmd.profile })
  }

  const runRestore = (): void => {
    const snap = previous
    if (!snap) return
    previous = null
    try {
      sessions.clearPrevious()
    } catch (e) {
      log.warn(`cannot remove previous session: ${(e as Error).message}`)
    }
    send(IPC.evRestore, null)
    if (autoTabId) {
      if (tabs.get(autoTabId)) tabs.close(autoTabId)
      autoTabId = null
    }
    let first: string | null = null
    for (const t of snap.tabs) {
      const { cwd, warning } = resolveLaunchDir(t.cwd, homedir(), isDirectory)
      if (warning) toast(warning)
      const opened = openTab(
        { kind: t.kind, cwd, profile: t.kind === 'shell' ? t.profile : null, title: t.title, resumeSessionId: t.kind === 'claude' ? t.claudeSessionId : null },
        false
      )
      if (opened && first === null) first = opened.id
    }
    if (first) tabs.activate(first)
  }

  const focusWindow =(): void => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    // Windows foreground lock: briefly going always-on-top lets a background process bring the window forward
    win.setAlwaysOnTop(true)
    win.focus()
    win.setAlwaysOnTop(false)
    if (!win.isFocused()) win.flashFrame(true)
  }

  app.on('second-instance', (_e, argv, _cwd, additionalData) => {
    const data = additionalData as { argv?: string[] } | null
    const cmd = parseArgs(data?.argv ?? argv)
    if (rendererReady) openFromLaunch(cmd)
    else pendingLaunches.push(cmd)
    focusWindow()
  })

  const updater = new Updater({
    backend: app.isPackaged && !isTest ? createUpdateBackend(autoUpdater, { testFeed: process.env.CLAUDETERM_UPDATE_URL, installOnQuit: process.platform === 'win32', log }) : null,
    currentVersion: app.getVersion(),
    enabled: () => settings.autoUpdate,
    publish: (s) => send(IPC.evUpdate, s),
    notify: (m) => { if (rendererReady) send(IPC.evToast, m) },
    beforeInstall: () => {
      sessions.flush()
      if (!writeUpdateMarker(dataDir, Date.now())) log.warn('cannot write the update restart marker')
    },
    log: (m) => log.info(m)
  })
  updater.start()

  // a socket left by a run that crashed would refuse the new one; a socket folder others can enter is never used
  const uid = process.getuid?.() ?? -1
  const pipeProblem = process.platform === 'win32' ? null : socketProblem(pipeName, { privateDir: socketDir({ platform: process.platform, env: {}, uid }), uid })
  if (pipeProblem) toast(`Claude tabs cannot report to ClaudeTerm (status, images, notifications): ${pipeProblem}`)
  else startPipeServer(pipeName, {
    showImage: async (msg) => {
      const check = await checkImageFile(msg.path, [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions])
      if (!check.ok) return { ok: false, error: check.error }
      const target = images.resolveTarget(msg.tabId, tabs.activeTabId())
      if (!target) return { ok: false, error: 'no open tabs in ClaudeTerm' }
      images.add(target, msg.path, 'shown', msg.caption)
      return { ok: true }
    },
    session: (msg) => {
      log.info(`session ${msg.source} tab=${msg.tabId} id=${msg.sessionId} transcript=${msg.transcriptPath ?? '-'}`)
      if (!tabs.setClaudeSession(msg.tabId, msg.sessionId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      statusHub.session(msg.tabId, msg.sessionId, msg.source)
      // compact keeps the open dialogs: the conversation goes on
      review.sessionStarted(msg.tabId, msg.sessionId, msg.source)
      if (msg.transcriptPath) attachTranscript(msg.tabId, msg.sessionId, msg.transcriptPath)
      return { ok: true }
    },
    status: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      statusHub.status(msg)
      return { ok: true }
    },
    subagent: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`subagent ${msg.event} tab=${msg.tabId} id=${msg.agentId} type=${msg.agentType}`)
      statusHub.subagent(msg)
      // an interrupted subagent never writes again: its end closes a dialog it left open
      if (msg.event === 'stop') review.subagentStopped(msg.tabId, msg.agentId)
      return { ok: true }
    },
    sessionEnd: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`session end tab=${msg.tabId} id=${msg.sessionId}`)
      statusHub.sessionEnd(msg.tabId, msg.sessionId)
      // a late SessionEnd of the session before /clear leaves the new one running
      review.sessionEnded(msg.tabId, msg.sessionId)
      return { ok: true }
    },
    attention: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      // Send must never press Enter into a dialog; the end of a turn is a moment to look at the changes
      if (msg.reason === 'done') review.turnEnded(msg.tabId)
      else review.dialogOpened(msg.tabId, msg.agentId ?? null)
      const signalled = attention.notify(msg.tabId, msg.reason)
      log.info(`attention ${msg.reason} tab=${msg.tabId}${signalled ? '' : ' (seen)'}`)
      return { ok: true }
    },
    turn: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      review.turn(msg.tabId, msg.sessionId, msg.cwd)
      return { ok: true }
    },
    editBefore: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      // the reply lets the edit go ahead: the file is read before it
      review.recordBefore(msg.tabId, msg.sessionId, msg.toolUseId, msg.path)
      return { ok: true }
    },
    showDiff: (msg) => review.showRequest(msg.tabId, { cwd: msg.cwd, scope: msg.scope, from: msg.from, to: msg.to, paths: msg.paths, title: msg.title })
  })
    .then((h) => { pipe = h })
    .catch((e: unknown) => log.error(`pipe server failed: ${String(e)}`))

  if (app.isPackaged && process.env.CLAUDETERM_SKIP_MCP_REGISTER !== '1') {
    void ensureMcpRegistered({ run: execRunner, execPath: process.execPath, serverScript: resourcePath('mcp/show-image-server.js'), log: (m) => log.warn(m), resolve: () => findingClaude })
      .then((r) => log.info(`mcp registration: ${r}`))
  }

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || 0 : null, test: isTest, homeDir: homedir(), version: app.getVersion() }))
  ipcMain.on(IPC.rendererReady, () => {
    rendererReady = true
    for (const n of startupNotices.splice(0)) send(IPC.evToast, n)
    for (const cmd of pendingLaunches.splice(0)) openFromLaunch(cmd)
    if (restoreAfterUpdate) runRestore()
  })
  ipcMain.on(IPC.bell, (_e, tabId: unknown) => { if (isId(tabId) && tabs.get(tabId)) attention.notify(tabId, 'bell') })
  ipcMain.handle(IPC.tabsOpen, (_e, req: OpenTabRequest) => openTab(req))
  ipcMain.handle(IPC.sessionsList, async (): Promise<RecentSession[]> => {
    const list = await history.list(100)
    listedSessions = new Map(list.map((s) => [s.id, s]))
    const open = new Set(tabs.list().map((t) => t.claudeSessionId))
    return list.map((s) => ({ ...s, open: open.has(s.id) }))
  })
  ipcMain.on(IPC.sessionsOpen, (_e, id: unknown) => {
    const s = isId(id) ? listedSessions.get(id) : undefined
    if (!s) return
    const tab = tabs.list().find((t) => t.claudeSessionId === s.id)
    if (tab) {
      tabs.activate(tab.id)
      return
    }
    // Claude Code finds a conversation by its folder: resuming it anywhere else fails
    if (!isDirectory(s.cwd)) {
      toast(`The folder of this session no longer exists: ${s.cwd}`)
      return
    }
    openTab({ kind: 'claude', cwd: s.cwd, resumeSessionId: s.id })
  })
  ipcMain.on(IPC.tabsClose, (_e, id: unknown) => {
    if (!isId(id)) return
    tabs.close(id)
    if (tabs.list().length === 0) win?.close()
  })
  ipcMain.on(IPC.tabsActivate, (_e, id: unknown) => { if (isId(id)) tabs.activate(id) })
  ipcMain.on(IPC.tabsRename, (_e, id: unknown, title: unknown) => { if (isId(id) && isOptionalTitle(title)) tabs.rename(id, title) })
  ipcMain.on(IPC.tabsReorder, (_e, ids: unknown) => { if (isIdList(ids)) tabs.reorder(ids) })
  ipcMain.on(IPC.tabsRestart, (_e, id: unknown, live: unknown) => {
    if (isId(id)) tabs.restart(id, { live: live === true }).catch((e: Error) => log.warn(`cannot restart tab: ${e.message}`))
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: unknown, data: unknown) => {
    if (!isId(id) || !isPtyData(data)) return
    if (id === autoTabId && isUserInput(data)) autoTabId = null
    tabs.write(id, data)
  })
  ipcMain.on(IPC.ptyResize, (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (isId(id) && isPtySize(cols, rows)) tabs.resize(id, cols as number, rows as number)
  })
  ipcMain.handle(IPC.imagesList, (_e, tabId: unknown): ImagesUpdate => (isId(tabId) ? imagesUpdate(tabId) : { tabId: '', cards: [], unseen: 0, notice: null }))
  ipcMain.on(IPC.reviewSetScope, (_e, tabId: unknown, scope: unknown) => { if (isId(tabId) && isReviewScope(scope)) review.setScope(tabId, scope) })
  ipcMain.on(IPC.reviewClearRequest, (_e, tabId: unknown) => { if (isId(tabId)) review.clearRequest(tabId) })
  ipcMain.on(IPC.reviewRefresh, (_e, tabId: unknown) => { if (isId(tabId)) review.refresh(tabId) })
  ipcMain.on(IPC.reviewSetViewed, (_e, tabId: unknown, path: unknown, hash: unknown, viewed: unknown) => {
    if (isId(tabId) && isAbsPath(path) && isHash(hash) && typeof viewed === 'boolean') review.setViewed(tabId, path, hash, viewed)
  })
  ipcMain.on(IPC.reviewShowFile, (_e, tabId: unknown, path: unknown) => { if (isId(tabId) && isAbsPath(path)) review.showFile(tabId, path) })
  // only a file the tab's view shows; without an editor the file is shown in its folder, never opened: that could run it
  ipcMain.on(IPC.reviewOpenEditor, (_e, tabId: unknown, path: unknown, line: unknown) => {
    if (!isId(tabId) || !isAbsPath(path) || !isLineNo(line) || !review.hasFile(tabId, path)) return
    launchEditor(settings.review.editor, path, line, { spawn: spawnDetached, reveal: (p) => shell.showItemInFolder(p), onError: toast })
  })
  ipcMain.handle(IPC.reviewCanSend, (_e, tabId: unknown) => (isId(tabId) ? review.canSend(tabId) : { ok: false, reason: NOT_RUNNING }))
  ipcMain.on(IPC.imagesMarkSeen, (_e, tabId: unknown) => { if (isId(tabId)) images.markSeen(tabId) })
  ipcMain.on(IPC.imagesAction, (_e, cardId: unknown, action: unknown) => {
    if (!isId(cardId) || !isImageAction(action)) return
    const card = images.get(cardId)
    if (!card) return
    switch (action) {
      case 'open':
        void shell.openPath(card.path)
        break
      case 'reveal':
        shell.showItemInFolder(card.path)
        break
      case 'copy-image': {
        const img = nativeImage.createFromPath(card.path)
        if (img.isEmpty()) {
          toast(`Cannot copy this image format: ${card.path}`)
          break
        }
        const png = img.toPNG()
        clipboard
          .write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
          .catch((e: unknown) => toast(`Cannot copy image: ${String(e)}`))
        break
      }
      case 'copy-path':
        void clipboard.writeText(card.path)
        break
      case 'remove':
        images.remove(cardId)
        break
    }
  })
  ipcMain.handle(IPC.restoreGet, () => restoreInfo())
  ipcMain.on(IPC.restoreRun, () => runRestore())
  ipcMain.on(IPC.updateCheck, () => { void updater.check(true) })
  ipcMain.on(IPC.updateInstall, () => updater.install())
  ipcMain.handle(IPC.updateGet, () => updater.current)
  ipcMain.handle(IPC.profilesList, () => profiles.map((p) => p.name))
  ipcMain.handle(IPC.settingsGet, () => settings)
  ipcMain.on(IPC.settingsOpen, () => { void shell.openPath(settingsPath) })
  ipcMain.handle(IPC.settingsView, () => settingsView())
  ipcMain.handle(IPC.settingsSet, (_e, key: unknown, value: unknown): SetSettingResult => {
    if (!isSettingKey(key) || !isSettingValue(value)) return { ok: false, error: 'Not a setting' }
    let text: string | null = null
    try {
      text = readFileSync(settingsPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: `Cannot read settings.json: ${(e as Error).message}` }
    }
    const edited = applySettingEdit(text, key, value)
    if (!edited.ok) return edited
    try {
      writeFileSync(settingsPath, edited.text, 'utf8')
    } catch (e) {
      return { ok: false, error: `Cannot save settings.json: ${(e as Error).message}` }
    }
    appliedText = edited.text
    // apply now; the watcher sees the same text a moment later and leaves it
    reloadSettings()
    return { ok: true }
  })
  ipcMain.handle(IPC.settingsPickSound, async (e): Promise<string | null> => {
    if (isTest && process.env.CLAUDETERM_TEST_PICK_SOUND) return process.env.CLAUDETERM_TEST_PICK_SOUND
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = { title: 'Choose a sound', filters: [{ name: 'Sounds', extensions: ['wav'] }], properties: ['openFile'] }
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  ipcMain.on(IPC.settingsPlaySound, () => playSound(settings.notifications.sound))
  const settingsWindow = new SettingsWindow({
    parent: () => win,
    preload: join(__dirname, '../preload/index.js'),
    // the installed app takes its icon from ClaudeTerm.exe; dev and test runs use electron.exe's own
    icon: app.isPackaged ? undefined : join(__dirname, '..', '..', 'build', 'icon.png'),
    load: (w) => {
      if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
      else void w.loadFile(join(__dirname, '../renderer/settings.html'))
    }
  })
  ipcMain.on(IPC.settingsOpenWindow, () => settingsWindow.open())
  ipcMain.handle(IPC.clipboardRead, async (): Promise<ClipboardContent> => ({ text: await clipboard.readText(), hasImage: await clipboard.has('image/png') }))
  ipcMain.on(IPC.clipboardWriteText, (_e, text: string) => { void clipboard.writeText(text) })
  ipcMain.on(IPC.openExternal, (_e, url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) })

  const settingsView = (): SettingsView => ({
    settings,
    profiles: profiles.map((p) => p.name),
    path: settingsPath,
    problems: lastLoad.errors,
    locked: Boolean(lastLoad.failed || lastLoad.broken)
  })
  /** the text the settings in use came from, when the app wrote it or the watcher read it */
  let appliedText: string | null = null
  const readSettingsText = (): string | null => {
    try {
      return readFileSync(settingsPath, 'utf8')
    } catch {
      return null
    }
  }
  const reloadSettings = (): void => {
    const next = loadSettingsSafe(settingsPath)
    lastLoad = next
    let notices = next.errors
    // a file that cannot be read keeps the current settings
    if (!next.failed) {
      const hideIgnored = settings.review.hideIgnored
      settings = next.settings
      const computed = computeProfiles(settings)
      profiles = computed.profiles
      notices = [...notices, ...computed.notices]
      send(IPC.evSettings, settings)
      // the active tab's Last turn and Session views list other files now
      const active = tabs.activeTabId()
      if (hideIgnored !== settings.review.hideIgnored && active) review.refresh(active)
    }
    for (const n of notices) if (!lastNotices.includes(n)) toast(n)
    lastNotices = notices
    broadcast(IPC.evSettingsView, settingsView())
  }
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const settingsWatcher = watch(dataDir, (_event, file) => {
    if (file !== 'settings.json') return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      // the echo of the app's own save: those settings are already in use
      const text = readSettingsText()
      if (text !== null && text === appliedText) return
      appliedText = text
      reloadSettings()
    }, 300)
  })
  settingsWatcher.on('error', (e) => {
    log.warn(`settings watcher stopped: ${e.message}`)
    settingsWatcher.close()
  })

  const windowStatePath = join(dataDir, 'window-state.json')
  const state = loadWindowState(windowStatePath)
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 480,
    minHeight: 300,
    show: false,
    backgroundColor: '#0C0C0C',
    autoHideMenuBar: true,
    title: 'ClaudeTerm',
    // the installed app takes its icon from ClaudeTerm.exe; dev and test runs use electron.exe's own
    ...(app.isPackaged ? {} : { icon: join(__dirname, '..', '..', 'build', 'icon.png') }),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (state.maximized) win.maximize()
  trackWindowState(win, windowStatePath)
  win.on('close', () => sessions.flush())
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => {
    win?.flashFrame(false)
    const id = tabs.activeTabId()
    if (id) review.trigger(id)
  })
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  app.on('window-all-closed', () => app.quit())
  let ptysExited = false
  app.on('before-quit', (e) => {
    if (ptysExited) return
    updater.stop()
    sessions.flush()
    for (const id of [...sources.keys()]) stopTabImages(id)
    for (const t of imageTimers.values()) clearTimeout(t)
    imageTimers.clear()
    tabs.disposeAll()
    review.dispose()
    settingsWatcher.close()
    void pipe?.close()
    // Quitting while ConPTY sessions are still shutting down keeps the process alive for seconds after the
    // window is gone (indefinitely on some machines): let the killed PTYs exit first, then quit for real.
    e.preventDefault()
    void allPtysExited(3000).then(() => {
      ptysExited = true
      app.quit()
    })
  })
}
