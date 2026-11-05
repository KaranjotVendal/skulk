import type { SessionState } from "./builtin.ts"
import type { Delivery, DeliveryResult } from "./engine.ts"
import { env } from "./env.ts"
import { runCommand } from "./system.ts"

/**
 * A target of `hc:<terminal>` is a terminal in the Herdr app instead of an OpenCode session: the wake is
 * pasted into it with `hc send`, which suits Claude Code or any other agent running there. The terminal is
 * `t7`, a name, or `machine/t7`, as `hc` accepts it.
 */
const hcTargetPattern = /^hc:[A-Za-z0-9][\w.-]{0,63}(?:\/[A-Za-z0-9][\w.-]{0,63})?$/

export const isHcTarget = (target: string) => hcTargetPattern.test(target)

export const hcTerminal = (target: string) => target.slice("hc:".length)

/** Inside a Herdr terminal, the default target is that terminal. */
export const callingHcTarget = () => (process.env.HC_TERMINAL_ID ? `hc:${process.env.HC_TERMINAL_ID}` : undefined)

export const hcBinary = () => env("HC") ?? "hc"

/** `hc` prints errors as JSON `{ error: { kind, message } }`. */
function hcErrorKind(output: string) {
  try {
    return (JSON.parse(output) as { error?: { kind?: string } }).error?.kind
  } catch {
    return undefined
  }
}

/**
 * Pastes the wake into the terminal and presses Enter. Unlike OpenCode, `hc send` cannot deduplicate by
 * message ID, so a daemon killed between sending and recording the delivery can wake the terminal twice.
 */
export async function deliverViaHc(delivery: Delivery): Promise<DeliveryResult> {
  // `hc send` waits for a person typing in the terminal to pause, so it gets more time than an API call.
  const result = await runCommand([hcBinary(), "send", "--json", hcTerminal(delivery.sessionID), delivery.text], { timeoutMs: 180_000 })
  if (result.exitCode === 0 && !result.timedOut) return { ok: true }
  const output = `${result.stdout} ${result.stderr}`.trim()
  const permanent = hcErrorKind(result.stderr.trim() || result.stdout.trim()) === "not_found"
  return { ok: false, permanent, error: result.error ?? (result.timedOut ? "hc send timed out" : output.slice(0, 500)) }
}

interface HcTerminal {
  readonly state?: string
  readonly title?: string | null
  readonly status?: { readonly state?: string } | null
}

async function readTerminal(target: string) {
  const result = await runCommand([hcBinary(), "get", "--json", hcTerminal(target)], { timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    if (hcErrorKind(result.stderr.trim() || result.stdout.trim()) === "not_found") return undefined
    throw new Error(`could not reach hc to read ${target}: ${(result.error ?? `${result.stdout} ${result.stderr}`).trim().slice(0, 300)}`)
  }
  try {
    return JSON.parse(result.stdout) as HcTerminal
  } catch {
    throw new Error(`could not parse ${target} JSON from hc get`)
  }
}

export async function hcTerminalExists(target: string) {
  const terminal = await readTerminal(target)
  if (!terminal || terminal.state !== "live") return { exists: false as const }
  return { exists: true as const, title: terminal.title || undefined }
}

/** A terminal is idle when the program in it reports so (agents in Herdr report `idle` or `working`). */
export async function hcTerminalState(target: string): Promise<SessionState> {
  const terminal = await readTerminal(target)
  if (!terminal || terminal.state !== "live") return "missing"
  return terminal.status?.state === "idle" ? "idle" : "busy"
}
