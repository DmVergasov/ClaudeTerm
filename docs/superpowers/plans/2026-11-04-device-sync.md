# Device Sync, Part 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClaudeTerm devices pair with a one-time code, keep mutually authenticated TLS connections to each other over a network the user set up, and keep one merged copy of the starred sessions and session notes — all behind `devices.enabled` (off by default).

**Architecture:** A state-based replica (multi-value registers with dotted version vectors, ordered by a hybrid logical clock) holds five collections: `admitted`, `removed`, `members`, `stars`, `notes`. `DeviceNet` owns the TLS listener, dialing, pairing and member authentication; `DeviceGroup` runs the exchange over the authenticated links and builds the view for the Settings window; `StoreBridge` keeps `StarredSessions` / `SessionNotes` (still the app-facing stores, still writing their own files) and the replica in step. The renderer gets a Devices section and live star updates.

**Tech Stack:** TypeScript (strict), Electron 44 main process, Node `tls` / `crypto` / `net`, `@peculiar/x509` (new devDependency, bundled into main) for the self-signed certificate, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-device-sync-design.md` — read it first; this plan argues from it.

## Global Constraints

- **No git commits.** Leave every change uncommitted; the user commits. There are no commit steps in this plan.
- Everything is off unless `settings.json` has `"devices": { "enabled": true }`. Off: no port, no new files, the Settings window shows no Devices section, stars and notes behave exactly as today.
- `devices.port` default **47821**, whole number 1024–65535.
- Pairing code: **16 Crockford base32 characters in four groups of four** (`K7QM-2XPD-9TRA-W4BN`), alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 80 bits from 10 random bytes; valid **5 minutes**, one pairing, cancelled after **5** wrong proofs.
- TLS 1.3 only (`minVersion: 'TLSv1.3'`), both sides present certificates; ECDSA P-256 self-signed certificates; identity = lowercase hex SHA-256 of the public key's SPKI DER. No home-made cryptography: HMAC-SHA256 and `timingSafeEqual` from `node:crypto`.
- Everything from the network is untrusted: validate shapes (Task 5) and values (Task 1) and drop what fails; never throw out of a socket handler.
- The main process never blocks on the network; no synchronous waits on sockets.
- Every UI string is English. The exact strings are in `DEVICE_COPY` (Task 11) and must be used as written.
- Data files in the data folder: `device-identity.json` (mode 0o600), `sync-replica.json`. Both are written through a `.tmp` file and renamed; a file that cannot be read is moved aside (`.corrupt-<ms>`), never written over.
- Tests never use a network address other than `127.0.0.1`, never the real data folder, never the real `claude`. The app honors `CLAUDETERM_TEST_DEVICE_HOST` and `CLAUDETERM_TEST_DEVICE_PORT` only when `CLAUDETERM_TEST=1`.
- Match the surrounding code: no UI framework, manual guards (no zod in main), comments in the style of `session-notes.ts`, LF line endings in new files.
- Not in `CHANGELOG.md` or the README (released later together with part 2).

## Review Focus

1. **Addresses as people type them** — `macbook`, `192.168.1.20:5000`, `[::1]:47821`, `::1`, with spaces around — must all parse; `host:0`, `host:99999`, empty must be refused with the "does not answer" error, not a crash. Test: Task 7, `parseAddress`.
2. **Codes as people type them** — lowercase, without dashes, with spaces, `O` for `0`, `I`/`L` for `1` — must be accepted. Test: Task 3, `normalizePairCode`.
3. **The port is taken** (a second ClaudeTerm, another program) — the Devices section shows the problem; nothing throws. Test: Task 7, "a port in use is reported as a problem".
4. **A laptop sleeps with the connection open** — the dead connection must be noticed by the ping timeout and redialed, not stay "Connected" forever. Test: Task 6, "a link that hears nothing closes"; Task 7, "reconnects after the other side comes back".
5. **A note at the length limit** (100 000 characters, non-ASCII) must travel. Test: Task 5, "a 100 000-character note survives a frame round trip".

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/devices.ts` (new) | Types and constants shared with the renderer: `DevicesView`, `DeviceView`, `DeviceState`, `DeviceResult`, limits, `DEVICE_COPY` |
| `src/main/sync/clock.ts` (new) | Hybrid logical clock, stamp ordering |
| `src/main/sync/replica.ts` (new) | Records, local writes, merge, exchange bookkeeping |
| `src/main/sync/views.ts` (new) | Reading a key's state per collection (star, note join, member, admission, removal) and value validation |
| `src/main/sync/replica-file.ts` (new) | `sync-replica.json` on disk |
| `src/main/sync/pair-code.ts` (new) | Pairing code and proof |
| `src/main/sync/identity.ts` (new) | Device id, key, certificate, fingerprint; `device-identity.json` |
| `src/main/sync/wire.ts` (new) | Framing, message types, message shape validation |
| `src/main/sync/address.ts` (new) | Parsing typed addresses; this machine's addresses |
| `src/main/sync/peer-link.ts` (new) | One TLS connection: frames in and out, ping, idle close |
| `src/main/sync/device-net.ts` (new) | Listener, dialing with backoff, pairing handshake, member authentication, duplicate links, removal notice |
| `src/main/sync/device-group.ts` (new) | Exchange over links, membership actions, the view |
| `src/main/sync/store-bridge.ts` (new) | Keeps `StarredSessions`, `SessionNotes` and the group in step |
| `src/main/starred-sessions.ts`, `src/main/session-notes.ts`, `src/main/note-hub.ts` | Sync hooks; notes from another device |
| `src/main/settings.ts`, `src/shared/types.ts` | `devices` settings |
| `src/main/index.ts`, `src/main/ipc-guards.ts`, `src/shared/ipc.ts`, `src/preload/index.ts` | Wiring, IPC |
| `src/renderer/devices-section.ts` (new), `src/renderer/settings-page.ts`, `src/renderer/recent-sessions.ts`, `src/renderer/main.ts`, `src/renderer/styles.css` / settings styles | UI |
| `tests/fixtures/sync.ts` (new) | Fake vault, temp dirs, identities for the sync tests |

---

### Task 1: Clock, replica and views

**Files:**
- Create: `src/main/sync/clock.ts`, `src/main/sync/replica.ts`, `src/main/sync/views.ts`, `src/shared/devices.ts` (types only in this task: `DevicePlatform`, `DEVICE_PLATFORMS`, `MAX_DEVICE_NAME`, `MAX_ADDRESS_LENGTH`)
- Test: `tests/unit/sync-replica.test.ts`, `tests/unit/sync-views.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/devices.ts`: `type DevicePlatform = 'windows' | 'macos' | 'linux'`; `DEVICE_PLATFORMS: readonly DevicePlatform[]`; `MAX_DEVICE_NAME = 64`; `MAX_ADDRESS_LENGTH = 255`.
  - `clock.ts`: `interface Stamp { t: number; c: number }`; `class Clock { constructor(last: Stamp | null, now: () => number); now(): Stamp; observe(s: Stamp): void; last(): Stamp }`; `compareStamps(a: Stamp, aBy: string, b: Stamp, bBy: string): number` (by `t`, then `c`, then the device id string).
  - `replica.ts`: `type Collection = 'admitted' | 'removed' | 'members' | 'stars' | 'notes'`; `COLLECTIONS: readonly Collection[]`; `type Dot = [by: string, seq: number]`; `type VersionVector = Record<string, number>`; `interface Sibling { value: unknown; at: Stamp; dot: Dot }`; `interface KeyState { siblings: Sibling[]; ctx: VersionVector }`; `interface RecordUpdate { col: Collection; key: string; state: KeyState }`; `interface LocalState { addresses: Record<string, string>; name: string | null; removedBy: string | null }`; `interface ReplicaData { version: 1; device: string; seq: number; clock: Stamp | null; seen: VersionVector; records: Record<Collection, Record<string, KeyState>>; local: LocalState }`; `emptyReplica(device: string): ReplicaData`;
    `class Replica { constructor(data: ReplicaData, now?: () => number); readonly device: string; get(col: Collection, key: string): KeyState | undefined; keys(col: Collection): string[]; context(col: Collection, key: string): VersionVector; write(col: Collection, key: string, value: unknown, base?: VersionVector): RecordUpdate; apply(updates: RecordUpdate[]): RecordUpdate[]; since(peer: VersionVector): RecordUpdate[]; seen(): VersionVector; absorbSeen(v: VersionVector): void; local: LocalState; data(): ReplicaData }`
  - `views.ts`: `starOf(s?: KeyState): boolean`; `noteOf(s?: KeyState): Note | null`; `interface Admission { fingerprint: string; addedBy: string; addedAt: number }`; `admissionOf(s?: KeyState): Admission | null`; `interface Removal { by: string; at: number }`; `isRemoved(s?: KeyState): boolean`; `removalOf(s?: KeyState): Removal | null`; `interface SelfDescription { name: string; platform: DevicePlatform; addresses: string[]; port: number }`; `memberOf(s?: KeyState): SelfDescription | null`; `validSibling(col: Collection, key: string, s: Sibling): boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-replica.test.ts` (devices `A = '1…'`, `B = '2…'` as UUIDs, a `now` the test controls):

