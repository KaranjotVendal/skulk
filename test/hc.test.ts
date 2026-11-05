import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { timerWatch } from "../src/create.ts"
import { deliverViaHc, hcTerminalExists, hcTerminalState } from "../src/hc.ts"
import { isTarget } from "../src/target.ts"
import { tempRoot } from "./helpers.ts"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

/**
 * Stands in for `hc`: `send --json <terminal> <text>` appends the text to $FAKE_LOG; `get --json <terminal>`
 * describes the terminal. Terminal `gone` does not exist, `dead` has exited, `idler` is idle and `stuck`
 * fails to send with a transient error.
 */
const fakeHc = `#!/usr/bin/env bash
terminal="$3"
not_found() { echo "{\\"error\\":{\\"kind\\":\\"not_found\\",\\"message\\":\\"no terminal $terminal\\"}}" >&2; exit 3; }
if [ "$terminal" = "gone" ]; then not_found; fi
if [ "$1" = "get" ]; then
  case "$terminal" in
    dead) echo '{"state":"exited","title":null,"status":null}' ;;
    idler) echo '{"state":"live","title":"Idle agent","status":{"state":"idle"}}' ;;
    *) echo '{"state":"live","title":"Busy agent","status":{"state":"working"}}' ;;
  esac
  exit 0
fi
if [ "$terminal" = "stuck" ]; then echo '{"error":{"kind":"blocked","message":"waiting on a dialog"}}' >&2; exit 1; fi
printf '%s\\n---\\n' "$4" >> "$FAKE_LOG"
`

let root: string
let fake: string
let sends: string

beforeAll(() => {
  root = tempRoot()
  fake = join(root, "fake-hc")
  sends = join(root, "sends.log")
  writeFileSync(fake, fakeHc)
  chmodSync(fake, 0o700)
  process.env.SKULK_HC = fake
  process.env.FAKE_LOG = sends
})

afterAll(() => {
  delete process.env.SKULK_HC
  delete process.env.FAKE_LOG
})

const delivery = (target: string) => ({ sessionID: target, messageID: "msg_test", text: "Skulk: wake\nNext: publish.", metadata: {} })

test.each([
  ["ses_abc123", true],
  ["hc:t1k", true],
  ["hc:handbook-hosting", true],
  ["hc:laptop/t7", true],
  ["hc:", false],
  ["hc:t1k; rm -rf /", false],
  ["hc:-flag", false],
  ["t1k", false],
])("isTarget(%p) is %p", (target, expected) => {
  expect(isTarget(target)).toBe(expected)
})

test("a timer can target a Herdr terminal", () => {
  const now = Date.now()
  const watch = timerWatch({ id: "wk_hc", sessionID: "hc:t1k", instruction: "Publish.", now, at: now + 60_000 })
  expect(watch.sessionID).toBe("hc:t1k")
})

test("a wake is pasted into the terminal with hc send", async () => {
  expect(await deliverViaHc(delivery("hc:t1k"))).toEqual({ ok: true })
  expect(readFileSync(sends, "utf8")).toContain("Skulk: wake\nNext: publish.")
})

test.each([
  ["hc:gone", true],
  ["hc:stuck", false],
])("a failed send to %p is permanent: %p", async (target, permanent) => {
  const result = await deliverViaHc(delivery(target))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.permanent).toBe(permanent)
})

test.each([
  ["hc:idler", "idle"],
  ["hc:t1k", "busy"],
  ["hc:dead", "missing"],
  ["hc:gone", "missing"],
] as const)("terminal %p reads as %p", async (target, state) => {
  expect(await hcTerminalState(target)).toBe(state)
})

test("an exited terminal does not count as an existing target", async () => {
  expect(await hcTerminalExists("hc:dead")).toEqual({ exists: false })
  expect(await hcTerminalExists("hc:idler")).toEqual({ exists: true, title: "Idle agent" })
})

test("the real daemon wakes the calling Herdr terminal", async () => {
  const daemonRoot = tempRoot()
  const daemonSends = join(daemonRoot, "sends.log")
  const env = { ...process.env, SKULK_HOME: daemonRoot, SKULK_HC: fake, FAKE_LOG: daemonSends, OPENCODE_SESSION_ID: undefined, HC_TERMINAL_ID: "t9" }
  const created = Bun.spawnSync([process.execPath, cli, "in", "2s", "--name", "hc-e2e", "--do", "Publish the site."], { env })
  expect(created.exitCode).toBe(0)
  expect(created.stdout.toString()).toContain("hc:t9")

  const daemon = Bun.spawn([process.execPath, cli, "daemon"], { env, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 40 && !existsSync(daemonSends); attempt++) await Bun.sleep(250)
  daemon.kill("SIGTERM")
  await daemon.exited

  const sent = readFileSync(daemonSends, "utf8")
  expect(sent).toContain("Skulk: hc-e2e")
  expect(sent).toContain("Next: Publish the site.")
}, 20_000)
