import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, powerSaveBlocker, safeStorage, screen, shell, type Rectangle } from 'electron'
import { randomUUID } from 'node:crypto'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir, hostname, release, tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import type { AccountResult, AccountsView } from '../shared/accounts'
import { IPC, type AppInfo, type ClipboardContent, type ImageAction, type ImagesUpdate, type PlanUpdate, type RestoreInfo, type SetSettingResult, type SettingsView } from '../shared/ipc'
import type { DocRead } from '../shared/docs'
import { checkDocFile, docStamp, readDocText } from '../shared/doc-file'
import { DEVICE_COPY, type ActiveDevicesView, type DeviceResult, type DevicePlatform, type DevicesView, MAX_DEVICE_NAME } from '../shared/devices'
import { socketDir } from '../shared/protocol'
import { describeTaskList, taskListSummary } from '../shared/task-list'
import { isSettingKey, isSettingValue } from '../shared/settings-keys'
import type { NotificationCase, OpenTabRequest, ProfileDef, RecentSession, SessionSummary, Settings, TabInfo, TabLayout, TabPlace } from '../shared/types'
import { MAX_SNAPSHOT_BYTES, MAX_TRANSFER_FILES, REMOTE_COPY, type DeviceAnswer, type DeviceChoices, type FolderResult, type PushKind, type RemoteDeviceView } from '../shared/remote'
import { AccountStore, accountLaunch, electronVault, nodeAccountFile } from './accounts'
import { parseArgs, resolveLaunchDir, type LaunchCommand } from './args'
import { Attention } from './attention'
import { badgeDescription, dotBitmap } from './app-badge'
import { AutoContinue, type RestoreCut } from './auto-continue'
import { PromptQueries } from './prompt-query'
import { autoUpdater } from 'electron-updater'
import { statusRefreshInterval, writeClaudeTabFiles } from './claude-tab-settings'
import { buildChildEnv } from './child-env'
import { initDataDir, resolvePipeName } from './data-dir'
import { isAbsPath, isAccountRef, isAddressInput, isDeviceId, isDeviceNameInput, isDocAction, isDropPaths, isFolderInput, isGeneration, isHash, isId, isIdList, isFlag, isImageAction, isLineNo, isLineSpan, isLocalDropPaths, isNoteForm, isNoteText, isOpenRemoteTabArgs, isOpenTabRequest, openTabRequestFields, isOptionalAddress, isOptionalTitle, isPairCodeInput, isPanelWidth, isPathText, isPromptInput, isPtyData, isPtySize, isReviewScope, isSeedText, isSeedToken, isSessionId, isTabCount, isTabLayoutChange, isUserInput } from './ipc-guards'
import { NOT_RUNNING, type ReviewUpdate } from '../shared/review'
import { EditLedger } from './edit-ledger'
import { launchEditor, nodeRevealDeps, revealInFolder, spawnDetached } from './editor-launch'
import { ReviewHub } from './review-hub'
import { DocHub, htmlFolderRefused } from './doc-hub'
import { DOC_SCHEME_PRIVILEGES, frameNavigationAllowed, handleDocProtocol } from './doc-protocol'
import { createSources, nodeIo } from './review-sources'
import { checkShowableFile, DEFAULT_IMAGE_EXTENSIONS, MEDIA_EXTENSIONS } from '../shared/image-file'
import { ImageHub, showImageFile } from './image-hub'
import { openCard } from './image-open'
import { CLAUDE_CLIPBOARD_CHECK, checkOnce, runsCleanly } from './image-paste'
import { claudeTempRoot, realTempRoot, sessionTempDir, watchImages, type ImageWatcherHandle } from './image-watcher'
import { handleImgProtocol, registerImgScheme, remoteCardSource } from './img-protocol'
import { createLogger } from './log'
import { PanelRoom } from './panel-room'
import { findExecutable, isExecutableFile } from './login-env'
import { macMenuTemplate } from './mac-menu'
import { bundleOf, createMacUpdateBackend, feedFileUrl, prepareUpdate, releasePage, startSwap } from './mac-update'
import { ensureMcpRegistered, execRunner, resolveClaude, resolveClaudePosix, type ClaudeCli } from './mcp-registrar'
import { anchorExe, findGitBash, MsysAnchor, spawnAnchor } from './msys-anchor'
import { execGit } from './git-source'
import { changeFolderOf, folderListingOf, type TabFolderDeps } from './folder-browse'
import { pathKey } from './path-key'
import { startPipeServer, type PipeServerHandle } from './pipe-server'
import { buildLaunch, detectInstalledProfiles, loginShell, pickClaudeProfile, pickProfile, profileResolver, typedPaths } from './profiles'
import { allPtysExited, spawnPty } from './pty-host'
import { resourcePath } from './resources'
import { applySettingEdit, loadSettingsSafe, type ParsedSettings } from './settings'
import { Coalescer } from './coalesce'
import { SettingsWindow } from './settings-window'
import { claudeProjectsDir, SessionHistory } from './session-history'
import { SessionStore } from './session-store'
import { StarredSessions } from './starred-sessions'
import { NoteHub } from './note-hub'
import { SessionNotes } from './session-notes'
import { TaskListHub, shownPlan } from './task-list-hub'
import { TaskListStore } from './task-list-store'
import { TurnOrigins } from './turn-origins'
import { TabLayoutStore } from './tab-layout'
import { localAddresses } from './sync/address'
import { formatDeviceStatus } from './sync/device-status'
import { PortMirrors, screenWorkerPath } from './sync/mirror-port'
import screenWorkerFile from './sync/screen-worker?modulePath'
import type { PeerLink } from './sync/peer-link'
import { nextTurn } from './sync/tab-host'
import { KeepAwake, type PowerBlocker } from './sync/keep-awake'
import { Presence } from './sync/presence'
import { RemoteImages, remoteTabInfo } from './sync/remote-actions'
import { sendFiles } from './sync/file-sender'
import { fileToSend, RemoteCopies } from './sync/outgoing-files'
import { FileReceiver, receivedPeerGone, receivedRoot } from './sync/file-receiver'
import { CallError } from './sync/calls'
import { TabAttention, TabInputs } from './sync/tab-directory'
import { type AppliedSize, TabSizes } from './sync/tab-sizes'
import type { ViewerEvents } from './sync/tab-viewer'
import type { HelloMessage } from './sync/wire'
import { DeviceGroup } from './sync/device-group'
import { StoreBridge } from './sync/store-bridge'
import { socketProblem } from './socket-file'
import { createSoundPlayer, linuxSoundDeps, macSoundDeps, startPlayer, wavPlayer } from './sound'
import { StatusHub } from './status-hub'
import { PlanHub, readPlanFile } from './plan-hub'
import { TabManager } from './tab-manager'
import { TabPlaces } from './tab-places'
import { clampPush, hostHandlers, hostTabs, planPush, pruneListedMembers, reviewPushes, withoutTabId, type HostContext } from './remote-host'
import { clearFlag, frontClears, presentViewers, RemoteFront } from './remote-front'
import { RemoteHolder, type RemoteHolderDeps } from './remote-holder'
import { readAgentMeta } from './transcript-agent-info'
import { consumeFailedUpdate, consumeUpdateMarker, FAILED_UPDATE, writeUpdateMarker } from './update-marker'
import { Updater, type UpdaterBackend } from './updater'
import { createUpdateBackend } from './update-backend'
import { cleanupImageCache, findTranscript, TranscriptFeed } from './transcript-feed'
import { showWindow } from './window-show'
import { loadWindowState, trackWindowState } from './window-state'

const dataDir = initDataDir()
const log = createLogger(join(dataDir, 'logs'))
const pipeName = resolvePipeName()
const settingsPath = join(dataDir, 'settings.json')
const isTest = process.env.CLAUDETERM_TEST === '1'
/** what a test run reads back from the main process: the window it would have brought forward, the badge it set */
const testState = globalThis as { ctFocusRequests?: number; ctBadgeCount?: number }

registerImgScheme([DOC_SCHEME_PRIVILEGES])

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

const MIN_WIDTH = 480

/** Sets the window's bounds and waits for its resize, which may come after the call, or never when a window manager keeps the size. */
function resizeWindow(win: BrowserWindow, r: Rectangle): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      win.off('resize', done)
      resolve()
    }
    const timer = setTimeout(done, 300)
    win.on('resize', done)
    win.setBounds(r)
  })
}