```ts
it('a later local write replaces the earlier one', () => {
  const r = new Replica(emptyReplica(A), () => 1000)
  r.write('stars', S1, true); r.write('stars', S1, false)
  expect(r.get('stars', S1)!.siblings.map((s) => s.value)).toEqual([false])
  expect(r.seen()).toEqual({ [A]: 2 })
})
it('two writes on the same base from two devices are both kept, whatever the order of arrival', () => {
  const a = new Replica(emptyReplica(A), () => 1000), b = new Replica(emptyReplica(B), () => 2000)
  const wa = a.write('notes', S1, noteA), wb = b.write('notes', S1, noteB)
  const x = new Replica(emptyReplica(C)); x.apply([wa]); x.apply([wb])
  const y = new Replica(emptyReplica(D)); y.apply([wb]); y.apply([wa])
  expect(x.get('notes', S1)).toEqual(y.get('notes', S1))
  expect(x.get('notes', S1)!.siblings).toHaveLength(2)
})
it('a write on a base that includes the other device\'s write replaces it', () => { /* b applies wa, then writes: one sibling, value from b */ })
it('a write on an older base (passed explicitly) keeps the sibling it did not see', () => {
  /* a writes v1; base = a.context(); b's write arrives at a; a.write(..., v2, base) → 2 siblings: b's and v2 */
})
it('applying the same update twice changes nothing and is not reported', () => {
  expect(x.apply([wa])).toHaveLength(1); expect(x.apply([wa])).toEqual([])
})
it('since() gives the records with writes the peer has not seen; absorbSeen raises seen', () => {
  /* a writes S1, S2; since({ [A]: 1 }) → only S2's update; since({}) → both; absorbSeen({ [B]: 7 }) → seen()[B] === 7 */
})
it('apply advances seen only over writes without a gap', () => {
  // a writes three keys: w1, w2, w3 (seq 1, 2, 3)
  x.apply([w3]); expect(x.seen()[A] ?? 0).toBe(0)
  x.apply([w1, w2]); expect(x.seen()[A]).toBe(2)
  x.apply([w3]); expect(x.seen()[A]).toBe(3)
})
it('a device whose clock runs an hour ahead does not make a later change lose', () => {
  /* fast = Replica(B, () => base + 3_600_000) stars S1 true; a applies it, then a.write(stars, S1, false) with a's clock at base → starOf(a.get) === false, and the same on fast after applying a's update */
})
it('a sibling that fails validSibling is dropped on apply', () => { /* a stars update whose value is 'yes' → get() undefined, apply() returns [] */ })
```

`tests/unit/sync-views.test.ts`:

```ts
it('starOf: the latest sibling; none is false')
it('noteOf joins concurrent texts: the later text, an empty line, the other', () => {
  expect(noteOf(state([sib(note('one', 'card'), t1, A), sib(note('two', 'label'), t2, B)])))
    .toEqual({ text: 'two\n\none', shown: true, form: 'label' })
})
it('noteOf: an empty or equal text adds nothing', () => { /* ['', 'x'] → 'x'; ['x', 'x'] → 'x' */ })
it('noteOf: a removal concurrent with an edit keeps the edit; only removals → null')
it('noteOf: three concurrent texts give the same note in every order of the siblings')
it('noteOf cuts the joined text at MAX_NOTE_LENGTH')
it('admissionOf: the earliest sibling; isRemoved: any sibling; memberOf: the latest sibling')
it('validSibling', () => {
  expect(validSibling('members', A, sib(desc, t1, B))).toBe(false)   // a device describes only itself
  expect(validSibling('members', A, sib(desc, t1, A))).toBe(true)
  expect(validSibling('stars', S1, sib('yes', t1, A))).toBe(false)
  expect(validSibling('notes', S1, sib({ text: 'x'.repeat(MAX_NOTE_LENGTH + 1), shown: true, form: 'card' }, t1, A))).toBe(false)
  expect(validSibling('admitted', B, sib({ fingerprint: 'f'.repeat(64), addedBy: A, addedAt: 1 }, t1, A))).toBe(true)
  expect(validSibling('stars', 'not-a-uuid', sib(true, t1, A))).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/sync-replica.test.ts tests/unit/sync-views.test.ts`
Expected: FAIL — cannot resolve `../../src/main/sync/replica`.

- [ ] **Step 3: Implement `clock.ts`, `replica.ts`, `views.ts`**

`Clock.now()`: `pt = now()`; if `pt > last.t` the stamp is `{ t: pt, c: 0 }`, else `{ t: last.t, c: last.c + 1 }`; it becomes `last`. `observe(s)`: if `s` is after `last` (`t`, then `c`) it becomes `last`.

Replica algorithm (`covers(vv, [by, seq]) = (vv[by] ?? 0) >= seq`; `maxVV` takes the larger number per device; siblings are kept sorted by `dot` so equal states compare and serialize equally):

```
write(col, key, value, base = context(col, key)):
  seq += 1; dot = [device, seq]; at = clock.now()
  cur = get(col, key) ?? { siblings: [], ctx: {} }
  siblings = cur.siblings.filter(s => !covers(base, s.dot)) ++ [{ value, at, dot }]
  ctx = maxVV(cur.ctx, base); ctx[device] = seq; seen[device] = seq
  store; return { col, key, state }

merge(a, b):
  keepA = a.siblings.filter(s => !covers(b.ctx, s.dot) || b has s.dot)
  keepB = b.siblings.filter(s => !covers(a.ctx, s.dot) && keepA lacks s.dot)
  return { siblings: sort(keepA ++ keepB), ctx: maxVV(a.ctx, b.ctx) }

apply(updates):
  for u: drop siblings failing validSibling(u.col, u.key, s); clock.observe(s.at) for the rest
         merged = merge(cur ?? empty, u.state); if differs from cur: store, add to result
  for every device X in the dots of all updates: sort their seqs; while seen[X] + 1 is among them: seen[X] += 1
  return result (the merged states that changed)

since(peer) = every stored state with a sibling whose dot[1] > (peer[dot[0]] ?? 0)
```

`noteOf`: live siblings (value not null) sorted latest first by `compareStamps`; none → `null`; texts = the distinct non-blank texts in that order joined with `'\n\n'`, cut to `MAX_NOTE_LENGTH`; `shown`/`form` from the latest live sibling. `validSibling` checks: the dot (`isUuid` device, positive safe integer seq), the stamp (non-negative safe integers), the key (`isUuid` for every collection) and the value per collection — `stars` boolean; `notes` `null` or a valid `Note`; `members` `dot[0] === key` and `{ name 1..MAX_DEVICE_NAME, platform in DEVICE_PLATFORMS, addresses ≤ 16 strings of 1..MAX_ADDRESS_LENGTH, port integer 1..65535 }`; `admitted` `{ fingerprint /^[0-9a-f]{64}$/, addedBy uuid, addedAt safe integer }`; `removed` `{ by uuid, at safe integer }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/sync-replica.test.ts tests/unit/sync-views.test.ts` — Expected: PASS. Then `npm run typecheck` — Expected: no errors.

---

### Task 2: The replica file

**Files:**
- Create: `src/main/sync/replica-file.ts`
- Test: `tests/integration/sync-replica-file.int.test.ts`

**Interfaces:**
- Consumes: `ReplicaData`, `emptyReplica` (Task 1).
- Produces: `class ReplicaFile { constructor(dir: string, opts?: { debounceMs?: number; onError?(m: string): void; warn?(m: string): void }); readonly path: string; load(): ReplicaData | null; schedule(data: () => ReplicaData): void; flush(): void; remove(): void }` — `path` is `<dir>/sync-replica.json`; `load()` returns `null` for a missing file and for a moved-aside one.

- [ ] **Step 1: Write the failing tests**

