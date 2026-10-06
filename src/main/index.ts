import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, watch } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type AppInfo, type ClipboardContent, type ImagesUpdate, type RestoreInfo } from '../shared/ipc'
import type { OpenTabRequest, ProfileDef, Settings, TabInfo } from '../shared/types'
import { parseArgs, resolveLaunchDir, type LaunchCommand } from './args'
import { Attention } from './attention'
import { autoUpdater } from 'electron-updater'
import { writeClaudeTabFiles } from './claude-tab-settings'
import { buildChildEnv } from './child-env'
import { initDataDir, resolvePipeName } from './data-dir'
import { isId, isIdList, isImageAction, isOptionalTitle, isPtyData, isPtySize, isUserInput } from './ipc-guards'
import { checkImageFile, DEFAULT_IMAGE_EXTENSIONS } from '../shared/image-file'
import { ImageHub } from './image-hub'
import { sessionTempDir, shouldWatchDir, watchImages, type ImageWatcherHandle } from './image-watcher'
import { handleImgProtocol, registerImgScheme } from './img-protocol'
import { createLogger } from './log'
import { ensureMcpRegistered, execRunner, resolveClaude, type ClaudeCli } from './mcp-registrar'
import { startPipeServer, type PipeServerHandle } from './pipe-server'
import { buildLaunch, detectProfiles, filterAvailable, mergeProfiles, pickClaudeProfile, pickProfile, systemDetectDeps } from './profiles'
import { allPtysExited, spawnPty } from './pty-host'
import { resourcePath } from './resources'
import { loadSettingsSafe } from './settings'
import { SessionStore } from './session-store'
import { createSoundPlayer } from './sound'
import { StatusHub } from './status-hub'
import { TabManager } from './tab-manager'
import { readAgentMeta } from './transcript-agent-info'
import { consumeUpdateMarker, writeUpdateMarker } from './update-marker'
import { Updater } from './updater'
import { createUpdateBackend } from './update-backend'
import { cleanupImageCache, TranscriptFeed } from './transcript-feed'
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
  const toast = (message: string): void => {
    log.warn(message)
    if (rendererReady) send(IPC.evToast, message)
    else startupNotices.push(message)
  }

  const computeProfiles = (s: Settings): ProfileDef[] => {
    const { available, missing } = filterAvailable(s.profiles, existsSync)
    for (const p of missing) toast(`Profile "${p.name}" not found: ${p.command}`)
    return mergeProfiles(detectProfiles(systemDetectDeps()), available)
  }

  const loaded = loadSettingsSafe(settingsPath)
  let settings: Settings = loaded.settings
  if (loaded.failed) log.error(loaded.errors[0])
  startupNotices.push(...loaded.errors)
  let profiles = computeProfiles(settings)
  const claudeFiles = writeClaudeTabFiles(dataDir, process.execPath, resourcePath('hook/session-hook.js'))
  const sessions = new SessionStore(dataDir, { onError: (m) => log.warn(m) })
  // the previous run restarted into an update: reopen its tabs without asking
  const restoreAfterUpdate = consumeUpdateMarker(dataDir, Date.now())
  let previous = sessions.rotateOnStartup({ afterUpdate: restoreAfterUpdate })
  const restoreInfo = (): RestoreInfo | null =>
    previous ? { tabs: previous.tabs.length, claudeTabs: previous.tabs.filter((t) => t.kind === 'claude').length, savedAt: previous.savedAt } : null

  const imageCacheRoot = join(tmpdir(), 'ClaudeTerm', 'images')
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
    cwdWatcher: ImageWatcherHandle | null
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
    env: process.env,
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

  const watchDir = (tabId: string, dir: string, which: 'cwdWatcher' | 'tempWatcher'): ImageWatcherHandle => {
    const handle: ImageWatcherHandle = watchImages(dir, settings.imageWatch, {
      added: (p) => images.add(tabId, p, 'created', null),
      changed: (p) => images.add(tabId, p, 'created', null, undefined, true),
      removed: (p) => images.markDeleted(tabId, p),
      error: (err) => {
        log.warn(`watcher ${dir}: ${err.message}`)
        const s = sources.get(tabId)
        // ignore a late error from a watcher that was already replaced
        if (s && s[which] && s[which] !== handle) return
        if (s) {
          void s[which]?.close()
          s[which] = null
        }
        images.setNotice(tabId, `Stopped watching for new images: ${err.message}`)
      }
    })
    return handle
  }

  const startTabImages = (tab: TabInfo): void => {
    images.addTab(tab.id, tab.cwd)
    const s: TabImageSources = { cwdWatcher: null, tempWatcher: null, feed: null, transcriptPath: null }
    sources.set(tab.id, s)
    if (tab.kind !== 'claude' || !settings.imageWatch.enabled) return
    if (shouldWatchDir(tab.cwd, homedir())) s.cwdWatcher = watchDir(tab.id, tab.cwd, 'cwdWatcher')
    else images.setNotice(tab.id, 'Not watching this folder for new images')
  }

  const stopTabImages = (tabId: string): void => {
    const s = sources.get(tabId)
    if (s) {
      void s.cwdWatcher?.close()
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
    if (!s || s.transcriptPath?.toLowerCase() === transcriptPath.toLowerCase()) return
    s.feed?.stop()
    void s.tempWatcher?.close()
    s.tempWatcher = null
    s.transcriptPath = transcriptPath
    s.feed = new TranscriptFeed({
      transcriptPath,
      sessionId,
      cacheRoot: imageCacheRoot,
      fileExists: existsSync,
      onImage: (img) => images.add(tabId, img.path, img.source, img.caption, img.at ?? undefined),
      onError: (m) => log.warn(m),
      onSubagentInfo: (agentId, info) => statusHub.subagentInfo(tabId, agentId, info)
    })
    s.feed.start()
    if (!settings.imageWatch.enabled) return
    const temp = sessionTempDir(transcriptPath, sessionId, tmpdir())
    try {
      mkdirSync(temp, { recursive: true })
      s.tempWatcher = watchDir(tabId, temp, 'tempWatcher')
    } catch (e) {
      log.warn(`cannot watch ${temp}: ${(e as Error).message}`)
    }
  }

  handleImgProtocol(images, () => [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions])

  let claudeCli: ClaudeCli | null | undefined
  void resolveClaude(execRunner).then((cli) => { claudeCli = cli })

  const tabs = new TabManager({
    onTabStarted: startTabImages,
    onTabClosed: (tabId) => {
      stopTabImages(tabId)
      stopTabStatus(tabId)
      attention.removeTab(tabId)
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
    resumable: (tabId) => {
      const p = sources.get(tabId)?.transcriptPath
      return p ? existsSync(p) : true
    },
    events: {
      opened: (t) => send(IPC.evTabOpened, t),
      updated: (t) => send(IPC.evTabUpdated, t),
      closed: (id) => send(IPC.evTabClosed, id),
      activated: (id) => send(IPC.evTabActivated, id),
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
    settings: () => settings.attention,
    flash: () => { if (win && !win.isDestroyed()) win.flashFrame(true) },
    play: playSound,
    markTab: (tabId) => send(IPC.evAttention, tabId)
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
    backend: app.isPackaged && !isTest ? createUpdateBackend(autoUpdater, { testFeed: process.env.CLAUDETERM_UPDATE_URL, log }) : null,
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

  startPipeServer(pipeName, {
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
      return { ok: true }
    },
    sessionEnd: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`session end tab=${msg.tabId} id=${msg.sessionId}`)
      statusHub.sessionEnd(msg.tabId, msg.sessionId)
      return { ok: true }
    },
    attention: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      const signalled = attention.notify(msg.tabId)
      log.info(`attention ${msg.reason} tab=${msg.tabId}${signalled ? '' : ' (seen)'}`)
      return { ok: true }
    }
  })
    .then((h) => { pipe = h })
    .catch((e: unknown) => log.error(`pipe server failed: ${String(e)}`))

  if (app.isPackaged && process.env.CLAUDETERM_SKIP_MCP_REGISTER !== '1') {
    void ensureMcpRegistered({ run: execRunner, execPath: process.execPath, serverScript: resourcePath('mcp/show-image-server.js'), log: (m) => log.warn(m) })
      .then((r) => log.info(`mcp registration: ${r}`))
  }

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ windowsBuild: Number(release().split('.')[2]) || 0, test: isTest, homeDir: homedir(), version: app.getVersion() }))
  ipcMain.on(IPC.rendererReady, () => {
    rendererReady = true
    for (const n of startupNotices.splice(0)) send(IPC.evToast, n)
    for (const cmd of pendingLaunches.splice(0)) openFromLaunch(cmd)
    if (restoreAfterUpdate) runRestore()
  })
  ipcMain.on(IPC.bell, () => { if (win && !win.isFocused()) win.flashFrame(true) })
  ipcMain.handle(IPC.tabsOpen, (_e, req: OpenTabRequest) => openTab(req))
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
  ipcMain.handle(IPC.clipboardRead, async (): Promise<ClipboardContent> => ({ text: await clipboard.readText(), hasImage: await clipboard.has('image/png') }))
  ipcMain.on(IPC.clipboardWriteText, (_e, text: string) => { void clipboard.writeText(text) })
  ipcMain.on(IPC.openExternal, (_e, url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) })

  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const settingsWatcher = watch(dataDir, (_event, file) => {
    if (file !== 'settings.json') return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      const next = loadSettingsSafe(settingsPath)
      if (next.failed) {
        // keep the current settings
        for (const err of next.errors) toast(err)
        return
      }
      settings = next.settings
      profiles = computeProfiles(settings)
      for (const err of next.errors) toast(err)
      send(IPC.evSettings, settings)
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
  win.on('focus', () => win?.flashFrame(false))
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