function bootstrap(): void {
  // Windows and Linux: no menu bar; macOS gets its own below, once the settings window can open
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
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
  const liveWin = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null)
  const panelRoom = new PanelRoom({
    bounds: () => liveWin()?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
    setBounds: (r) => {
      const w = liveWin()
      return w ? resizeWindow(w, r) : Promise.resolve()
    },
    workArea: () => screen.getDisplayMatching(liveWin()?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }).workArea,
    pinned: () => Boolean(liveWin()?.isMaximized() || liveWin()?.isFullScreen()),
    minWidth: MIN_WIDTH
  }, () => settings.sidePanel.noRoom)
  const refitPanel = (): void => { void panelRoom.refit().then((mode) => send(IPC.evPanelMode, mode)) }
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
  const hookScript = resourcePath('hook/session-hook.js')
  const claudeFiles = writeClaudeTabFiles(dataDir, process.execPath, hookScript, statusRefreshInterval(settings.claude))
  const sessions = new SessionStore(dataDir, { onError: (m) => log.warn(m) })
  // the previous run restarted into an update: reopen its tabs without asking
  const restoreAfterUpdate = consumeUpdateMarker(dataDir, Date.now())
  let previous = sessions.rotateOnStartup({ afterUpdate: restoreAfterUpdate })
  const history = new SessionHistory(claudeProjectsDir(process.env, homedir()))
  const starred = new StarredSessions(dataDir, toast)
  const tabLayout = new TabLayoutStore(dataDir, toast)
  const notes = new SessionNotes(dataDir, { onError: (m) => log.warn(m), warn: toast })
  const noteHub = new NoteHub({ store: notes, publish: (tabId, note, generation) => send(IPC.evNote, tabId, note, generation) })
  const taskListStore = new TaskListStore(dataDir, { onError: (m) => log.warn(m), warn: toast })
  // the side of a tab's plan and list that changed last: with both finished, the one that finished later shows
  const newerSide = new Map<string, 'plan' | 'list'>()
  // the list Claude keeps for the status bar; each change goes out through sendPlan, with the plan
  const taskLists = new TaskListHub({
    store: taskListStore,
    onChange: (tabId) => {
      if (taskLists.status(tabId)) newerSide.set(tabId, 'list')
      sendPlan(tabId)
    }
  })
  const accounts = new AccountStore(nodeAccountFile(join(dataDir, 'accounts.json')), electronVault(safeStorage, process.platform), { onError: (m) => log.warn(m) })
  /** how a message names an account */
  const accountName = (id: string): string => {
    const name = accounts.nameOf(id)
    return name ? `Account "${name}"` : 'The account'
  }
  // what the window was last shown; opening looks the id up here, so the renderer only passes an id
  let listedSessions = new Map<string, SessionSummary>()
  const restoreInfo = (): RestoreInfo | null =>
    previous ? { tabs: previous.tabs.length, claudeTabs: previous.tabs.filter((t) => t.kind === 'claude').length, savedAt: previous.savedAt } : null

  const imageCacheRoot = join(tmpdir(), 'ClaudeTerm', 'images')
  const tempRoot = claudeTempRoot({ platform: process.platform, env: process.env, tmpdir: tmpdir(), uid: process.getuid?.() ?? -1 })
  const claudeRoot = process.platform === 'win32' ? tempRoot : realTempRoot(tempRoot, realpathSync)
  cleanupImageCache(imageCacheRoot, 7 * 24 * 60 * 60 * 1000)
  // clipboard images pasted into a tab as files; Claude Code reads one as its path is pasted
  const clipboardImageRoot = join(tmpdir(), 'ClaudeTerm', 'clipboard')
  cleanupImageCache(clipboardImageRoot, 7 * 24 * 60 * 60 * 1000)
  // files pasted or dropped into a remote tab arrive here, each in a folder of its own; a test sets the root
  const receivedFolder = isTest ? process.env.CLAUDETERM_TEST_RECEIVED_ROOT || join(dataDir, 'received') : receivedRoot({ platform: process.platform, tmpdir: tmpdir(), uid: process.getuid?.() ?? -1 })
  const receiver = new FileReceiver({ root: receivedFolder, log: (m) => log.warn(m) })
  void receiver.cleanup(7 * 24 * 60 * 60 * 1000)
  const peerGoneReceived = receivedPeerGone(receiver)
  const imageTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const images = new ImageHub({
    maxItems: () => settings.imagePanel.maxItems,
    // coalesce bursts (e.g. transcript history on --resume) into one update per tab
    onChange: (tabId) => {
      if (imageTimers.has(tabId)) return
      imageTimers.set(tabId, setTimeout(() => {
        imageTimers.delete(tabId)
        const update = imagesUpdate(tabId)
        send(IPC.evImages, update)
        pushToMembers(tabId, 'images', { cards: update.cards, unseen: update.unseen, notice: update.notice })
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
  // what started each turn of a tab's conversation, from its transcript: the end of a turn another session started is its own signal
  const turns = new TurnOrigins()

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
        const status = statusHub.get(tabId)
        // past the end of a turn, the agents still running are the work Claude left in the background
        tabs.setAgentsRunning(tabId, status.agents.length > 0)
        // the session snapshot keeps it: a restore must wake a conversation whose background work stopped with ClaudeTerm
        tabs.setBackgroundWork(tabId, status.background.length > 0)
        send(IPC.evStatus, status)
        pushToMembers(tabId, 'status', { main: status.main, agents: status.agents, background: status.background })
      }, 50))
    }
  })

  // the status bar's plan segment: the superpowers plan, or else the list Claude keeps; every evPlan goes through here, and
  // the members attached to the tab get the same plan with the same flag
  const shownPlanOf = (tabId: string): PlanUpdate => ({ tabId, ...shownPlan(planHub.get(tabId).plan, taskLists.status(tabId), newerSide.get(tabId) ?? 'plan') })
  const sendPlan = (tabId: string): void => {
    const shown = shownPlanOf(tabId)
    send(IPC.evPlan, shown)
    pushToMembers(tabId, 'plan', planPush(shown))
  }
  const planHub = new PlanHub({
    read: readPlanFile,
    onChange: (tabId) => {
      if (planHub.get(tabId).plan) newerSide.set(tabId, 'plan')
      sendPlan(tabId)
    }
  })
  setInterval(() => void planHub.refresh(), 1000)

  // a test run can have each sound written to a file instead of played
  const testSoundLog = isTest ? process.env.CLAUDETERM_TEST_SOUND_LOG : undefined
  const playSound = testSoundLog
    ? (sound: string): void => appendFileSync(testSoundLog, `${sound}\n`)
    : createSoundPlayer({
      ...(process.platform === 'win32'
        ? { player: (f: string) => wavPlayer(f, process.env), systemSound: null }
        : process.platform === 'darwin'
          ? macSoundDeps(process.env, existsSync)
          : linuxSoundDeps(process.env, (cmd) => findExecutable(cmd, process.env.PATH ?? '', isExecutableFile) !== null, existsSync)),
      beep: () => shell.beep(),
      spawn: startPlayer,
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
    // the cards of this watcher belong to the folder the tab is in now: a folder change drops a card that lands after it
    const gen = images.generation(tabId)
    const handle: ImageWatcherHandle = watchImages(dir, { ...settings.imageWatch, extensions: [...settings.imageWatch.extensions, ...MEDIA_EXTENSIONS] }, {
      added: (p) => images.add(tabId, p, 'created', null, undefined, false, gen),
      changed: (p) => images.add(tabId, p, 'created', null, undefined, true, gen),
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
    remoteFront: (tabId) => [...remoteFronts.values()].some((f) => f.tabId === tabId),
    publish: (u) => {
      const rev = ++reviewCounter
      lastReviews.set(u.tabId, u)
      reviewRevs.set(u.tabId, rev)
      send(IPC.evReview, u)
      pushReviewToMembers(u.tabId, withoutTabId(u), rev).catch((err: unknown) => log.warn(`review push failed: ${String(err)}`))
    },
    onError: (m) => log.warn(m),
    hideIgnored: () => settings.review.hideIgnored,
    testPatterns: () => (settings.review.hideTests ? settings.review.testPatterns : null),
    renderMarkdown: () => settings.review.renderMarkdown
  })
  const docs = new DocHub({ publish: (u) => send(IPC.evDocs, u), newId: () => randomUUID() })

  const startTabImages = (tab: TabInfo): void => {
    images.addTab(tab.id, tab.cwd)
    review.addTab(tab.id, tab.cwd, tab.kind === 'claude')
    docs.addTab(tab.id, tab.cwd, tab.kind === 'claude')
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

  // a test run can have idle transcripts wait long, so that a read the hooks bring is told apart from one within the wait
  const testFeedMaxMs = isTest ? Number(process.env.CLAUDETERM_TEST_FEED_MAX_MS) || undefined : undefined
  // a test holds the transcript poll of a turn's end back, so an answer typed meanwhile is the one that counts
  const testDoneDelayMs = isTest ? Number(process.env.CLAUDETERM_TEST_DONE_DELAY_MS) || 0 : 0
  const attachTranscript = (tabId: string, sessionId: string, transcriptPath: string): void => {
    const s = sources.get(tabId)
    if (!s || (s.transcriptPath !== null && pathKey(s.transcriptPath) === pathKey(transcriptPath))) return
    s.feed?.stop()
    void s.tempWatcher?.close()
    s.tempWatcher = null
    s.transcriptPath = transcriptPath
    const gen = images.generation(tabId)
    s.feed = new TranscriptFeed({
      transcriptPath,
      sessionId,
      cacheRoot: imageCacheRoot,
      fileExists: existsSync,
      locate: () => findTranscript(transcriptPath, sessionId),
      onImage: (img) => images.add(tabId, img.path, img.source, img.caption, img.at ?? undefined, false, gen),
      onError: (m) => log.warn(m),
      onSubagentInfo: (agentId, info) => statusHub.subagentInfo(tabId, agentId, info),
      onEditEvent: (ev) => review.transcriptEvent(tabId, ev),
      onAssistant: (agentId, at) => review.assistantEntry(tabId, agentId, at),
      onInterrupt: (agentId, at) => review.interrupted(tabId, agentId, at),
      onTurn: (turnIndex, peer) => turns.report(tabId, turnIndex, peer),
      onPlanWorkspace: (printed, at) => void planHub.workspace(tabId, printed, at),
      pollMaxMs: testFeedMaxMs,
      subagentPollMaxMs: testFeedMaxMs,
      subagentScanMaxMs: testFeedMaxMs
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

  // a tab's transcripts are read rarely while they stay idle: a hook that says the tab works has them read at once again
  const wakeFeed = (tabId: string, agentId?: string): void => sources.get(tabId)?.feed?.wake(agentId)

  // the Media cards of the other devices' tabs: served from their device, through the bytes kept for the window's cards
  const remoteImages = new RemoteImages()
  handleImgProtocol(images, () => [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions], remoteCardSource(remoteImages, (tabId, cardId) => {
    const version = remoteImages.card(cardId)?.version ?? 0
    return remote?.actions.imageBytes(tabId, cardId, version, () => remoteImages.card(cardId)?.version === version) ?? Promise.resolve(null)
  }))
  handleDocProtocol((id) => docs.get(id))

  let claudeCli: ClaudeCli | null | undefined
  // looked up once: on Linux this starts the login shell
  const findingClaude = process.platform === 'win32'
    ? resolveClaude(execRunner)
    : resolveClaudePosix({ run: execRunner, shell: loginShell(), env: process.env, isExecutable: isExecutableFile })
  void findingClaude.then((cli) => { claudeCli = cli })
  // Windows: Claude Code runs a Claude tab's statusLine and hooks through Git Bash, whose runtime an idle process keeps sound
  const gitBash = process.platform === 'win32' ? findGitBash(process.env, existsSync) : null
  const anchorFile = gitBash ? anchorExe(gitBash, existsSync) : null
  const msysAnchor = anchorFile ? new MsysAnchor(anchorFile, { spawn: spawnAnchor, log }) : null

  /** the place each of this device's tabs last had, as TabPlaces published it: the directory carries it to the members */
  const tabPlaces = new Map<string, TabPlace | null>()
  const places = new TabPlaces({
    run: execGit,
    publish: (id, place) => {
      tabPlaces.set(id, place)
      send(IPC.evTabPlace, id, place)
      // the place is part of the tab's directory entry: the members hear of it as of any other change
      remote?.host.changed()
    }
  })
  const tabs = new TabManager({
    onTabStarted: (tab) => {
      startTabImages(tab)
      places.addTab(tab.id, tab.cwd)
      if (tab.kind === 'claude') {
        noteHub.addTab(tab.id, tab.claudeSessionId)
        taskLists.addTab(tab.id, tab.claudeSessionId)
      }
    },
    // the tab's group and branch are those of the folder Claude works in
    onFolderChanged: (tabId, folder) => {
      places.moveTab(tabId, folder)
      // the folder moves the tab's place, and its directory entry goes out again to the members, as other tab changes do
      remote?.host.changed()
    },
    // the user moved the tab to another folder: what the tab knew of the old folder goes, and a Claude tab starts a new conversation
    onTabFolderChanged: (tab) => {
      const s = sources.get(tab.id)
      if (s) {
        void s.tempWatcher?.close()
        s.feed?.stop()
      }
      sources.set(tab.id, { tempWatcher: null, feed: null, transcriptPath: null })
      images.resetTab(tab.id, tab.cwd)
      review.resetTab(tab.id, tab.cwd)
      docs.resetTab(tab.id, tab.cwd)
      planHub.resetTab(tab.id)
      // the task list of the old folder goes with its conversation: the new folder shows none of it
      newerSide.delete(tab.id)
      taskLists.resetTab(tab.id)
      // the status timer stops; the status hub retires the old session and tells the window its state is gone
      const timer = statusTimers.get(tab.id)
      if (timer) clearTimeout(timer)
      statusTimers.delete(tab.id)
      statusHub.resetTab(tab.id)
      autoContinue.forget(tab.id)
      noteHub.resetTab(tab.id)
      remote?.host.changed()
    },
    // a continue armed for the old process would type into the resumed one
    onTabRestarting: (tabId) => {
      autoContinue.forget(tabId)
      resumeAfterRestore.delete(tabId)
    },
    onTabClosed: (tabId) => {
      stopTabImages(tabId)
      // after the feed has stopped, so no late report brings the closed tab back
      planHub.removeTab(tabId)
      stopTabStatus(tabId)
      attention.removeTab(tabId)
      turns.removeTab(tabId)
      autoContinue.forget(tabId)
      resumeAfterRestore.delete(tabId)
      review.removeTab(tabId)
      places.removeTab(tabId)
      tabPlaces.delete(tabId)
      docs.removeTab(tabId)
      noteHub.removeTab(tabId)
      taskLists.removeTab(tabId)
      newerSide.delete(tabId)
    },
    // read at each start: the console host applies to tabs opened after a change
    spawn: (o) => spawnPty({ ...o, bundledConpty: settings.conpty === 'bundled' }),
    pipeName,
    baseEnv: childEnv,
    resolveLaunch: (req) => {
      if (req.kind === 'claude' || req.setupToken) {
        msysAnchor?.ensure()
        const acc = accountLaunch(req.kind === 'claude' ? req.account : null, (id) => accounts.token(id))
        // a switch to an account that cannot be used changes nothing; a start goes on with the main account
        if (acc.unavailable && req.strict) throw new Error(`${accountName(req.account!)} is not available`)
        if (claudeCli === null && settings.claude.command === 'claude') toast('claude not found in PATH — install Claude Code: https://claude.com/claude-code')
        const { profile, warning } = pickClaudeProfile(profiles, settings.claude.shellProfile)
        if (warning) toast(warning)
        if (req.setupToken) {
          return { profileName: profile.name, spec: buildLaunch(profile, 'claude', { command: `${settings.claude.command} setup-token`, settingsPath: null, resumeSessionId: null, forkSession: false }) }
        }
        if (acc.unavailable) toast(`${accountName(req.account!)} is not available; the tab started on the main account`)
        // a fork without a conversation of its own starts as a fork of its head's conversation
        const forkFrom = req.kind === 'claude' && !req.resumeSessionId && req.fork ? req.fork.from : null
        const claude = { command: settings.claude.command, settingsPath: claudeFiles.settingsPath, resumeSessionId: req.resumeSessionId ?? forkFrom, forkSession: forkFrom !== null }
        return { profileName: profile.name, spec: buildLaunch(profile, 'claude', claude), account: acc.account, env: acc.env }
      }
      const profile = profiles.find((p) => p.name === req.profile) ?? pickProfile(profiles, settings.defaultProfile)
      if (req.profile && profile.name !== req.profile) toast(`Profile "${req.profile}" not found; using ${profile.name}`)
      return { profileName: profile.name, spec: buildLaunch(profile, 'shell', null) }
    },
    onStateChanged: () => {
      sessions.scheduleSave(tabs.snapshot())
      remote?.host.changed()
      updateAwake()
    },
    // Claude Code writes the transcript with the first message; --resume of a conversation without one fails
    resumable: async (tabId, sessionId) => {
      const p = sources.get(tabId)?.transcriptPath
      return p ? (await findTranscript(p, sessionId)) !== null : true
    },
    events: {
      opened: (t) => {
        send(IPC.evTabOpened, t)
        // a new tab has printed nothing yet: its copy opens at number 0 and waits for no seed
        const size = tabs.size(t.id)
        if (size) remote?.host.opened(t.id, size.cols, size.rows, settings.scrollback)
      },
      updated: (t) => {
        send(IPC.evTabUpdated, t)
        // the other devices show the tab's activity and exit too: an update goes out in the directory
        remote?.host.changed()
        // an agent's start or stop changes the activity without a state change: the hold follows it
        updateAwake()
      },
      closed: (id) => {
        send(IPC.evTabClosed, id)
        remote?.closed(id)
        sizes.drop(id)
        deviceSized.delete(id)
        tabAttention.drop(id)
        tabInputs.drop(id)
        titles.delete(id)
        lastReviews.delete(id)
        reviewRevs.delete(id)
        if (lastLocalActive === id) lastLocalActive = null
      },
      activated: (id) => {
        lastLocalActive = id
        activeRemote = null
        // a local tab in front in the meantime: the window never jumps to the requested remote tab later
        remoteFront.activated()
        tabInputs.bump(id)
        clearAttention(id)
        send(IPC.evTabActivated, id)
        review.activated(id)
        places.refresh(id)
        applySize(id, sizes.claim(id, null))
        remote?.viewer.activated(id)
      },
      order: (ids) => send(IPC.evTabsOrder, ids),
      data: (id, d) => {
        send(IPC.evPtyData, id, d)
        // the copy takes the same string as the window, in the same order
        remote?.host.output(id, d)
      },
      exit: (id, code) => {
        send(IPC.evPtyExit, id, code)
        // the process that waited is gone: an attention still in its poll must not start
        tabInputs.bump(id)
        clearAttention(id)
        remote?.host.exit(id, code)
        // a Claude tab that exits mid-turn is no longer working: the hold it kept for its watchers ends
        updateAwake()
      },
      reset: (id) => {
        send(IPC.evPtyReset, id)
        // the process that waited is gone: the tab stops waiting on every device
        tabInputs.bump(id)
        clearAttention(id)
        remote?.host.reset(id)
      }
    }
  })
  const isClaudeTab = (tabId: string): boolean => tabs.get(tabId)?.kind === 'claude'

  // ---- remote tabs: the other devices' tabs in this window, and this device's tabs as the other devices see them
  /** the size of each tab's PTY, and the device it is sized for (null: this window) */
  const sizes = new TabSizes()
  /** the attention each of this device's tabs waits with, as the other devices see it */
  const tabAttention = new TabAttention()
  /** the answers each of this device's tabs got: an attention that starts after a turn's end is read is void if one came meanwhile */
  const tabInputs = new TabInputs()
  /** a tab starts waiting with a reason: the other devices show it pulsing too */
  const startAttention = (tabId: string, reason: NotificationCase): void => {
    tabAttention.start(tabId, reason)
    remote?.host.changed()
  }
  /** an answer on any device stops the tab waiting everywhere; a clear that changes nothing is not sent */
  const clearAttention = (tabId: string): void => {
    if (!tabAttention.clear(tabId)) return
    send(IPC.evAttentionClear, tabId)
    remote?.host.changed()
  }
  /** the title of each of this device's tabs, from its program */
  const titles = new Map<string, string>()
  /** the latest review update of each of this device's tabs */
  const lastReviews = new Map<string, ReviewUpdate>()
  /** the rev of each tab's latest review: a counter of the publishes, which only grows */
  const reviewRevs = new Map<string, number>()
  let reviewCounter = 0
  /** the latest images update of each remote tab in this window */
  const lastImages = new Map<string, ImagesUpdate>()
  /**
   * each member's tab of this device in front on the member's window, and its flags: present (see Presence) and focused, the
   * 0.15.0 member's flag
   */
  const remoteFronts = new Map<string, { tabId: string; present: boolean; focused: boolean }>()
  /** the remote tab in front in this window; null while a local tab (or none) is in front */
  let activeRemote: string | null = null
  /** which tab a new-tab request on another device brings to the front, and when it must not: see RemoteFront */
  const remoteFront = new RemoteFront()
  /** this device's id, from the group's view */
  let selfDeviceId = ''
  /** this device's side of the remote tabs: built while the group is open and the window is ready */
  let remote: RemoteHolder | null = null
  /** test runs never keep the machine awake: each start and stop is appended to the log a test names */
  const testPowerLog = isTest ? process.env.CLAUDETERM_TEST_POWER_LOG : undefined
  let testBlockerIds = 0
  const testBlocker: PowerBlocker = {
    start: () => {
      if (testPowerLog) appendFileSync(testPowerLog, 'start\n')
      return ++testBlockerIds
    },
    stop: () => {
      if (testPowerLog) appendFileSync(testPowerLog, 'stop\n')
    }
  }
  /** keeps this computer awake while another device uses it: see KeepAwake */
  const keepAwake = new KeepAwake({
    blocker: isTest ? testBlocker : { start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => powerSaveBlocker.stop(id) },
    enabled: () => settings.devices.keepAwake,
    now: Date.now
  })
  /** a test names a file whose content is 'present' while this device is present; a missing file is not present */
  const testPresence = isTest ? process.env.CLAUDETERM_TEST_PRESENCE : undefined
  const testPresenceFile = (path: string): boolean => {
    try {
      return readFileSync(path, 'utf8').trim() === 'present'
    } catch {
      return false
    }
  }
  /** the machine sleeps or its screen is locked: this device counts as away until it wakes, so its absence is told at once */
  let away = false
  /** whether this device is present: its window is focused and the machine had input recently. See Presence */
  const presence = new Presence({
    focused: () => !away && (testPresence ? testPresenceFile(testPresence) : Boolean(win && !win.isDestroyed() && win.isFocused())),
    // a test run never reads the machine's idle time: without a presence file it is never present
    idleSeconds: testPresence ? () => 0 : isTest ? () => Infinity : () => powerMonitor.getSystemIdleTime(),
    changed: (present) => {
      remote?.viewer.presenceChanged(present)
      // a device that becomes present with no remote tab in front clears the tab in front here, as bringing it to the front does
      if (present && activeRemote === null) {
        const id = tabs.activeTabId()
        if (id) clearAttention(id)
      }
    },
    ...(testPresence ? { tickMs: 200, alwaysTick: true } : {})
  })
  const onPowerAway = (): void => {
    away = true
    presence.check()
  }
  const onPowerBack = (): void => {
    away = false
    presence.check()
  }
  // these listeners live as long as the app, so away always follows the machine
  powerMonitor.on('suspend', onPowerAway)
  powerMonitor.on('lock-screen', onPowerAway)
  powerMonitor.on('resume', onPowerBack)
  powerMonitor.on('unlock-screen', onPowerBack)
  /** checks the keep-awake hold again: a member link came or went, a tab's watchers or its work changed, or the setting did */
  const updateAwake = (): void => keepAwake.update({
    linked: (remote?.host.peers().length ?? 0) > 0,
    watchedWorking: tabs.list().some((t) => t.kind === 'claude' && !t.exited && t.activity === 'working' && (remote?.host.watchers(t.id).length ?? 0) > 0)
  })
  /** the app is quitting: no tab is activated or opened */
  let quitting = false
  /** the local tab in front last: show_image without a tab id goes there while a remote tab is in front */
  let lastLocalActive: string | null = null
  /** the seed requests the window was not ready for: tab id to token */
  const pendingSeeds = new Map<string, number>()
  /** the links of devices that came up before the holder was built, by device: connected when it is built */
  const earlyPeers = new Map<string, { link: PeerLink; hello: HelloMessage }>()
  /** the tabs of this device whose size another device owns, as the viewers were last told */
  const deviceSized = new Set<string>()

  /** what the window shows of the other devices' tabs */
  const viewerEvents: ViewerEvents = {
    opened: (device, tab) => {
      devicesSoonIfShown()
      send(IPC.evTabOpened, remoteTabInfo(device, tab))
      if (tab.placeKnown) send(IPC.evTabPlace, tab.id, tab.place)
      if (tab.kind === 'claude') noteHub.addTab(tab.id, tab.claudeSessionId, { remote: true })
      // deferred: the viewer is still in the middle of listing the tab
      setImmediate(() => {
        if (remoteFront.arrived(tab.id, Date.now()) && remote?.viewer.has(tab.id)) activateRemote(tab.id, true)
      })
    },
    updated: (device, tab, before) => {
      send(IPC.evTabUpdated, remoteTabInfo(device, tab))
      if (tab.placeKnown && (!before.placeKnown || JSON.stringify(tab.place) !== JSON.stringify(before.place))) send(IPC.evTabPlace, tab.id, tab.place)
      if (tab.claudeSessionId !== null && tab.claudeSessionId !== before.claudeSessionId) noteHub.session(tab.id, tab.claudeSessionId)
      // the device changed the tab's folder: the note of the old folder goes here too
      if (tab.claudeSessionId === null && before.claudeSessionId !== null) noteHub.resetTab(tab.id)
    },
    closed: (tabId) => {
      devicesSoonIfShown()
      send(IPC.evTabClosed, tabId)
      noteHub.removeTab(tabId)
      lastImages.delete(tabId)
      remoteImages.dropTab(tabId)
      if (activeRemote === tabId) activeRemote = null
      remoteFront.closed(tabId)
      // the last tab of a device that went leaves no empty window; deferred, because a device's list is replaced close by close
      setImmediate(ensureSomeTab)
    },
    devices: (list) => {
      // a device that went or came back changes the tab counts of the Devices section too
      devicesSoonIfShown()
      send(IPC.evRemoteDevices, list)
      // a device that went or came back changes the Recent sessions window's sections: they are drawn again
      send(IPC.evRemoteSessions, remoteSessionsView())
      for (const d of list) if (!d.online) remoteFront.deviceGone(d.id)
    },
    data: (tabId, d) => send(IPC.evPtyData, tabId, d),
    reset: (tabId) => send(IPC.evPtyReset, tabId),
    exit: (tabId, code) => send(IPC.evPtyExit, tabId, code),
    size: (tabId, size) => send(IPC.evTabSize, tabId, size),
    attention: (tabId, reason, fresh) => {
      if (fresh) attention.notify(tabId, reason)
      else send(IPC.evAttention, tabId, reason)
    },
    attentionCleared: (tabId) => send(IPC.evAttentionClear, tabId),
    ring: (tabId, reason) => attention.ringInFront(tabId, reason),
    push: (tabId, value) => {
      if (value.k === 'status') {
        send(IPC.evStatus, { tabId, ...value.v })
      } else if (value.k === 'plan') {
        send(IPC.evPlan, { tabId, plan: value.v, agentList: value.agentList })
      } else if (value.k === 'images') {
        const update: ImagesUpdate = { tabId, ...value.v, remote: true }
        remoteImages.setCards(tabId, update.cards)
        lastImages.set(tabId, update)
        send(IPC.evImages, update)
      } else if (value.k === 'review') {
        send(IPC.evReview, { ...value.v, tabId, remote: true })
      }
    }
  }

  /** what the folder calls of this device read: the tab's folder, this device's name, the history, and the tab's move */
  const folderDeps = (): TabFolderDeps => ({
    home: homedir(),
    tabFolder: (tabId) => tabs.get(tabId)?.folder ?? null,
    device: () => group?.view().self.name || hostname(),
    sessions: () => history.list(50).catch(() => []),
    changeFolder: (tabId, path) => tabs.changeFolder(tabId, path)
  })

  /** this device's Recent sessions, newest first: the window's list, and the list a member gets; it keeps the sessions it listed */
  const listSessions = async (): Promise<RecentSession[]> => {
    const list = await history.list(100, starred.ids())
    listedSessions = new Map(list.map((s) => [s.id, s]))
    const open = new Set(tabs.list().map((t) => t.claudeSessionId))
    return list.map((s) => ({ ...s, open: open.has(s.id), starred: starred.ids().has(s.id) }))
  }

  /** the tab in a session's conversation (not brought forward), or a new Claude tab that resumes it (opened in the background), for a member that was listed it */
  const openSessionOf = (id: string): string => {
    const s = listedSessions.get(id)
    if (!s) throw new CallError(REMOTE_COPY.unknownSession)
    const tab = tabs.list().find((t) => t.claudeSessionId === s.id)
    if (tab) return tab.id
    // Claude Code finds a conversation by its folder: resuming it anywhere else fails
    if (!isDirectory(s.cwd)) throw new CallError(`The folder of this session no longer exists: ${s.cwd}`)
    const opened = openTab({ kind: 'claude', cwd: s.cwd, resumeSessionId: s.id }, false)
    if (!opened) throw new CallError(REMOTE_COPY.openTabFailed)
    return opened.id
  }

  /** what this device serves its members of its own tabs: the tabs, their sizes, the pushes and the calls */
  const hostCtx: HostContext = {
    tabs: {
      list: () => tabs.list(),
      get: (tabId) => tabs.get(tabId),
      // a tab closed from another device leaves no empty window (the window's own close is tabsClose's)
      close: (tabId) => {
        tabs.close(tabId)
        ensureSomeTab()
      },
      rename: (tabId, title) => tabs.rename(tabId, title),
      setMuted: (tabId, muted) => tabs.setMuted(tabId, muted),
      restart: (tabId, opts) => tabs.restart(tabId, opts),
      switchAccount: (tabId, account) => tabs.switchAccount(tabId, account),
      size: (tabId) => tabs.size(tabId),
      canFork: (tabId) => tabs.canFork(tabId),
      fork: (tabId, opts) => tabs.fork(tabId, opts)
    },
    images,
    review,
    imageExtensions: () => [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions],
    status: statusHub,
    shownPlan: shownPlanOf,
    clearTaskList: (tabId) => taskLists.set(tabId, null),
    notes: noteHub,
    accounts,
    sizes,
    attention: tabAttention,
    titles,
    places: tabPlaces,
    receiver,
    reviews: lastReviews,
    reviewRevs,
    profiles: () => profiles.map((p) => p.name),
    typedPaths: (tabId, paths) => typedTextOf(tabId, paths),
    openTab: (r) => openTab({ kind: r.kind, cwd: defaultFolder(), profile: r.profile, account: r.account, resumeSessionId: r.resume }, false),
    writeInput: (tabId, data, from) => writeInput(tabId, data, from),
    folders: (tabId, path) => folderListingOf(tabId, path, folderDeps()),
    changeFolder: (tabId, path) => changeFolderOf(tabId, path, folderDeps()),
    sessions: () => listSessions(),
    openSession: (id) => openSessionOf(id),
    claim: (tabId, from, cols, rows) => applySize(tabId, sizes.claim(tabId, from, cols, rows)),
    front: (from, tabId, present, focused) => {
      if (tabId === null) {
        remoteFronts.delete(from)
        return
      }
      const was = remoteFronts.get(from)
      remoteFronts.set(from, { tabId, present, focused })
      // a member that stops being present by itself leaves the tab's mark: only a new tab in front, or the member becoming present, answers it
      const wasFlag = was && { tabId: was.tabId, present: clearFlag(was) }
      if (frontClears(wasFlag, tabId, clearFlag({ present, focused }))) {
        tabInputs.bump(tabId)
        clearAttention(tabId)
      }
      if (isClaudeTab(tabId)) review.activated(tabId)
      places.refresh(tabId)
    }
  }

  /** the new-tab menu's answers: this device's name in the group, and each online device's last answer */
  const choicesNow = (): { self: string; devices: DeviceAnswer<DeviceChoices>[] } => ({
    self: group?.view().self.name ?? '',
    devices: remote?.actions.choicesNow() ?? []
  })

  /** the other devices' Recent sessions as the window shows them: each device's last answer, without the sessions this device lists itself */
  // the star is this device's, as the shared set has it: a device's own answer may be from before a star toggled here
  const remoteSessionsView = (): DeviceAnswer<RecentSession[]>[] =>
    (remote?.actions.sessionsNow() ?? []).map((d) => ({
      ...d,
      value: d.value?.filter((s) => !listedSessions.has(s.id)).map((s) => ({ ...s, starred: starred.ids().has(s.id) })) ?? null
    }))

  /** a session another device lists: the tab in its conversation there, or the new tab that resumes it, which comes to the front here as a new remote tab does; a device that is offline is toasted by the call */
  const openRemoteSession = async (id: string, prefer?: string): Promise<void> => {
    const r = remote
    const device = r?.actions.deviceOfSession(id, prefer) ?? null
    if (!r || device === null || quitting) return
    const mark = remoteFront.mark()
    const tabId = await r.actions.openSession(device, id)
    if (tabId !== null && remote === r && remoteFront.answered(mark, tabId, r.viewer.has(tabId), Date.now(), device) === 'activate') {
      activateRemote(tabId, true)
    }
  }

  /** what the holder of the open group needs of this window */
  const remoteDeps = (): RemoteHolderDeps => ({
    tabs,
    scrollback: () => settings.scrollback,
    present: () => presence.present(),
    hostTabs: hostTabs(hostCtx),
    hostHandlers: (device) => hostHandlers(hostCtx, device),
    viewerEvents,
    isLocal: (tabId) => tabs.get(tabId) !== null,
    selfId: () => selfDeviceId,
    onFresh: (what) => {
      if (what === 'choices') send(IPC.evDeviceChoices, choicesNow())
      else send(IPC.evRemoteSessions, remoteSessionsView())
    },
    toast,
    startMirrors: () => new PortMirrors(new Worker(screenWorkerPath(screenWorkerFile), { workerData: { screenWorker: true, maxSnapshotBytes: MAX_SNAPSHOT_BYTES } })),
    requestSeed: (tabId, token) => {
      if (rendererReady) send(IPC.evScreenSeed, tabId, token)
      else pendingSeeds.set(tabId, token)
    },
    // the holder tells the members, once per wait of its own: a title may change many times a second
    onTitle: (tabId, title) => {
      if (!tabs.get(tabId)) return
      titles.set(tabId, title)
    },
    onPeerGone: (device) => {
      remoteFronts.delete(device)
      peerGoneReceived(device)
      for (const [tabId, s] of sizes.dropViewer(device)) applySize(tabId, s)
    },
    log: (m) => log.warn(m),
    onLinks: () => updateAwake(),
    onWatchers: () => updateAwake()
  })

  /** a tab's size as its PTY takes it; the viewers hear of a device's size, and of the return to this window's (once) */
  const applySize = (tabId: string, s: AppliedSize | null): void => {
    if (!s) return
    tabs.resize(tabId, s.cols, s.rows)
    remote?.host.resized(tabId, s.cols, s.rows)
    remote?.host.changed()
    if (s.by !== null) {
      deviceSized.add(tabId)
      send(IPC.evTabSize, tabId, { cols: s.cols, rows: s.rows })
    } else if (deviceSized.delete(tabId)) {
      send(IPC.evTabSize, tabId, null)
    }
  }

  /** input into a tab: the window's own keys (from null, which take the tab at its fitted size) or a member device's */
  const writeInput = (tabId: string, data: string, from: string | null): void => {
    const prompt = isPromptInput(data)
    // a member typed into this device's tab (not a terminal report or a reading key): the computer stays awake for a while
    if (from !== null && prompt) keepAwake.input()
    // typing from any device is the user at the tab: it stops waiting everywhere; terminal reports and reading keys are no answer
    if (prompt) {
      // a key pressed as a tab closes leaves no entry behind
      if (tabs.get(tabId)) tabInputs.bump(tabId)
      clearAttention(tabId)
    }
    if (from === null) applySize(tabId, sizes.claim(tabId, null))
    if (tabId === autoTabId && isUserInput(data)) autoTabId = null
    // scrolling through the reply with the mouse or PgUp is reading it, it puts nothing in the prompt
    if (prompt) {
      autoContinue.userInput(tabId)
      resumeAfterRestore.delete(tabId)
    }
    // Esc or Ctrl+C stops a turn, and Claude Code runs no Stop hook for that: a restore must not take the turn up again
    if (data === '\x1b' || data === '\x03') tabs.setWorking(tabId, false)
    tabs.write(tabId, data)
  }

  /** a remote tab comes to the front in this window: no local tab is in front, and its device hears of it */
  const activateRemote = (tabId: string, byRequest: boolean): void => {
    if (byRequest) remoteFront.activatedByRequest()
    else remoteFront.activated()
    activeRemote = tabId
    tabs.deactivate()
    send(IPC.evTabActivated, tabId)
    remote?.viewer.activated(tabId)
  }

  /**
   * A review of a tab for the members attached to it: clamped in steps, sent in parts in order. A review published while
   * this one is clamped or sent ends it, since its rev is no longer the tab's.
   */
  const pushReviewToMembers = async (tabId: string, v: unknown, rev: number): Promise<void> => {
    if (!remote) return
    remote.host.changed()
    if (remote.host.watchers(tabId).length === 0) return
    const pushes = await reviewPushes(v, rev, { yieldNow: nextTurn, stale: () => reviewRevs.get(tabId) !== rev })
    for (const [n, p] of (pushes ?? []).entries()) {
      if (n > 0) await nextTurn()
      if (!remote || reviewRevs.get(tabId) !== rev) return
      remote.host.push(tabId, p.k, p.v)
    }
  }

  /** a hub update of a tab for the members attached to it, clamped to what they check; the directory follows */
  const pushToMembers = (tabId: string, k: PushKind, v: unknown): void => {
    if (!remote) return
    // a value is clamped only when a member is attached to the tab: nobody else gets it
    if (remote.host.watchers(tabId).length > 0) remote.host.push(tabId, k, clampPush(k, v))
    remote.host.changed()
  }

  /** whether a device of the group lists a tab in this window */
  const remoteTabsListed = (): boolean => {
    const r = remote
    return r !== null && r.viewer.devices().some((d) => r.viewer.tabsOf(d.id).length > 0)
  }

  /** a window with no tab of its own opens one, unless a remote tab of another device is listed to show in its place */
  const ensureSomeTab = (): void => {
    if (quitting || tabs.list().length > 0 || remoteTabsListed()) return
    openTab({ kind: 'shell', cwd: defaultFolder() })
  }

  /** the group closed or is closing: the holder goes, and the window's view of the other devices' tabs with it */
  const stopRemote = (): void => {
    const hadRemoteFront = activeRemote !== null
    remote?.dispose()
    remote = null
    updateAwake()
    activeRemote = null
    remoteFront.reset()
    earlyPeers.clear()
    titles.clear()
    remoteFronts.clear()
    lastImages.clear()
    remoteImages.clear()
    if (quitting) return
    if (hadRemoteFront) {
      const first = tabs.list()[0]
      if (first) tabs.activate(first.id)
    }
    ensureSomeTab()
  }

  /** builds the holder for the open group: its copies open and ask the window for their seeds, the members come, and the links that came first connect */
  const buildRemote = (view: ActiveDevicesView): void => {
    remote?.dispose()
    remote = new RemoteHolder(remoteDeps())
    remote.viewer.members(view.devices)
    const early = [...earlyPeers.values()]
    earlyPeers.clear()
    for (const { link, hello } of early) {
      try {
        remote.connect(link, hello)
      } catch (e) {
        log.warn("cannot connect a device's tabs: " + (e instanceof Error ? e.message : String(e)))
      }
    }
    updateAwake()
  }

  const attention = new Attention({
    windowFocused: () => Boolean(win && !win.isDestroyed() && win.isFocused()),
    activeTabId: () => activeRemote ?? tabs.activeTabId(),
    settings: () => settings.notifications,
    flash: () => { if (win && !win.isDestroyed()) win.flashFrame(true) },
    play: playSound,
    markTab: (tabId, reason) => send(IPC.evAttention, tabId, reason),
    // the window shows it: it knows the tab's title, and which tab the user opens
    banner: (tabId, reason) => send(IPC.evBanner, tabId, reason),
    muted: (tabId) => (remote?.viewer.tab(tabId)?.muted ?? tabs.get(tabId)?.muted) === true
  })
  /**
   * An attention starts on a tab of this device. When the person is present here with the tab in front, it starts nowhere
   * else: each device present with the tab in front rings for it, and this one signals it here (see Presence). Otherwise it
   * starts as before. share: false for a turn that ends with background work while doneWithBackgroundWork is off: it starts
   * nothing and rings nobody.
   */
  const raiseAttention = (tabId: string, reason: NotificationCase, o: { background?: boolean; share?: boolean } = {}): void => {
    const background = o.background === true
    if (o.share === false) {
      log.info(`attention ${reason} tab=${tabId} quiet`)
      return
    }
    const here = activeRemote === null && tabs.activeTabId() === tabId && presence.present()
    const there = presentViewers(tabId, remoteFronts)
    if (!here && there.length === 0) {
      startAttention(tabId, reason)
      const signalled = attention.notify(tabId, reason, background)
      log.info(`attention ${reason} tab=${tabId} ${signalled ? 'started' : 'seen'}`)
      return
    }
    const parts: string[] = []
    if (here) parts.push(attention.notify(tabId, reason, background) ? 'here' : 'seen')
    // a ring is sent once and not stored: a ring lost on a dying link is accepted
    for (const d of there) remote?.host.ring(tabId, d, reason)
    if (there.length > 0) parts.push(`rung ${there.length}`)
    log.info(`attention ${reason} tab=${tabId} ${parts.join(' ')}`)
  }
  const promptQueries = new PromptQueries({
    send: (queryId, tabId) => {
      if (!win || win.isDestroyed()) return false
      win.webContents.send(IPC.evPromptQuery, queryId, tabId)
      return true
    }
  })
  const autoContinue = new AutoContinue({
    enabled: () => settings.claude.autoContinue,
    promptState: (tabId) => promptQueries.ask(tabId),
    // writes go to the PTY directly: what it types is not taken for the user's keys
    write: (tabId, data) => tabs.write(tabId, data),
    notify: (tabId) => {
      raiseAttention(tabId, 'done')
    },
    log
  })
  // restored tabs whose turn, or the background work a finished turn left, ClaudeTerm's closing cut off: they go on once
  // their session has started again
  const resumeAfterRestore = new Map<string, RestoreCut>()

  const openTab = (req: OpenTabRequest, activate = true, setupToken = false): TabInfo | null => {
    try {
      return tabs.open(req, { activate, setupToken })
    } catch (e) {
      toast(`Cannot open tab: ${(e as Error).message}`)
      return null
    }
  }

  /** the folder new tabs open in: the defaultFolder setting, else (or when that folder is gone) the home folder */
  const defaultFolder = (): string => {
    if (settings.defaultFolder === null) return homedir()
    const { cwd, warning } = resolveLaunchDir(settings.defaultFolder, homedir(), isDirectory)
    if (warning) toast(warning)
    return cwd
  }
  // the renderer opens new tabs in the defaultFolder setting, a folder only main can check
  const inDefaultFolder = (req: OpenTabRequest): OpenTabRequest =>
    settings.defaultFolder !== null && typeof req?.cwd === 'string' && pathKey(req.cwd) === pathKey(settings.defaultFolder) ? { ...req, cwd: defaultFolder() } : req

  // the tab opened by a no-argument start; replaced by a restore unless the user typed into it
  let autoTabId: string | null = null
  const openFromLaunch = (cmd: LaunchCommand): void => {
    if (cmd.kind === 'default') {
      if (tabs.list().length === 0) {
        const t = openTab({ kind: 'shell', cwd: defaultFolder() })
        autoTabId = t?.id ?? null
      }
      return
    }
    const { cwd, warning } = resolveLaunchDir(cmd.dir, homedir(), isDirectory)
    if (warning) toast(warning)
    openTab(cmd.kind === 'claude' ? { kind: 'claude', cwd } : { kind: 'shell', cwd, profile: cmd.profile })
  }

  const runRestore = async (): Promise<void> => {
    const snap = previous
    if (!snap) return
    previous = null
    try {
      sessions.clearPrevious()
    } catch (e) {
      log.warn(`cannot remove previous session: ${(e as Error).message}`)
    }
    send(IPC.evRestore, null)
    // a fork whose own conversation was never saved forks its head's again, rather than resuming nothing. The transcripts
    // are looked for together, before any tab opens, so the restored tabs then open in one go, in their saved order
    const projects = claudeProjectsDir(process.env, homedir())
    const unsaved = await Promise.all(snap.tabs.map(async (t) => {
      const id = t.kind === 'claude' && t.fork?.from ? t.claudeSessionId : null
      return id !== null && (await findTranscript(join(projects, t.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`), id)) === null
    }))
    if (autoTabId) {
      if (tabs.get(autoTabId)) tabs.close(autoTabId)
      autoTabId = null
    }
    let first: string | null = null
    // the opened tab of each snapshot tab, by its index in the snapshot: a fork finds its head there
    const openedIds: (string | null)[] = []
    snap.tabs.forEach((t, i) => {
      const { cwd, warning } = resolveLaunchDir(t.cwd, homedir(), isDirectory)
      if (warning) toast(warning)
      const resumeSessionId = t.kind === 'claude' && !unsaved[i] ? t.claudeSessionId : null
      // a fork opens where it was saved, and joins its head's family below, once the head is open too
      const fork = t.kind === 'claude' && t.fork ? { of: null, from: t.fork.from } : null
      const opened = openTab(
        { kind: t.kind, cwd, profile: t.kind === 'shell' ? t.profile : null, title: t.title, resumeSessionId, account: t.kind === 'claude' ? t.account : null, muted: t.muted, fork },
        false
      )
      // the note stored under the fork's own conversation goes with the tab to the conversation it gets
      if (opened && unsaved[i] && t.claudeSessionId !== null) noteHub.adopt(opened.id, t.claudeSessionId)
      openedIds.push(opened?.id ?? null)
      if (opened && settings.claude.continueAfterRestore && (t.working || t.background)) resumeAfterRestore.set(opened.id, t.working ? 'turn' : 'background')
      if (opened && first === null) first = opened.id
    })
    snap.tabs.forEach((t, i) => {
      const head = t.fork?.of ?? null
      const id = openedIds[i]
      const headId = head === null ? null : openedIds[head]
      if (id && headId) tabs.joinFamily(id, headId)
    })
    if (first) tabs.activate(first)
  }

  const focusWindow =(): void => {
    // a test run never takes the focus: it counts what would have
    if (isTest) testState.ctFocusRequests = (testState.ctFocusRequests ?? 0) + 1
    if (!win || isTest) return
    if (win.isMinimized()) win.restore()
    win.show()
    // Windows foreground lock: briefly going always-on-top lets a background process bring the window forward
    win.setAlwaysOnTop(true)
    win.focus()
    win.setAlwaysOnTop(false)
    if (!win.isFocused()) win.flashFrame(true)
  }

  /** the tabs that need the user: a count on the Dock icon and the launcher, a dot over the taskbar button on Windows */
  let badgeDot: Electron.NativeImage | null = null
  const showBadge = (count: number): void => {
    if (isTest) testState.ctBadgeCount = count
    if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '')
    else if (process.platform === 'linux') app.setBadgeCount(count)
    else if (win && !win.isDestroyed()) {
      badgeDot ??= nativeImage.createFromBitmap(dotBitmap(16, [0xd9, 0x77, 0x57]), { width: 16, height: 16 })
      win.setOverlayIcon(count > 0 ? badgeDot : null, count > 0 ? badgeDescription(count) : '')
    }
  }

  app.on('second-instance', (_e, argv, _cwd, additionalData) => {
    const data = additionalData as { argv?: string[] } | null
    const cmd = parseArgs(data?.argv ?? argv)
    if (rendererReady) openFromLaunch(cmd)
    else pendingLaunches.push(cmd)
    focusWindow()
  })

  const updateFeed = process.env.CLAUDETERM_UPDATE_URL
  // macOS: the swap script could not put the downloaded version in place of this one
  const failedUpdate = process.platform === 'darwin' ? consumeFailedUpdate(dataDir) : null
  if (failedUpdate) toast(`ClaudeTerm ${failedUpdate} could not replace this copy: download it from its release page`)
  const updateBackend = (): UpdaterBackend | null => {
    if (!app.isPackaged || isTest) return null
    if (process.platform !== 'darwin') return createUpdateBackend(autoUpdater, { testFeed: updateFeed, installOnQuit: process.platform === 'win32', log })
    const canWrite = (p: string): boolean => {
      try {
        accessSync(p, constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    return createMacUpdateBackend(autoUpdater, {
      bundle: bundleOf(process.execPath),
      arch: process.arch,
      canReplace: (bundle) => canWrite(bundle) && canWrite(dirname(bundle)),
      failedVersion: failedUpdate,
      fileUrl: (version, name) => feedFileUrl(version, name, updateFeed),
      fetch: (version, url, sha512) => prepareUpdate({ stagingDir: join(dataDir, 'update'), version, url, sha512, get: (u) => net.fetch(u) }),
      swap: (bundle, next, version) => startSwap({ pid: process.pid, app: bundle, next, version, failedFile: join(dataDir, FAILED_UPDATE), relaunch: '/usr/bin/open' }),
      quit: () => app.quit()
    }, { testFeed: updateFeed, log })
  }
  const updater = new Updater({
    backend: updateBackend(),
    currentVersion: app.getVersion(),
    enabled: () => settings.autoUpdate,
    publish: (s) => send(IPC.evUpdate, s),
    notify: (m) => { if (rendererReady) send(IPC.evToast, m) },
    beforeInstall: () => {
      sessions.flush()
      notes.flush()
      taskListStore.flush()
      if (!writeUpdateMarker(dataDir, Date.now())) log.warn('cannot write the update restart marker')
    },
    openReleasePage: (version) => void shell.openExternal(releasePage(version)),
    log: (m) => log.info(m)
  })
  updater.start()

  // a socket left by a run that crashed would refuse the new one; a socket folder others can enter is never used
  const uid = process.getuid?.() ?? -1
  const pipeProblem = process.platform === 'win32' ? null : socketProblem(pipeName, { privateDir: socketDir({ platform: process.platform, env: {}, uid }), uid })
  if (pipeProblem) toast(`Claude tabs cannot report to ClaudeTerm (status, images, notifications): ${pipeProblem}`)
  else startPipeServer(pipeName, {
    showImage: (msg) => showImageFile(images, msg, {
      check: (path) => checkShowableFile(path, [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions]),
      fallback: () => tabs.activeTabId() ?? lastLocalActive ?? tabs.list()[0]?.id ?? null
    }),
    session: (msg) => {
      log.info(`session ${msg.source} tab=${msg.tabId} id=${msg.sessionId} transcript=${msg.transcriptPath ?? '-'}`)
      if (!tabs.setClaudeSession(msg.tabId, msg.sessionId, msg.source)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      statusHub.session(msg.tabId, msg.sessionId, msg.source)
      planHub.session(msg.tabId, msg.sessionId)
      noteHub.session(msg.tabId, msg.sessionId)
      taskLists.session(msg.tabId, msg.sessionId, msg.source === 'fork' ? tabs.get(msg.tabId)?.fork?.from ?? null : null)
      // compact keeps the open dialogs: the conversation goes on
      review.sessionStarted(msg.tabId, msg.sessionId, msg.source)
      turns.session(msg.tabId, msg.sessionId)
      if (msg.transcriptPath) attachTranscript(msg.tabId, msg.sessionId, msg.transcriptPath)
      const cut = resumeAfterRestore.get(msg.tabId)
      if (cut) {
        resumeAfterRestore.delete(msg.tabId)
        autoContinue.resumed(msg.tabId, cut)
      }
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
      wakeFeed(msg.tabId, msg.agentId)
      statusHub.subagent(msg)
      // an interrupted subagent never writes again: its end closes a dialog it left open
      if (msg.event === 'stop') review.subagentStopped(msg.tabId, msg.agentId)
      return { ok: true }
    },
    sessionEnd: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`session end tab=${msg.tabId} id=${msg.sessionId}`)
      statusHub.sessionEnd(msg.tabId, msg.sessionId)
      planHub.sessionEnd(msg.tabId, msg.sessionId)
      taskLists.sessionEnd(msg.tabId, msg.sessionId)
      // a late SessionEnd of the session before /clear leaves the new one running
      review.sessionEnded(msg.tabId, msg.sessionId)
      // a continue still waiting would be typed into the shell
      autoContinue.forget(msg.tabId)
      return { ok: true }
    },
    attention: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      wakeFeed(msg.tabId)
      // Send must never press Enter into a dialog; the end of a turn is a moment to look at the changes
      if (msg.reason === 'done') {
        review.turnEnded(msg.tabId)
        places.refresh(msg.tabId)
        tabs.setWorking(msg.tabId, false)
        // the status bar shows the background work still running; a turn end that does not say leaves the last list
        if (msg.tasks !== undefined) statusHub.background(msg.tabId, msg.sessionId, msg.tasks)
        if (msg.error === undefined) autoContinue.turnEnded(msg.tabId)
        // a response a dropped connection cut off goes on by itself: nobody needs to look yet
        else if (autoContinue.failed(msg.tabId, msg.error)) return { ok: true }
      } else review.dialogOpened(msg.tabId, msg.agentId ?? null)
      // an answer typed or fronted while the turn's end is read makes the attention void: it starts nowhere
      const inputsAtEnd = tabInputs.of(msg.tabId)
      const signal = (): void => {
        if (!isClaudeTab(msg.tabId)) return
        if (tabInputs.of(msg.tabId) !== inputsAtEnd) {
          log.info(`attention ${msg.reason} tab=${msg.tabId} void: answered while the turn's end was read`)
          return
        }
        // a turn a message from another session started has its own settings: the transcript tells which turn this is
        const reason = msg.reason === 'done' && turns.lastTurnIsPeer(msg.tabId) ? 'peer' : msg.reason
        // a done with background work still running gives no signal while doneWithBackgroundWork is off: no tab waits for it
        const share = msg.reason !== 'done' || msg.background !== true || settings.notifications.doneWithBackgroundWork
        raiseAttention(msg.tabId, reason, { background: msg.background === true, share })
        if (msg.error) log.info(`attention ${reason} tab=${msg.tabId} error=${msg.error}`)
      }
      // the end of a turn waits for the main transcript to be read up to it: the pipe answers at once, the signal follows
      const feed = msg.reason === 'done' ? sources.get(msg.tabId)?.feed : undefined
      if (feed) {
        const read = testDoneDelayMs > 0 ? new Promise<void>((r) => setTimeout(r, testDoneDelayMs)).then(() => feed.pollMain()) : feed.pollMain()
        void read.then(signal, signal)
      } else signal()
      return { ok: true }
    },
    turn: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      wakeFeed(msg.tabId)
      // the folder Claude Code works in now: it moves its shell back from a cd out of the session's folders without a CwdChanged
      if (msg.cwd !== null) tabs.setFolder(msg.tabId, msg.cwd)
      review.turn(msg.tabId, msg.sessionId)
      tabs.setWorking(msg.tabId, true)
      autoContinue.turnStarted(msg.tabId)
      return { ok: true }
    },
    cwd: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`folder tab=${msg.tabId} ${msg.cwd}`)
      tabs.setFolder(msg.tabId, msg.cwd)
      return { ok: true }
    },
    editBefore: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      wakeFeed(msg.tabId)
      // the reply lets the edit go ahead: the file is read before it
      review.recordBefore(msg.tabId, msg.sessionId, msg.toolUseId, msg.path)
      return { ok: true }
    },
    taskList: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: 'set_task_list works only in a ClaudeTerm Claude tab' }
      taskLists.set(msg.tabId, msg.list)
      return { ok: true, info: taskListSummary(msg.list) }
    },
    taskListGet: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: 'get_task_list works only in a ClaudeTerm Claude tab' }
      return { ok: true, info: describeTaskList(taskLists.get(msg.tabId)) }
    },
    showDiff: (msg) => review.showRequest(msg.tabId, { cwd: msg.cwd, scope: msg.scope, from: msg.from, to: msg.to, paths: msg.paths, title: msg.title }),
    showDocument: async (msg) => {
      const check = await checkDocFile(msg.path)
      if (!check.ok) return { ok: false, error: check.error }
      if (check.kind === 'html' && htmlFolderRefused(msg.path, homedir())) return { ok: false, error: `an HTML document is not shown from the home folder or a drive root: ${msg.path}` }
      return docs.show(msg.tabId, msg.path, msg.title, check.kind)
    },
    deviceStatus: () => ({
      ok: true,
      info: formatDeviceStatus({
        view: group?.view() ?? null,
        selfTabs: hostTabs(hostCtx).list(),
        tabsOf: (id) => (remote?.viewer.online(id) ? remote.viewer.tabsOf(id) : null)
      })
    }),
    openDeviceSettings: () => {
      settingsWindow.open('devices')
      return { ok: true }
    }
  })
    .then((h) => { pipe = h })
    .catch((e: unknown) => log.error(`pipe server failed: ${String(e)}`))

  if (app.isPackaged && process.env.CLAUDETERM_SKIP_MCP_REGISTER !== '1') {
    void ensureMcpRegistered({ run: execRunner, execPath: process.execPath, serverScript: resourcePath('mcp/show-image-server.js'), log: (m) => log.warn(m), resolve: () => findingClaude })
      .then((r) => log.info(`mcp registration: ${r}`))
  }

  // device sync: the group opens once this device has an identity (device-identity.json), or with the first pairing or join
  const testDeviceHost = isTest ? process.env.CLAUDETERM_TEST_DEVICE_HOST : undefined
  // a value that is not a port is ignored: the settings port is used
  const testDevicePortText = isTest ? process.env.CLAUDETERM_TEST_DEVICE_PORT : undefined
  const testDevicePort = testDevicePortText !== undefined && /^\d{1,5}$/.test(testDevicePortText) && Number(testDevicePortText) <= 65535 ? Number(testDevicePortText) : undefined
  const devicePlatform: DevicePlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  let group: DeviceGroup | null = null
  let bridge: StoreBridge | null = null
  let opening: Promise<DeviceGroup | null> | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  const onPowerResume = (): void => { group?.wake() }
  /** the view with the tab count of each connected device: the tabs of it this window lists; a device whose list has not come yet has no count */
  const withTabs = (v: DevicesView): DevicesView => {
    const r = remote
    if (!v.enabled || !r) return v
    return { ...v, devices: v.devices.map((d) => (d.state.kind === 'connected' && r.viewer.listedOf(d.id) ? { ...d, tabs: r.viewer.tabsOf(d.id).length } : d)) }
  }
  const devicesView = (): DevicesView => withTabs(group ? group.view() : { enabled: false })
  // the view again while the Settings window is open, at most once per 100 ms: a device's tabs opened or closed
  const devicesSoon = new Coalescer(100, () => {
    if (settingsWindow.isOpen()) broadcast(IPC.evDevices, devicesView())
  })
  const devicesSoonIfShown = (): void => {
    if (settingsWindow.isOpen()) devicesSoon.request()
  }
  const offline = (): DeviceResult => ({ ok: false, error: DEVICE_COPY.disabled })
  // the stores' changes from other devices reach every window; the notes go to the tabs of their conversation
  starred.onExternal(() => broadcast(IPC.evStarred, [...starred.ids()]))
  notes.onExternal((id, note, before) => {
    noteHub.external(id, note, before)
    remote?.host.changed()
  })

  /** Opens the group, once: a call while it opens gets the same open, and a group that is open is given back. Null when it cannot open. */
  const startDevices = (): Promise<DeviceGroup | null> => {
    if (group) return Promise.resolve(group)
    if (!opening) {
      opening = DeviceGroup.open({
        dir: dataDir,
        vault: electronVault(safeStorage, process.platform),
        host: testDeviceHost ?? '::',
        port: testDevicePort ?? settings.devices.port,
        platform: devicePlatform,
        hostName: () => hostname().slice(0, MAX_DEVICE_NAME),
        addresses: testDeviceHost ? () => [testDeviceHost] : localAddresses,
        onData: (updates) => bridge?.applied(updates),
        onView: (view) => {
          selfDeviceId = view.self.id
          broadcast(IPC.evDevices, withTabs(view))
          // a device that left the group can link no more: the sessions it was answered with are forgotten
          pruneListedMembers(hostCtx, view.devices.map((d) => d.id))
          remote?.viewer.members(view.devices)
        },
        onReset: () => bridge?.start(),
        onPeer: (link, hello) => {
          if (remote) {
            remote.connect(link, hello)
            return
          }
          // the window is not ready yet: the link is connected when the holder is built
          earlyPeers.set(hello.id, { link, hello })
          link.once('close', () => {
            if (earlyPeers.get(hello.id)?.link === link) earlyPeers.delete(hello.id)
          })
        },
        // a warning is a toast, as the other notices are; an error is logged
        warn: toast,
        onError: (m) => log.warn(m)
      }).then((g) => {
        // a failure after the open leaves no group behind: the group is closed and the open counts as failed
        try {
          bridge = new StoreBridge(starred, notes, g)
          bridge.start()
          refreshTimer = setInterval(() => group?.refreshSelf(), 10_000)
          powerMonitor.on('resume', onPowerResume)
          group = g
          const view = g.view()
          selfDeviceId = view.self.id
          if (rendererReady && !quitting) buildRemote(view)
          broadcast(IPC.evDevices, withTabs(view))
          return g
        } catch (e) {
          log.warn(`cannot start device sync: ${(e as Error).message}`)
          group = null
          remote?.dispose()
          remote = null
          updateAwake()
          earlyPeers.clear()
          if (refreshTimer) clearInterval(refreshTimer)
          refreshTimer = null
          powerMonitor.removeListener('resume', onPowerResume)
          bridge?.stop()
          bridge = null
          g.close().catch((err: unknown) => log.warn(`cannot close device sync: ${(err as Error).message}`))
          return null
        }
      }, () => {
        earlyPeers.clear()
        return null
      }).finally(() => {
        opening = null
      })
    }
    return opening
  }

  /** Closes the group: the stores stop following it, what is pending is written, and the network stops. */
  const stopDevices = async (): Promise<void> => {
    if (opening) await opening
    stopRemote()
    const closing = group
    group = null
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    powerMonitor.removeListener('resume', onPowerResume)
    bridge?.stop()
    bridge = null
    if (closing) {
      closing.flush()
      await closing.close()
    }
  }

  /** The port changed while the group is open or opening: it is closed and opened again on the new port. Restarts run one after another. */
  let restarts: Promise<void> = Promise.resolve()
  const restartDevices = (): Promise<void> => {
    restarts = restarts.then(async () => {
      await stopDevices()
      await startDevices()
      broadcast(IPC.evDevices, devicesView())
    }).catch((e: unknown) => {
      log.warn(`cannot restart device sync: ${(e as Error).message}`)
    })
    return restarts
  }

  ipcMain.handle(IPC.devicesView, (): DevicesView => devicesView())
  ipcMain.handle(IPC.devicesStartPairing, async (): Promise<DevicesView> => {
    // a restart that is running opens the group on the new port: the pairing waits for it
    await restarts
    const g = await startDevices()
    if (!g) return { enabled: false }
    try {
      await g.startPairing()
    } catch (e) {
      log.warn(`cannot start pairing: ${(e as Error).message}`)
    }
    return devicesView()
  })
  ipcMain.on(IPC.devicesCancelPairing, () => { group?.cancelPairing() })
  ipcMain.handle(IPC.devicesJoin, async (_e, address: unknown, code: unknown): Promise<DeviceResult> => {
    await restarts
    // with a group open, a bad argument is answered with what is wrong with it; with no group, device sync is off
    if (!isAddressInput(address)) return group ? { ok: false, error: DEVICE_COPY.badAddress } : offline()
    if (!isPairCodeInput(code)) return group ? { ok: false, error: DEVICE_COPY.joinBadCode } : offline()
    const g = await startDevices()
    return g ? g.join(address, code) : offline()
  })
  ipcMain.handle(IPC.devicesRemove, (_e, id: unknown): DeviceResult => {
    if (!group) return offline()
    return isDeviceId(id) ? group.remove(id) : { ok: false, error: DEVICE_COPY.unknownDevice }
  })
  ipcMain.handle(IPC.devicesLeave, (): Promise<DeviceResult> => (group ? group.leave() : Promise.resolve(offline())))
  ipcMain.handle(IPC.devicesSetAddress, (_e, id: unknown, address: unknown): DeviceResult => {
    if (!group) return offline()
    if (!isDeviceId(id)) return { ok: false, error: DEVICE_COPY.unknownDevice }
    return isOptionalAddress(address) ? group.setAddress(id, address) : { ok: false, error: DEVICE_COPY.badAddress }
  })
  ipcMain.handle(IPC.devicesRename, (_e, name: unknown): DeviceResult => {
    if (!group) return offline()
    return isDeviceNameInput(name) ? group.rename(name) : { ok: false, error: DEVICE_COPY.badName }
  })
  // a device that has its identity is in its group from the start
  if (existsSync(join(dataDir, 'device-identity.json'))) void startDevices()

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || 0 : null, test: isTest, homeDir: homedir(), version: app.getVersion() }))
  ipcMain.on(IPC.rendererReady, () => {
    rendererReady = true
    for (const n of startupNotices.splice(0)) send(IPC.evToast, n)
    for (const cmd of pendingLaunches.splice(0)) openFromLaunch(cmd)
    if (restoreAfterUpdate) void runRestore()
    // the window is ready: the open group's holder is built now, and its copies ask the window for their seeds
    if (group && !remote && !quitting) {
      try {
        buildRemote(group.view())
      } catch (e) {
        log.warn('cannot start remote tabs: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    // the window hears of the remote tabs, the devices and the seed requests that came before it was ready
    if (remote) {
      // the devices first: a remote tab is never drawn or fronted before its device's chip is known
      send(IPC.evRemoteDevices, remote.viewer.devices())
      for (const d of remote.viewer.devices()) {
        for (const t of remote.viewer.tabsOf(d.id)) {
          send(IPC.evTabOpened, remoteTabInfo(d.id, t))
          // as the live path sends it: the device's size, or null where this window's own device sized the tab
          send(IPC.evTabSize, t.id, t.size.by === selfDeviceId ? null : { cols: t.size.cols, rows: t.size.rows })
        }
      }
      for (const [tabId, token] of pendingSeeds) send(IPC.evScreenSeed, tabId, token)
      pendingSeeds.clear()
    }
  })
  ipcMain.on(IPC.bell, (_e, tabId: unknown) => { if (isId(tabId) && tabs.get(tabId)) raiseAttention(tabId, 'bell') })
  // a fork comes only from Fork session (tabs:fork), never from a request to open a tab
  ipcMain.handle(IPC.tabsOpen, (_e, req: unknown) => (isOpenTabRequest(req) ? openTab(inDefaultFolder(openTabRequestFields(req))) : null))
  ipcMain.handle(IPC.sessionsList, listSessions)
  ipcMain.handle(IPC.sessionsStar, (_e, id: unknown, on: unknown): void => {
    if (isSessionId(id) && isFlag(on)) starred.set(id, on)
  })
  ipcMain.on(IPC.notesSetText, (_e, id: unknown, text: unknown, generation: unknown) => {
    if (isId(id) && isNoteText(text) && isGeneration(generation)) {
      noteHub.setText(id, text, generation)
      remote?.host.changed()
    }
  })
  ipcMain.on(IPC.notesSetView, (_e, id: unknown, shown: unknown, form: unknown, generation: unknown) => {
    if (isId(id) && isFlag(shown) && isNoteForm(form) && isGeneration(generation)) {
      noteHub.setView(id, shown, form, generation)
      remote?.host.changed()
    }
  })
  ipcMain.on(IPC.tasksClear, (_e, id: unknown) => {
    if (!isId(id)) return
    // a tab of another device keeps its list there: the device clears it
    if (remote?.viewer.has(id)) void remote.actions.clearTaskList(id)
    else if (isClaudeTab(id)) taskLists.set(id, null)
  })
  ipcMain.handle(IPC.sessionsStarred, (): string[] => [...starred.ids()])
  ipcMain.handle(IPC.layoutGet, (): TabLayout => tabLayout.get())
  ipcMain.on(IPC.layoutSet, (_e, c: unknown) => { if (isTabLayoutChange(c)) tabLayout.set(c) })
  ipcMain.on(IPC.sessionsOpen, (_e, id: unknown, device?: unknown) => {
    // the device of the section the pick was made in; a value that is not a device drops the pick
    if (device !== undefined && !isDeviceId(device)) return
    const s = isId(id) ? listedSessions.get(id) : undefined
    // a session another device lists is opened on that device
    if (!s) {
      if (isId(id)) void openRemoteSession(id, isDeviceId(device) ? device : undefined)
      return
    }
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
    if (remote?.viewer.has(id)) {
      remote.actions.close(id)
      return
    }
    tabs.close(id)
    // the window closes only when no tab is left, of this device or listed from another device
    if (tabs.list().length === 0 && !remoteTabsListed()) win?.close()
  })
  ipcMain.on(IPC.tabsActivate, (_e, id: unknown) => {
    if (!isId(id)) return
    if (remote?.viewer.has(id)) activateRemote(id, false)
    else tabs.activate(id)
  })
  ipcMain.on(IPC.tabsRename, (_e, id: unknown, title: unknown) => {
    if (!isId(id) || !isOptionalTitle(title)) return
    if (remote?.viewer.has(id)) remote.actions.rename(id, title)
    else tabs.rename(id, title)
  })
  ipcMain.on(IPC.windowFocus, () => focusWindow())
  ipcMain.on(IPC.attentionCount, (_e, count: unknown) => { if (isTabCount(count)) showBadge(count) })
  ipcMain.on(IPC.tabsReorder, (_e, ids: unknown) => { if (isIdList(ids)) tabs.reorder(ids) })
  ipcMain.on(IPC.tabsRestart, (_e, id: unknown, live: unknown) => {
    if (!isId(id)) return
    if (remote?.viewer.has(id)) remote.actions.restart(id, live === true)
    else tabs.restart(id, { live: live === true }).catch((e: Error) => log.warn(`cannot restart tab: ${e.message}`))
  })
  ipcMain.on(IPC.tabsSwitchAccount, (_e, id: unknown, account: unknown) => {
    if (!isId(id) || !isAccountRef(account)) return
    if (remote?.viewer.has(id)) {
      void remote.actions.switchAccount(id, account)
      return
    }
    tabs.switchAccount(id, account)
      .then((ok) => { if (!ok && account !== null && accounts.token(account) === null) toast(`${accountName(account)} is not available`) })
      .catch((e: Error) => log.warn(`cannot switch the account: ${e.message}`))
  })
  ipcMain.on(IPC.tabsMute, (_e, id: unknown, muted: unknown) => {
    if (!isId(id) || !isFlag(muted)) return
    if (remote?.viewer.has(id)) remote.actions.mute(id, muted)
    else tabs.setMuted(id, muted)
  })
  // the transcript is looked for without blocking: the tab menu waits for this answer on every right-click
  // a remote tab's fork is checked and made on its device, where its transcript is
  ipcMain.handle(IPC.tabsCanFork, (_e, id: unknown): Promise<boolean> => {
    if (!isId(id)) return Promise.resolve(false)
    return remote?.viewer.has(id) ? remote.actions.canFork(id) : tabs.canFork(id)
  })
  ipcMain.on(IPC.tabsFork, async (_e, id: unknown) => {
    if (!isId(id)) return
    if (remote?.viewer.has(id)) {
      if (quitting) return
      // the fork comes to the front here the way an open-tab answer does
      const r = remote
      const device = r.viewer.deviceOf(id) ?? ''
      const mark = remoteFront.mark()
      const forked = await r.actions.forkTab(id)
      if (forked !== null && remote === r && remoteFront.answered(mark, forked, r.viewer.has(forked), Date.now(), device) === 'activate') {
        activateRemote(forked, true)
      }
      return
    }
    try {
      await tabs.fork(id)
    } catch (e) {
      toast(`Cannot open tab: ${(e as Error).message}`)
    }
  })
  // Change folder: a remote tab's folder is listed and changed on its device, where the folder is
  ipcMain.handle(IPC.foldersList, (_e, id: unknown, path: unknown): Promise<FolderResult> => {
    if (!isId(id) || !(path === null || isFolderInput(path))) return Promise.resolve({ ok: false, error: 'bad arguments' })
    return remote?.viewer.has(id) ? remote.actions.listFolders(id, path) : folderListingOf(id, path, folderDeps())
  })
  ipcMain.handle(IPC.tabsChangeFolder, (_e, id: unknown, path: unknown): Promise<DeviceResult> => {
    if (!isId(id) || !isFolderInput(path)) return Promise.resolve({ ok: false, error: 'bad arguments' })
    return remote?.viewer.has(id) ? remote.actions.changeFolder(id, path) : changeFolderOf(id, path, folderDeps())
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: unknown, data: unknown) => {
    if (!isId(id) || !isPtyData(data)) return
    if (remote?.viewer.has(id)) remote.viewer.input(id, data)
    else writeInput(id, data, null)
  })
  // only the main window has the terminals; PromptQueries checks the answer itself
  ipcMain.on(IPC.promptAnswer, (e, queryId: unknown, state: unknown) => { if (win && e.sender === win.webContents) promptQueries.answer(queryId, state) })
  ipcMain.on(IPC.ptyResize, (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (!isId(id) || !isPtySize(cols, rows)) return
    if (remote?.viewer.has(id)) remote.viewer.fit(id, cols as number, rows as number)
    else applySize(id, sizes.fit(id, cols as number, rows as number))
  })
  ipcMain.handle(IPC.imagesList, (_e, tabId: unknown): ImagesUpdate => {
    if (!isId(tabId)) return { tabId: '', cards: [], unseen: 0, notice: null }
    // a remote tab's images are the last update its device sent; an empty one until then
    if (remote?.viewer.has(tabId)) return lastImages.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null }
    return imagesUpdate(tabId)
  })
  ipcMain.handle(IPC.remoteDevices, (): RemoteDeviceView[] => remote?.viewer.devices() ?? [])
  // the lists of the new-tab menu: the kept answers at once, and a refresh of every device's lists in the background
  ipcMain.handle(IPC.devicesChoices, () => {
    const view = choicesNow()
    remote?.actions.refreshChoices()
    return view
  })
  // the other devices' Recent sessions: the kept answers at once, and a refresh of every device's list in the background
  ipcMain.handle(IPC.remoteSessions, () => {
    const view = remoteSessionsView()
    remote?.actions.refreshSessions()
    return view
  })
  ipcMain.handle(IPC.remoteOpenTab, async (_e, device: unknown, kind: unknown, profile: unknown, account: unknown): Promise<string | null> => {
    if (!isOpenRemoteTabArgs(device, kind, profile, account) || !remote || quitting) return null
    const r = remote
    const mark = remoteFront.mark()
    const tabId = await r.actions.openTab(device as string, { kind: kind as 'claude' | 'shell', profile: profile as string | null, account: account as string | null, resume: null })
    // the tab comes to the front here once it is listed, unless the person picked another tab meanwhile; a holder that went meanwhile takes no request
    if (tabId !== null && remote === r && remoteFront.answered(mark, tabId, r.viewer.has(tabId), Date.now(), device as string) === 'activate') {
      activateRemote(tabId, true)
    }
    return tabId
  })
  ipcMain.on(IPC.screenSeed, (_e, id: unknown, token: unknown, data: unknown) => {
    if (isId(id) && isSeedToken(token) && isSeedText(data)) remote?.seed(id, token, data)
  })
  // a remote tab's Changes actions go to its device, which checks them; a local tab's go to its review
  ipcMain.on(IPC.reviewSetScope, (_e, tabId: unknown, scope: unknown) => {
    if (!isId(tabId) || !isReviewScope(scope)) return
    if (remote?.viewer.has(tabId)) remote.actions.review(tabId, { k: 'scope', scope })
    else review.setScope(tabId, scope)
  })
  ipcMain.on(IPC.reviewClearRequest, (_e, tabId: unknown) => {
    if (!isId(tabId)) return
    if (remote?.viewer.has(tabId)) remote.actions.review(tabId, { k: 'clear' })
    else review.clearRequest(tabId)
  })
  ipcMain.on(IPC.reviewRefresh, (_e, tabId: unknown) => {
    if (!isId(tabId)) return
    if (remote?.viewer.has(tabId)) remote.actions.review(tabId, { k: 'refresh' })
    else review.refresh(tabId)
  })
  ipcMain.on(IPC.reviewSetViewed, (_e, tabId: unknown, path: unknown, hash: unknown, viewed: unknown) => {
    if (!isId(tabId) || typeof viewed !== 'boolean') return
    // a remote tab's path is checked by its device, with the rules of its own system: here it is only bounded text
    if (remote?.viewer.has(tabId)) {
      if (isPathText(path) && isHash(hash)) remote.actions.review(tabId, { k: 'viewed', path, hash, viewed })
    } else if (isAbsPath(path) && isHash(hash)) review.setViewed(tabId, path, hash, viewed)
  })
  ipcMain.on(IPC.reviewShowFile, (_e, tabId: unknown, path: unknown) => {
    if (!isId(tabId)) return
    if (remote?.viewer.has(tabId)) {
      if (isPathText(path)) remote.actions.review(tabId, { k: 'show', path })
    } else if (isAbsPath(path)) review.showFile(tabId, path)
  })
  // only a file the tab's view shows; without an editor the file is shown in its folder, never opened: that could run it
  ipcMain.on(IPC.reviewOpenEditor, (_e, tabId: unknown, path: unknown, line: unknown) => {
    if (!isId(tabId) || remote?.viewer.has(tabId) || !isAbsPath(path) || !isLineNo(line) || !review.hasFile(tabId, path)) return
    launchEditor(settings.review.editor, path, line, { spawn: spawnDetached, reveal: (p) => shell.showItemInFolder(p), onError: toast })
  })
  // only a file the tab's view shows; a file gone from the disk opens its folder
  ipcMain.on(IPC.reviewReveal, (_e, tabId: unknown, path: unknown) => {
    if (!isId(tabId) || remote?.viewer.has(tabId) || !isAbsPath(path) || !review.hasFile(tabId, path)) return
    revealInFolder(path, nodeRevealDeps((p) => shell.showItemInFolder(p), (d) => void shell.openPath(d)))
  })
  ipcMain.handle(IPC.panelSet, (_e, width: unknown, resize: unknown) => (liveWin() && isPanelWidth(width) && isFlag(resize) ? panelRoom.set(Math.round(width), resize) : panelRoom.mode))
  const accountsView = (): AccountsView => ({ accounts: accounts.list(), keyring: accounts.keyring() })
  /** both windows show the accounts: the settings window lists them, the main window's menus and status bar name them */
  const accountsChanged = (r: AccountResult): AccountResult => {
    if (r.ok) broadcast(IPC.evAccounts, accountsView())
    return r
  }
  // the store checks the names, tokens and ids it is given
  ipcMain.handle(IPC.accountsList, () => accountsView())
  ipcMain.handle(IPC.accountsAdd, (_e, name: unknown, token: unknown) => accountsChanged(accounts.add(name, token)))
  ipcMain.handle(IPC.accountsRename, (_e, id: unknown, name: unknown) => accountsChanged(accounts.rename(id, name)))
  ipcMain.handle(IPC.accountsSetToken, (_e, id: unknown, token: unknown) => accountsChanged(accounts.setToken(id, token)))
  ipcMain.handle(IPC.accountsRemove, (_e, id: unknown) => accountsChanged(accounts.remove(id)))
  ipcMain.on(IPC.accountsGetToken, () => {
    if (openTab({ kind: 'shell', cwd: homedir(), title: 'Get a token' }, true, true)) focusWindow()
  })
  ipcMain.handle(IPC.reviewCanSend, (_e, tabId: unknown) => {
    if (!isId(tabId)) return { ok: false, reason: NOT_RUNNING }
    return remote?.viewer.has(tabId) ? remote.actions.canSend(tabId) : review.canSend(tabId)
  })
  ipcMain.handle(IPC.reviewLines, (_e, tabId: unknown, path: unknown, hash: unknown, from: unknown, to: unknown) =>
    isId(tabId) && isAbsPath(path) && isHash(hash) && isLineSpan(from, to) ? review.contextLines(tabId, path, hash, from as number, to as number) : null)
  /** a picture on the clipboard as a PNG; an image the system cannot read is toasted with `failure` */
  const copyPicture = (img: Electron.NativeImage, failure: string): void => {
    if (img.isEmpty()) {
      toast(failure)
      return
    }
    const png = img.toPNG()
    clipboard
      .write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
      .catch((e: unknown) => toast(`Cannot copy image: ${String(e)}`))
  }
  /** an action on a card of another device's tab: the bytes and the path are that device's; open and reveal show a file of this device, so they do nothing */
  const remoteImageAction = (cardId: string, action: ImageAction): void => {
    const card = remoteImages.card(cardId)
    const r = remote
    if (!card || !r || !r.viewer.has(card.tabId)) return
    switch (action) {
      case 'copy-image':
        if (card.kind !== 'image') break
        {
          const cached = remoteImages.cached(cardId, card.version)
          if (cached) {
            copyPicture(nativeImage.createFromBuffer(cached), `Cannot copy this image format: ${card.path}`)
            break
          }
          const version = card.version
          void r.actions.imageBytes(card.tabId, cardId, version, () => remoteImages.card(cardId)?.version === version).then((got) => {
            if (got) copyPicture(nativeImage.createFromBuffer(got.data), `Cannot copy this image format: ${card.path}`)
            else toast(REMOTE_COPY.imageUnavailable)
          })
        }
        break
      case 'copy-path':
        void clipboard.writeText(card.path)
        break
      case 'remove':
        r.actions.removeImage(card.tabId, cardId)
        break
      case 'open':
      case 'reveal':
        break
    }
  }
  /** the copies to remote tabs: one per tab at a time, the toasts name the device, and the sending is the device's */
  const copies = new RemoteCopies({
    toast,
    sendFiles: (tabId, files) => (remote ? sendFiles(remote.actions, tabId, files) : Promise.reject(new CallError(REMOTE_COPY.unknownTab))),
    nameOf: (tabId) => {
      const device = remote?.viewer.has(tabId) ? remote.viewer.deviceOf(tabId) : null
      if (!remote || device === null) return null
      return remote.viewer.devices().find((d) => d.id === device)?.name ?? device
    }
  })
  // a clipboard image pasted into a remote tab is copied to its device, and the path it was saved at there is answered
  ipcMain.handle(IPC.remotePasteImage, (_e, tabId: unknown): Promise<string | null> => {
    if (!isId(tabId)) return Promise.resolve(null)
    return copies.copy(tabId, async () => {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return null
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      return [{ name: `clipboard-${Date.now()}.png`, size: png.length, read: async (offset, length) => png.subarray(offset, offset + length) }]
    }).then((sent) => sent?.text ?? null)
  })
  // files dropped on a remote tab are copied to its device, and the text to type for them there is answered; this device's own files only
  ipcMain.handle(IPC.remoteDropFiles, (_e, tabId: unknown, paths: unknown): Promise<string | null> => {
    if (!isId(tabId) || !remote?.viewer.has(tabId)) return Promise.resolve(null)
    if (Array.isArray(paths) && paths.length > MAX_TRANSFER_FILES) return Promise.resolve(copies.refuse(tabId, REMOTE_COPY.copyTooManyFiles))
    if (!isDropPaths(paths)) return Promise.resolve(null)
    const files = paths
    return copies.copy(tabId, () => Promise.all(files.map((p) => fileToSend(p)))).then((sent) => sent?.text ?? null)
  })
  /** the text typed for paths into one of this device's tabs: quoted for the shell the tab runs, from the live profiles */
  function typedTextOf(tabId: string, paths: string[]): string {
    const info = tabs.get(tabId)
    return typedPaths(profiles.find((p) => p.name === info?.profile) ?? null, info?.kind ?? 'claude', paths)
  }
  // the text typed for files dropped on a local tab
  ipcMain.handle(IPC.typedPaths, (_e, tabId: unknown, paths: unknown): string | null => {
    if (!isId(tabId) || !tabs.get(tabId) || !isLocalDropPaths(paths)) return null
    return typedTextOf(tabId, paths)
  })
  ipcMain.on(IPC.imagesMarkSeen, (_e, tabId: unknown) => {
    if (!isId(tabId)) return
    if (remote?.viewer.has(tabId)) remote.actions.markImagesSeen(tabId)
    else images.markSeen(tabId)
  })
  ipcMain.on(IPC.imagesAction, (_e, cardId: unknown, action: unknown) => {
    if (!isId(cardId) || !isImageAction(action)) return
    const card = images.get(cardId)
    if (!card) {
      remoteImageAction(cardId, action)
      return
    }
    switch (action) {
      case 'open':
        void openCard(card, {
          imageExtensions: [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions],
          openPath: (p) => shell.openPath(p),
          toast
        })
        break
      case 'reveal':
        shell.showItemInFolder(card.path)
        break
      case 'copy-image':
        if (card.kind !== 'image') break
        copyPicture(nativeImage.createFromPath(card.path), `Cannot copy this image format: ${card.path}`)
        break
      case 'copy-path':
        void clipboard.writeText(card.path)
        break
      case 'remove':
        images.remove(cardId)
        break
    }
  })
  ipcMain.handle(IPC.docsRead, async (_e, docId: unknown): Promise<DocRead> => {
    const doc = isId(docId) ? docs.get(docId) : undefined
    return doc ? readDocText(doc.path) : { ok: false, error: 'unknown document' }
  })
  ipcMain.handle(IPC.docsStamp, async (_e, docId: unknown): Promise<string | null> => {
    const doc = isId(docId) ? docs.get(docId) : undefined
    return doc ? docStamp(doc.path) : null
  })
  ipcMain.on(IPC.docsAction, (_e, docId: unknown, action: unknown) => {
    if (!isId(docId) || !isDocAction(action)) return
    const doc = docs.get(docId)
    if (!doc) return
    switch (action) {
      case 'open':
        void shell.openPath(doc.path).then((answer) => { if (answer) toast(answer) })
        break
      case 'reveal':
        revealInFolder(doc.path, nodeRevealDeps((p) => shell.showItemInFolder(p), (d) => void shell.openPath(d)))
        break
      case 'copy-path':
        void clipboard.writeText(doc.path)
        break
      case 'remove':
        docs.remove(docId)
        break
    }
  })
  // only a Markdown document the panel shows: the editor gets its text, the other kinds are not opened in an editor
  ipcMain.on(IPC.docsOpenEditor, (_e, docId: unknown, line: unknown) => {
    if (!isId(docId) || !isLineNo(line)) return
    const doc = docs.get(docId)
    if (!doc || doc.kind !== 'markdown') return
    launchEditor(settings.review.editor, doc.path, line, { spawn: spawnDetached, reveal: (p) => shell.showItemInFolder(p), onError: toast })
  })
  ipcMain.handle(IPC.restoreGet, () => restoreInfo())
  ipcMain.on(IPC.restoreRun, () => { void runRestore() })
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
    offScreen: isTest,
    load: (w, section) => {
      if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html${section ? `#${section}` : ''}`)
      else void w.loadFile(join(__dirname, '../renderer/settings.html'), section ? { hash: section } : undefined)
    }
  })
  ipcMain.on(IPC.settingsOpenWindow, () => settingsWindow.open())
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(app.name, () => settingsWindow.open())))
  ipcMain.handle(IPC.clipboardRead, async (): Promise<ClipboardContent> => ({ text: await clipboard.readText(), hasImage: await clipboard.has('image/png') }))
  ipcMain.on(IPC.clipboardWriteText, (_e, text: string) => { void clipboard.writeText(text) })
  // checked at the first image paste of the run; tests stand in for PowerShell with a program run without arguments
  const testPowerShell = isTest ? process.env.CLAUDETERM_TEST_POWERSHELL : undefined
  const claudeReadsClipboard = checkOnce(() => runsCleanly(testPowerShell ? { file: testPowerShell, args: [] } : CLAUDE_CLIPBOARD_CHECK, 5000))
  ipcMain.handle(IPC.clipboardImageAsFile, async (): Promise<boolean> => !(await claudeReadsClipboard()))
  ipcMain.handle(IPC.clipboardSaveImage, async (): Promise<string | null> => {
    try {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return null
      const png = new Uint8Array(await (await item.getType('image/png')).arrayBuffer())
      mkdirSync(clipboardImageRoot, { recursive: true })
      const file = join(clipboardImageRoot, `clipboard-${Date.now()}.png`)
      writeFileSync(file, png)
      return file
    } catch (e) {
      toast(`Cannot paste the image: ${String(e)}`)
      return null
    }
  })
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
      const renderMarkdown = settings.review.renderMarkdown
      const noRoom = settings.sidePanel.noRoom
      const devicePortBefore = settings.devices.port
      const testsBefore = JSON.stringify(settings.review.hideTests ? settings.review.testPatterns : null)
      const refreshBefore = statusRefreshInterval(settings.claude)
      settings = next.settings
      // Claude tabs started from now on read their settings file with the new status bar refresh
      const refreshNow = statusRefreshInterval(settings.claude)
      if (refreshNow !== refreshBefore) {
        try {
          writeClaudeTabFiles(dataDir, process.execPath, hookScript, refreshNow)
        } catch (e) {
          notices = [...notices, `Cannot update claude-tab-settings.json: ${(e as Error).message}`]
        }
      }
      const computed = computeProfiles(settings)
      profiles = computed.profiles
      notices = [...notices, ...computed.notices]
      send(IPC.evSettings, settings)
      // the active tab's Last turn and Session views list other files now, or give their Markdown files whole or not
      const active = tabs.activeTabId()
      const testsNow = JSON.stringify(settings.review.hideTests ? settings.review.testPatterns : null)
      const changed = hideIgnored !== settings.review.hideIgnored || testsBefore !== testsNow || renderMarkdown !== settings.review.renderMarkdown
      if (changed && active) review.refresh(active)
      if (noRoom !== settings.sidePanel.noRoom) refitPanel()
      // the group listens on the port it was opened with: a new port opens it again, also while it is still opening
      if ((group || opening) && devicePortBefore !== settings.devices.port) void restartDevices()
      updateAwake()
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
    minWidth: MIN_WIDTH,
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
  trackWindowState(win, windowStatePath, () => panelRoom.added)
  // maximized or full screen the window cannot make room for the side panel; restored, it can again (and gives back the
  // width of a panel closed meanwhile). Deferred: the window takes its new size after the event on some systems.
  const refitLater = (): void => { setTimeout(refitPanel, 0) }
  win.on('maximize', refitLater)
  win.on('unmaximize', refitLater)
  win.on('enter-full-screen', refitLater)
  win.on('leave-full-screen', refitLater)
  win.on('close', () => { sessions.flush(); notes.flush(); taskListStore.flush(); bridge?.flush(); group?.flush() })
  win.once('ready-to-show', () => {
    if (!win) return
    showWindow(win, isTest)
    // a window that starts focused gets no focus event: its presence is read now
    presence.check()
  })
  win.on('focus', () => {
    win?.flashFrame(false)
    places.refreshAll()
    const id = tabs.activeTabId()
    if (id) review.trigger(id)
    // the device that owns a tab in front here hears when this device becomes present: its tab clears its attention
    presence.check()
  })
  win.on('blur', () => presence.check())
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // ClaudeTerm uses no WebRTC: a page may send its data over UDP only through a proxy, so a report's script cannot use it to reach the network
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // a document's HTML or PDF may load its own frames; any other frame navigation is refused
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !frameNavigationAllowed(e.url, (id) => docs.get(id) !== undefined)) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  app.on('window-all-closed', () => app.quit())
  let ptysExited = false
  app.on('before-quit', (e) => {
    if (ptysExited) return
    quitting = true
    remote?.dispose()
    remote = null
    keepAwake.dispose()
    presence.dispose()
    earlyPeers.clear()
    updater.stop()
    sessions.flush()
    notes.flush()
    taskListStore.flush()
    bridge?.flush()
    group?.flush()
    for (const id of [...sources.keys()]) stopTabImages(id)
    for (const t of imageTimers.values()) clearTimeout(t)
    imageTimers.clear()
    tabs.disposeAll()
    review.dispose()
    receiver.dispose()
    settingsWatcher.close()
    void pipe?.close()
    // Quitting while ConPTY sessions are still shutting down keeps the process alive for seconds after the
    // window is gone (indefinitely on some machines): let the killed PTYs exit first, then quit for real.
    e.preventDefault()
    void allPtysExited(3000).then(() => {
      ptysExited = true
      // last: a Git Bash that Claude Code starts while its tab closes still finds the runtime ready
      msysAnchor?.stop()
      app.quit()
    })
  })
}