```ts
it('saves after the debounce, through a temp file, and loads the same data', async () => { /* schedule(); wait debounceMs 20; readdirSync(dir) === ['sync-replica.json']; load() toEqual data */ })
it('flush writes at once; schedule after flush writes again later')
it('a file that is not replica data is moved aside, reported, and loads as null', () => {
  writeFileSync(path, '{nope'); expect(f.load()).toBeNull()
  expect(readdirSync(dir).some((n) => n.startsWith('sync-replica.json.corrupt-'))).toBe(true)
  expect(warnings).toEqual([expect.stringMatching(/^Device sync data could not be read; the file was kept as sync-replica\.json\.corrupt-\d+$/)])
})
it('a file of a wrong version or shape is moved aside too', () => { /* { version: 2 } and { version: 1, device: 'x' } */ })
it('a folder that cannot be written reports through onError and does not throw')
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-replica-file.int.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `ReplicaFile`** following `SessionNotes`' load / `moveAside` / temp-file pattern; the shape check accepts `version === 1`, a UUID `device`, a non-negative integer `seq`, objects for `seen`, `records` (all five collections present, missing ones filled with `{}`) and `local`. Deep value checks are not repeated here: the `Replica` re-validates nothing it stores itself.

- [ ] **Step 4: Run to verify they pass** — same command — PASS.

---

### Task 3: Pairing code and proof

**Files:**
- Create: `src/main/sync/pair-code.ts`
- Test: `tests/unit/sync-pair-code.test.ts`

**Interfaces:**
- Produces: `newPairCode(random?: (n: number) => Buffer): string`; `normalizePairCode(input: string): string | null` (16 characters, no dashes, upper case, or `null`); `pairProof(code: string, role: 'join' | 'accept', hostFingerprint: string, joinerFingerprint: string): string` (lowercase hex HMAC-SHA256, key = the normalized code, message = `` `${role}\n${hostFingerprint}\n${joinerFingerprint}` ``); `proofMatches(a: string, b: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a new code is four groups of four Crockford characters', () => {
  expect(newPairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
  expect(newPairCode(() => Buffer.alloc(10, 0))).toBe('0000-0000-0000-0000')
  expect(newPairCode(() => Buffer.alloc(10, 0xff))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
})
it('accepts the code as people type it', () => {
  for (const typed of ['k7qm-2xpd-9tra-w4bn', 'K7QM2XPD9TRAW4BN', ' K7QM 2XPD 9TRA W4BN ']) expect(normalizePairCode(typed)).toBe('K7QM2XPD9TRAW4BN')
  expect(normalizePairCode('O0IL-1111-1111-1111')).toBe('0011111111111111')
  expect(normalizePairCode('K7QM-2XPD-9TRA')).toBeNull()
  expect(normalizePairCode('K7QM-2XPD-9TRA-W4BU')).toBeNull()   // U is not in the alphabet
})
it('the proof depends on the code, the role and both fingerprints', () => {
  const p = pairProof('K7QM-2XPD-9TRA-W4BN', 'join', FA, FB)
  expect(pairProof('k7qm2xpd9traw4bn', 'join', FA, FB)).toBe(p)
  for (const other of [pairProof(CODE2, 'join', FA, FB), pairProof(CODE, 'accept', FA, FB), pairProof(CODE, 'join', FB, FA), pairProof(CODE, 'join', FA, FX)]) expect(other).not.toBe(p)
})
it('proofMatches compares in constant time and refuses other lengths', () => { /* equal → true; different → false; 'ab' vs 'abc' → false without throwing */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-pair-code.test.ts` — FAIL.

- [ ] **Step 3: Implement** with `randomBytes(10)` by default (80 bits → 16 five-bit groups, most significant first), `createHmac('sha256', …)`, `timingSafeEqual` after a length check.

- [ ] **Step 4: Run to verify they pass** — PASS.

---

### Task 4: Device identity

**Files:**
- Create: `src/main/sync/identity.ts`, `tests/fixtures/sync.ts`
- Modify: `package.json` (`@peculiar/x509` in `devDependencies`, exact version you install), `package-lock.json` (via `npm install -D @peculiar/x509`)
- Test: `tests/integration/sync-identity.int.test.ts`

**Interfaces:**
- Consumes: `Vault` from `src/main/accounts.ts`.
- Produces: `interface DeviceIdentity { id: string; certPem: string; keyPem: string; fingerprint: string }`; `fingerprintOf(cert: X509Certificate): string`; `createIdentity(): Promise<DeviceIdentity>`; `class IdentityStore { constructor(dir: string, vault: Vault, opts?: { onError?(m: string): void; warn?(m: string): void }); readonly path: string; keyring(): boolean; load(): Promise<DeviceIdentity>; reset(): Promise<DeviceIdentity> }`.
- `tests/fixtures/sync.ts` produces: `fakeVault(available?: boolean): Vault` (encrypt = `'enc:' + text`, decrypt strips it and throws for anything else); `tempDir(tag: string): string`; `testIdentity(): Promise<DeviceIdentity>` (memoized pair of identities is fine: `identities(n)`).

- [ ] **Step 1: Write the failing tests**

```ts
it('creates an identity once and loads the same one next time', async () => {
  const a = await new IdentityStore(dir, fakeVault()).load(); const b = await new IdentityStore(dir, fakeVault()).load()
  expect(b).toEqual(a); expect(a.id).toSatisfy(isUuid); expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
})
it('the private key is stored encrypted when the vault can, as it is otherwise', async () => {
  /* JSON.parse(file).key → { encrypted: true, data: 'enc:…' } with fakeVault(true); { encrypted: false, data: '-----BEGIN PRIVATE KEY-----…' } with fakeVault(false); keyring() mirrors vault.available() */
})
it.skipIf(WIN)('the file is readable only by the user', () => { expect(statSync(path).mode & 0o777).toBe(0o600) })
it('a file that cannot be read or decrypted gives a new identity and a warning', async () => { /* garbage file → new id; and a file written with fakeVault(true) loaded with a vault whose decrypt throws → new id; warn called once each */ })
it('reset gives a new id and a new key', async () => { /* ids and fingerprints differ; load() afterwards returns the reset one */ })
it('the fingerprint is the one a TLS 1.3 peer sees for the certificate', async () => {
  const id = await createIdentity()
  const server = tls.createServer({ key: id.keyPem, cert: id.certPem, minVersion: 'TLSv1.3' }, (s) => s.end())
  await listen(server, '127.0.0.1')
  const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  await once(sock, 'secureConnect')
  expect(fingerprintOf(sock.getPeerX509Certificate()!)).toBe(id.fingerprint)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-identity.int.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`createIdentity`: `x509.cryptoProvider.set(webcrypto)`; generate an ECDSA P-256 key pair with `webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])`; `x509.X509CertificateGenerator.createSelfSigned` with `name: 'CN=ClaudeTerm device'`, a random serial, `notBefore` one day ago, `notAfter` in 30 years, `signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }`; key exported as PKCS#8 PEM. (If the installed `@peculiar/x509` version needs `reflect-metadata` imported first, its README says so — follow it.) `fingerprintOf`: `createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')`. File `device-identity.json`: `{ version: 1, id, cert, key: { encrypted, data } }`, written like `nodeAccountFile.write` (remove `.tmp`, write with `mode: 0o600`, rename). The fingerprint is recomputed from the certificate on load, never stored. Warning text: `This device's key could not be read; it was given a new one and has to be paired again`.

- [ ] **Step 4: Run to verify they pass** — PASS; `npm run typecheck` — no errors.

---

### Task 5: Wire format

**Files:**
- Create: `src/main/sync/wire.ts`
- Test: `tests/unit/sync-wire.test.ts`

**Interfaces:**
- Consumes: `RecordUpdate`, `VersionVector`, `COLLECTIONS` (Task 1), `DevicePlatform`, `DEVICE_PLATFORMS`.
- Produces: `PROTOCOL_VERSION = 1`; `MAX_FRAME_BYTES = 16 * 1024 * 1024`; 
  ```ts
  interface HelloMessage { t: 'hello'; v: number; id: string; name: string; platform: DevicePlatform; port: number; addresses: string[]; reachedYou: boolean | null }
  type Message = HelloMessage
    | { t: 'pair'; proof: string } | { t: 'pair-ok'; proof: string } | { t: 'pair-fail'; reason: 'code' | 'expired' | 'no-code' }
    | { t: 'removed'; by: string } | { t: 'sync'; seen: VersionVector }
    | { t: 'records'; updates: RecordUpdate[]; done?: { seen: VersionVector } } | { t: 'ping' } | { t: 'pong' }
  ```
  `encodeFrame(m: Message): Buffer` (4-byte big-endian length, then UTF-8 JSON); `class FrameError extends Error`; `class FrameDecoder { push(chunk: Buffer): unknown[] }` (throws `FrameError` for a declared length over `MAX_FRAME_BYTES` or JSON that does not parse); `parseMessage(v: unknown): Message | 'unknown' | null` (`'unknown'`: an object with a string `t` this version does not know; `null`: malformed).

- [ ] **Step 1: Write the failing tests**

```ts
it('frames split across chunks and several frames in one chunk decode in order')
it('a declared length over the limit and bad JSON throw FrameError')
it('parseMessage accepts each message type and refuses wrong shapes', () => {
  expect(parseMessage({ t: 'hello', v: 1, id: A, name: 'Studio', platform: 'windows', port: 47821, addresses: ['10.0.0.2'], reachedYou: null })).toMatchObject({ t: 'hello' })
  expect(parseMessage({ t: 'hello', v: 1, id: 'x', name: 'Studio', platform: 'windows', port: 47821, addresses: [], reachedYou: null })).toBeNull()
  expect(parseMessage({ t: 'records', updates: [{ col: 'stars', key: S1, state: { siblings: [], ctx: { [A]: -1 } } }] })).toBeNull()
  expect(parseMessage({ t: 'records', updates: [{ col: 'nope', key: S1, state: { siblings: [], ctx: {} } }] })).toBeNull()
  expect(parseMessage({ t: 'pair-fail', reason: 'other' })).toBeNull()
  expect(parseMessage({ t: 'future-thing', x: 1 })).toBe('unknown')
  expect(parseMessage([1, 2])).toBeNull()
})
it('a 100 000-character note survives a frame round trip', () => {
  const text = 'ж'.repeat(MAX_NOTE_LENGTH)
  const m: Message = { t: 'records', updates: [{ col: 'notes', key: S1, state: { siblings: [{ value: { text, shown: true, form: 'card' }, at: { t: 1, c: 0 }, dot: [A, 1] }], ctx: { [A]: 1 } } }] }
  expect(parseMessage(new FrameDecoder().push(encodeFrame(m))[0])).toEqual(m)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-wire.test.ts` — FAIL.

- [ ] **Step 3: Implement.** Shape limits: `id`/`key`/`by` UUIDs; `name` 1..`MAX_DEVICE_NAME`; `addresses` ≤ 16 strings 1..`MAX_ADDRESS_LENGTH`; `port` integer 0..65535 (0 allowed in `hello`: a device that does not listen); `proof` 64 lowercase hex; a version vector ≤ 1024 entries, UUID keys, non-negative safe integers; `updates` ≤ 10 000; `siblings` ≤ 64 each with a dot and a stamp of the right shape (values are checked later by `validSibling`); `v` a positive integer.

- [ ] **Step 4: Run to verify they pass** — PASS.

---

### Task 6: A peer link

**Files:**
- Create: `src/main/sync/peer-link.ts`
- Test: `tests/integration/sync-peer-link.int.test.ts`

**Interfaces:**
- Consumes: wire (Task 5), `fingerprintOf` (Task 4).
- Produces: `interface PeerLinkOptions { outbound: boolean; pingMs?: number; idleMs?: number; maxBufferedBytes?: number }` (defaults 15 000, 45 000, 32 MiB); `class PeerLink extends EventEmitter` with events `'message' (m: Message)` and `'close' (reason: string)`; `constructor(socket: TLSSocket, opts: PeerLinkOptions)` (the socket is already secure); `readonly peerFingerprint: string`; `readonly outbound: boolean`; `readonly remoteAddress: string | null`; `send(m: Message): void` (no-op once closed); `close(reason: string): void` (emits `'close'` once).

- [ ] **Step 1: Write the failing tests** (a loopback TLS pair built from two `testIdentity()`s with `requestCert: true, rejectUnauthorized: false`)

```ts
it('messages go both ways and each side knows the other\'s fingerprint')
it('pings keep a quiet link open', async () => { /* pingMs 50, idleMs 200; wait 600 ms; both still open */ })
it('a link that hears nothing closes', async () => {
  /* the other side's socket is paused (socket.pause()) so it never answers pings; 'close' with reason 'timeout' within idleMs + pingMs */
})
it('a malformed frame closes the link; an unknown message type is ignored')
it('send after close does nothing and does not throw')
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-peer-link.int.test.ts` — FAIL.

- [ ] **Step 3: Implement.** Reply `pong` to `ping` inside the link (not emitted); any received frame resets the idle timer; `socket.setNoDelay(true)`; a `send` while `socket.writableLength > maxBufferedBytes` closes with reason `'slow peer'`; socket errors close with the error's message; `parseMessage` `null` or a `FrameError` closes with reason `'bad message'`.

- [ ] **Step 4: Run to verify they pass** — PASS.

---

### Task 7: Addresses and the device network

**Files:**
- Create: `src/main/sync/address.ts`, `src/main/sync/device-net.ts`; add to `src/shared/devices.ts`: `DeviceState`, `PairingView`, `DeviceResult`, `DEFAULT_DEVICE_PORT = 47821`, `PAIR_CODE_TTL_MS = 300_000`, `MAX_PAIR_FAILURES = 5`, and the join error strings in `DEVICE_COPY` (see Task 11 for the full object; add the keys this task uses now)
- Test: `tests/unit/sync-address.test.ts`, `tests/integration/sync-device-net.int.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - `address.ts`: `parseAddress(input: string, defaultPort: number): { host: string; port: number } | null`; `localAddresses(ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[]` (non-internal IPv4 and non-link-local IPv6, IPv4 first, at most 16).
  - `devices.ts`: `type DeviceState = { kind: 'connected' } | { kind: 'unreachable'; address: string } | { kind: 'offline'; since: number } | { kind: 'unknown' }`; `interface PairingView { code: string; addresses: string[]; port: number; expiresAt: number }`; `type DeviceResult = { ok: true } | { ok: false; error: string }`.
  - `device-net.ts`:
    ```ts
    interface NetMember { id: string; fingerprint: string; addresses: string[]; port: number }
    interface DeviceNetDeps {
      identity: DeviceIdentity
      hello(): Omit<HelloMessage, 't' | 'v' | 'reachedYou'>
      members(): NetMember[]                      // admitted, not removed, not this device
      removedBy(fingerprint: string): string | null  // the remover's name when that fingerprint was removed
      onPaired(link: PeerLink, hello: HelloMessage, typedAddress: string | null): void
      onLink(link: PeerLink, hello: HelloMessage): void
      onRemovedNotice(by: string): void
      onReach(memberId: string, reachedYou: boolean | null): void
      onChange(): void                             // listening, pairing or a member's state changed
      host: string; port: number; now(): number
      timing?: { minRetryMs: number; maxRetryMs: number; dialTimeoutMs: number; handshakeMs: number; link?: Partial<PeerLinkOptions> }
    }
    class DeviceNet {
      constructor(deps: DeviceNetDeps)
      update(): void                     // listen or stop, dial new members, close links of former members
      startPairing(): Promise<PairingView>  // a new code, replacing a shown one; resolves once listening (port known)
      cancelPairing(): void
      pairing(): PairingView | null
      join(address: string, code: string): Promise<DeviceResult>
      state(memberId: string): DeviceState
      listeningPort(): number | null
      problem(): string | null
      links(): PeerLink[]
      wake(): void
      stop(): Promise<void>
    }
    ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-address.test.ts`:

```ts
it('parses addresses as people type them', () => {
  expect(parseAddress('macbook', 47821)).toEqual({ host: 'macbook', port: 47821 })
  expect(parseAddress(' 192.168.1.20:5000 ', 47821)).toEqual({ host: '192.168.1.20', port: 5000 })
  expect(parseAddress('[::1]:47821', 1)).toEqual({ host: '::1', port: 47821 })
  expect(parseAddress('::1', 47821)).toEqual({ host: '::1', port: 47821 })
  for (const bad of ['', '   ', 'host:0', 'host:99999', 'host:abc', '[::1', 'a b']) expect(parseAddress(bad, 47821)).toBeNull()
})
it('localAddresses keeps the external ones, IPv4 first', () => { /* a fake interfaces dict with lo, a fe80:: and a 100.64.0.5 → ['100.64.0.5', '2001:db8::5'] */ })
```

`tests/integration/sync-device-net.int.test.ts` — two or three `DeviceNet`s on `127.0.0.1`, port 0, short timings (`minRetryMs: 50, maxRetryMs: 200, dialTimeoutMs: 500, handshakeMs: 500`), members supplied by a mutable list in the test:

```ts
it('listens only while it has members or shows a code', async () => {
  expect(net.listeningPort()).toBeNull()
  await net.startPairing(); expect(net.listeningPort()).toBeGreaterThan(0)
  net.cancelPairing(); expect(net.listeningPort()).toBeNull()   // null as soon as the server is closing
})
it('pairs with the right code; both sides learn the other; the code is used up', async () => {
  const view = await a.startPairing()
  expect(await b.join(`127.0.0.1:${a.listeningPort()}`, view.code.toLowerCase())).toEqual({ ok: true })
  expect(pairedOnA).toEqual([[B_ID, null]]); expect(pairedOnB).toEqual([[A_ID, `127.0.0.1:${portA}`]])
  expect(a.pairing()).toBeNull()
  expect(await c.join(`127.0.0.1:${portA}`, view.code)).toEqual({ ok: false, error: DEVICE_COPY.joinNoCode })
})
it('a wrong code is refused; after five the code is cancelled', async () => { /* errors joinBadCode ×5, then joinNoCode; a.pairing() null */ })
it('an expired code is refused', async () => { /* deps.now moved past expiresAt → joinBadCode */ })
it('a proof made for other fingerprints is refused', async () => {
  /* a raw TLS client with its own identity sends hello + pair{ proof: pairProof(code, 'join', SOMEONE_ELSE, fpClient) } → receives pair-fail 'code' */
})
it('nothing answers: the join says so', async () => { expect(await b.join('127.0.0.1:1', CODE)).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer }) })
it('members connect to each other; a certificate that is not a member is closed', async () => { /* onLink on both; a third identity dialing gets the socket closed and no onLink */ })
it('when both dial at once one link is kept', async () => { /* both have each other as members with addresses; after settle each side has exactly one link and they are the same connection (remote/local ports match) */ })
it('a removed device is told by whom and closed', async () => { /* a.removedBy(fpB) returns 'Studio' → b gets onRemovedNotice('Studio') */ })
it('reconnects after the other side comes back; meanwhile it is offline', async () => {
  /* connected → b.stop() → a.state(B).kind === 'offline' → new DeviceNet for B on the same port → a.state(B).kind === 'connected' */
})
it('a member it cannot reach is shown with the address it tried', async () => { /* member with addresses ['127.0.0.1'] port 1 → state { kind: 'unreachable', address: '127.0.0.1:1' } */ })
it('a port in use is reported as a problem', async () => {
  /* a plain net server holds port P; DeviceNet with port P and a code → problem() === DEVICE_COPY.portInUse(P), listeningPort() null, nothing thrown */
})
it('the hello tells whether this side could reach the other', async () => { /* b's dial to a failed earlier (wrong port), then a dials b → b's hello carries reachedYou false → onReach(B, false) on a */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-address.test.ts tests/integration/sync-device-net.int.test.ts` — FAIL.

- [ ] **Step 3: Implement**

Server: `tls.createServer({ key, cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' })`, `listen(port, host)`; for host `'::'` an `EAFNOSUPPORT`/`EADDRNOTAVAIL` error retries on `'0.0.0.0'`; `EADDRINUSE` sets `problem()`. Client: `tls.connect({ host, port, key, cert, rejectUnauthorized: false, minVersion: 'TLSv1.3' })` with `dialTimeoutMs`.

Handshakes (`hello.v !== PROTOCOL_VERSION` closes; every step has `handshakeMs`):

```
member, dialer → acceptor:  dialer sends hello; acceptor checks members() has hello.id with the TLS fingerprint
                            → replies hello → both onLink(link, hello)
                            fingerprint removed → acceptor sends { t:'removed', by } and closes
                            otherwise, no code shown → closes; code shown → handled as pairing below
                            the dialer checks the acceptor's fingerprint equals the member it dialed, else closes
                            a dialer that receives 'removed' from a fingerprint it has as a member → onRemovedNotice(by)
pairing, joiner B → host A: B sends hello + { t:'pair', proof: pairProof(code,'join',fpA,fpB) }
  A: no code → pair-fail 'no-code'; now > expiresAt → pair-fail 'expired', cancel; proof wrong → failures += 1,
     MAX_PAIR_FAILURES reached → cancel; pair-fail 'code'
     right → code used up; A sends hello + { t:'pair-ok', proof: pairProof(code,'accept',fpA,fpB) };
     onPaired(link, helloB, null), then the link is a member link (onLink)
  B: pair-ok with the right proof → onPaired(link, helloA, typedAddress), onLink; join() → { ok: true }
     wrong proof → close, join() → joinNotProved; pair-fail 'code'|'expired' → joinBadCode; 'no-code' → joinNoCode;
     no TLS connection on any attempt → joinNoAnswer; unparsable address → joinNoAnswer
```

Dialing: for each member without a link, try `[local override passed in NetMember.addresses order]` — `NetMember.addresses` already lists the typed address first (the group builds it); each entry through `parseAddress(entry, member.port)`; on failure wait `min(minRetryMs · 2^n, maxRetryMs)`; `wake()` dials every unlinked member now. Duplicate rule: when a second link to a member authenticates, keep the one whose dialer id (`link.outbound ? self.id : member.id`) is lower by string comparison; close the other with reason `'duplicate'`. `onLink` is emitted only for the kept link; if the closed one had already been emitted, its `'close'` is the group's signal to drop it. State: `connected` while linked; `offline { since }` after a link closed this run; `unreachable { address: host:port last tried }` when every address failed and it was never connected this run; `unknown` before the first attempt. `reachedYou` in our hello: the result of our last dial to that member (`true`/`false`/`null`).

- [ ] **Step 4: Run to verify they pass** — PASS; `npm run typecheck` — no errors.

---

### Task 8: The device group

**Files:**
- Create: `src/main/sync/device-group.ts`; add to `src/shared/devices.ts`: `DeviceView`, `ActiveDevicesView`, `DevicesView`
- Test: `tests/integration/sync-device-group.int.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  ```ts
  // devices.ts
  interface DeviceView { id: string; name: string; platform: DevicePlatform; state: DeviceState; addedBy: string; addedAt: number; address: string | null }
  interface ActiveDevicesView { enabled: true; self: { id: string; name: string; addresses: string[]; port: number | null }; devices: DeviceView[];
    pairing: PairingView | null; unreachableByOthers: boolean; removedBy: string | null; problem: string | null; keyring: boolean; canLeave: boolean }
  type DevicesView = { enabled: false } | ActiveDevicesView
  // device-group.ts
  interface DeviceGroupDeps { dir: string; vault: Vault; host: string; port: number; platform: DevicePlatform; hostName(): string; addresses(): string[];
    now?(): number; onData(updates: RecordUpdate[]): void; onView(view: ActiveDevicesView): void;
    /** the replica started over (removed, left): the bridge writes the stores' data into it again */
    onReset(): void;
    warn(m: string): void; onError(m: string): void;
    timing?: DeviceNetDeps['timing']; saveDebounceMs?: number }
  class DeviceGroup {
    static open(deps: DeviceGroupDeps): Promise<DeviceGroup>
    write(col: 'stars' | 'notes', key: string, value: unknown, base?: VersionVector): void
    context(col: 'stars' | 'notes', key: string): VersionVector
    state(col: 'stars' | 'notes', key: string): KeyState | undefined
    keys(col: 'stars' | 'notes'): string[]
    startPairing(): Promise<ActiveDevicesView>; cancelPairing(): void
    join(address: string, code: string): Promise<DeviceResult>
    remove(id: string): DeviceResult
    leave(): Promise<DeviceResult>
    setAddress(id: string, address: string | null): DeviceResult
    rename(name: string): DeviceResult
    /** this machine's addresses may have changed: rewrite members[self] if they did, and redial */
    refreshSelf(): void
    view(): ActiveDevicesView
    wake(): void; flush(): void; close(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests** — groups in temp dirs with `fakeVault()`, host `127.0.0.1`, port 0, short timings, `hostName()` returning `Studio` / `Laptop` / `Mini`; a helper `pair(a, b)` = `const v = await a.startPairing(); return b.join('127.0.0.1:' + v.self.port, v.pairing!.code)`; `until(fn)` polls up to 5 s.

```ts
it('pairing: each lists the other as connected, added by the one that paired it', async () => {
  await pair(a, b)
  await until(() => a.view().devices[0]?.state.kind === 'connected' && b.view().devices[0]?.state.kind === 'connected')
  expect(a.view().devices[0]).toMatchObject({ name: 'Laptop', platform: 'windows', addedBy: 'Studio' })
  expect(b.view().devices[0]).toMatchObject({ name: 'Studio', addedBy: 'Laptop', address: `127.0.0.1:${portA}` })
})
it('a star written on one device arrives on the other', async () => { a.write('stars', S1, true); await until(() => starOf(b.state('stars', S1))); expect(dataOnB.at(-1)!.map((u) => u.key)).toEqual([S1]) })
it('a device that was closed catches up when it opens again', async () => { /* b.close(); a writes stars S1, notes S2; reopen b from its dir → both arrive */ })
it('a third device paired with one member becomes known to all and they connect', async () => {
  await pair(a, b); await pair(b, c)
  await until(() => a.view().devices.some((d) => d.name === 'Mini' && d.state.kind === 'connected'))
})
it('a change reaches a device through another when it cannot reach the writer directly', async () => {
  /* a–b and b–c paired; c's override for a set to '127.0.0.1:1' and a's member addresses empty → c never links to a; a.write → c gets it via b */
})
it('remove: the removed device is told, forgets the group and gets a new identity; the others refuse it', async () => {
  const oldId = b.view().self.id
  expect(a.remove(oldId)).toEqual({ ok: true })
  await until(() => b.view().removedBy === 'Studio')
  expect(b.view().devices).toEqual([]); expect(b.view().self.id).not.toBe(oldId)
  expect(a.view().devices).toEqual([])
})
it('a device removed while it was off learns it when it connects', async () => { /* b closed; a.remove(B); reopen b → removedBy 'Studio' */ })
it('leave needs a connected member; with one it removes this device everywhere', async () => {
  expect(await lonely.leave()).toEqual({ ok: false, error: DEVICE_COPY.leaveNeedsConnection })
  expect(await c.leave()).toEqual({ ok: true })
  await until(() => !a.view().devices.some((d) => d.name === 'Mini'))
  expect(c.view().devices).toEqual([]); expect(c.view().removedBy).toBeNull()
})
it('the same note changed on two devices while apart is joined on both', async () => {
  // paired, then: close b; a writes notes S1 'from Studio'; close a; reopen b, b writes 'from Laptop' (later); reopen a
  await until(() => noteOf(a.state('notes', S1))?.text === 'from Laptop\n\nfrom Studio')
  expect(noteOf(b.state('notes', S1))?.text).toBe('from Laptop\n\nfrom Studio')
})
it('a device that reports a new address is dialed there', async () => { /* b restarts on another port; it reaches a (b dials); a's member record for b now has the new port; close the link from a's side → a redials the new port and connects */ })
it('refreshSelf rewrites this device\'s addresses only when they changed', async () => { /* addresses() returns ['127.0.0.1'] then ['127.0.0.1', '10.9.9.9'] → after refreshSelf b sees the new list; a second refreshSelf writes nothing (seen unchanged) */ })
it('the port it listens on is the one it tells the others', async () => { /* port 0: after pairing, b's member record on a has b's listening port */ })
it('rename changes the name the others show', async () => { a.rename('Desk'); await until(() => b.view().devices[0]?.name === 'Desk') })
it('joining while in another group merges both groups', async () => { /* a–b paired, c–d paired; c joins a → every one of the four lists the other three */ })
it('unreachableByOthers follows the members\' reports', async () => { /* covered with DeviceNet's onReach: a member reporting false → true; an inbound link from it → false */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-device-group.int.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`open`: `IdentityStore.load()`; `ReplicaFile.load()` — a missing file, or one whose `device` is not the identity's id, starts from `emptyReplica(identity.id)`; write `members[self]` when it is missing or differs from `{ name: local.name ?? hostName(), platform, addresses: addresses(), port: net.listeningPort() ?? deps.port }` — checked again on every `DeviceNet.onChange` (the listening port becomes known) and in `refreshSelf()`; create `DeviceNet` (members = admitted, not removed, not self; each `NetMember.addresses` = `[local.addresses[id], ...memberOf(...).addresses]` without empties or duplicates, `port` from `memberOf` or `DEFAULT_DEVICE_PORT`); `update()`.

Exchange on each link: on `onLink` send `{ t: 'sync', seen }`; on `sync` send `since(peer.seen)` in `records` messages of at most ~256 KiB of JSON each, the last one carrying `done: { seen: replica.seen() }`; on `records` → `changed = replica.apply(updates)`, then `absorbSeen(done.seen)` when present; forward `changed` to every other link; `onData(changed restricted to stars and notes)`; when `admitted`, `removed` or `members` changed → `net.update()` and `onView`. Local `write` → `replica.write` → send to every link → `onData([update])` is **not** called for local writes (the bridge made them). Save through `ReplicaFile.schedule` after every change.

Pairing `onPaired`: if `admitted[self]` is missing write it (`addedBy: self`); write `admitted[peer] = { fingerprint: link.peerFingerprint, addedBy: self.id, addedAt: now }` when missing; the joiner stores `local.addresses[peer.id] = typedAddress`; clear `local.removedBy`.

`remove(id)`: refuse unknown ids (`DEVICE_COPY.unknownDevice`); write `removed[id] = { by: self, at: now }`; `net.update()` closes its link after `DeviceNet` sends the `removed` notice. `removedBy(fp)` for `DeviceNet`: the device with that admitted fingerprint, removed → the remover's `memberOf` name (or `admitted` id when unknown). `onRemovedNotice(by)` and `leave()` both reset: `net.stop()`, `IdentityStore.reset()`, `replicaFile` replaced by `emptyReplica(newId)` with `local.removedBy` = `by` (notice) or `null` (leave), a new `DeviceNet`, `onReset()`, `onView`. `leave()`: no connected member → `leaveNeedsConnection`; else write `removed[self]`, wait until the `records` message is written on every link (socket `write` callback or 2 s), then reset. `setAddress(id, null)` deletes the override; a non-null address must pass `parseAddress` (`DEVICE_COPY.badAddress` otherwise). `rename(name)`: trimmed 1..`MAX_DEVICE_NAME` without control characters (`DEVICE_COPY.badName`), `local.name = name`, rewrite `members[self]`. `canLeave` = some member connected. `keyring` = `IdentityStore.keyring()`.

- [ ] **Step 4: Run to verify they pass** — PASS (run it three times in a row to catch timing flakiness); `npm run typecheck` — no errors.

---

### Task 9: Stores and the bridge

**Files:**
- Create: `src/main/sync/store-bridge.ts`
- Modify: `src/main/starred-sessions.ts`, `src/main/session-notes.ts`
- Test: `tests/unit/sync-store-bridge.test.ts`, `tests/integration/sync-store-bridge.int.test.ts`; existing `tests/integration/starred-sessions.int.test.ts`, `tests/unit/session-notes.test.ts` keep passing unchanged

**Interfaces:**
- Consumes: `DeviceGroup` (`write`, `context`, `state`, `keys`), `starOf`, `noteOf`, `RecordUpdate`.
- Produces:
  - `StarredSessions`: `interface StarSync { changed(id: string, starred: boolean): void }`; `attach(sync: StarSync | null): void`; `set()` calls `sync.changed` when the value changed; `applySync(id: string, starred: boolean): void` (saves, does not call `sync`, calls the external listeners); `onExternal(cb: (ids: ReadonlySet<string>) => void): () => void`.
  - `SessionNotes`: `interface NoteSync { version(sessionId: string): unknown; changed(sessionId: string, note: Note | null, base: unknown): void }`; `attach(sync: NoteSync | null): void`; `version(sessionId: string): unknown` (`null` without sync); `set(sessionId: string, note: Note | null, base?: unknown): void` (calls `sync.changed(id, stored-or-null, base)`; `base` is `undefined` unless given); `applySync(sessionId: string, note: Note | null, before: unknown): void`; `keys(): string[]`; `onExternal(cb: (sessionId: string, note: Note | null, before: unknown) => void): () => void`.
  - `store-bridge.ts`: `type BridgeGroup = Pick<DeviceGroup, 'write' | 'context' | 'state' | 'keys'>`; `class StoreBridge { constructor(starred: StarredSessions, notes: SessionNotes, group: BridgeGroup, opts?: { debounceMs?: number }); start(): void; applied(updates: RecordUpdate[]): void; flush(): void; stop(): void }` — `start()` attaches both syncs and reconciles; `stop()` flushes and detaches.

- [ ] **Step 1: Write the failing tests** (`tests/unit/sync-store-bridge.test.ts`, a real `Replica` behind a tiny fake group; stores in temp dirs)

```ts
it('start writes into the group whatever the stores hold that the group does not', () => {
  starred.set(S1, true); notes.set(S2, alpha); notes.flush()
  bridge.start()
  expect(starOf(group.state('stars', S1))).toBe(true); expect(noteOf(group.state('notes', S2))).toEqual(alpha)
  bridge.start() // a second start writes nothing new
  expect(replica.seen()).toEqual({ [SELF]: 2 })
})
it('start: where the stores and the group differ, the stores win (changes made while sync was off)', () => {
  /* the group has S1 starred, the store has it unstarred → after start starOf(group S1) === false; a note removed in the store but present in the group → removed in the group */
})
it('a local star goes to the group at once; a remote one comes to the store and its listeners', () => {
  starred.set(S1, true); expect(starOf(group.state('stars', S1))).toBe(true)
  bridge.applied([remoteStar(S2, true)]); expect(starred.ids().has(S2)).toBe(true); expect(externalIds.at(-1)!.has(S2)).toBe(true)
})
it('typing in a note writes once per pause', async () => { /* notes.set ×3 within 20 ms, debounceMs 50 → one write in the group (seen[SELF] +1) after the pause */ })
it('a remote change while a local one waits: the local one is written first on its own base, and the joined note comes back', () => {
  notes.set(S1, { ...alpha, text: 'mine' })               // pending, base = the state before
  bridge.applied([remoteNote(S1, 'theirs', laterStamp)])
  expect(noteOf(group.state('notes', S1))!.text).toBe('theirs\n\nmine')
  expect(external.at(-1)).toEqual([S1, { ...alpha, text: 'theirs\n\nmine' }, expect.anything()])
})
it('a base passed to set is the base of the write', () => { /* version() before a remote change, then set(..., before) → joined */ })
it('stop detaches: changes stay local', () => { /* after stop, starred.set → group unchanged */ })
```

`tests/integration/sync-store-bridge.int.test.ts`: existing `starred-sessions.json` with two ids and `session-notes.json` with one note in a data folder → `StarredSessions` + `SessionNotes` + a real `DeviceGroup` on that folder + bridge `start()` → the group holds both stars and the note; both files still hold the same data; after `stop()` and a new `StarredSessions(dir)` the stars are unchanged.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-store-bridge.test.ts tests/integration/sync-store-bridge.int.test.ts` — FAIL.

- [ ] **Step 3: Implement**

Bridge state per note key: `shown: VersionVector` (the context whose view the store holds) and `pending: { note: Note | null; base: VersionVector } | null` with one timer per key.
- `NoteSync.version(id)` → a copy of `shown[id] ?? group.context('notes', id)`.
- `NoteSync.changed(id, note, base)` → `pending[id] = { note, base: pending[id]?.base ?? (base as VersionVector | undefined) ?? shown[id] ?? group.context('notes', id) }` (an explicit `base` replaces a pending one's base only when there is no pending write) and (re)start the timer.
- flush of a key → `group.write('notes', id, note, base)`; then `view = noteOf(group.state('notes', id))`; `shown[id] = group.context('notes', id)`; when `view` differs from the note written → `notes.applySync(id, view, baseOfThatWrite)`.
- `applied(updates)` → for each notes key: flush its pending write first, then `before = shown[id]`, `shown[id] = context`, `applySync(id, noteOf(...), before)` when the view differs from `notes.get(id)`; for each stars key: `applySync(id, starOf(...))` when it differs.
- `StarSync.changed` → `group.write('stars', id, starred)` at once.
- reconcile (in `start`, which `onReset` calls again): for every key in the union of the store's and the group's keys, compare the store's value (an absent star is `false`, an absent note `null`) with the group's view (`starOf` / `noteOf`); where they differ, write the store's value into the group. While sync is on the stores are saved with every change the bridge applies, so they differ from the group only by changes made while sync was off — the user's latest. Set `shown` for every notes key.

- [ ] **Step 4: Run to verify they pass** — PASS; existing store tests still PASS: `npx vitest run tests/integration/starred-sessions.int.test.ts tests/unit/session-notes.test.ts`.

---

### Task 10: Notes from another device in open tabs

**Files:**
- Modify: `src/main/note-hub.ts`
- Test: `tests/unit/note-hub.test.ts`

**Interfaces:**
- Consumes: `SessionNotes.set(id, note, base)`; the `before` token `SessionNotes.onExternal` passes.
- Produces: `NoteHubDeps.store: Pick<SessionNotes, 'get' | 'set'>` (now with the optional `base`); `NoteHub.external(sessionId: string, note: Note | null, before: unknown): void`; `Before` gains `{ replaced: { sessionId: string; base: unknown } }`.

- [ ] **Step 1: Write the failing tests** (the fake store records `set` calls with their `base`)

```ts
it('a note from another device goes to every tab on that conversation with the next number', () => {
  hub.addTab('t1', S1); hub.addTab('t2', S1); hub.addTab('t3', S2)
  hub.external(S1, beta, 'v0')
  expect(published).toEqual([['t1', beta, 1], ['t2', beta, 1]])
})
it('a removed note from another device clears the tab', () => { /* external(S1, null, 'v0') → ['t1', null, n] */ })
it('text typed against the note before it was replaced is written on the old base', () => {
  hub.addTab('t1', S1); hub.external(S1, beta, 'v0')
  hub.setText('t1', 'typed before', 0)
  expect(store.sets.at(-1)).toEqual([S1, { ...beta, text: 'typed before' }, 'v0'])
})
it('external does not write to the store', () => { /* store.sets unchanged */ })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/note-hub.test.ts` — FAIL.

- [ ] **Step 3: Implement** `external` with the existing `give` path (a `null` note publishes `null` and leaves `tab.note` `null`), setting `tab.before = { replaced: { sessionId, base: before } }`; `late` writes `store.set(before.replaced.sessionId, { ...(tab.note ?? EMPTY), text }, before.replaced.base)` for that kind. Existing behaviors and tests are unchanged.

- [ ] **Step 4: Run to verify they pass** — PASS (the whole file).

---

### Task 11: Settings, IPC and wiring in main

**Files:**
- Modify: `src/shared/types.ts` (`Settings.devices: { enabled: boolean; port: number }`), `src/main/settings.ts` (default `{ enabled: false, port: DEFAULT_DEVICE_PORT }`, parse with `isBool` / `wholeIn(1024, 65535)`), `src/shared/devices.ts` (`DEVICE_COPY` complete), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts`
- Test: `tests/unit/settings.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/e2e/devices-api.spec.ts`

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces:
  - `DEVICE_COPY` (exact strings):
    ```ts
    export const DEVICE_COPY = {
      section: 'Devices',
      connected: 'Connected',
      unreachable: (address: string) => `Not reachable at ${address}`,
      offline: (time: string) => `Offline since ${time}`,
      notTried: 'Not connected yet',
      addedBy: (name: string, date: string) => `Added by ${name}, ${date}`,
      removedBy: (name: string) => `Removed from the group by ${name}`,
      pairingHint: 'Enter this code on the other device, together with one of these addresses:',
      validFor: (left: string) => `Valid for ${left}`,
      joinNoAnswer: 'The address does not answer',
      joinBadCode: 'The code is wrong or has expired',
      joinNoCode: 'The other device is not showing a code',
      joinNotProved: 'The other device could not prove the code',
      unreachableByOthers: 'The other devices cannot connect to this one; to pair, show the code on the other device',
      leaveNeedsConnection: 'Leave needs another device connected, so that the group hears of it. A computer that is gone for good is removed from another device instead.',
      keyringMissing: 'No system keyring: this device\'s key is stored unencrypted, readable only by your user.',
      portInUse: (port: number) => `Port ${port} is in use by another program; set another devices.port in settings.json`,
      badAddress: 'Not an address: a name like macbook or an IP address, optionally with :port',
      badName: 'A name of 1 to 64 characters',
      unknownDevice: 'That device is not in the group',
      disabled: 'Device sync is off'
    } as const
    ```
  - `IPC`: `devicesView: 'devices:view'`, `devicesStartPairing: 'devices:start-pairing'`, `devicesCancelPairing: 'devices:cancel-pairing'`, `devicesJoin: 'devices:join'`, `devicesRemove: 'devices:remove'`, `devicesLeave: 'devices:leave'`, `devicesSetAddress: 'devices:set-address'`, `devicesRename: 'devices:rename'`, `evDevices: 'ev:devices'`, `evStarred: 'ev:starred'`.
  - `CtApi`: `getDevicesView(): Promise<DevicesView>`; `startDevicePairing(): Promise<DevicesView>`; `cancelDevicePairing(): void`; `joinDevice(address: string, code: string): Promise<DeviceResult>`; `removeDevice(id: string): Promise<DeviceResult>`; `leaveDeviceGroup(): Promise<DeviceResult>`; `setDeviceAddress(id: string, address: string | null): Promise<DeviceResult>`; `renameThisDevice(name: string): Promise<DeviceResult>`; `onDevices(cb: (view: DevicesView) => void): Unsubscribe`; `onStarred(cb: (ids: string[]) => void): Unsubscribe`.
  - `ipc-guards.ts`: `isDeviceId = isUuid`; `isAddressInput(v): v is string` (string, 1..`MAX_ADDRESS_LENGTH`); `isOptionalAddress(v): v is string | null`; `isPairCodeInput(v): v is string` (string ≤ 64); `isDeviceNameInput(v): v is string` (string ≤ 256; the group checks the rest).

- [ ] **Step 1: Write the failing tests**

`tests/unit/settings.test.ts`: `devices` defaults to `{ enabled: false, port: 47821 }`; `{ devices: { enabled: true, port: 5000 } }` parses; `port: 80`, `port: 70000`, `port: 1.5`, `enabled: 'yes'` fall back with the usual `invalid value for "devices.port"` / `"devices.enabled"` errors.
`tests/unit/ipc-guards.test.ts`: the new guards accept and refuse at their limits.
`tests/e2e/devices-api.spec.ts` — two apps, each `launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, devices: { enabled: true } }, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config, CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: '0' } })`, both configs with `writeTranscript(config, work, SID_A)`, each tab given `SID_A` with the pipe `session` message as in `notes.spec.ts`:

```ts
test('two devices pair, then a star and a note made on one show on the other', async () => {
  const view = await a.page.evaluate(() => window.ct.startDevicePairing())
  if (!view.enabled || !view.pairing) throw new Error('no code')
  expect(await b.page.evaluate(([port, code]) => window.ct.joinDevice(`127.0.0.1:${port}`, code), [view.self.port, view.pairing.code])).toEqual({ ok: true })
  // state = (p) => p.evaluate(async () => { const v = await window.ct.getDevicesView(); return v.enabled ? v.devices[0]?.state.kind : null })
  await expect.poll(() => state(b.page)).toBe('connected')
  await recordStars(b.page); await record(b.page)            // onStarred / onNote recorders
  await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
  await expect.poll(async () => (await b.page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.starred).toBe(true)
  await a.page.evaluate((id) => window.ct.setNoteText(id, 'shared plan', 0), a.tabId)
  await expect.poll(async () => (await recorded(b.page)).at(-1)?.[1]?.text).toBe('shared plan')
})
test('removing a device tells it', async () => { /* a.removeDevice(bId) → b's onDevices view removedBy === a's self.name */ })
test('with the setting off there is no device sync and no port', async () => {
  /* a free port P (open a net server on 0, read it, close it); launchApp without devices.enabled, env CLAUDETERM_TEST_DEVICE_HOST 127.0.0.1 and CLAUDETERM_TEST_DEVICE_PORT P
     → getDevicesView() and startDevicePairing() → { enabled: false }; net.connect(P, '127.0.0.1') fails with ECONNREFUSED; no device-identity.json / sync-replica.json in the data folder */
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/settings.test.ts tests/unit/ipc-guards.test.ts` — FAIL; `npm run build; npx playwright test tests/e2e/devices-api.spec.ts` — FAIL (`window.ct.startDevicePairing is not a function`).

- [ ] **Step 3: Implement the wiring in `index.ts`**

- `startDevices()` when `settings.devices.enabled`: `DeviceGroup.open({ dir: dataDir, vault: electronVault(safeStorage, process.platform), host: testHost ?? '::', port: testPort ?? settings.devices.port, platform: windows/macos/linux from process.platform, hostName: os.hostname (cut to 64), addresses: testHost ? () => [testHost] : localAddresses, onData: (u) => bridge.applied(u), onView: (v) => broadcast(IPC.evDevices, v), warn: toast, onError: log.warn })`, then `bridge = new StoreBridge(starred, notes, group)`, `bridge.start()`. `testHost`/`testPort` come from `CLAUDETERM_TEST_DEVICE_HOST`/`CLAUDETERM_TEST_DEVICE_PORT` only when `isTest`.
- `stopDevices()`: `bridge.stop()`, `group.flush()`, `await group.close()`.
- `reloadSettings`: when `devices.enabled` or `devices.port` changed → stop, then start when enabled; broadcast the new view.
- `starred.onExternal((ids) => broadcast(IPC.evStarred, [...ids]))`; `notes.onExternal((id, note, before) => noteHub.external(id, note, before))`.
- IPC handlers with the guards; with sync off every handler answers `{ enabled: false }` or `{ ok: false, error: DEVICE_COPY.disabled }`.
- `powerMonitor.on('resume', () => group?.wake())`; every 10 s `group?.refreshSelf()` (Task 8), cleared when sync stops.
- `onReset: () => bridge?.start()`.
- `before-quit` and the window `close` handler: `bridge?.flush(); group?.flush()` next to `notes.flush()`.

- [ ] **Step 4: Run to verify they pass** — `npx vitest run` (all) — PASS; `npm run typecheck` — no errors; `npm run build; npx playwright test tests/e2e/devices-api.spec.ts` — PASS.

---

### Task 12: The Devices section and live stars

**Files:**
- Create: `src/renderer/devices-section.ts`
- Modify: `src/renderer/settings-page.ts` (the section after `accountsSection()`, shown only when `view.settings.devices.enabled`), the settings window stylesheet (follow `accounts-section.ts`' classes), `src/renderer/recent-sessions.ts` (`applyStars(ids: ReadonlySet<string>): void`), `src/renderer/main.ts` (`ct.onStarred((ids) => sessionsWindow.applyStars(new Set(ids)))`)
- Test: `tests/e2e/devices.spec.ts`

**Interfaces:**
- Consumes: the `CtApi` device calls and `DEVICE_COPY` (Task 11).
- Produces: `devicesSection(): HTMLElement` (renders from `ct.getDevicesView()` and `ct.onDevices`; the test relies on the classes `.device-row` and `.device-code`, the placeholders `Address` and `Code`, and the button labels `Add a device`, `Cancel`, `Join`, `Remove`, `Leave the group`); `RecentSessionsWindow.applyStars(ids)` — updates `starred` of the listed sessions, keeps the selection and the unfolded projects, re-renders; no-op while closed.

The section, from the spec ("What the user sees"): this device's name (an input; Enter or blur calls `renameThisDevice`) and its addresses and port; one row per device with name, system, the state line (`DEVICE_COPY.connected` / `unreachable(address)` / `offline(time as toLocaleTimeString, or date and time when not today)` / `notTried`), `addedBy(name, toLocaleDateString)`, an address input (Enter or blur → `setDeviceAddress`; empty → `null`), **Remove** (a confirm inside the row, not `window.confirm`: the button turns into `Remove <name>?` with **Remove** / **Cancel`); this device's own row with **Leave the group**, disabled with `DEVICE_COPY.leaveNeedsConnection` as its text below when `!canLeave`; **Add a device** → the code in large monospace, `pairingHint`, the addresses with the port, `validFor(m:ss)` counting down, **Cancel**; **Join a device**: address and code inputs and **Join**, the error line under them; notices: `removedBy`, `unreachableByOthers`, `problem`, `keyringMissing` when `!keyring`.

- [ ] **Step 1: Write the failing test** `tests/e2e/devices.spec.ts` (two apps as in Task 11; open each Settings window the way `tests/e2e/settings.spec.ts` does)

```ts
test('pairing through the Settings windows, and a star in Recent sessions shows on the other device at once', async () => {
  await settingsA.getByRole('button', { name: 'Add a device' }).click()
  const code = await settingsA.locator('.device-code').textContent()
  await settingsB.getByPlaceholder('Address').fill(`127.0.0.1:${portA}`)
  await settingsB.getByPlaceholder('Code').fill(code!)
  await settingsB.getByRole('button', { name: 'Join' }).click()
  await expect(settingsB.locator('.device-row', { hasText: 'Connected' })).toHaveCount(1)
  await expect(settingsA.locator('.device-row', { hasText: 'Connected' })).toHaveCount(1)
  await b.page.keyboard.press(KEYS.recentSessions)                         // B's window stays open
  await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
  await expect(b.page.locator('.session-row .session-star.starred')).toHaveCount(1)
})
test('a wrong code shows the error under the form', async () => { /* joinBadCode text visible in B's settings */ })
test('Remove asks in the row, then the other device says it was removed', async () => { /* Remove → Remove <name>? → Remove; B shows removedBy(A name) */ })
test('with the setting off the Settings window has no Devices section', async () => { /* plain app: settings window has no heading 'Devices' */ })
```

- [ ] **Step 2: Run to verify it fails** — `npm run build; npx playwright test tests/e2e/devices.spec.ts` — FAIL (no `Add a device` button).

- [ ] **Step 3: Implement** `devicesSection` in the style of `accounts-section.ts` (`el`, `errorLine`, `run`), `applyStars`, the `onStarred` subscription and the section's placement and visibility.

- [ ] **Step 4: Run to verify it passes** — `npm run build; npx playwright test tests/e2e/devices.spec.ts` — PASS. Then the whole suite: `npm run typecheck; npx vitest run; npx playwright test` — all PASS.
